/**
 * The rebalance trigger and its engine. A run (claimed in the ledger first, candle-bot-core/scheduler) has two phases:
 *  1. **sells**: the wallet and every target coin's venue are read fresh; the plan (plan.ts) is logged in full; an
 *     unpriced coin or an unreadable balance blocks the run (alerted, nothing traded); the overweight coins are sold
 *     over their lots through Engine.placeSell (the core's clamp).
 *  2. **buys**, once every sell has ended: the wallet is read again and the buys are planned from it, with what is left
 *     of maxSolPerRun; each buy is a candidate the engine decides (its caps: PAUSE_BUYS, buy.maxOpen,
 *     buy.lifetimeSol, buy.sol) after decide() checks its venue again (impact, a fresh quote).
 * The run ends when its buys have ended. A run in flight blocks the next. After a restart a run in flight places
 * nothing more: its booked orders run to their end, and it ends then.
 */
import { join } from "node:path";
import { Engine, Executor, lamportsOf, type Alerter, type Candidate, type PendingInfo, type Trigger, type TriggerContext, type Verdict } from "candle-bot-core";
import { KNOWN_PROGRAMS } from "candle-bot-core/exec/trader";
import { buyQuote, dryPricer, readMarkets, sellFloor } from "candle-bot-core/market/reader";
import { decodeMint } from "candle-bot-core/market/mint";
import { parts, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { Scheduler, type Run } from "candle-bot-core/scheduler";
import { LotExits, PollWork, WalletLots, checkExcludeDirs, isWalletLot, lotsOf, lotsSellRequests, ordersEnded, ordersSummary, runBuyOrders, sellLots } from "candle-bot-core/lots";
import { tokenBalance, type Rpc } from "candle-bot-core/solana/rpc";
import type { Ledger } from "candle-bot-core/ledger";
import type { Logger } from "candle-bot-core/log";
import type { ExitStrategy } from "candle-bot-core/strategies/types";
import { SCHEDULE_ID, type Config } from "./config.ts";
import { plan, planText, type Plan, type PlanInput } from "./plan.ts";

type Ctx = CoreCtx<Config>;

/** A buy with no verdict after this long is dropped from its run (the engine never decided it). */
export const VERDICT_MAX_MS = 600_000;

/** A run of this process. */
interface Local {
  /** planning: between the claim and the last sell booked (set before any await). */
  phase: "planning" | "sells" | "buys";
  at: number;
  sells: number[];
  /** Mints whose buy waits for its verdict. */
  awaiting: Set<string>;
  /** SOL of maxSolPerRun the sells used (at the decision prices). */
  soldSol: number;
  skips: string[];
}

/** The wallet as the plan sees it: SOL, and each target coin's holding, lots and price. */
export async function snapshot(d: { cfg: Config; ledger: Ledger | null; rpc: Rpc; now: () => number; decimals?: Map<string, number> }): Promise<{ input: PlanInput } | { why: string }> {
  const cfg = d.cfg;
  const dry = cfg.mode === "dry";
  const mints = Object.keys(cfg.rebalance.targets);
  let lamports: bigint;
  try {
    const r = await d.rpc.call<any>("getBalance", [cfg.wallet, { commitment: "confirmed" }]);
    const v = r?.value ?? r;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return { why: "SOL balance unreadable" };
    lamports = BigInt(Math.floor(v));
  } catch (e) {
    return { why: `SOL balance unreadable (${String((e as Error)?.message ?? e).slice(0, 80)})` };
  }
  if (dry && d.ledger) {
    // A dry run's fills never touch the wallet: its SOL is the wallet's less what its dry buys cost, plus its dry sells.
    for (const p of d.ledger.allPositions()) {
      if (!p.dry) continue;
      if (!isWalletLot(p)) lamports -= BigInt(p.cost_lamports);
      lamports += BigInt(p.proceeds_lamports);
    }
    if (lamports < 0n) lamports = 0n;
  }
  const decimals = d.decimals ?? new Map<string, number>();
  for (const m of mints) {
    if (decimals.has(m)) continue;
    const lot = d.ledger?.allPositions().find((p) => p.mint === m);
    if (lot) {
      decimals.set(m, lot.decimals);
      continue;
    }
    try {
      decimals.set(m, decodeMint((await d.rpc.call<any>("getAccountInfo", [m, { encoding: "base64", commitment: "confirmed" }]))?.value).decimals);
    } catch (e) {
      return { why: `mint ${m} unreadable (${String((e as Error)?.message ?? e).slice(0, 80)})` };
    }
  }
  let markets: Awaited<ReturnType<typeof readMarkets>>;
  try {
    markets = await readMarkets(d.rpc, mints.map((m) => ({ mint: m, decimals: decimals.get(m)! })), d.now(), { pump: true });
  } catch (e) {
    return { why: `venues unreadable (${String((e as Error)?.message ?? e).slice(0, 80)})` };
  }
  const coins: PlanInput["coins"] = [];
  for (const m of mints) {
    const lots = d.ledger ? lotsOf(d.ledger, dry, m) : [];
    const booked = lots.reduce((t, p) => t + BigInt(p.remaining_raw), 0n);
    let raw: bigint;
    if (dry && d.ledger) raw = booked;
    else {
      const b = await tokenBalance(d.rpc, cfg.wallet, m);
      if (b === null) return { why: `balance of ${m} unreadable` };
      raw = b;
    }
    const mk = markets.get(m);
    const price = mk && !mk.problem && mk.priceSol !== null ? mk.priceSol : null;
    // Without a ledger (the plan command) the wallet's bags would be booked as lots at start: all of it is sellable.
    coins.push({ mint: m, raw, sellableRaw: d.ledger ? booked : raw, decimals: decimals.get(m)!, priceSol: price });
  }
  const r = cfg.rebalance;
  return {
    input: { targets: r.targets, solWeight: r.solWeight, solLamports: lamports, reserveLamports: lamportsOf(r.reserveSol), coins, bandPct: r.bandPct, minTradeSol: r.minTradeSol, maxSolPerRun: r.maxSolPerRun, maxTicketSol: cfg.buy.sol },
  };
}

/** The plan in log fields (bigints as strings). */
function planFields(p: Plan): Record<string, unknown> {
  return {
    blocked: p.blocked, totalSol: p.totalSol, freeSol: p.freeSol, sol: p.sol,
    rows: p.rows.map((r) => ({ mint: r.mint, valueSol: r.valueSol, weight: r.weight, target: r.target, offPct: r.offPct, action: r.action })),
    orders: p.orders.map((o) => ({ mint: o.mint, side: o.side, sol: o.sol, ...(o.raw !== undefined ? { raw: o.raw.toString() } : {}), ...(o.lamports !== undefined ? { lamports: o.lamports.toString() } : {}), why: o.why })),
    dropped: p.dropped, movedSol: p.movedSol,
  };
}

export interface RebalanceDeps {
  cfg: Config;
  ledger: Ledger;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  sched: Scheduler;
  lots: WalletLots;
  now?: () => number;
  /** How long a poll waits for its run work (default POLL_BUDGET_MS, 5 s; at most half of triggerTimeoutMs). */
  pollBudgetMs?: number;
  /** The engine's trigger timeout (default TRIGGER_TIMEOUT_MS, 10 s): the poll budget is at most half of it. */
  triggerTimeoutMs?: number;
}

export class RebalanceTrigger implements Trigger {
  readonly name = "rebalancer";
  readonly candidateLabel = "buys";
  readonly buyIdPrefix = "crbb";
  readonly sellIdPrefix = "crbs";
  engine: Engine | null = null;
  private d: RebalanceDeps;
  private now: () => number;
  private dry: boolean;
  private local = new Map<number, Local>();
  private decimals = new Map<string, number>();
  /** The last plan logged (status.json). */
  lastPlan: { run: number; phase: string; at: string; plan: Record<string, unknown> } | null = null;
  stats = { runs: 0, blocked: 0, sells: 0, buys: 0, interrupted: 0 };
  private work: PollWork<Candidate>;

  constructor(d: RebalanceDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.dry = d.cfg.mode === "dry";
    this.work = new PollWork<Candidate>(d.log, d.pollBudgetMs, d.triggerTimeoutMs);
  }

  private end(run: number, status: "done" | "skipped" | "failed" | "blocked" | "interrupted", detail: string): void {
    this.local.delete(run);
    if (this.d.sched.finish(SCHEDULE_ID, run, status, detail) && status === "interrupted") this.stats.interrupted++;
  }

  private logPlan(run: number, phase: string, p: Plan): void {
    const fields = planFields(p);
    this.lastPlan = { run, phase, at: new Date(this.now()).toISOString(), plan: fields };
    this.d.log.info(this.dry ? "dry_rebalance_plan" : "rebalance_plan", { run, phase, ...fields, text: planText(p) });
  }

  /** A run that threw: ended failed with the orders it booked (they run on through the core), alerted. */
  private fail(run: number, e: unknown): void {
    const loc = this.local.get(run);
    const ids = [...new Set([...(loc?.sells ?? []), ...runBuyOrders(this.d.ledger, this.dry, SCHEDULE_ID, run).map((o) => o.id)])];
    const why = String((e as Error)?.message ?? e).slice(0, 300);
    this.d.log.error("rebalance_run_failed", { run, error: String((e as Error)?.stack ?? e).slice(0, 1000), orders: ids });
    this.d.alerter.raise(`rebalance:run_failed`, `rebalance run ${run} failed: ${why}${ids.length ? `; its orders ${ids.join(", ")} go on` : "; nothing booked"}`);
    this.end(run, "failed", `${why}${ids.length ? `; orders ${ids.join(", ")}` : ""}`);
  }

  private block(run: number, why: string): void {
    this.stats.blocked++;
    this.d.alerter.raise(`rebalance:blocked:${why.slice(0, 120)}`, `rebalance run ${run} blocked: ${why}; nothing traded`);
    this.d.log.warn("rebalance_blocked", { run, why });
    this.end(run, "blocked", why);
  }

  /** Runs in flight: next phase or end. After a restart, a run this process did not start places nothing more. */
  private async settle(ctx: TriggerContext): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const r of this.d.sched.inflight()) {
      const loc = this.local.get(r.run);
      const ref = (r.ref ?? {}) as { sells?: number[] };
      const buys = runBuyOrders(this.d.ledger, this.dry, SCHEDULE_ID, r.run).map((o) => o.id);
      if (!loc) {
        const ids = [...new Set([...(ref.sells ?? []), ...buys])];
        if (!ids.length) {
          this.end(r.run, "interrupted", "the bot stopped before this run booked an order; nothing placed");
          continue;
        }
        if (!ordersEnded(this.d.ledger, ids)) continue;
        const s = ordersSummary(this.d.ledger, ids);
        this.end(r.run, s.filled ? "done" : "interrupted", `resumed after a restart (no new orders): ${s.detail}`);
        continue;
      }
      if (loc.phase === "planning") continue;
      if (loc.phase === "sells") {
        if (!ordersEnded(this.d.ledger, loc.sells)) continue;
        try {
          out.push(...(await this.buyPhase(r, loc, ctx)));
        } catch (e) {
          this.fail(r.run, e);
        }
        continue;
      }
      if (loc.awaiting.size) {
        if (this.now() - loc.at > VERDICT_MAX_MS) {
          loc.skips.push(`no verdict for ${[...loc.awaiting].join(", ")}`);
          loc.awaiting.clear();
        } else continue;
      }
      const ids = [...loc.sells, ...buys];
      if (!ordersEnded(this.d.ledger, ids)) continue;
      const s = ordersSummary(this.d.ledger, ids);
      this.end(r.run, ids.length ? s.status : "done", `${ids.length ? s.detail : "no orders"}${loc.skips.length ? `; skipped: ${loc.skips.join("; ")}` : ""}`);
    }
    return out;
  }

  /** Phase 2: the buys, planned from the wallet as it is after the sells. */
  private async buyPhase(r: Run, loc: Local, ctx: TriggerContext): Promise<Candidate[]> {
    loc.phase = "buys";
    loc.at = this.now();
    if (ctx.caps(Object.keys(this.d.cfg.rebalance.targets)[0]).paused) {
      loc.skips.push("buys: PAUSE_BUYS");
      return [];
    }
    const snap = await snapshot({ cfg: this.d.cfg, ledger: this.d.ledger, rpc: ctx.rpc, now: this.now, decimals: this.decimals });
    if ("why" in snap) {
      loc.skips.push(`buys blocked: ${snap.why}`);
      this.d.alerter.raise(`rebalance:blocked:${snap.why.slice(0, 120)}`, `rebalance run ${r.run}: buys blocked: ${snap.why}; nothing bought`);
      return [];
    }
    const p = plan({ ...snap.input, side: "buy", budgetSol: Math.max(0, this.d.cfg.rebalance.maxSolPerRun - loc.soldSol) });
    this.logPlan(r.run, "buys", p);
    if (p.blocked) {
      loc.skips.push(`buys blocked: no price for ${p.blocked.join(", ")}`);
      this.d.alerter.raise(`rebalance:blocked:price`, `rebalance run ${r.run}: buys blocked, no price for ${p.blocked.join(", ")}; nothing bought`);
      return [];
    }
    const out: Candidate[] = [];
    for (const o of p.orders) {
      if (o.side !== "buy" || !o.lamports) continue;
      loc.awaiting.add(o.mint);
      out.push({ mint: o.mint, chain: "solana", seenAtMs: this.now(), source: "rebalance", reason: `run ${r.run}: ${o.why}`, meta: { schedule: SCHEDULE_ID, run: r.run, lamports: o.lamports.toString(), why: o.why, decidedAt: this.now() } });
    }
    return out;
  }

  /**
   * The run work (reads, plans, sells) runs as one PollWork step at a time: a poll waits for it at most `pollBudgetMs`
   * (under the engine's trigger timeout); buys planned by a step that took longer come with the next poll. A second
   * poll never starts a second step.
   */
  async poll(ctx: TriggerContext): Promise<Candidate[]> {
    if (!this.d.lots.ready || !this.engine) return [];
    return this.work.poll((push) => this.step(ctx, push), () => ctx.wake());
  }

  stop(): Promise<void> {
    return this.work.stop();
  }

  private async step(ctx: TriggerContext, push: (c: Candidate) => void): Promise<void> {
    await lotsSellRequests(this.engine!, this.d.ledger, this.dry, this.d.cfg.stateDir, this.d.log);
    for (const c of await this.settle(ctx)) push(c);
    for (const r of this.d.sched.due()) {
      // The run's own entry first, before anything is awaited.
      this.local.set(r.run, { phase: "planning", at: this.now(), sells: [], awaiting: new Set(), soldSol: 0, skips: [] });
      if (ctx.shouldStop()) {
        this.end(r.run, "interrupted", "STOP before the run placed anything");
        continue;
      }
      this.stats.runs++;
      try {
        for (const c of await this.sellPhase(r, ctx)) push(c);
      } catch (e) {
        this.fail(r.run, e);
      }
    }
  }

  /** Phase 1: the plan and the sells. No sells: straight on to the buys. */
  private async sellPhase(r: Run, ctx: TriggerContext): Promise<Candidate[]> {
    const mints = Object.keys(this.d.cfg.rebalance.targets);
    const busy = mints.find((m) => lotsOf(this.d.ledger, this.dry, m).some((p) => this.d.ledger.openOrderFor(p.id)));
    if (busy) {
      this.end(r.run, "skipped", `an order of ${busy} is in flight`);
      return [];
    }
    const snap = await snapshot({ cfg: this.d.cfg, ledger: this.d.ledger, rpc: ctx.rpc, now: this.now, decimals: this.decimals });
    if ("why" in snap) {
      this.block(r.run, snap.why);
      return [];
    }
    const p = plan(snap.input);
    this.logPlan(r.run, "full", p);
    if (p.blocked) {
      this.block(r.run, `no price for ${p.blocked.join(", ")}`);
      return [];
    }
    const loc = this.local.get(r.run)!;
    const sells = p.orders.filter((o) => o.side === "sell");
    if (sells.length && this.engine!.sellsPaused()) loc.skips.push("sells: PAUSE_SELLS");
    else
      for (const o of sells) {
        // STOP: nothing more is booked (an order booked now would run at the next start, on this plan's old prices).
        if (ctx.shouldStop()) break;
        const res = await sellLots(this.engine!, this.d.ledger, this.dry, o.mint, o.raw!, `rebalance run ${r.run}: ${o.why}`, false, (id) => {
          loc.sells.push(id);
          this.d.sched.setRef(SCHEDULE_ID, r.run, { sells: loc.sells });
        }, ctx.shouldStop);
        if (res.orders.length) loc.soldSol += o.sol * (Number(res.placedRaw) / Number(o.raw!));
        if (res.why.length) loc.skips.push(`sell ${o.mint}: ${res.why.join("; ")}`);
        this.stats.sells += res.orders.length;
      }
    loc.phase = "sells";
    this.d.sched.setRef(SCHEDULE_ID, r.run, { sells: loc.sells });
    if (ctx.shouldStop()) {
      // Orders booked before STOP run on (settled at the next start); with none the run ends here.
      if (!loc.sells.length) this.end(r.run, "interrupted", "STOP before the run placed anything");
      return [];
    }
    if (loc.sells.length) return [];
    return this.buyPhase(r, loc, ctx);
  }

  async decide(c: Candidate, ctx: TriggerContext): Promise<Verdict> {
    const meta = c.meta as { run: number; lamports: string; why: string; decidedAt: number };
    const ticket = BigInt(meta.lamports);
    if (!this.d.sched.inflight().some((r) => r.run === meta.run)) return { verdict: "skip", reason: `run ${meta.run} is no longer in flight` };
    const caps = ctx.caps(c.mint);
    if (caps.paused) return { verdict: "skip", reason: "PAUSE_BUYS" };
    if (this.now() > meta.decidedAt + this.d.cfg.rebalance.buyWithinSec * 1000) return { verdict: "skip", reason: `stale: over buyWithinSec ${this.d.cfg.rebalance.buyWithinSec} s since the plan` };
    if (caps.open >= ctx.cfg.buy.maxOpen) return { verdict: "skip", reason: `maxOpen ${ctx.cfg.buy.maxOpen}` };
    if (caps.lifetimeLamports + ticket > lamportsOf(ctx.cfg.buy.lifetimeSol)) return { verdict: "skip", reason: `lifetimeSol ${ctx.cfg.buy.lifetimeSol}` };
    const decimals = this.decimals.get(c.mint) ?? 6;
    let m;
    try {
      m = (await readMarkets(ctx.rpc, [{ mint: c.mint, decimals }], this.now(), { pump: true })).get(c.mint);
    } catch {
      m = undefined;
    }
    if (!m || m.priceSol === null) return { verdict: "skip", reason: `no price (${m?.problem ?? "venue not readable"})` };
    const q = buyQuote(m, ticket);
    if ("why" in q) return { verdict: "skip", reason: `venue refused: ${q.why}` };
    if (q.impactBps > this.d.cfg.rebalance.maxImpactBps) return { verdict: "skip", reason: `impact ${q.impactBps} bps > ${this.d.cfg.rebalance.maxImpactBps}` };
    return {
      verdict: "buy",
      reason: `rebalance run ${meta.run}: ${meta.why}; impact ${q.impactBps} bps on ${q.venue}`,
      lamports: ticket,
      deadlineAtMs: meta.decidedAt + this.d.cfg.rebalance.buyWithinSec * 1000,
      expectedOutRaw: q.expectedOutRaw,
      decimals,
      context: { schedule: SCHEDULE_ID, run: meta.run, venue: q.venue, impactBps: q.impactBps, priceSol: m.priceSol },
      log: { run: meta.run, venue: q.venue, impactBps: q.impactBps, sol: Number(ticket) / 1e9 },
    };
  }

  onVerdict(c: Candidate, v: Verdict, _ctx: TriggerContext, _p: PendingInfo): void {
    if (v.verdict === "wait") return;
    const meta = c.meta as { run: number };
    const loc = this.local.get(meta.run);
    loc?.awaiting.delete(c.mint);
    if (v.verdict === "skip") {
      loc?.skips.push(`buy ${c.mint}: ${v.reason}`);
      this.d.log.info("rebalance_buy_skip", { run: meta.run, mint: c.mint, reason: v.reason });
    } else this.stats.buys++;
  }

  status(): Record<string, unknown> {
    const targets = Object.entries(this.d.cfg.rebalance.targets).map(([mint, weight]) => {
      const lots = lotsOf(this.d.ledger, this.dry, mint);
      return { mint, target: weight, lots: lots.length, heldRaw: lots.reduce((t, p) => t + BigInt(p.remaining_raw), 0n).toString() };
    });
    return { rebalance: { ...this.stats, lotsReady: this.d.lots.ready, walletLotSkips: this.d.lots.skips(), schedule: this.d.sched.status()[0] ?? null, solWeight: this.d.cfg.rebalance.solWeight, targets, lastPlan: this.lastPlan } };
  }
}

