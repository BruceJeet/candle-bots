/**
 * The launch bot on the core engine (candle-bot-core): the core runs the loop, the caps, the orders and the exits;
 * this file is the trigger. New launches come from the detector, pass the filters (filters.ts) and, for a launch whose
 * mode Candle's token list did not give, wait for Candle's market record. Every decision is a row in `launches`.
 */
import { Engine as CoreEngine, lamportsOf } from "candle-bot-core/engine";
import type { Candidate, PendingInfo, Trigger, TriggerContext, Verdict } from "candle-bot-core/trigger";
import type { Alerter } from "candle-bot-core/alerts";
import type { Logger } from "candle-bot-core/log";
import type { CandleCurve } from "candle-bot-core/market/curve";
import { candleCurve } from "candle-bot-core/solana/pda";
import type { Rpc } from "candle-bot-core/solana/rpc";
import type { ExitStrategy } from "candle-bot-core/strategies/types";
import type { Config } from "./config.ts";
import type { Detector, Launch } from "./detect/detector.ts";
import type { Executor } from "./exec/executor.ts";
import { evaluate } from "./filters.ts";
import type { Ledger } from "./ledger.ts";

export { readControl, acquireLock, lockHeld, CYCLE_BUDGET_MS, SURPLUS_CHECK_MS, SURPLUS_TAIL_MS, FLOOR_ROOM_MIN } from "candle-bot-core/engine";

export interface MarketInfoSource {
  /**
   * Candle's public market record: launch mode (`tier`), name/symbol and decimals for a chain-first launch, and
   * whether Candle has the market at all (`candleLaunched`, `trade.routable`).
   */
  getMarket(chain: "solana", mint: string): Promise<any>;
}

/** How often a chain-first launch's Candle market is re-read while the bot waits for it (Candle caches ~5 s). */
export const MARKET_CHECK_MS = 2_000;
/** The verdict reason while a launch Candle cannot trade waits, and the skip reason when it ages out. */
export const NO_CANDLE_MARKET = "no Candle market";
/** Candle's market record while filtering a launch: a slow answer must not hold the loop. */
export const MARKET_READ_TIMEOUT_MS = 3_000;

/**
 * Does Candle's market record say Candle has this market and can route a trade on it? Candle answers 200 for every
 * mint, with `candleLaunched: false` for an unknown one or one launched with non-production visibility, so only an
 * explicit `candleLaunched: true` passes; `trade.routable: false` refuses. Anything else (missing fields, an older
 * API) is unknown, and unknown never passes.
 */
export function candleHasMarket(m: any): { ok: true } | { ok: false; why: string } {
  if (!m || typeof m !== "object") return { ok: false, why: "no market record" };
  if (m.candleLaunched !== true) return { ok: false, why: m.candleLaunched === false ? "not a Candle market" : "candleLaunched unknown" };
  if (m.trade && m.trade.routable === false) return { ok: false, why: `not routable${m.trade.reason ? ` (${m.trade.reason})` : ""}` };
  return { ok: true };
}

export interface EngineDeps {
  cfg: Config;
  ledger: Ledger;
  detector: Detector;
  executor: Executor;
  strategy: ExitStrategy;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  markets?: MarketInfoSource | null;
  now?: () => number;
}

/** The trigger's own state per pending launch (the engine keeps the wait reason). */
interface LaunchState {
  marketTried: number;
  /** The launch mode came from Candle's market read (not from Candle's token list). */
  modeFromMarket?: boolean;
  /** Candle's market record said it has this market (see candleHasMarket). */
  marketOk?: boolean;
  /** When the market was last read, and why the last read did not pass. */
  marketCheckedAt?: number;
  marketWhy?: string;
  /** The impact of the buy just decided (for the launch row; the engine hands onVerdict its own copy of the verdict). */
  impactBps?: number;
}

type LaunchVerdict = { verdict: "buy"; impactBps: number; expectedOutRaw: bigint } | { verdict: "skip"; reason: string } | { verdict: "wait"; reason: string };


export class LaunchTrigger implements Trigger {
  readonly name = "launch";
  readonly candidateLabel = "launches";
  readonly buyIdPrefix = "clb";
  readonly sellIdPrefix = "cls";
  /** Launches are decided four at a time in the run loop (each its own coin; market and curve reads are slow). */
  readonly concurrency = 4;
  private d: EngineDeps;
  private now: () => number;
  private state = new Map<string, LaunchState>();

