/**
 * The engine loop. Each cycle:
 *   controls (STOP, PAUSE_BUYS, manual sell requests) -> sells -> market reads for open positions -> exit strategy ->
 *   sells -> settle buys -> new candidates from the trigger, its verdicts, the caps -> buys -> one executor sweep ->
 *   alerts that nag -> surplus check -> status.json
 * Nothing in a cycle can throw out of the loop; the control files are read first and never block.
 * The bot supplies the trigger (see trigger.ts); everything else here is the same for every bot.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { Executor } from "./exec/executor.ts";
import type { Ledger, PositionRow } from "./ledger.ts";
import type { Logger } from "./log.ts";
import { readMarkets, type MarketRead } from "./market/reader.ts";
import { redactDeep } from "./redact.ts";
import { tokenBalance, type Rpc } from "./solana/rpc.ts";
import type { ExitStrategy, PositionView } from "./strategies/types.ts";
import type { Alerter } from "./alerts.ts";
import type { BuyVerdict, Candidate, EntryCaps, PendingInfo, Trigger, TriggerContext, Verdict } from "./trigger.ts";

export interface EngineDeps {
  cfg: Config;
  ledger: Ledger;
  trigger: Trigger;
  executor: Executor;
  strategy: ExitStrategy;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  now?: () => number;
}

export function lamportsOf(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

/** Most time one cycle spends before the rest of its work waits for the next one (exits always run). */
export const CYCLE_BUDGET_MS = 20_000;

/** How often the wallet's balance of each held coin is compared with what this bot booked. */
export const SURPLUS_CHECK_MS = 600_000;
/** Coins whose position ended this recently are still checked for a surplus. */
export const SURPLUS_TAIL_MS = 3_600_000;
/** A DAMM v2 pool this close to its floor has no liquidity left to sell into. */
export const FLOOR_ROOM_MIN = 0.005;

interface Pending extends PendingInfo {
  candidate: Candidate;
}

const DEFAULT_DECIMALS = 6;

/** Read a control file without ever blocking or throwing: regular files only, non-blocking open, bounded read. */
export function readControl(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}

export class Engine {
  private d: EngineDeps;
  private now: () => number;
  private pending = new Map<string, Pending>();
  private exitHoldUntil = new Map<number, number>();
  /** When each position's exits were first held for want of a sell route (cleared once a route is back). */
  private noRouteSince = new Map<number, number>();
  /** Next surplus check per coin. */
  private surplusAt = new Map<string, number>();
  private surplusSeen = new Set<string>();
  private markets = new Map<string, MarketRead>();
  private stopRequested = false;
  private cycles = 0;
  private lastCycleMs = 0;
  /** Counts for status.json: candidates (under the trigger's candidateLabel), buys, skips and sells placed. */
  readonly stats = { candidates: 0, buys: 0, skips: 0, sells: 0 };
  /** What every trigger call gets. */
  readonly ctx: TriggerContext;

  constructor(d: EngineDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    mkdirSync(join(d.cfg.stateDir, "requests"), { recursive: true });
    const self = this;
    this.ctx = {
      cfg: d.cfg, ledger: d.ledger, rpc: d.rpc, log: d.log, alerter: d.alerter,
      get dry() { return self.dry; },
      now: () => self.now(),
      caps: (mint) => self.caps(mint),
      shouldStop: () => self.shouldStop(),
    };
  }

  get executor(): Executor {
    return this.d.executor;
  }

  get trigger(): Trigger {
    return this.d.trigger;
  }