export interface Built {
  engine: Engine;
  trigger: RebalanceTrigger;
  lots: WalletLots;
  sched: Scheduler;
}

export function knownProgramsFor(cfg: Config): Set<string> | undefined {
  return cfg.payer === "linked" && cfg.rebalance.checkPrograms ? new Set([...KNOWN_PROGRAMS, ...cfg.rebalance.extraPrograms]) : undefined;
}

export async function makeBot(ctx: Ctx, ledger: Ledger, d: { now?: () => number; random?: () => number } = {}): Promise<Built> {
  const cfg = ctx.cfg;
  const r = cfg.rebalance;
  checkExcludeDirs(r.excludeStateDirs, cfg.stateDir, "config.rebalance.excludeStateDirs");
  const known = knownProgramsFor(cfg);
  const linked = cfg.payer === "linked";
  const decimalsOf = (m: string) => ledger.allPositions().find((p) => p.mint === m)?.decimals ?? 6;
  const { alerter, executor, strategy } = await parts(ctx, ledger, {
    maxBuyImpactBps: r.maxImpactBps,
    executor: (x) => new Executor({ ...x, dry: dryPricer(ctx.rpc, ctx.client, decimalsOf, { pump: true }), pumpBuys: true, dammBuys: true, ...(known ? { knownPrograms: known } : {}), ...(linked ? { sellFloor: sellFloor(ctx.rpc, cfg.sell.maxSlippageBps, r.sellFloorMarginBps), buyFloorMarginBps: r.buyFloorMarginBps } : {}) }),
    ...(d.now ? { now: d.now } : {}),
  });
  return assemble({ cfg, ledger, rpc: ctx.rpc, log: ctx.log, alerter, executor, strategy, ...d });
}

