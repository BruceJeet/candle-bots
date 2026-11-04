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
import type { BuyVerdict, Candidate, CurveRead, EntryCaps, LedgerView, PendingInfo, Trigger, TriggerContext, Verdict } from "./trigger.ts";
import { deepFreeze } from "./config.ts";
import { asAddress } from "./solana/base58.ts";
import { buyImpact, decodeCandleCurve } from "./market/curve.ts";
import { candleCurve as curveOf } from "./solana/pda.ts";

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
  /** Longest one trigger call (poll, decide) may take, ms (default TRIGGER_TIMEOUT_MS; capped by the cycle budget left). */
  triggerTimeoutMs?: number;
}

/** Consecutive exit-strategy errors on one position before it is alerted. */
export const STRATEGY_ERROR_ALERT = 3;

/**
 * Longest one entries step (a fast lane, or the entries step of a full cycle) keeps deciding before the scheduler
 * looks at the exits again; what is left goes on in the next lane.
 */
export const LANE_BUDGET_MS = 1_000;

/** A wake waits until no new wake came for this long before its lane runs: a burst gives one lane, not a storm. */
export const WAKE_DEBOUNCE_MS = 10;
/** ... but never longer than this after the first wake. */
export const WAKE_DEBOUNCE_MAX_MS = 50;
/** Surplus balance reads in flight at once. */
export const SURPLUS_READS = 8;

/** Default limit on one trigger call. */
export const TRIGGER_TIMEOUT_MS = 10_000;

/** The engine's copy of a buy verdict: primitives only, frozen. */
interface Buy {
  readonly verdict: "buy";
  readonly reason: string;
  readonly lamports: bigint;
  readonly deadlineAtMs: number | null;
  readonly expectedOutRaw: bigint | null;
  readonly decimals: number;
  /** The entry context, already serialized (what positions.launch_json gets). */
  readonly entryJson: string;
  readonly log: Readonly<Record<string, unknown>> | ((nowMs: number) => Record<string, unknown>) | undefined;
}

type Decided = Buy | { readonly verdict: "wait"; readonly reason: string } | { readonly verdict: "skip"; readonly reason: string };

const CORE_STATUS_KEYS = new Set(["at", "mode", "wallet", "strategy", "paused", "stopping", "cycles", "lastCycleMs", "equity", "caps", "queue", "alertsSent", "positions", "stats"]);

function skip(reason: string): Decided {
  return Object.freeze({ verdict: "skip" as const, reason });
}