  get stopping(): boolean {
    return this.stopRequested;
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  paused(): boolean {
    return readControl(join(this.d.cfg.stateDir, "PAUSE_BUYS")) !== null;
  }

  /** STOP file or SIGTERM/SIGINT: checked before every step and between orders. */
  shouldStop = (): boolean => {
    if (!this.stopRequested && readControl(join(this.d.cfg.stateDir, "STOP")) !== null) {
      this.d.log.info("stop_file_seen");
      this.stopRequested = true;
    }
    return this.stopRequested;
  };

  /** Each cycle has a time budget; work left over waits for the next cycle. */
  private overBudget(t0: number): boolean {
    return this.now() - t0 > CYCLE_BUDGET_MS;
  }

  /** One full cycle. Returns false when STOP was seen (the caller exits cleanly). */
  async cycle(): Promise<boolean> {
    const t0 = this.now();
    const sweep = (side?: "buy" | "sell", reconcileOnly = false) => this.d.executor.sweep(5, { side, reconcileOnly, budgetMs: Math.max(1_000, CYCLE_BUDGET_MS - (this.now() - t0)), shouldStop: this.shouldStop });
    // Exits first: a stop-loss never waits behind new entries.
    const steps: Array<[string, () => Promise<void>]> = [
      ["requests", () => this.manualRequests()],
      ["sells", () => sweep("sell")],
      ["exits", () => this.exits()],
      ["sells2", () => sweep("sell")],
      // Buys that may already have executed get their own slot: settling them never waits behind a slow sell side.
      ["settle-buys", () => sweep("buy", true)],
      ["entries", () => this.entries(t0)],
      ["orders", () => sweep()],
      ["nag", async () => this.nag()],
      ["surplus", () => this.surplus()],
    ];
    for (const [name, fn] of steps) {
      if (this.shouldStop()) {
        this.writeStatus();
        return false;
      }
      // Past the budget only the exit steps still run.
      if (this.overBudget(t0) && !["sells", "exits", "sells2", "settle-buys", "nag"].includes(name)) continue;
      await this.guard(name, fn);
    }
    if (this.shouldStop()) {
      this.writeStatus();
      return false;
    }
    this.cycles++;
    this.lastCycleMs = this.now() - t0;
    this.writeStatus();
    return true;
  }

  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.d.log.error("cycle_step_failed", { step: what, error: String((e as Error)?.stack ?? e) });
    }
  }

  /** Conditions that need a human re-announce (alerts.renotifyMs) until they clear. */
  private nag(): void {
    for (const p of this.mine("exit_stuck"))
      this.d.alerter.raise(`position:${p.id}:exit_stuck`, `position ${p.id} ${p.mint}: exits refused ${p.exit_orders_failed} times; retried every ${Math.round(this.d.cfg.retry.stuckRetryMs / 60000)} min, or run \`sell\` by hand`);
    for (const p of this.mine("opening", "open", "exit_stuck")) {
      const o = this.d.ledger.openOrderFor(p.id);
      if (o && o.tx_read_failures >= 6) this.d.alerter.raise(`order:${o.id}:qty_unknown`, `order ${o.id} ${o.side} ${p.mint} landed but its fill is still unread`);
    }
  }

  /**
   * The wallet holding more of a coin than this bot booked (a second execution that landed after the first was booked,
   * or tokens from elsewhere): alerted, never adopted. Checked per coin every SURPLUS_CHECK_MS, while no order of the
   * coin is in flight.
   */
  private async surplus(): Promise<void> {
    if (this.dry) return;
    const held = this.mine("opening", "open", "exit_stuck");
    // Also coins whose position ended within the last hour: a late second execution can outlive the position.
    const recent = this.mine("closed", "failed").filter((p) => p.closed_at !== null && this.now() - p.closed_at < SURPLUS_TAIL_MS);
    const mints = [...new Set([...held, ...recent].map((p) => p.mint))];
    for (const mint of mints) {
      if (this.shouldStop()) return;
      if ((this.surplusAt.get(mint) ?? 0) > this.now()) continue;
      const ps = held.filter((p) => p.mint === mint);
      if (ps.some((p) => p.status === "opening" || this.d.ledger.openOrderFor(p.id))) continue;
      this.surplusAt.set(mint, this.now() + SURPLUS_CHECK_MS);
      const bal = await tokenBalance(this.d.rpc, this.d.cfg.wallet, mint);
      if (bal === null) continue;
      const booked = ps.reduce((t, p) => t + BigInt(p.remaining_raw), 0n);
      if (bal <= booked) {
        this.surplusSeen.delete(mint);
        continue;
      }
      // Two readings in a row (a minute apart), so one lagging read after a sell is not an alarm.
      if (!this.surplusSeen.has(mint)) {
        this.surplusSeen.add(mint);
        this.surplusAt.set(mint, this.now() + 60_000);
        continue;
      }
      this.d.alerter.raise(`coin:${mint}:surplus`, `${mint}: the wallet holds ${bal} tokens, ${bal - booked} more than this bot booked${ps.length ? ` (positions ${ps.map((p) => p.id).join(", ")})` : " (no open position)"}; not managed, \`sell\` reaches a failed buy's own`);
    }
  }

  // ---------------------------------------------------------------- entries
  private get dry(): boolean {
    return this.d.cfg.mode === "dry";
  }

  /** Positions of this run's mode only: a dry run never manages live rows, a live run never dry ones. */
  private mine(...statuses: Parameters<Ledger["positionsByStatus"]>): PositionRow[] {
    return this.d.ledger.positionsByStatus(...statuses).filter((p) => !!p.dry === this.dry);
  }

  private openCount(): number {
    return this.mine("opening", "open", "exit_stuck").length;
  }

  private caps(mint: string): EntryCaps {
    return { open: this.openCount(), entriesForMint: this.d.ledger.entriesForMint(mint, this.dry), lifetimeLamports: this.d.ledger.lifetimeBuyLamports(this.dry), paused: this.paused() };
  }

  /**
   * The engine's own caps on a buy verdict, whatever the trigger decided: a trigger cannot buy past them. Same reasons
   * and order as the launch bot's filters always had.
   */
  private capCheck(mint: string, v: BuyVerdict): Verdict {
    const ticket = v.lamports ?? lamportsOf(this.d.cfg.buy.sol);
    if (!(typeof ticket === "bigint" && ticket > 0n && ticket <= lamportsOf(this.d.cfg.buy.sol))) return { verdict: "skip", reason: `ticket ${String(ticket)} lamports outside (0, buy.sol]` };
    const caps = this.caps(mint);
    if (caps.paused) return { verdict: "skip", reason: "PAUSE_BUYS" };
    if (caps.entriesForMint >= this.d.cfg.buy.maxPerCoin) return { verdict: "skip", reason: `maxPerCoin ${this.d.cfg.buy.maxPerCoin}` };
    if (caps.open >= this.d.cfg.buy.maxOpen) return { verdict: "skip", reason: `maxOpen ${this.d.cfg.buy.maxOpen}` };
    if (caps.lifetimeLamports + ticket > lamportsOf(this.d.cfg.buy.lifetimeSol)) return { verdict: "skip", reason: `lifetimeSol ${this.d.cfg.buy.lifetimeSol}` };
    return v;
  }

  private async entries(t0: number = this.now()): Promise<void> {
    const t = this.d.trigger;
    for (const c of await t.poll(this.ctx)) {
      this.stats.candidates++;
      this.pending.set(c.mint, { candidate: c, firstSeenMs: this.now(), lastReason: "" });
    }
    for (const [mint, p] of [...this.pending]) {
      if (this.shouldStop() || this.overBudget(t0)) break;
      let v = await t.decide(p.candidate, this.ctx, p);
      if (v.verdict === "buy") v = this.capCheck(mint, v);
      if (v.verdict === "wait") {
        if (t.onVerdict) t.onVerdict(p.candidate, v, this.ctx, p);
        else if (v.reason !== p.lastReason) this.d.log.info("candidate_wait", { mint, source: p.candidate.source, reason: v.reason });
        p.lastReason = v.reason;
        continue;
      }
      this.pending.delete(mint);
      if (t.onVerdict) t.onVerdict(p.candidate, v, this.ctx, p);
      else if (v.verdict === "skip") this.d.log.info("candidate_skip", { mint, source: p.candidate.source, reason: v.reason });
      if (v.verdict === "skip") {
        this.stats.skips++;
        continue;
      }
      this.buy(p.candidate, v);
    }
    t.afterEntries?.(this.ctx);
  }

  private buy(c: Candidate, v: BuyVerdict): void {
    const now = this.now();
    const dry = this.d.cfg.mode === "dry";
    const lamports = v.lamports ?? lamportsOf(this.d.cfg.buy.sol);
    const t = this.d.trigger;
    const id = this.d.ledger.tx(() => {
      const pid = this.d.ledger.createPosition({ mint: c.mint, chain: c.chain, dry, now, decimals: v.decimals ?? DEFAULT_DECIMALS, strategy: this.d.strategy.name, entry: v.context !== undefined ? v.context : c.meta });
      // The buy is only good while the trigger's decision is: no attempt is built past its deadline.
      this.d.ledger.createOrder({ positionId: pid, side: "buy", clientTradeId: `${t.buyIdPrefix ?? "bot"}-${randomUUID()}`, amountRaw: lamports, slippageBps: this.d.cfg.buy.maxSlippageBps, maxAttempts: this.d.cfg.retry.maxAttempts, now, reason: v.reason, deadlineAt: v.deadlineAtMs ?? null, expectedOutRaw: v.expectedOutRaw ?? null });
      return pid;
    });
    this.stats.buys++;
    const extra = typeof v.log === "function" ? v.log(now) : v.log ?? { sol: Number(lamports) / 1e9 };
    this.d.log.info(dry ? "dry_buy" : "buy_order", { position: id, mint: c.mint, ...extra });
  }

  // ---------------------------------------------------------------- exits
  private view(p: PositionRow, m: MarketRead): PositionView {
    const qty = BigInt(p.qty_raw);
    const rem = BigInt(p.remaining_raw);
    // Tokens written off for a wallet shortfall were never sold: they leave both sides of soldFraction.
    const base = qty - BigInt(p.written_down_raw ?? "0");
    const entry = qty > 0n ? Number(BigInt(p.cost_lamports)) / 1e9 / (Number(qty) / 10 ** p.decimals) : 0;
    return {
      mint: p.mint,
      openedAtMs: p.opened_at,
      qtyRaw: qty,
      remainingRaw: rem,
      decimals: p.decimals,
      entryPriceSol: entry,
      peakPriceSol: Math.max(p.peak_price, m.priceSol ?? 0),
      soldFraction: base > 0n ? Math.max(0, Number(base - rem) / Number(base)) : 0,
    };
  }

  private async exits(): Promise<void> {
    const open = this.mine("open", "exit_stuck");
    if (!open.length) return;
    this.markets = await readMarkets(this.d.rpc, open.map((p) => ({ mint: p.mint, decimals: p.decimals })), this.now());
    for (const p of open) {
      const m = this.markets.get(p.mint);
      if (!m) continue;
      if (m.priceSol !== null) this.d.ledger.updatePosition(p.id, { last_price: m.priceSol, peak_price: Math.max(p.peak_price, m.priceSol) });
      if (this.shouldStop()) return;
      // exit_stuck: refused repeatedly. Not permanent: one more try on the slow clock (the alert keeps nagging).
      if (p.status === "exit_stuck") {
        const lastSell = this.d.ledger.ordersFor(p.id).filter((o) => o.side === "sell").pop();
        if (lastSell && this.now() < lastSell.updated_at + this.d.cfg.retry.stuckRetryMs) continue;
      }
      if (this.d.ledger.openOrderFor(p.id)) continue;               // one exit in flight at a time
      if ((this.exitHoldUntil.get(p.id) ?? 0) > this.now()) continue;
      // No sell route right now: migrating to its pool, unreadable, or a pool at its floor. Hold; don't burn exits.
      if (m.problem || m.priceSol === null || (m.venue === "damm" && m.roomAboveFloor !== null && m.roomAboveFloor < FLOOR_ROOM_MIN)) {
        const why = m.problem ?? (m.priceSol === null ? "no price" : "pool at its floor");
        if (this.d.ledger.alert(`position:${p.id}:no_route:${why}`, `position ${p.id} ${p.mint}: exits held (${why})`, this.now(), 3_600_000)) this.d.log.info("exit_held", { position: p.id, mint: p.mint, why });
        // A short hold is normal (migration takes a few slots); one that lasts reaches the alert sinks, renotified.
        const since = this.noRouteSince.get(p.id) ?? this.now();
        if (!this.noRouteSince.has(p.id)) this.noRouteSince.set(p.id, since);
        const held = this.now() - since;
        if (held >= this.d.cfg.alerts.holdAlertMs) this.d.alerter.raise(`position:${p.id}:no_route`, `position ${p.id} ${p.mint}: no sell route for ${Math.round(held / 60_000)} min (${why}); exits held`);
        continue;
      }
      this.noRouteSince.delete(p.id);
      // After failed exit orders (refused or out of attempts), the next waits on the position's own backoff clock.
      const sells = this.d.ledger.ordersFor(p.id).filter((o) => o.side === "sell");
      let streak = 0;
      for (let i = sells.length - 1; i >= 0 && ["failed", "rejected", "reverted"].includes(sells[i].status); i--) streak++;
      if (streak > 0 && p.status !== "exit_stuck" && this.now() < sells[sells.length - 1].updated_at + this.d.executor.backoffMs(streak + 1)) continue;
      let decision;
      try {
        decision = this.d.strategy.onTick(this.view(p, m), m);
      } catch (e) {
        this.d.log.error("strategy_error", { position: p.id, error: String((e as Error)?.message ?? e) });
        continue;
      }
      if (decision.action !== "sell") continue;
      await this.placeSell(p, decision.fraction, decision.reason, false);
    }
  }

  /** Create a sell order clamped to the on-chain balance. Returns the order id, or null when refused. */
  async placeSell(p: PositionRow, fraction: number, reason: string, manual: boolean): Promise<number | null> {
    p = this.d.ledger.position(p.id) ?? p;
    if (!(fraction > 0 && fraction <= 1)) throw new Error("fraction must be in (0, 1]");
    let remaining = BigInt(p.remaining_raw);
    if (remaining <= 0n) return null;
    const part = (x: bigint) => (fraction >= 1 ? x : (x * BigInt(Math.round(fraction * 1e6))) / 1_000_000n);
    if (part(remaining) <= 0n) return null;
    if (!p.dry) {
      const bal = await tokenBalance(this.d.rpc, this.d.cfg.wallet, p.mint);
      const refuse = (why: "unreadable" | "zero") => {
        // Zero or unreadable: the tokens are gone or this is the wrong account. Never sell for nothing.
        this.exitHoldUntil.set(p.id, this.now() + 60_000);
        const key = `position:${p.id}:balance:${why}`;
        this.d.alerter.raise(key, `sell refused for position ${p.id} ${p.mint}: wallet balance ${why}`);
        return null;
      };
      if (bal === null) return refuse("unreadable");
      // Other open positions of this bot in the same coin own part of the balance.
      const others = this.mine("open", "exit_stuck", "opening").filter((x) => x.mint === p.mint && x.id !== p.id).reduce((s, x) => s + BigInt(x.remaining_raw), 0n);
      const available = bal - others;
      if (available <= 0n) return refuse("zero");
      if (available < remaining) {
        // The wallet holds less than the ledger says: write the position down to what is really there (only ever
        // down), so a sell of it can close the position instead of leaving a phantom remainder forever.
        this.d.ledger.updatePosition(p.id, { remaining_raw: available.toString(), written_down_raw: (BigInt(p.written_down_raw ?? "0") + remaining - available).toString(), note: `shortfall: ledger ${remaining}, wallet ${available}` });
        const key = `position:${p.id}:shortfall`;
        this.d.alerter.raise(key, `position ${p.id} ${p.mint}: wallet holds ${available} of ${remaining} booked`);
        this.d.log.warn("sell_clamped", { position: p.id, mint: p.mint, bookedRaw: remaining, balanceRaw: available });
        remaining = available;
      }
    }
    const amount = part(remaining);
    if (amount <= 0n) return null;
    const now = this.now();
    const id = this.d.ledger.createOrder({ positionId: p.id, side: "sell", clientTradeId: `${this.d.trigger.sellIdPrefix ?? "bots"}-${randomUUID()}`, amountRaw: amount, slippageBps: this.d.cfg.sell.maxSlippageBps, maxAttempts: this.d.cfg.retry.maxAttempts, now, reason, manual });
    this.stats.sells++;
    this.d.log.info(p.dry ? "dry_sell" : "sell_order", { position: p.id, mint: p.mint, amountRaw: amount, fraction, reason, manual });
    return id;
  }

  // ---------------------------------------------------------------- manual requests (from the `sell` command)
  private async manualRequests(): Promise<void> {
    const dir = join(this.d.cfg.stateDir, "requests");
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => /^sell-[A-Za-z0-9-]+\.json$/.test(n));
    } catch {
      return;
    }
    for (const n of names) {
      const path = join(dir, n);
      const text = readControl(path);
      try {
        unlinkSync(path);
      } catch {
        /* gone */
      }
      if (!text) continue;
      try {
        const req = JSON.parse(text) as { mint: string; fraction: number };
        const r = await this.manualSell(req.mint, req.fraction);
        this.d.log.info("manual_sell_request", { mint: req.mint, fraction: req.fraction, result: r });
      } catch (e) {
        this.d.log.warn("manual_sell_request_bad", { file: n, error: String((e as Error).message) });
      }
    }
  }

  /** The `sell` command's path: same clamp, same executor. Moves an exit_stuck position back to open. */
  async manualSell(mint: string, fraction: number): Promise<string> {
    let p = this.mine("open", "exit_stuck").find((x) => x.mint === mint);
    if (!p) {
      const r = await this.reopenFailedBuy(mint);
      if (typeof r === "string") return r;
      p = r;
    }
    if (this.d.ledger.openOrderFor(p.id)) return "an exit order is already in flight";
    // exit_stuck is cleared only when this manual sell fills (the executor does that), not before.
    const id = await this.placeSell(p, fraction, "manual", true);
    return id === null ? "refused (see alerts)" : `order ${id}`;
  }

  /**
   * `sell` on a coin whose buy ended failed or rejected while the wallet holds its tokens (a buy that landed after the
   * bot gave up, or that it could not prove): reopen that position with the wallet's unexplained tokens (qty from the
   * wallet, cost the order's ticket) so the sell can run. Only buys that may have executed qualify. Alerted.
   */
  private async reopenFailedBuy(mint: string): Promise<PositionRow | string> {
    const dry = this.d.cfg.mode === "dry";
    const cand = this.d.ledger.positionsByStatus("failed").filter((x) => x.mint === mint && !!x.dry === dry).pop();
    const buy = cand ? this.d.ledger.ordersFor(cand.id).find((o) => o.side === "buy") : undefined;
    // Only a buy that ended failed or rejected and may have run: a revert delivered nothing, a filled buy was booked.
    if (!cand || !buy || !["failed", "rejected"].includes(buy.status) || !(buy.ever_signed === 1 || buy.signature) || BigInt(cand.qty_raw) > 0n) return "no open position for that mint";
    if (dry) return "no open position for that mint";
    const r = await this.d.executor.reopenable(buy.id);
    if ("why" in r) return `no open position for that mint (${r.why})`;
    this.d.ledger.tx(() => {
      this.d.ledger.updatePosition(cand.id, { status: "open", closed_at: null, qty_raw: r.amount.toString(), remaining_raw: r.amount.toString(), qty_source: r.signatures.length ? "onchain" : "wallet", cost_lamports: r.costLamports.toString(), note: `reopened by sell: ${r.amount} tokens received since the buy (ended ${buy.status})` });
      // Our transactions, once found, are booked to the buy so no other scan claims them.
      if (r.signatures.length) this.d.ledger.updateOrder(buy.id, { status: "filled", signature: r.signatures[0], extra_signatures: r.signatures.length > 1 ? JSON.stringify(r.signatures.slice(1)) : null });
    });
    this.d.alerter.raise(`position:${cand.id}:reopened`, `position ${cand.id} ${mint}: buy ended ${buy.status}; reopened with ${r.amount} tokens received since the order (${r.signatures.length ? `our tx ${r.signatures.join(", ")}` : "no tx of ours found; capped, cost the ticket"}) for the manual sell`);
    return this.d.ledger.position(cand.id)!;
  }

  // ---------------------------------------------------------------- status.json
  statusObject(): Record<string, unknown> {
    const now = this.now();
    const dry = this.d.cfg.mode === "dry";
    const all = this.d.ledger.allPositions().filter((p) => !!p.dry === dry);
    let spent = 0n, proceeds = 0n, fees = 0n, rent = 0n, openValue = 0;
    const open: unknown[] = [];
    for (const p of all) {
      spent += BigInt(p.cost_lamports);
      proceeds += BigInt(p.proceeds_lamports);
      fees += BigInt(p.network_fees_lamports);
      rent += BigInt(p.rent_lamports ?? "0");
      if (p.status === "open" || p.status === "exit_stuck" || p.status === "opening") {
        const m = this.markets.get(p.mint);
        const price = m?.priceSol ?? p.last_price ?? null;
        const remaining = BigInt(p.remaining_raw);
        const value = price === null ? null : (Number(remaining) / 10 ** p.decimals) * price;
        if (value !== null) openValue += value;
        const qty = BigInt(p.qty_raw);
        const entry = qty > 0n ? Number(BigInt(p.cost_lamports)) / 1e9 / (Number(qty) / 10 ** p.decimals) : null;
        open.push({ id: p.id, mint: p.mint, status: p.status, openedAt: new Date(p.opened_at).toISOString(), remainingRaw: p.remaining_raw, qtySource: p.qty_source, entryPriceSol: entry, priceSol: price, multiple: entry && price ? price / entry : null, valueSol: value, venue: m?.venue ?? null, progress: m?.progress ?? null, exitOrdersFailed: p.exit_orders_failed });
      }
    }
    const { candidates, ...counts } = this.stats;
    const extra = this.d.trigger.status?.([...this.pending.values()].map((p) => ({ candidate: p.candidate, firstSeenMs: p.firstSeenMs, lastReason: p.lastReason }))) ?? {};
    return redactDeep({
      at: new Date(now).toISOString(),
      mode: this.d.cfg.mode,
      wallet: this.d.cfg.wallet,
      strategy: this.d.strategy.name,
      paused: this.paused(),
      stopping: this.stopRequested,
      cycles: this.cycles,
      lastCycleMs: this.lastCycleMs,
      equity: { spentSol: Number(spent) / 1e9, proceedsSol: Number(proceeds) / 1e9, networkFeesSol: Number(fees) / 1e9, rentSol: Number(rent) / 1e9, openValueSol: openValue, pnlSol: (Number(proceeds) - Number(spent) - Number(fees) - Number(rent)) / 1e9 + openValue },
      caps: { open: this.openCount(), maxOpen: this.d.cfg.buy.maxOpen, lifetimeSolUsed: Number(this.d.ledger.lifetimeBuyLamports(dry)) / 1e9, lifetimeSol: this.d.cfg.buy.lifetimeSol },
      queue: this.d.ledger.queueHealth(now, dry),
      alertsSent: this.d.alerter.sent,
      ...extra,
      positions: open,
      stats: { [this.d.trigger.candidateLabel ?? "candidates"]: candidates, ...counts },
    });
  }

  writeStatus(): void {
    try {
      const path = join(this.d.cfg.stateDir, "status.json");
      const tmp = path + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.statusObject(), (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      renameSync(tmp, path);
    } catch (e) {
      this.d.log.warn("status_write_failed", { error: String((e as Error).message) });
    }
  }
}

/** One process per state dir. */
export function acquireLock(stateDir: string): { release(): void } | null {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "lock");
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release() {
          try {
            unlinkSync(path);
          } catch {
            /* gone */
          }
        },
      };
    } catch {
      const pid = Number(readControl(path) ?? "0");
      let alive = false;
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = (e as any)?.code === "EPERM";
        }
      }
      if (alive) return null;
      try {
        unlinkSync(path); // stale lock from a crashed run
      } catch {
        /* raced */
      }
    }
  }
  return null;
}

export function lockHeld(stateDir: string): boolean {
  return existsSync(join(stateDir, "lock"));
}