export function assemble(d: { cfg: Config; ledger: Ledger; rpc: Rpc; log: Logger; alerter: Alerter; executor: Executor; strategy: ExitStrategy; now?: () => number; random?: () => number; pollBudgetMs?: number; triggerTimeoutMs?: number }): Built {
  const { cfg, ledger } = d;
  const r = cfg.rebalance;
  const lots = new WalletLots({ cfg, ledger, rpc: d.rpc, log: d.log, alerter: d.alerter, holds: d.executor, mints: Object.keys(r.targets), enabled: r.walletLots, excludeStateDirs: r.excludeStateDirs, minValueSol: r.minValueSol, maxTransferFeeBps: r.maxTransferFeeBps, venues: { pump: true }, ...(d.now ? { now: d.now } : {}) });
  const sched = new Scheduler({ ledger, specs: [r.schedule], dry: cfg.mode === "dry", log: d.log, ...(d.now ? { now: d.now } : {}), ...(d.random ? { random: d.random } : {}) });
  const trigger = new RebalanceTrigger({ cfg, ledger, rpc: d.rpc, log: d.log, alerter: d.alerter, sched, lots, ...(d.now ? { now: d.now } : {}), ...(d.pollBudgetMs !== undefined ? { pollBudgetMs: d.pollBudgetMs } : {}), ...(d.triggerTimeoutMs !== undefined ? { triggerTimeoutMs: d.triggerTimeoutMs } : {}) });
  // The exit is hold (the config allows no other): lots are sold only by runs, and by `sell`.
  const engine = new Engine({ cfg, ledger, trigger, executor: d.executor, strategy: new LotExits(d.strategy, lots), rpc: d.rpc, log: d.log, alerter: d.alerter, venues: { pump: true }, pumpBuys: true, adopter: lots, pauseSells: true, ...(d.now ? { now: d.now } : {}), ...(d.triggerTimeoutMs !== undefined ? { triggerTimeoutMs: d.triggerTimeoutMs } : {}) });
  trigger.engine = engine;
  return { engine, trigger, lots, sched };
}

export const ledgerPath = (cfg: Config) => join(cfg.stateDir, "ledger.sqlite");