  constructor(d: EngineDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  /** Start the detector; a new launch wakes the engine at once (a fast entry lane) instead of at the next cycle. */
  async start(ctx?: TriggerContext): Promise<void> {
    if (ctx?.wake) this.d.detector.onNew = () => ctx.wake();
    await this.d.detector.start();
  }

  stop(): void {
    this.d.detector.stop();
  }

  poll(): Candidate[] {
    const out: Candidate[] = [];
    for (const l of this.d.detector.drain()) {
      const s = this.d.detector.sightingsFor(l.mint)[l.source];
      this.d.log.info("launch_detected", { mint: l.mint, source: l.source, symbol: l.symbol, mode: l.launchMode, latencyMs: s?.latencyMs ?? null, signature: l.signature });
      this.state.set(l.mint, { marketTried: 0 });
      out.push({ mint: l.mint, chain: l.chain, seenAtMs: l.detectedAtMs, source: l.source, reason: "new launch", meta: l });
    }
    return out;
  }

  /** The detector's current record of the launch (both sources merged), else the one first seen. */
  private launchOf(c: Candidate): Launch {
    return this.d.detector.get(c.mint) ?? (c.meta as Launch);
  }

  private st(mint: string): LaunchState {
    let p = this.state.get(mint);
    if (!p) this.state.set(mint, (p = { marketTried: 0 }));
    return p;
  }

  async decide(c: Candidate, ctx: TriggerContext, pending: PendingInfo): Promise<Verdict> {
    const l = this.launchOf(c);
    const st = this.st(c.mint);
    const v = await this.decideLaunch(l, st, pending.lastReason, ctx);
    if (v.verdict !== "buy") return v;
    st.impactBps = v.impactBps;
    return {
      verdict: "buy",
      reason: `entry, impact ${v.impactBps} bps`,
      lamports: lamportsOf(this.d.cfg.buy.sol),
      // The buy is only good while the filter's decision is: no attempt is built past the coin's max age. (The filters
      // skip a launch with no launch time, so launchedAtMs is set here.)
      deadlineAtMs: l.launchedAtMs === null ? null : l.launchedAtMs + this.d.cfg.filters.maxAgeSec * 1000,
      expectedOutRaw: v.expectedOutRaw,
      decimals: l.decimals,
      context: l,
      log: (now) => ({ symbol: l.symbol, sol: this.d.cfg.buy.sol, impactBps: v.impactBps, ageMs: l.launchedAtMs ? now - l.launchedAtMs : null }),
    };
  }

  onVerdict(c: Candidate, v: Verdict, _ctx: TriggerContext, pending: PendingInfo): void {
    const mint = c.mint;
    if (v.verdict === "wait") {
      if (v.reason !== pending.lastReason) this.d.log.info("launch_wait", { mint, reason: v.reason, ...(v.reason === NO_CANDLE_MARKET ? { market: this.state.get(mint)?.marketWhy ?? null } : {}) });
      return;
    }
    const l = this.launchOf(c);
    const sights = this.d.detector.sightingsFor(mint);
    const impactBps = this.state.get(mint)?.impactBps;
    this.state.delete(mint);
    this.d.ledger.recordLaunch({
      mint, chain: l.chain, first_source: l.source, first_seen_at: l.detectedAtMs, launched_at: l.launchedAtMs,
      api_seen_at: sights.api?.atMs ?? null, chain_seen_at: sights.chain?.atMs ?? null,
      api_latency_ms: sights.api?.latencyMs ?? null, chain_latency_ms: sights.chain?.latencyMs ?? null,
      symbol: l.symbol ?? null, name: l.name ?? null, creator: l.creator ?? l.signer ?? null, launch_mode: l.launchMode ?? null,
      decision: v.verdict, reason: v.verdict === "skip" ? v.reason : `impact ${impactBps} bps`,
    });
    if (v.verdict === "skip") this.d.log.info("launch_skip", { mint, symbol: l.symbol, reason: v.reason });
  }

  /** Keep the latency record current for launches decided before the slower source saw them. */
  afterEntries(): void {
    for (const row of this.d.ledger.recentLaunches(10)) {
      const s = this.d.detector.sightingsFor(row.mint);
      if ((s.api && (row.api_seen_at === null || row.api_latency_ms !== s.api.latencyMs)) || (s.chain && row.chain_seen_at === null)) {
        this.d.ledger.recordLaunch({ ...row, api_seen_at: s.api?.atMs ?? null, chain_seen_at: s.chain?.atMs ?? null, api_latency_ms: s.api?.latencyMs ?? null, chain_latency_ms: s.chain?.latencyMs ?? null, decision: null, reason: null });
      }
    }
  }

  status(pending: Array<{ candidate: Candidate } & PendingInfo>): Record<string, unknown> {
    const det = this.d.detector.stats;
    const recent = this.d.ledger.recentLaunches(10).map((r) => ({ mint: r.mint, symbol: r.symbol, mode: r.launch_mode, firstSource: r.first_source, apiLatencyMs: r.api_latency_ms, chainLatencyMs: r.chain_latency_ms, decision: r.decision, reason: r.reason }));
    return {
      detection: {
        ...det,
        pending: pending.map((p) => {
          const why = this.state.get(p.candidate.mint)?.marketWhy;
          return { mint: p.candidate.mint, waiting: p.lastReason, ...(p.lastReason === NO_CANDLE_MARKET && why ? { market: why } : {}) };
        }),
        recent,
      },
    };
  }

  private async decideLaunch(l: Launch, p: LaunchState, lastReason: string, ctx: TriggerContext): Promise<LaunchVerdict> {
    const v = await this.verdict(l, p, ctx);
    // A launch that waited for its Candle market and aged out is skipped for that reason, not just its age.
    if (v.verdict === "skip" && lastReason === NO_CANDLE_MARKET && /^age /.test(v.reason)) {
      this.d.log.info("launch_no_market", { mint: l.mint, why: p.marketWhy ?? null });
      return { verdict: "skip", reason: NO_CANDLE_MARKET };
    }
    // A launch whose mode Candle's token list did not give (inferred from the curve, or read from Candle's market
    // record) is bought only once Candle's market record says Candle has the market: otherwise every build is refused
    // (MARKET_NOT_FOUND). A launch from Candle's list never waits here and costs no extra call.
    if (v.verdict === "buy" && (!l.launchMode || p.modeFromMarket) && !p.marketOk) {
      if (this.d.markets && (p.marketCheckedAt === undefined || this.now() - p.marketCheckedAt >= MARKET_CHECK_MS)) {
        p.marketCheckedAt = this.now();
        try {
          this.noteMarket(p, await this.readMarket(l.mint));
        } catch (e) {
          p.marketWhy = `market read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
        }
      } else if (!this.d.markets) p.marketWhy = "no market source";
      if (!p.marketOk) return { verdict: "wait", reason: NO_CANDLE_MARKET };
    }
    return v;
  }

  private readMarket(mint: string): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      this.d.markets!.getMarket("solana", mint),
      new Promise<never>((_r, rej) => (timer = setTimeout(() => rej(new Error("market read timeout")), MARKET_READ_TIMEOUT_MS))),
    ]).finally(() => clearTimeout(timer));
  }

  private noteMarket(p: LaunchState, m: any): void {
    const has = candleHasMarket(m);
    if (has.ok) {
      p.marketOk = true;
      p.marketWhy = undefined;
    } else p.marketWhy = has.why;
  }

  private async verdict(l: Launch, p: LaunchState, ctx: TriggerContext): Promise<LaunchVerdict> {
    const caps = ctx.caps(l.mint);
    let v = evaluate(this.d.cfg, l, null, caps, this.now());
    if (v.verdict === "wait" && /mode unknown|name unknown|symbol unknown|creator unknown/.test(v.reason) && this.d.markets && p.marketTried < 10) {
      p.marketTried++;
      try {
        const m = await this.readMarket(l.mint);
        p.marketCheckedAt = this.now();
        this.noteMarket(p, m);
        if (m?.tier && !l.launchMode) {
          l.launchMode = String(m.tier);
          p.modeFromMarket = true;
        }
        if (m?.metadata?.name && l.name === undefined) l.name = String(m.metadata.name);
        if (m?.metadata?.symbol && l.symbol === undefined) l.symbol = String(m.metadata.symbol);
        if (typeof m?.decimals === "number" && l.decimals === undefined) l.decimals = m.decimals;
      } catch {
        /* not indexed yet: the next cycle asks again */
      }
      v = evaluate(this.d.cfg, l, null, caps, this.now());
    }
    if (v.verdict !== "wait" || v.reason !== "curve not readable yet") return v;
    // The engine reads the curve (one read per buy: its expected-fill check reuses it). Same outcomes as 0.1.3's own
    // read: no account or a failed call waits, an account that is not a Candle curve (owner, layout) is unreadable.
    const r = await ctx.readCurve(l.mint, l.curve ?? candleCurve(l.mint));
    const unreadable = (why: string) => (/owner|layout/.test(why) ? ("unreadable" as const) : null);
    const curve: CandleCurve | "unreadable" | null = r.status === "ok" ? r.curve : r.status === "missing" ? null : unreadable(r.error);
    return evaluate(this.d.cfg, l, curve, caps, this.now());
  }
}

/** The launch bot's engine: the core engine with the launch trigger. Same constructor as 0.1.3. */
export class Engine extends CoreEngine {
  constructor(d: EngineDeps) {
    super({ cfg: d.cfg, ledger: d.ledger, trigger: new LaunchTrigger(d), executor: d.executor, strategy: d.strategy, rpc: d.rpc, log: d.log, alerter: d.alerter, now: d.now });
  }
}
