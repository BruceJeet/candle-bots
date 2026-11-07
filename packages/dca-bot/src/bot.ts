/**
 * The DCA trigger and its engine. Each schedule's run is claimed in the ledger first (candle-bot-core/scheduler), then:
 *  - a buy run becomes one candidate for the engine: decide() checks the run's guards on a fresh read of the coin's
 *    venue (the price cap, the impact cap, the schedule's budget) and gives a buy verdict for the run's ticket, which
 *    the engine's own caps check again (PAUSE_BUYS, buy.maxOpen, buy.lifetimeSol, buy.sol) before it books one lot;
 *  - a sell run reads the venue (the price floor, the impact cap on pump.fun venues), and sells over the coin's lots
 *    through Engine.placeSell (the core's clamp to what the wallet holds).
 * A run ends when its orders have ended (status.json and the run history say how). A run in flight blocks the
 * schedule's next run. After a restart a run in flight places nothing more: its booked orders run to their end and it
 * ends then (`interrupted` when nothing was booked).
 */
import { join } from "node:path";
import { Engine, Executor, lamportsOf, type Alerter, type ExitStrategy, type Candidate, type PendingInfo, type Trigger, type TriggerContext, type Verdict } from "candle-bot-core";
import { KNOWN_PROGRAMS } from "candle-bot-core/exec/trader";
import { buyQuote, dryPricer, readMarkets, sellFloor, type MarketRead } from "candle-bot-core/market/reader";
import { decodeMint } from "candle-bot-core/market/mint";
import { pumpCurveSell, pumpPoolSell } from "candle-bot-core/market/pump";
import { parts, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { Scheduler, type Run } from "candle-bot-core/scheduler";
import { LotExits, PollWork, WalletLots, checkExcludeDirs, lotsOf, lotsSellRequests, ordersEnded, ordersSummary, runBuyOrders, scheduleBuyLamports, sellLots } from "candle-bot-core/lots";
import type { Ledger } from "candle-bot-core/ledger";
import type { Rpc } from "candle-bot-core/solana/rpc";
import type { Logger } from "candle-bot-core/log";
import type { Config, DcaSchedule } from "./config.ts";

type Ctx = CoreCtx<Config>;

/** A run of this process: waiting for its buy verdict, or with its orders booked. */
interface Local {
  /** placing: a sell run between its claim and its last order (set before any await). */
  state: "awaiting" | "placing" | "booked";
  at: number;
  orders: number[];
}

/** A buy run with no verdict after this long is ended (failed): the engine never decided it. */
export const VERDICT_MAX_MS = 600_000;

/** Sell impact (bps, fees apart) of selling `raw` on a pump.fun venue as read, or why it cannot be computed. */
export function sellImpactBps(m: MarketRead, raw: bigint, decimals: number): number | { why: string } {
  if (m.priceSol === null || !(m.priceSol > 0)) return { why: "no price" };
  if (!m.pumpFees) return { why: m.venue === "pump-curve" || m.venue === "pumpswap" ? "pump fee config unread" : `sell impact not computable on ${m.venue}` };
  let gross: bigint;
  try {
    if (m.venue === "pump-curve" && m.pumpCurve) gross = pumpCurveSell(m.pumpCurve, raw, m.pumpFees).grossLamports;
    else if (m.venue === "pumpswap" && m.pumpPool && m.supply) gross = pumpPoolSell(m.pumpPool, m.mint, raw, m.supply, m.pumpFees).grossLamports;
    else return { why: `sell impact not computable on ${m.venue}` };
  } catch (e) {
    return { why: String((e as Error).message) };
  }
  const spot = (Number(raw) / 10 ** decimals) * m.priceSol * 1e9;
  if (!(spot > 0)) return { why: "no value" };
  return Math.max(0, Math.round(((spot - Number(gross)) / spot) * 10_000));
}

export interface DcaDeps {
  cfg: Config;
  ledger: Ledger;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  sched: Scheduler;
  lots: WalletLots;
  now?: () => number;
  /** How long a poll waits for its run work (default POLL_BUDGET_MS, 5 s). */
  pollBudgetMs?: number;
}

export class DcaTrigger implements Trigger {
  readonly name = "dca";
  readonly candidateLabel = "runs";
  readonly buyIdPrefix = "cdcb";
  readonly sellIdPrefix = "cdcs";
  engine: Engine | null = null;
  private d: DcaDeps;
  private now: () => number;
  private dry: boolean;
  private local = new Map<string, Local>();
  private decimals = new Map<string, number>();
  private specs: Map<string, DcaSchedule>;
  stats = { runs: 0, bought: 0, sold: 0, skipped: 0, interrupted: 0 };
  private work: PollWork<Candidate>;

  constructor(d: DcaDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.dry = d.cfg.mode === "dry";
    this.specs = new Map(d.cfg.dca.schedules.map((s) => [s.id, s]));
    this.work = new PollWork<Candidate>(d.log, d.pollBudgetMs);
  }

  private key(id: string, run: number): string {
    return `${id}#${run}`;
  }

  private end(r: { id: string; run: number }, status: "done" | "skipped" | "failed" | "interrupted", detail: string): void {
    this.local.delete(this.key(r.id, r.run));
    if (this.d.sched.finish(r.id, r.run, status, detail)) {
      if (status === "skipped") this.stats.skipped++;
      if (status === "interrupted") this.stats.interrupted++;
    }
  }

  private async decimalsOf(mint: string, rpc: Rpc): Promise<number> {
    const have = this.decimals.get(mint);
    if (have !== undefined) return have;
    const lot = this.d.ledger.allPositions().find((p) => p.mint === mint);
    if (lot) {
      this.decimals.set(mint, lot.decimals);
      return lot.decimals;
    }
    const d = decodeMint((await rpc.call<any>("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }]))?.value).decimals;
    this.decimals.set(mint, d);
    return d;
  }

  /** A fresh read of the coin's venue (every venue the core prices). */
  private async market(mint: string, rpc: Rpc): Promise<{ m: MarketRead; decimals: number } | { why: string }> {
    let decimals: number;
    try {
      decimals = await this.decimalsOf(mint, rpc);
    } catch (e) {
      return { why: `mint unreadable (${String((e as Error)?.message ?? e).slice(0, 80)})` };
    }
    try {
      const m = (await readMarkets(rpc, [{ mint, decimals }], this.now(), { pump: true })).get(mint);
      if (!m) return { why: "venue not readable" };
      return { m, decimals };
    } catch (e) {
      return { why: `venue not readable (${String((e as Error)?.message ?? e).slice(0, 80)})` };
    }
  }

  /** Runs in flight: end those whose orders have ended; after a restart, those this process did not start. */
  private settle(): void {
    for (const r of this.d.sched.inflight()) {
      const k = this.key(r.id, r.run);
      const loc = this.local.get(k);
      if (loc?.state === "placing") continue;
      if (loc?.state === "awaiting") {
        if (this.now() - loc.at > VERDICT_MAX_MS) this.end(r, "failed", "no verdict from the engine");
        continue;
      }
      const ref = (r.ref ?? {}) as { orders?: number[] };
      const ids = [...new Set([...(ref.orders ?? []), ...(loc?.orders ?? []), ...runBuyOrders(this.d.ledger, this.dry, r.id, r.run).map((o) => o.id)])];
      if (!loc && !ids.length) {
        this.end(r, "interrupted", "the bot stopped before this run booked an order; nothing placed");
        continue;
      }
      if (loc && !ids.length) {
        // A buy verdict the engine's booking refused (its caps, checked once more inside the booking).
        this.end(r, "skipped", "the engine did not book the buy (see buy_refused_at_booking)");
        continue;
      }
      if (!ordersEnded(this.d.ledger, ids)) continue;
      const s = ordersSummary(this.d.ledger, ids);
      this.end(r, loc ? s.status : s.filled ? "done" : "interrupted", `${loc ? "" : "resumed after a restart: "}${s.detail}`);
    }
  }

  /**
   * The run work (requests, settling, claims, sell runs) runs as one PollWork step at a time: a poll waits for it at
   * most `pollBudgetMs` (under the engine's trigger timeout), and buys made by a step that took longer come with the
   * next poll. A second poll never starts a second step.
   */
  async poll(ctx: TriggerContext): Promise<Candidate[]> {
    // Nothing runs before the wallet's bags are booked as lots (a sell must see them; a buy must not come first).
    if (!this.d.lots.ready) return [];
    return this.work.poll((push) => this.step(ctx, push), () => ctx.wake());
  }

  stop(): Promise<void> {
    return this.work.stop();
  }

  private async step(ctx: TriggerContext, push: (c: Candidate) => void): Promise<void> {
    if (this.engine) await lotsSellRequests(this.engine, this.d.ledger, this.dry, this.d.cfg.stateDir, this.d.log);
    this.settle();
    for (const r of this.d.sched.due()) {
      const s = this.specs.get(r.id)!;
      // The run's own entry first, before anything is awaited.
      this.local.set(this.key(r.id, r.run), { state: s.side === "buy" ? "awaiting" : "placing", at: this.now(), orders: [] });
      if (ctx.shouldStop()) {
        this.end(r, "interrupted", "STOP before the run placed anything");
        continue;
      }
      this.stats.runs++;
      if (s.side === "buy") push({ mint: s.mint, chain: "solana", seenAtMs: this.now(), source: "schedule", reason: `${s.id} run ${r.run}`, meta: { schedule: s.id, run: r.run, startedAt: r.startedAt } });
      else await this.sellRun(r, s, ctx.rpc);
    }
  }

  /** A sell run: the guards on a fresh read, then a sell over the coin's lots. */
  private async sellRun(r: Run, s: DcaSchedule, rpc: Rpc): Promise<void> {
    const skip = (why: string) => {
      this.d.log.info("dca_sell_skip", { schedule: s.id, run: r.run, mint: s.mint, why });
      this.end(r, "skipped", why);
    };
    if (!this.engine) return skip("no engine");
    if (this.engine.sellsPaused()) return skip("PAUSE_SELLS");
    const lots = lotsOf(this.d.ledger, this.dry, s.mint);
    const held = lots.reduce((t, p) => t + BigInt(p.remaining_raw), 0n);
    if (held <= 0n) return skip("the bot holds none of this coin");
    if (lots.some((p) => this.d.ledger.openOrderFor(p.id))) return skip("an order of this coin is in flight");
    const got = await this.market(s.mint, rpc);
    if ("why" in got) return skip(got.why);
    const { m, decimals } = got;
    if (m.priceSol === null || !(m.priceSol > 0)) return skip(`no price (${m.problem ?? m.venue})`);
    if (s.minPriceSol !== null && m.priceSol < s.minPriceSol) return skip(`price ${m.priceSol} under minPriceSol ${s.minPriceSol}`);
    let amount: bigint;
    if (s.fraction !== null) amount = s.fraction >= 1 ? held : (held * BigInt(Math.round(s.fraction * 1e6))) / 1_000_000n;
    else {
      const x = Math.floor((s.sol! / m.priceSol) * 10 ** decimals);
      amount = Number.isFinite(x) && x > 0 ? BigInt(x) : 0n;
    }
    if (amount > held) amount = held;
    if (amount <= 0n) return skip("rounds to zero tokens");
    if (s.maxImpactBps !== null) {
      const imp = sellImpactBps(m, amount, decimals);
      if (typeof imp !== "number") return skip(`impact cap set, ${imp.why}`);
      if (imp > s.maxImpactBps) return skip(`impact ${imp} bps > ${s.maxImpactBps}`);
    }
    const loc = this.local.get(this.key(r.id, r.run))!;
    const res = await sellLots(this.engine, this.d.ledger, this.dry, s.mint, amount, `dca ${s.id} run ${r.run}`, false, (id) => {
      loc.orders.push(id);
      this.d.sched.setRef(r.id, r.run, { orders: loc.orders });
    });
    if (!res.orders.length) return skip(`no sell booked: ${res.why.join("; ") || "nothing to sell"}`);
    loc.state = "booked";
    this.stats.sold++;
    this.d.log.info(this.dry ? "dry_dca_sell" : "dca_sell", { schedule: s.id, run: r.run, mint: s.mint, amountRaw: amount, placedRaw: res.placedRaw, orders: res.orders, priceSol: m.priceSol, venue: m.venue });
  }

  async decide(c: Candidate, ctx: TriggerContext): Promise<Verdict> {
    const meta = c.meta as { schedule: string; run: number; startedAt: number };
    const s = this.specs.get(meta.schedule);
    if (!s || s.side !== "buy") return { verdict: "skip", reason: "unknown schedule" };
    if (!this.d.sched.inflight().some((r) => r.id === meta.schedule && r.run === meta.run)) return { verdict: "skip", reason: `run ${meta.run} is no longer in flight` };
    const ticket = lamportsOf(s.sol!);
    const caps = ctx.caps(c.mint);
    if (caps.paused) return { verdict: "skip", reason: "PAUSE_BUYS" };
    if (this.now() > meta.startedAt + this.d.cfg.dca.buyWithinSec * 1000) return { verdict: "skip", reason: `stale: over buyWithinSec ${this.d.cfg.dca.buyWithinSec} s since the run started` };
    if (caps.open >= ctx.cfg.buy.maxOpen) return { verdict: "skip", reason: `maxOpen ${ctx.cfg.buy.maxOpen}` };
    if (caps.lifetimeLamports + ticket > lamportsOf(ctx.cfg.buy.lifetimeSol)) return { verdict: "skip", reason: `lifetimeSol ${ctx.cfg.buy.lifetimeSol}` };
    if (s.budgetSol !== null && scheduleBuyLamports(this.d.ledger, this.dry, s.id) + ticket > lamportsOf(s.budgetSol)) return { verdict: "skip", reason: `budgetSol ${s.budgetSol} used` };
    const got = await this.market(c.mint, ctx.rpc);
    if ("why" in got) return { verdict: "skip", reason: got.why };
    const { m, decimals } = got;
    if (m.priceSol === null || !(m.priceSol > 0)) return { verdict: "skip", reason: `no price (${m.problem ?? m.venue})` };
    if (s.maxPriceSol !== null && m.priceSol > s.maxPriceSol) return { verdict: "skip", reason: `price ${m.priceSol} over maxPriceSol ${s.maxPriceSol}` };
    const q = buyQuote(m, ticket);
    if ("why" in q) return { verdict: "skip", reason: `venue refused: ${q.why}` };
    const cap = s.maxImpactBps ?? this.d.cfg.dca.maxImpactBps;
    if (q.impactBps > cap) return { verdict: "skip", reason: `impact ${q.impactBps} bps > ${cap}` };
    return {
      verdict: "buy",
      reason: `dca ${s.id} run ${meta.run}; impact ${q.impactBps} bps on ${q.venue}`,
      lamports: ticket,
      deadlineAtMs: meta.startedAt + this.d.cfg.dca.buyWithinSec * 1000,
      expectedOutRaw: q.expectedOutRaw,
      decimals,
      context: { schedule: s.id, run: meta.run, venue: q.venue, impactBps: q.impactBps, priceSol: m.priceSol },
      log: { schedule: s.id, run: meta.run, venue: q.venue, impactBps: q.impactBps, priceSol: m.priceSol },
    };
  }

  onVerdict(c: Candidate, v: Verdict, _ctx: TriggerContext, _p: PendingInfo): void {
    if (v.verdict === "wait") return;
    const meta = c.meta as { schedule: string; run: number };
    const k = this.key(meta.schedule, meta.run);
    if (v.verdict === "skip") {
      this.d.log.info("dca_buy_skip", { schedule: meta.schedule, run: meta.run, mint: c.mint, reason: v.reason });
      this.end({ id: meta.schedule, run: meta.run }, "skipped", v.reason);
      return;
    }
    // The engine books the order right after this call (same turn); settle() finds it by the run's entry context.
    const loc = this.local.get(k);
    if (loc) loc.state = "booked";
    this.stats.bought++;
  }

  status(): Record<string, unknown> {
    return {
      dca: {
        ...this.stats,
        lotsReady: this.d.lots.ready,
        walletLotSkips: this.d.lots.skips(),
        schedules: this.d.sched.status().map((x) => {
          const s = this.specs.get(String(x.id))!;
          const lots = lotsOf(this.d.ledger, this.dry, s.mint);
          return { ...x, mint: s.mint, side: s.side, ...(s.sol !== null ? { sol: s.sol } : {}), ...(s.fraction !== null ? { fraction: s.fraction } : {}), ...(s.budgetSol !== null ? { budgetSol: s.budgetSol, budgetUsedSol: Number(scheduleBuyLamports(this.d.ledger, this.dry, s.id)) / 1e9 } : {}), lots: lots.length, heldRaw: lots.reduce((t, p) => t + BigInt(p.remaining_raw), 0n).toString() };
        }),
      },
    };
  }
}

export interface Built {
  engine: Engine;
  trigger: DcaTrigger;
  lots: WalletLots;
  sched: Scheduler;
}

/** Linked wallet with checkPrograms on: the programs it may sign for (core KNOWN_PROGRAMS plus extraPrograms). */
export function knownProgramsFor(cfg: Config): Set<string> | undefined {
  return cfg.payer === "linked" && cfg.dca.checkPrograms ? new Set([...KNOWN_PROGRAMS, ...cfg.dca.extraPrograms]) : undefined;
}

/** The engine for a run context: every buy and its retries checked on its venue (Candle curve, DAMM v2, pump.fun). */
export async function makeBot(ctx: Ctx, ledger: Ledger, d: { now?: () => number; random?: () => number } = {}): Promise<Built> {
  const cfg = ctx.cfg;
  checkExcludeDirs(cfg.dca.excludeStateDirs, cfg.stateDir, "config.dca.excludeStateDirs");
  const known = knownProgramsFor(cfg);
  const linked = cfg.payer === "linked";
  const decimalsOf = (m: string) => ledger.allPositions().find((p) => p.mint === m)?.decimals ?? 6;
  const { alerter, executor, strategy } = await parts(ctx, ledger, {
    maxBuyImpactBps: cfg.dca.maxImpactBps,
    executor: (x) => new Executor({ ...x, dry: dryPricer(ctx.rpc, ctx.client, decimalsOf, { pump: true }), pumpBuys: true, dammBuys: true, ...(known ? { knownPrograms: known } : {}), ...(linked ? { sellFloor: sellFloor(ctx.rpc, cfg.sell.maxSlippageBps, cfg.dca.sellFloorMarginBps), buyFloorMarginBps: cfg.dca.buyFloorMarginBps } : {}) }),
    ...(d.now ? { now: d.now } : {}),
  });
  return assemble({ cfg, ledger, rpc: ctx.rpc, log: ctx.log, alerter, executor, strategy, ...d });
}

/** The scheduler, the lots, the trigger and the engine around an executor (a library user, or a test, brings its own). */
export function assemble(d: { cfg: Config; ledger: Ledger; rpc: Rpc; log: Logger; alerter: Alerter; executor: Executor; strategy: ExitStrategy; now?: () => number; random?: () => number; pollBudgetMs?: number }): Built {
  const { cfg, ledger } = d;
  const mints = [...new Set(cfg.dca.schedules.map((s) => s.mint))];
  const lots = new WalletLots({ cfg, ledger, rpc: d.rpc, log: d.log, alerter: d.alerter, holds: d.executor, mints, enabled: cfg.dca.walletLots, excludeStateDirs: cfg.dca.excludeStateDirs, minValueSol: cfg.dca.minValueSol, maxTransferFeeBps: cfg.dca.maxTransferFeeBps, venues: { pump: true }, ...(d.now ? { now: d.now } : {}) });
  const sched = new Scheduler({ ledger, specs: cfg.dca.schedules, dry: cfg.mode === "dry", log: d.log, ...(d.now ? { now: d.now } : {}), ...(d.random ? { random: d.random } : {}) });
  const trigger = new DcaTrigger({ cfg, ledger, rpc: d.rpc, log: d.log, alerter: d.alerter, sched, lots, ...(d.now ? { now: d.now } : {}), ...(d.pollBudgetMs !== undefined ? { pollBudgetMs: d.pollBudgetMs } : {}) });
  const engine = new Engine({ cfg, ledger, trigger, executor: d.executor, strategy: new LotExits(d.strategy, lots), rpc: d.rpc, log: d.log, alerter: d.alerter, venues: { pump: true }, pumpBuys: true, adopter: lots, pauseSells: true, ...(d.now ? { now: d.now } : {}) });
  trigger.engine = engine;
  return { engine, trigger, lots, sched };
}

export const ledgerPath = (cfg: Config) => join(cfg.stateDir, "ledger.sqlite");