/** What onVerdict gets: a frozen copy in the public shape (changing it changes nothing). */
function publicVerdict(v: Decided): Verdict {
  if (v.verdict !== "buy") return Object.freeze({ verdict: v.verdict, reason: v.reason }) as Verdict;
  return Object.freeze({ verdict: "buy", reason: v.reason, lamports: v.lamports, deadlineAtMs: v.deadlineAtMs, expectedOutRaw: v.expectedOutRaw, decimals: v.decimals, context: JSON.parse(v.entryJson) });
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
  /** The engine's frozen copy of the candidate (meta stays the trigger's). */
  candidate: Readonly<Candidate>;
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

  /** Entries-loop polls run (run(), lane()). */
  lanes = 0;
  /** Exit ticks run (run()). */
  exitTicks = 0;
  /** Decides in flight (the entries loop), by mint. */
  private inflight = new Map<string, Promise<void>>();
  /** When a waiting candidate is asked again (the entries loop). */
  private nextAsk = new Map<string, number>();
  /** A wake arrived and its lane has not run yet. */
  private wakePending = false;
  private lastWakeAt = 0;
  private wakeWaiter: (() => void) | null = null;
  /** Cycles and lanes never run at the same time (one engine, one worker). */
  private lockBusy = false;
  private lockExits: Array<() => void> = [];
  private lockNormal: Array<() => void> = [];
  /** The engine's own curve reads in this entries step, by account (a trigger's ctx.readCurve and expectedOut share it). */
  private curveCache = new Map<string, { at: number; read: Promise<CurveRead> }>();
  /** Drop curve reads too old to be reused by anyone. */
  private pruneCurves(): void {
    const keep = this.d.cfg.exitMs * 10;
    for (const [k, v] of this.curveCache) if (this.now() - v.at > keep) this.curveCache.delete(k);
  }
  /** Where the next entries step starts when the last one stopped on its budget (round robin; null: the head). */
  private resumeAt: string | null = null;
  /** Consecutive exit-strategy errors per position. */
  private strategyErrors = new Map<number, number>();
  /** Trigger calls that timed out and have not ended yet: no new call while one is still running. */
  private hung = new Set<string>();

  constructor(d: EngineDeps) {
    // The config is the engine's, the executor's and every trigger's: nobody may change it under the caps.
    deepFreeze(d.cfg);

    this.d = d;
    this.now = d.now ?? Date.now;
    mkdirSync(join(d.cfg.stateDir, "requests"), { recursive: true });
    const self = this;
    const mine = (rows: PositionRow[]) => Object.freeze(rows.filter((p) => !!p.dry === self.dry).map((r) => Object.freeze({ ...r })));
    const view: LedgerView = Object.freeze({
      position: (id: number) => {
        const p = d.ledger.position(id);
        return p && !!p.dry === self.dry ? Object.freeze({ ...p }) : undefined;
      },
      positions: (...st: Parameters<Ledger["positionsByStatus"]>) => mine(st.length ? d.ledger.positionsByStatus(...st) : d.ledger.allPositions()),
      ordersFor: (id: number) => (view.position(id) ? Object.freeze(d.ledger.ordersFor(id).map((o) => Object.freeze({ ...o }))) : Object.freeze([])),
      entriesForMint: (mint: string) => d.ledger.entriesForMint(mint, self.dry),
      lifetimeBuyLamports: () => d.ledger.lifetimeBuyLamports(self.dry),
      openCount: () => self.openCount(),
    });
    // The trigger gets its own frozen handles: replacing ctx.rpc.call (or the log, or the alerter) cannot reach the
    // engine's and the executor's own objects.
    const rpc: Rpc = Object.freeze({ call: <T>(method: string, params: unknown[]) => d.rpc.call<T>(method, params) });
    const log: Logger = Object.freeze({
      log: (l: Parameters<Logger["log"]>[0], e: string, f?: Record<string, unknown>) => d.log.log(l, e, f),
      info: (e: string, f?: Record<string, unknown>) => d.log.info(e, f),
      warn: (e: string, f?: Record<string, unknown>) => d.log.warn(e, f),
      error: (e: string, f?: Record<string, unknown>) => d.log.error(e, f),
    });
    // Alerts a trigger raises go through the bot's alerter; it cannot replace or silence it.
    const alerter = Object.freeze({ raise: (key: string, message: string, fields?: Record<string, unknown>) => d.alerter.raise(key, message, fields), get sent() { return d.alerter.sent; } }) as unknown as Alerter;
    this.ctx = Object.freeze({
      cfg: d.cfg, ledger: view, rpc, log, alerter,
      get dry() { return self.dry; },
      now: () => self.now(),
      caps: (mint: string) => Object.freeze(self.caps(mint)),
      shouldStop: () => self.shouldStop(),
      readCurve: (mint: string, address?: string) => self.readCurve(mint, address),
      wake: () => self.wake(),
    });
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
    this.signalStop();
    const w = this.wakeWaiter;
    this.wakeWaiter = null;
    w?.();
  }

  paused(): boolean {
    return readControl(join(this.d.cfg.stateDir, "PAUSE_BUYS")) !== null;
  }

  /** STOP file or SIGTERM/SIGINT: checked before every step and between orders. */
  shouldStop = (): boolean => {
    if (!this.stopRequested && readControl(join(this.d.cfg.stateDir, "STOP")) !== null) {
      this.d.log.info("stop_file_seen");
      this.stopRequested = true;
      this.signalStop();
    }
    return this.stopRequested;
  };

  /** Run-loop sleeps waiting now: STOP ends them all. Each removes itself when it ends (nothing accumulates). */
  private sleepers = new Set<() => void>();

  /** STOP or a signal: end every sleep and the entries loop's idle wait. */
  private signalStop(): void {
    for (const r of [...this.sleepers]) r();
    const w = this.wakeWaiter;
    this.wakeWaiter = null;
    w?.();
  }

  /** p, or STOP if it comes first. The STOP wait is dropped as soon as either ends. */
  private untilStopOr<T>(p: Promise<T>): Promise<T | void> {
    if (this.stopRequested) return Promise.resolve();
    let done!: () => void;
    const stop = new Promise<void>((r) => {
      done = () => {
        this.sleepers.delete(done);
        r();
      };
      this.sleepers.add(done);
    });
    return Promise.race([p, stop]).finally(() => done());
  }

  /** Sleep ms (real time), or less if STOP arrives. */
  private sleepUnlessStopped(ms: number): Promise<void> {
    if (this.stopRequested) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.sleepers.add(done);
    });
  }

  /** Each cycle has a time budget; work left over waits for the next cycle. */
  private overBudget(t0: number): boolean {
    return this.now() - t0 > CYCLE_BUDGET_MS;
  }

  /**
   * The money lock: fn runs when no other holder runs. Held by full cycles, exit ticks and each booking (the cap check,
   * the booking transaction and that order's build and submit). Never held by a trigger call (poll, decide).
   */
  private async exclusive<T>(fn: () => Promise<T>, prio: "exits" | "normal" = "normal"): Promise<T> {
    if (this.lockBusy) await new Promise<void>((r) => (prio === "exits" ? this.lockExits : this.lockNormal).push(r));
    else this.lockBusy = true;
    try {
      return await fn();
    } finally {
      // Exit ticks first: a waiting exit tick runs next, ahead of bookings and cycle steps queued before it.
      const next = this.lockExits.shift() ?? this.lockNormal.shift();
      if (next) next();
      else this.lockBusy = false;
    }
  }

  /**
   * A trigger's source saw something new: run a fast entry lane soon. Wakes are debounced (WAKE_DEBOUNCE_MS) and
   * coalesced: any number of wakes before the lane starts give one lane.
   */
  wake(): void {
    if (this.stopRequested) return;
    this.wakePending = true;
    this.lastWakeAt = Date.now();
    const w = this.wakeWaiter;
    this.wakeWaiter = null;
    w?.();
  }

  /** Wait up to ms, or until a wake or a stop request. */
  private idle(ms: number): Promise<void> {
    // One idle wait at a time: a new one ends the last (its timer cleared, its promise resolved).
    this.wakeWaiter?.();
    this.wakeWaiter = null;
    if (this.wakePending || this.stopRequested || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeWaiter = null;
        resolve();
      }, ms);
      this.wakeWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * The run loop: three loops that share only the money lock.
   *  - exits: every cfg.exitMs (a stop-aware sleep after each tick), the exit tick under the lock: sells in flight, one
   *    batched market read for the open coins, the exit strategy, new sells. Skipped (no RPC) with no open position.
   *  - full cycle: every loopMs after the last one ended, under the lock: sell requests, settle buys, the orders sweep,
   *    alerts, the surplus check, status.json.
   *  - entries: polls on a wake (debounced) or every loopMs, and decides pending candidates, trigger.concurrency at a
   *    time (default 1), OUTSIDE the lock. A candidate that waits is asked again after loopMs. Each buy verdict takes
   *    the lock to check the caps again, book (one ledger transaction) and build and submit that order.
   * A hung or slow trigger call never holds the lock, so it never delays an exit. Returns once STOP is seen.
   */
  async run(loopMs: number): Promise<void> {
    const exitMs = Math.max(200, Math.min(this.d.cfg.exitMs ?? loopMs, loopMs));
    const k = Math.max(1, Math.min(16, Math.floor(Number(this.d.trigger.concurrency ?? 1)) || 1));
    const exitsLoop = (async () => {
      while (!this.shouldStop()) {
        await this.exclusive(() => this.exitTick(), "exits");
        await this.sleepUnlessStopped(exitMs);
      }
    })();
    const fullLoop = (async () => {
      while (!this.shouldStop()) {
        if (!(await this.runCycle())) break;
        await this.sleepUnlessStopped(loopMs);
      }
    })();
    const entriesLoop = (async () => {
      let nextPoll = 0;
      while (!this.shouldStop()) {
        if (this.wakePending || this.now() >= nextPoll) {
          if (this.wakePending) {
            // Debounce: wait for WAKE_DEBOUNCE_MS without a new wake (at most WAKE_DEBOUNCE_MAX_MS): a burst gives one poll.
            const first = Date.now();
            while (Date.now() - this.lastWakeAt < WAKE_DEBOUNCE_MS && Date.now() - first < WAKE_DEBOUNCE_MAX_MS) await new Promise((r) => setTimeout(r, WAKE_DEBOUNCE_MS));
          }
          this.wakePending = false;
          nextPoll = this.now() + loopMs;
          this.lanes++;
          // A slow poll does not hold up STOP (the poll itself is bounded by the trigger timeout).
          await this.untilStopOr(this.guard("poll", () => this.pollOnce()));
          if (this.shouldStop()) break;
        }
        this.startDecides(k, loopMs);
        // Until a decide ends, a wake, STOP, or the next poll is due, or a re-ask when a decide slot is free. Never a
        // spin: at least a few ms between rounds.
        const askAt = this.inflight.size < k ? this.nextAskDue() : Number.POSITIVE_INFINITY;
        const dueIn = Math.max(5, Math.min(nextPoll, askAt) - this.now());
        await Promise.race([...this.inflight.values(), this.idle(dueIn)]);
      }
    })();
    await Promise.all([exitsLoop, fullLoop, entriesLoop]);
    // Drain the money lock: a booking's build and submit, or a sweep, in flight when STOP came finishes before run()
    // returns (the runtime then closes the ledger). Anything that gets the lock after STOP books nothing.
    await this.exclusive(async () => undefined);
    this.writeStatus();
  }

  /**
   * The run loop's full cycle: sell requests, settle buys, the orders sweep, alerts, the surplus check, status.json.
   * Each step takes the lock on its own and the orders sweep takes it once per order, so an exit tick waits at most for
   * one step or one order attempt, never a whole cycle.
   */
  private async runCycle(): Promise<boolean> {
    const t0 = this.now();
    const budget = () => Math.max(1_000, CYCLE_BUDGET_MS - (this.now() - t0));
    const locked = (name: string, fn: () => Promise<void>) => this.exclusive(() => this.guard(name, fn));
    const steps: Array<[string, () => Promise<void>]> = [
      ["requests", () => locked("requests", () => this.manualRequests())],
      ["settle-buys", async () => {
        for (const id of this.dueOrderIds({ side: "buy", reconcileOnly: true })) {
          if (this.shouldStop()) break;
          await locked("settle-buys", () => this.d.executor.sweep(1, { onlyIds: [id], side: "buy", reconcileOnly: true, budgetMs: budget(), shouldStop: this.shouldStop }));
        }
      }],
      ["orders", async () => {
        for (const id of this.dueOrderIds({})) {
          if (this.shouldStop() || this.overBudget(t0)) break;
          await locked("orders", () => this.d.executor.sweep(1, { onlyIds: [id], budgetMs: budget(), shouldStop: this.shouldStop }));
        }
      }],
      ["nag", () => locked("nag", async () => this.nag())],
      // Surplus: which coins are due and the verdicts under the lock, the balance reads outside it.
      ["surplus", async () => {
        const due = await this.exclusive(async () => this.surplusDue());
        if (!due.length || this.shouldStop()) return;
        const balances = await this.surplusReads(due);
        await locked("surplus", async () => this.surplusJudge(due, balances));
      }],
    ];
    for (const [name, fn] of steps) {
      if (this.shouldStop()) break;
      if (this.overBudget(t0) && !["settle-buys", "nag"].includes(name)) continue;
      await fn();
    }
    await this.exclusive(async () => {
      if (!this.shouldStop()) {
        this.cycles++;
        this.lastCycleMs = this.now() - t0;
      }
      this.writeStatus();
    });
    return !this.shouldStop();
  }

  /**
   * The orders a sweep of 5 would claim now, in its order (sells first, then by next attempt): each is then swept on
   * its own (its claim checks again that it is due), so every order runs at most once per step, as in sweep(5).
   */
  private dueOrderIds(opts: { side?: "buy" | "sell"; reconcileOnly?: boolean }): number[] {
    const now = this.now();
    const side = opts.side === "buy" ? "and o.side = 'buy'" : opts.side === "sell" ? "and o.side = 'sell'" : "";
    const rec = opts.reconcileOnly ? "and (o.signature is not null or o.ever_signed = 1)" : "";
    const rows = this.d.ledger.db
      .prepare(
        `select o.id id from orders o join positions p on p.id = o.position_id
          where ((o.status = 'pending' and o.next_attempt_at <= ?) or (o.status = 'inflight' and o.lease_until <= ?))
            and (? = 0 or p.dry = 1) ${side} ${rec}
          order by (o.side = 'sell') desc, o.next_attempt_at limit 5`,
      )
      .all(now, now, this.dry ? 1 : 0) as Array<{ id: number }>;
    return rows.map((r) => Number(r.id));
  }

  /** The exit tick (under the lock): sells in flight, market reads, exits, new sells. No RPC without open positions. */
  private async exitTick(): Promise<void> {
    if (this.shouldStop() || !this.mine("open", "exit_stuck").length) return;
    const t0 = this.now();
    const sweep = () => this.d.executor.sweep(5, { side: "sell", budgetMs: Math.max(1_000, CYCLE_BUDGET_MS - (this.now() - t0)), shouldStop: this.shouldStop });
    await this.guard("sells", sweep);
    if (this.shouldStop()) return;
    await this.guard("exits", () => this.exits());
    if (this.shouldStop()) return;
    await this.guard("sells2", sweep);
    this.exitTicks++;
  }

  /** Poll the trigger (outside the lock) and add its candidates to the pending set. */
  private async pollOnce(): Promise<void> {
    const t = this.d.trigger;
    if (this.hung.has("poll")) return;
    const got = await this.bounded("poll", this.now(), () => t.poll(this.ctx));
    for (const raw of Array.isArray(got) ? got : []) {
      this.stats.candidates++;
      const c = this.snapshot(raw);
      if ("bad" in c) {
        this.stats.skips++;
        this.d.log.warn("candidate_refused", { mint: c.mint, reason: c.bad });
        continue;
      }
      this.pending.set(c.mint, { candidate: c, firstSeenMs: this.now(), lastReason: "" });
      this.nextAsk.delete(c.mint);
    }
    this.pruneCurves();
    if (t.afterEntries) this.hook("afterEntries", () => t.afterEntries!(this.ctx));
  }

  /** The earliest time a waiting candidate is due to be asked again (Infinity: none). */
  private nextAskDue(): number {
    let at = Number.POSITIVE_INFINITY;
    for (const mint of this.pending.keys()) {
      if (this.inflight.has(mint) || this.hung.has(`decide:${mint}`)) continue;
      at = Math.min(at, this.nextAsk.get(mint) ?? 0);
    }
    return at;
  }

  /** Start decides for due pending candidates, up to k in flight (each runs outside the lock). */
  private startDecides(k: number, reaskMs: number): void {
    for (const [mint, p] of this.pending) {
      if (this.inflight.size >= k || this.shouldStop()) return;
      if (this.inflight.has(mint) || this.hung.has(`decide:${mint}`)) continue;
      if ((this.nextAsk.get(mint) ?? 0) > this.now()) continue;
      const task = this.decideOne(mint, p, reaskMs).finally(() => this.inflight.delete(mint));
      this.inflight.set(mint, task);
    }
  }

  /**
   * One candidate: the trigger's verdict (outside the lock, under the trigger timeout), the engine's caps and expected
   * fill (outside the lock: reads), then for a buy the lock: STOP, the caps again, onVerdict, the booking transaction
   * (caps checked once more inside it), and that order's build and submit. A verdict that comes back after STOP books
   * nothing and leaves the candidate pending. Never throws.
   */
  private async decideOne(mint: string, p: Pending, reaskMs: number): Promise<void> {
    const t = this.d.trigger;
    try {
      const info = (): PendingInfo => Object.freeze({ firstSeenMs: p.firstSeenMs, lastReason: p.lastReason });
      let v = this.checked(await this.bounded(`decide:${mint}`, this.now(), () => t.decide(p.candidate, this.ctx, info())), p.candidate);
      if (this.pending.get(mint) !== p || this.shouldStop()) return;
      if (v.verdict === "buy") v = this.capCheck(mint, v);
      if (v.verdict === "buy") {
        const expected = await this.expectedOut(mint, v.lamports, v.expectedOutRaw);
        if (this.pending.get(mint) !== p || this.shouldStop()) return;
        v = Object.freeze({ ...v, expectedOutRaw: expected });
      }
      if (v.verdict === "wait") {
        if (t.onVerdict) this.hook("onVerdict", () => t.onVerdict!(p.candidate, publicVerdict(v), this.ctx, info()));
        else if (v.reason !== p.lastReason) this.d.log.info("candidate_wait", { mint, source: p.candidate.source, reason: v.reason });
        p.lastReason = v.reason;
        this.nextAsk.set(mint, this.now() + reaskMs);
        return;
      }
      if (v.verdict === "skip") {
        this.pending.delete(mint);
        if (t.onVerdict) this.hook("onVerdict", () => t.onVerdict!(p.candidate, publicVerdict(v), this.ctx, info()));
        else this.d.log.info("candidate_skip", { mint, source: p.candidate.source, reason: v.reason });
        this.stats.skips++;
        return;
      }
      const buyV = v;
      await this.exclusive(async () => {
        // Under the lock: nothing books after STOP; the caps as they stand now (another booking may have run).
        if (this.shouldStop() || this.pending.get(mint) !== p) return;
        const final = this.capCheck(mint, buyV);
        this.pending.delete(mint);
        if (t.onVerdict) this.hook("onVerdict", () => t.onVerdict!(p.candidate, publicVerdict(final), this.ctx, info()));
        else if (final.verdict === "skip") this.d.log.info("candidate_skip", { mint, source: p.candidate.source, reason: final.reason });
        if (final.verdict !== "buy") {
          this.stats.skips++;
          return;
        }
        const order = this.buy(p.candidate, final);
        if (order !== null) await this.d.executor.sweep(1, { onlyIds: [order], side: "buy", budgetMs: CYCLE_BUDGET_MS, shouldStop: this.shouldStop });
      });
    } catch (e) {
      // A throw or a timeout: logged as a failed entries step; the candidate stays pending and is asked again later.
      this.d.log.error("cycle_step_failed", { step: "entries", mint, error: String((e as Error)?.stack ?? e) });
      this.nextAsk.set(mint, this.now() + reaskMs);
    }
  }

  /**
   * One round of the entries loop, for callers that drive the engine themselves: poll, then decide every due candidate
   * (trigger.concurrency at a time) and wait for those decides and their bookings. Returns false when STOP was seen.
   */
  async lane(): Promise<boolean> {
    if (this.shouldStop()) return false;
    this.lanes++;
    await this.guard("poll", () => this.pollOnce());
    const k = Math.max(1, Math.min(16, Math.floor(Number(this.d.trigger.concurrency ?? 1)) || 1));
    const reask = this.d.cfg.loopMs;
    for (;;) {
      this.startDecides(k, reask);
      if (!this.inflight.size) break;
      await Promise.race(this.inflight.values());
      if (this.shouldStop()) break;
    }
    await Promise.all(this.inflight.values());
    return !this.shouldStop();
  }

  /** One full cycle. Returns false when STOP was seen (the caller exits cleanly). */
  /**
   * One full cycle, entries included (for callers that drive the engine themselves; run() keeps entries and exits on
   * their own loops). Its entries step decides for at most LANE_BUDGET_MS, under the lock. Returns false on STOP.
   */
  cycle(): Promise<boolean> {
    return this.exclusive(() => this.fullCycle(true));
  }

  private async fullCycle(all: boolean): Promise<boolean> {
    const t0 = this.now();
    const sweep = (side?: "buy" | "sell", reconcileOnly = false) => this.d.executor.sweep(5, { side, reconcileOnly, budgetMs: Math.max(1_000, CYCLE_BUDGET_MS - (this.now() - t0)), shouldStop: this.shouldStop });
    // Exits first: a stop-loss never waits behind new entries.
    const steps: Array<[string, () => Promise<void>]> = [
      ["requests", () => this.manualRequests()],
      ...(all ? ([["sells", () => sweep("sell")], ["exits", () => this.exits()], ["sells2", () => sweep("sell")]] as Array<[string, () => Promise<void>]>) : []),
      // Buys that may already have executed get their own slot: settling them never waits behind a slow sell side.
      ["settle-buys", () => sweep("buy", true)],
      ...(all ? ([["entries", async () => void (await this.entries(t0))]] as Array<[string, () => Promise<void>]>) : []),
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
    const due = this.surplusDue();
    if (!due.length) return;
    this.surplusJudge(due, await this.surplusReads(due));
  }

  /** The coins due a surplus check now (and their next check time set). */
  private surplusDue(): string[] {
    if (this.dry) return [];
    const held = this.mine("opening", "open", "exit_stuck");
    // Also coins whose position ended within the last hour: a late second execution can outlive the position.
    const recent = this.mine("closed", "failed").filter((p) => p.closed_at !== null && this.now() - p.closed_at < SURPLUS_TAIL_MS);
    const mints = [...new Set([...held, ...recent].map((p) => p.mint))];
    const due: string[] = [];
    for (const mint of mints) {
      if ((this.surplusAt.get(mint) ?? 0) > this.now()) continue;
      const ps = held.filter((p) => p.mint === mint);
      if (ps.some((p) => p.status === "opening" || this.d.ledger.openOrderFor(p.id))) continue;
      this.surplusAt.set(mint, this.now() + SURPLUS_CHECK_MS);
      due.push(mint);
    }
    return due;
  }

  /** The wallet's balance of each coin, SURPLUS_READS at a time (reads only). */
  private async surplusReads(due: string[]): Promise<Map<string, bigint | null>> {
    const balances = new Map<string, bigint | null>();
    for (let i = 0; i < due.length; i += SURPLUS_READS) {
      if (this.shouldStop()) break;
      const part = due.slice(i, i + SURPLUS_READS);
      const got = await Promise.all(part.map((m) => tokenBalance(this.d.rpc, this.d.cfg.wallet, m)));
      part.forEach((m, j) => balances.set(m, got[j]));
    }
    return balances;
  }

  /** Judge each coin against what the ledger holds now; a coin with an order in flight now waits for its next check. */
  private surplusJudge(due: string[], balances: Map<string, bigint | null>): void {
    const held = this.mine("opening", "open", "exit_stuck");
    for (const mint of due) {
      if (this.shouldStop()) return;
      const ps = held.filter((p) => p.mint === mint);
      if (ps.some((p) => p.status === "opening" || this.d.ledger.openOrderFor(p.id))) continue;
      const bal = balances.get(mint) ?? null;
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
   * The engine's own caps on a buy, whatever the trigger decided: a trigger cannot buy past them. Same reasons and
   * order as the launch bot's filters always had. Reads only the engine's copies.
   */
  private capCheck(mint: string, v: Buy): Decided {
    const ticket = v.lamports;
    if (!(ticket > 0n && ticket <= lamportsOf(this.d.cfg.buy.sol))) return skip(`ticket ${String(ticket)} lamports outside (0, buy.sol]`);
    const caps = this.caps(mint);
    if (caps.paused) return skip("PAUSE_BUYS");
    if (caps.entriesForMint >= this.d.cfg.buy.maxPerCoin) return skip(`maxPerCoin ${this.d.cfg.buy.maxPerCoin}`);
    if (caps.open >= this.d.cfg.buy.maxOpen) return skip(`maxOpen ${this.d.cfg.buy.maxOpen}`);
    if (caps.lifetimeLamports + ticket > lamportsOf(this.d.cfg.buy.lifetimeSol)) return skip(`lifetimeSol ${this.d.cfg.buy.lifetimeSol}`);
    return v;
  }

  /**
   * A verdict as the engine will act on it: each field read once into a frozen copy of primitives. Only an exact
   * "wait", "skip" or "buy" with well-typed fields counts; anything else (a typo, a plug-in's own word, a bad field, a
   * getter that throws) is a skip, never a buy.
   */
  private checked(v: unknown, c: Readonly<Candidate>): Decided {
    try {
      if (!v || typeof v !== "object") return skip("trigger gave no verdict");
      const x = v as Record<string, unknown>;
      const verdict = x.verdict;
      const reason = x.reason;
      if (verdict === "wait" || verdict === "skip") return Object.freeze({ verdict, reason: typeof reason === "string" ? reason : "" }) as Decided;
      if (verdict !== "buy") return skip(`unknown verdict ${JSON.stringify(String(verdict)).slice(0, 40)}`);
      const lamports = x.lamports;
      const deadline = x.deadlineAtMs;
      const expected = x.expectedOutRaw;
      const decimals = x.decimals;
      const context = x.context;
      const log = x.log;
      if (typeof reason !== "string" || !reason) return skip("buy verdict: bad reason");
      if (lamports !== undefined && typeof lamports !== "bigint") return skip("buy verdict: bad lamports");
      if (deadline !== undefined && deadline !== null && !(typeof deadline === "number" && Number.isFinite(deadline))) return skip("buy verdict: bad deadlineAtMs");
      if (expected !== undefined && expected !== null && !(typeof expected === "bigint" && expected >= 0n)) return skip("buy verdict: bad expectedOutRaw");
      if (decimals !== undefined && !(typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18)) return skip("buy verdict: bad decimals");
      if (log !== undefined && typeof log !== "function" && (typeof log !== "object" || log === null)) return skip("buy verdict: bad log");
      let entryJson: string;
      try {
        entryJson = JSON.stringify(context !== undefined ? context : c.meta ?? null) ?? "null";
      } catch {
        return skip("buy verdict: context is not JSON");
      }
      return Object.freeze({
        verdict: "buy" as const, reason, lamports: lamports ?? lamportsOf(this.d.cfg.buy.sol), deadlineAtMs: (deadline as number | null | undefined) ?? null,
        expectedOutRaw: (expected as bigint | null | undefined) ?? null, decimals: (decimals as number | undefined) ?? DEFAULT_DECIMALS, entryJson,
        log: typeof log === "function" ? (log as (n: number) => Record<string, unknown>) : log ? Object.freeze({ ...(log as Record<string, unknown>) }) : undefined,
      });
    } catch (e) {
      return skip(`trigger verdict unreadable: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
    }
  }

  /** The engine's copy of a candidate, or why it is refused (mint a Solana address as given, chain "solana"). */
  private snapshot(c: unknown): Readonly<Candidate> | { bad: string; mint: string } {
    try {
      const x = c as Record<string, unknown>;
      const mint = x?.mint;
      const chain = x?.chain;
      const source = x?.source;
      const seenAtMs = x?.seenAtMs;
      const reason = x?.reason;
      const meta = x?.meta;
      if (typeof mint !== "string" || asAddress(mint) !== mint) return { bad: "mint is not a Solana address", mint: String(mint).slice(0, 60) };
      if (chain !== "solana") return { bad: `chain ${String(chain).slice(0, 20)}`, mint };
      return Object.freeze({ mint, chain, source: typeof source === "string" ? source : "unknown", seenAtMs: typeof seenAtMs === "number" ? seenAtMs : this.now(), ...(typeof reason === "string" ? { reason } : {}), meta });
    } catch {
      return { bad: "candidate unreadable", mint: "?" };
    }
  }

  /**
   * One trigger call, raced against the trigger timeout (within the cycle budget left). A call that does not answer
   * throws here, so the entries step ends as for a throwing trigger; until it ends, `key` is not called again.
   */
  private async bounded<T>(key: string, t0: number, call: () => T | Promise<T>): Promise<T> {
    const left = CYCLE_BUDGET_MS - (this.now() - t0);
    // Within the cycle budget left, but never under 5 s (or the configured limit, if smaller): a slow but working
    // decide near the end of a cycle is not cut short.
    const limit = this.d.triggerTimeoutMs ?? TRIGGER_TIMEOUT_MS;
    const ms = Math.max(Math.min(limit, 5_000), Math.min(limit, left));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const p = Promise.resolve().then(call);
    try {
      return await Promise.race([p, new Promise<never>((_r, rej) => (timer = setTimeout(() => rej(new Error(`trigger ${key} gave no answer in ${ms} ms`)), ms)))]);
    } catch (e) {
      if (/gave no answer/.test(String((e as Error)?.message))) {
        this.hung.add(key);
        p.then(() => this.hung.delete(key), () => this.hung.delete(key));
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The engine's own read of a Candle curve account (default the mint's curve PDA): once per entries step and account,
   * shared by the trigger (ctx.readCurve) and the expected-fill bound. Frozen.
   */
  private readCurve(mint: string, address?: string, opts: { maxAgeMs?: number; fresh?: (r: CurveRead) => boolean } = {}): Promise<CurveRead> {
    const key = typeof address === "string" && address ? address : curveOf(mint);
    // A read is reused while at most exitMs old (and, for the bound, only if it did not fail).
    const hit = this.curveCache.get(key);
    const maxAge = opts.maxAgeMs ?? this.d.cfg.exitMs;
    let p = hit && this.now() - hit.at <= maxAge ? hit.read : undefined;
    if (!p) {
      p = (async (): Promise<CurveRead> => {
        let v: any;
        try {
          v = (await this.d.rpc.call<any>("getAccountInfo", [key, { encoding: "base64", commitment: "confirmed" }]))?.value;
        } catch (e) {
          return Object.freeze({ status: "failed" as const, error: String((e as Error)?.message ?? e) });
        }
        if (!v) return Object.freeze({ status: "missing" as const });
        try {
          return Object.freeze({ status: "ok" as const, address: key, curve: deepFreeze(decodeCandleCurve(v)) });
        } catch (e) {
          return Object.freeze({ status: "invalid" as const, error: String((e as Error)?.message ?? e) });
        }
      })();
      this.curveCache.set(key, { at: this.now(), read: p });
    }
    return p;
  }

  /** Returns true when it stopped on its time budget with candidates still pending. */
  /** The entries step of cycle() (under the lock). Returns true when it stopped on its budget with candidates left. */
  private async entries(t0: number = this.now()): Promise<boolean> {
    const t = this.d.trigger;
    this.pruneCurves();
    if (!this.hung.has("poll")) {
      const got = await this.bounded("poll", t0, () => t.poll(this.ctx));
      for (const raw of Array.isArray(got) ? got : []) {
        this.stats.candidates++;
        const c = this.snapshot(raw);
        if ("bad" in c) {
          this.stats.skips++;
          this.d.log.warn("candidate_refused", { mint: c.mint, reason: c.bad });
          continue;
        }
        this.pending.set(c.mint, { candidate: c, firstSeenMs: this.now(), lastReason: "" });
      }
    }
    let more = false;
    // Every entries step, in a lane or a full cycle, decides for at most LANE_BUDGET_MS; the rest goes on in lanes, so
    // the next exit pass never waits behind a long backlog.
    const tEntries = this.now();
    // Round robin across steps: a step that stopped on its budget resumes at the first candidate it did not reach, so
    // slow candidates at the head cannot starve the rest. A step that reaches the end starts the next one at the head
    // (the 0.1.0 order whenever everything fits in one step).
    let order = [...this.pending];
    const from = this.resumeAt === null ? -1 : order.findIndex(([m]) => m === this.resumeAt);
    if (from > 0) order = [...order.slice(from), ...order.slice(0, from)];
    this.resumeAt = null;
    for (const [mint, p] of order) {
      if (this.shouldStop()) {
        this.resumeAt = mint;
        break;
      }
      if (!this.pending.has(mint)) continue;
      if (this.overBudget(t0) || this.now() - tEntries > LANE_BUDGET_MS) {
        more = true;
        this.resumeAt = mint;
        break;
      }
      if (this.hung.has(`decide:${mint}`)) continue;
      const info = (): PendingInfo => Object.freeze({ firstSeenMs: p.firstSeenMs, lastReason: p.lastReason });
      let v = this.checked(await this.bounded(`decide:${mint}`, t0, () => t.decide(p.candidate, this.ctx, info())), p.candidate);
      if (v.verdict === "buy") v = this.capCheck(mint, v);
      if (v.verdict === "buy") {
        // The engine's own expected fill (a curve read), then the caps once more: PAUSE_BUYS or STOP may have arrived
        // during the read. STOP leaves the candidate pending, untouched.
        const expected = await this.expectedOut(mint, v.lamports, v.expectedOutRaw);
        if (this.shouldStop()) {
          this.resumeAt = mint;
          break;
        }
        v = this.capCheck(mint, Object.freeze({ ...v, expectedOutRaw: expected }));
      }
      if (v.verdict === "wait") {
        if (t.onVerdict) this.hook("onVerdict", () => t.onVerdict!(p.candidate, publicVerdict(v), this.ctx, info()));
        else if (v.reason !== p.lastReason) this.d.log.info("candidate_wait", { mint, source: p.candidate.source, reason: v.reason });
        p.lastReason = v.reason;
        continue;
      }
      this.pending.delete(mint);
      if (t.onVerdict) this.hook("onVerdict", () => t.onVerdict!(p.candidate, publicVerdict(v), this.ctx, info()));
      else if (v.verdict === "skip") this.d.log.info("candidate_skip", { mint, source: p.candidate.source, reason: v.reason });
      if (v.verdict === "skip") {
        this.stats.skips++;
        continue;
      }
      this.buy(p.candidate, v);
    }
    if (t.afterEntries) this.hook("afterEntries", () => t.afterEntries!(this.ctx));
    return more;
  }

  /**
   * A trigger hook the engine does not wait for (onVerdict, afterEntries). A synchronous throw propagates as before
   * (it ends the entries step). An async hook that rejects is logged and alerted, never left unhandled (Node would
   * end the process on it).
   */
  private hook(name: string, fn: () => unknown): void {
    const r = fn() as { then?: unknown } | undefined;
    if (r && typeof r.then === "function") {
      Promise.resolve(r).catch((e) => {
        const why = String((e as Error)?.message ?? e).slice(0, 200);
        this.d.log.error("trigger_hook_failed", { hook: name, error: why });
        this.d.alerter.raise(`trigger:${name}:rejected`, `trigger ${this.d.trigger.name}: ${name} failed (${why})`);
      });
    }
  }

  /**
   * The tokens to expect for a ticket, for the adoption cap: the engine's own read of the Candle curve, and the smaller
   * of that and the trigger's. With no readable curve, none (an uncertain buy then adopts nothing; it alerts).
   */
  private async expectedOut(mint: string, lamports: bigint, fromTrigger: bigint | null): Promise<bigint | null> {
    // The engine's own read of the mint's curve PDA (shared with the trigger's ctx.readCurve in this step, never one
    // the trigger supplied).
    // The engine's read for this booking: a cached read is reused only if it is at most exitMs old (a slow decide can
    // hold one for seconds) and did not fail; otherwise read again, as 0.1.0 did.
    let mine: bigint | null = null;
    let r = await this.readCurve(mint, undefined, { maxAgeMs: this.d.cfg.exitMs });
    if (r.status === "failed") {
      this.curveCache.delete(curveOf(mint));
      r = await this.readCurve(mint);
    }
    if (r.status === "ok" && r.curve.baseMint === mint && !r.curve.migrated) {
      try {
        mine = buyImpact(r.curve, lamports).expectedOutRaw;
      } catch {
        mine = null;
      }
    }
    // No curve read: keep the trigger's value rather than none. With none, an uncertain buy whose transaction is not
    // found could adopt nothing and `sell` could not reach its tokens (0.1.3 always had a cap). The adoption still
    // counts only tokens received for SOL since the order, inside its attempt windows. Logged.
    if (mine === null) {
      if (fromTrigger !== null) this.d.log.warn("expected_fill_unverified", { mint, expectedOutRaw: fromTrigger, why: "curve not readable at the buy" });
      return fromTrigger;
    }
    return fromTrigger !== null && fromTrigger < mine ? fromTrigger : mine;
  }

  /**
   * Book the buy: a position in `opening` and its order, from the engine's checked copy only (expectedOutRaw final).
   * The caps are checked again inside the same ledger transaction that books it. Returns the order id, or null when
   * the caps refused it there.
   */
  private buy(c: Readonly<Candidate>, v: Buy): number | null {
    const expected = v.expectedOutRaw;
    const now = this.now();
    const dry = this.d.cfg.mode === "dry";
    const t = this.d.trigger;
    let orderId: number | null = null;
    const id = this.d.ledger.tx(() => {
      const again = this.capCheck(c.mint, v);
      if (again.verdict !== "buy") {
        this.d.log.warn("buy_refused_at_booking", { mint: c.mint, reason: again.reason });
        return null;
      }
      const pid = this.d.ledger.createPosition({ mint: c.mint, chain: c.chain, dry, now, decimals: v.decimals, strategy: this.d.strategy.name, entryJson: v.entryJson });
      // The buy is only good while the trigger's decision is: no attempt is built past its deadline.
      orderId = this.d.ledger.createOrder({ positionId: pid, side: "buy", clientTradeId: `${t.buyIdPrefix ?? "bot"}-${randomUUID()}`, amountRaw: v.lamports, slippageBps: this.d.cfg.buy.maxSlippageBps, maxAttempts: this.d.cfg.retry.maxAttempts, now, reason: v.reason, deadlineAt: v.deadlineAtMs, expectedOutRaw: expected });
      return pid;
    });
    if (id === null) {
      this.stats.skips++;
      return null;
    }
    this.stats.buys++;
    // The trigger's fields never overwrite the engine's (key order stays position, mint, then the trigger's). The order
    // is booked: nothing the trigger's log fields do can undo it or end the entries step.
    const fields: Record<string, unknown> = { position: id, mint: c.mint };
    try {
      const extra = typeof v.log === "function" ? v.log(now) ?? {} : v.log ?? { sol: Number(v.lamports) / 1e9 };
      for (const [k, val] of Object.entries(extra)) if (!(k in fields)) fields[k] = val;
    } catch {
      fields.sol = Number(v.lamports) / 1e9;
      fields.logError = true;
    }
    this.d.log.info(dry ? "dry_buy" : "buy_order", fields);
    return orderId;
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
    // Every position's last and peak price in one ledger transaction (one commit, not one per position), and only
    // where they changed. The strategy's view reads the peak from the row and the market, as before.
    this.d.ledger.tx(() => {
      for (const p of open) {
        const m = this.markets.get(p.mint);
        if (!m || m.priceSol === null) continue;
        const peak = Math.max(p.peak_price, m.priceSol);
        if (p.last_price !== m.priceSol || p.peak_price !== peak) this.d.ledger.updatePosition(p.id, { last_price: m.priceSol, peak_price: peak });
      }
    });
    for (const p of open) {
      const m = this.markets.get(p.mint);
      if (!m) continue;
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
        this.strategyErrors.delete(p.id);
      } catch (e) {
        const why = String((e as Error)?.message ?? e);
        this.d.log.error("strategy_error", { position: p.id, error: why });
        // Repeated: this position may never exit by itself. Alerted (renotified while it lasts).
        const n = (this.strategyErrors.get(p.id) ?? 0) + 1;
        this.strategyErrors.set(p.id, n);
        if (n >= STRATEGY_ERROR_ALERT) this.d.alerter.raise(`position:${p.id}:strategy_error`, `position ${p.id} ${p.mint}: the exit strategy ${this.d.strategy.name} failed ${n} times in a row (${why.slice(0, 160)}); this position does not exit until it is fixed, or run \`sell\` by hand`);
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
    const own = this.d.trigger.status?.([...this.pending.values()].map((p) => ({ candidate: p.candidate, firstSeenMs: p.firstSeenMs, lastReason: p.lastReason }))) ?? {};
    // The trigger's fields never shadow the engine's.
    const extra = Object.fromEntries(Object.entries(own).filter(([k]) => !CORE_STATUS_KEYS.has(k)));
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
