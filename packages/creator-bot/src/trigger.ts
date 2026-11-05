/**
 * The creator follower's trigger on the core engine (candle-bot-core): new Candle launches come from the core's launch
 * source; a launch whose creator (Candle's token list) or signer (the launch transaction's fee payer) is on the list is
 * checked against the global filters, the creator's own caps and, optionally, the creator's dev buy, and bought with
 * the creator's ticket. A launch whose creator is not known yet waits, as in candle-launch-bot. Every decision on a
 * listed creator's launch is a row in `follows`.
 */
import { Engine as CoreEngine, lamportsOf } from "candle-bot-core/engine";
import type { Candidate, PendingInfo, Trigger, TriggerContext, Verdict } from "candle-bot-core/trigger";
import type { Alerter } from "candle-bot-core/alerts";
import type { Executor } from "candle-bot-core/exec/executor";
import type { Logger } from "candle-bot-core/log";
import type { CandleCurve } from "candle-bot-core/market/curve";
import { candleCurve } from "candle-bot-core/solana/pda";
import { tokenBalance, type Rpc } from "candle-bot-core/solana/rpc";
import type { Launch } from "candle-bot-core/sources/candleLaunches";
import type { ExitStrategy } from "candle-bot-core/strategies/types";
import type { Config, Creator } from "./config.ts";
import { ageAndMode, onCurve } from "./filters.ts";
import type { Ledger } from "./ledger.ts";

/** What the trigger needs from a launch source (the core's CandleLaunches; a fake in tests). */
export interface LaunchSource {
  start(): Promise<void>;
  stop(): void;
  drain(): Launch[];
  get(mint: string): Launch | undefined;
  onNew: (() => void) | null;
  readonly stats?: unknown;
}

export interface MarketInfoSource {
  /** Candle's public market record (`tier`, `candleLaunched`, `trade.routable`). */
  getMarket(chain: "solana", mint: string): Promise<any>;
}

export const NO_CANDLE_MARKET = "no Candle market";
export const MARKET_CHECK_MS = 2_000;
export const MARKET_READ_TIMEOUT_MS = 3_000;
export const DEV_BUY_CHECK_MS = 2_000;

/** As candle-launch-bot's: only an explicit `candleLaunched: true` passes; `trade.routable: false` refuses. */
export function candleHasMarket(m: any): { ok: true } | { ok: false; why: string } {
  if (!m || typeof m !== "object") return { ok: false, why: "no market record" };
  if (m.candleLaunched !== true) return { ok: false, why: m.candleLaunched === false ? "not a Candle market" : "candleLaunched unknown" };
  if (m.trade && m.trade.routable === false) return { ok: false, why: `not routable${m.trade.reason ? ` (${m.trade.reason})` : ""}` };
  return { ok: true };
}

export interface TriggerDeps {
  cfg: Config;
  ledger: Ledger;
  source: LaunchSource;
  rpc: Rpc;
  log: Logger;
  markets?: MarketInfoSource | null;
  now?: () => number;
}

interface State {
  marketTried: number;
  modeFromMarket?: boolean;
  marketOk?: boolean;
  marketCheckedAt?: number;
  marketWhy?: string;
  devCheckedAt?: number;
  devBuy?: boolean;
  impactBps?: number;
}

/** The listed creator of a launch: the token list's creator first, then the launch transaction's signer. */
export function followedOf(creators: Creator[], l: Launch): Creator | undefined {
  for (const who of [l.creator, l.signer]) {
    if (!who) continue;
    const c = creators.find((x) => x.address === who);
    if (c) return c;
  }
  return undefined;
}

export class CreatorTrigger implements Trigger {
  readonly name = "creator";
  readonly candidateLabel = "launches";
  readonly buyIdPrefix = "ccb";
  readonly sellIdPrefix = "ccs";
  /** One decision at a time: a creator's caps are read from the ledger, and the booking of one buy lands before the next is decided. */
  readonly concurrency = 1;
  private d: TriggerDeps;
  private now: () => number;
  private state = new Map<string, State>();

  constructor(d: TriggerDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  async start(ctx?: TriggerContext): Promise<void> {
    if (ctx?.wake) this.d.source.onNew = () => ctx.wake();
    await this.d.source.start();
  }

  stop(): void {
    this.d.source.stop();
  }

  poll(): Candidate[] {
    const out: Candidate[] = [];
    for (const l of this.d.source.drain()) {
      this.state.set(l.mint, { marketTried: 0 });
      out.push({ mint: l.mint, chain: l.chain, seenAtMs: l.detectedAtMs, source: l.source, reason: "new launch", meta: l });
    }
    return out;
  }

  private launchOf(c: Candidate): Launch {
    return this.d.source.get(c.mint) ?? (c.meta as Launch);
  }

  private st(mint: string): State {
    let s = this.state.get(mint);
    if (!s) this.state.set(mint, (s = { marketTried: 0 }));
    return s;
  }

  async decide(c: Candidate, ctx: TriggerContext, pending: PendingInfo): Promise<Verdict> {
    const l = this.launchOf(c);
    const s = this.st(c.mint);
    const f = this.d.cfg.follow;
    if (l.creator === this.d.cfg.wallet || l.signer === this.d.cfg.wallet) return { verdict: "skip", reason: "own wallet's launch" };
    const who = followedOf(f.creators, l);
    if (!who) {
      if (!l.creator) {
        // A chain-first launch: Candle's list (which names the creator) may not have it yet. Wait until it ages out.
        if (l.launchedAtMs === null) return { verdict: "skip", reason: "launch time unknown" };
        const ageSec = (this.now() - l.launchedAtMs) / 1000;
        if (ageSec > f.maxAgeSec) return { verdict: "skip", reason: `age ${Math.round(ageSec)}s > ${f.maxAgeSec}s` };
        return { verdict: "wait", reason: "creator unknown" };
      }
      return { verdict: "skip", reason: "creator not followed" };
    }
    const lamports = lamportsOf(who.sol);
    let v = ageAndMode(f, l, null, this.now());
    if (v && v.verdict === "wait" && /mode unknown/.test(v.reason) && this.d.markets && s.marketTried < 10) {
      s.marketTried++;
      try {
        const m = await this.readMarket(l.mint);
        s.marketCheckedAt = this.now();
        this.noteMarket(s, m);
        if (m?.tier && !l.launchMode) {
          l.launchMode = String(m.tier);
          s.modeFromMarket = true;
        }
        if (typeof m?.decimals === "number" && l.decimals === undefined) l.decimals = m.decimals;
      } catch {
        /* not indexed yet */
      }
      v = ageAndMode(f, l, null, this.now());
    }
    let curve: CandleCurve | "unreadable" | null = null;
    if (v === null || (v.verdict === "wait" && v.reason === "curve not readable yet")) {
      const r = await ctx.readCurve(l.mint, l.curve ?? candleCurve(l.mint));
      curve = r.status === "ok" ? r.curve : r.status === "missing" ? null : /owner|layout/.test(r.error) ? "unreadable" : null;
      v = ageAndMode(f, l, curve, this.now());
    }
    if (v) return v;
    // The creator's caps (on top of the core's): from the ledger's own positions for this creator.
    const used = this.d.ledger.creatorUsage(who.address, ctx.dry);
    if (who.maxEntries !== undefined && used.entries >= who.maxEntries) return { verdict: "skip", reason: `creator maxEntries ${who.maxEntries}` };
    if (who.maxSol !== undefined && used.lamports + lamports > lamportsOf(who.maxSol)) return { verdict: "skip", reason: `creator maxSol ${who.maxSol}` };
    const caps = ctx.caps(l.mint);
    if (caps.paused) return { verdict: "skip", reason: "PAUSE_BUYS" };
    if (caps.entriesForMint >= this.d.cfg.buy.maxPerCoin) return { verdict: "skip", reason: `maxPerCoin ${this.d.cfg.buy.maxPerCoin}` };
    if (caps.open >= this.d.cfg.buy.maxOpen) return { verdict: "skip", reason: `maxOpen ${this.d.cfg.buy.maxOpen}` };
    if (caps.lifetimeLamports + lamports > lamportsOf(this.d.cfg.buy.lifetimeSol)) return { verdict: "skip", reason: `lifetimeSol ${this.d.cfg.buy.lifetimeSol}` };
    const cv = onCurve(f, l, curve, lamports);
    if (cv.verdict !== "buy") return cv;
    // The creator's own dev buy: its wallet (or the launch's signer) holds the coin. Read at most every 2 s.
    if (f.requireDevBuy && !s.devBuy) {
      if (s.devCheckedAt === undefined || this.now() - s.devCheckedAt >= DEV_BUY_CHECK_MS) {
        s.devCheckedAt = this.now();
        s.devBuy = await this.devBought(l, who);
      }
      if (!s.devBuy) return { verdict: "wait", reason: "no dev buy yet" };
    }
    // A launch whose mode Candle's list did not give is bought only once Candle's market record has the market.
    if ((!l.launchMode || s.modeFromMarket) && !s.marketOk) {
      if (this.d.markets && (s.marketCheckedAt === undefined || this.now() - s.marketCheckedAt >= MARKET_CHECK_MS)) {
        s.marketCheckedAt = this.now();
        try {
          this.noteMarket(s, await this.readMarket(l.mint));
        } catch (e) {
          s.marketWhy = `market read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
        }
      } else if (!this.d.markets) s.marketWhy = "no market source";
      if (!s.marketOk) return { verdict: "wait", reason: NO_CANDLE_MARKET };
    }
    s.impactBps = cv.impactBps;
    return {
      verdict: "buy",
      reason: `${who.label ?? who.address.slice(0, 8)}: entry, impact ${cv.impactBps} bps`,
      lamports,
      deadlineAtMs: l.launchedAtMs === null ? null : l.launchedAtMs + f.maxAgeSec * 1000,
      expectedOutRaw: cv.expectedOutRaw,
      decimals: l.decimals,
      // `followed` is what the creator's caps count by (Ledger.creatorUsage).
      context: { ...l, followed: who.address, label: who.label ?? null },
      log: (now) => ({ symbol: l.symbol, creator: who.address, label: who.label, sol: who.sol, impactBps: cv.impactBps, ageMs: l.launchedAtMs ? now - l.launchedAtMs : null, lastWait: pending.lastReason }),
    };
  }

  private async devBought(l: Launch, who: Creator): Promise<boolean> {
    for (const owner of new Set([who.address, l.creator, l.signer].filter(Boolean) as string[])) {
      try {
        const b = await tokenBalance(this.d.rpc, owner, l.mint);
        if (b !== null && b > 0n) return true;
      } catch {
        /* unread: not proven */
      }
    }
    return false;
  }

  private readMarket(mint: string): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      this.d.markets!.getMarket("solana", mint),
      new Promise<never>((_r, rej) => (timer = setTimeout(() => rej(new Error("market read timeout")), MARKET_READ_TIMEOUT_MS))),
    ]).finally(() => clearTimeout(timer));
  }

  private noteMarket(s: State, m: any): void {
    const has = candleHasMarket(m);
    if (has.ok) {
      s.marketOk = true;
      s.marketWhy = undefined;
    } else s.marketWhy = has.why;
  }

  onVerdict(c: Candidate, v: Verdict, _ctx: TriggerContext, pending: PendingInfo): void {
    const l = this.launchOf(c);
    const who = followedOf(this.d.cfg.follow.creators, l);
    if (v.verdict === "wait") {
      if (who && v.reason !== pending.lastReason) this.d.log.info("follow_wait", { mint: c.mint, creator: who.address, reason: v.reason });
      return;
    }
    const s = this.state.get(c.mint);
    this.state.delete(c.mint);
    if (!who) return; // launches of creators not on the list leave no row
    this.d.ledger.recordFollow({
      mint: c.mint, creator: who.address, label: who.label ?? null, launched_at: l.launchedAtMs, first_seen_at: l.detectedAtMs,
      symbol: l.symbol ?? null, launch_mode: l.launchMode ?? null, decision: v.verdict, reason: v.verdict === "skip" ? v.reason : `impact ${s?.impactBps} bps`,
    });
    this.d.log.info(v.verdict === "skip" ? "follow_skip" : "follow_buy", { mint: c.mint, creator: who.address, label: who.label, symbol: l.symbol, ...(v.verdict === "skip" ? { reason: v.reason } : {}) });
  }

  status(pending: Array<{ candidate: Candidate } & PendingInfo>): Record<string, unknown> {
    const dry = this.d.cfg.mode !== "live";
    return {
      follow: {
        creators: this.d.cfg.follow.creators.map((c) => {
          const u = this.d.ledger.creatorUsage(c.address, dry);
          return { address: c.address, label: c.label ?? null, sol: c.sol, entries: u.entries, spentSol: Number(u.lamports) / 1e9, maxEntries: c.maxEntries ?? null, maxSol: c.maxSol ?? null };
        }),
        pending: pending.map((p) => ({ mint: p.candidate.mint, waiting: p.lastReason })),
        recent: this.d.ledger.recentFollows(10),
        source: this.d.source.stats ?? null,
      },
    };
  }
}

export interface EngineDeps extends TriggerDeps {
  executor: Executor;
  strategy: ExitStrategy;
  alerter: Alerter;
}

/** The creator follower's engine: the core engine with the creator trigger. */
export class Engine extends CoreEngine {
  constructor(d: EngineDeps) {
    super({ cfg: d.cfg, ledger: d.ledger, trigger: new CreatorTrigger(d), executor: d.executor, strategy: d.strategy, rpc: d.rpc, log: d.log, alerter: d.alerter, now: d.now });
  }
}
