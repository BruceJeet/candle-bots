/**
 * (0.6.0) A buy trigger on a coin's price and volume series: the shared part of the dip buyer and the spike rider.
 *
 * Each poll: coins this bot holds are pushed onto the watchlist (so a series-aware exit keeps their bars), the
 * watchlist steps (list, pushed, feed), the series is read, and the bot's rule runs on every watched coin. A coin whose
 * rule fires (and that is out of its cooldown, not held, not already pending) becomes a candidate.
 *
 * decide(): the rule again on the series as it is now (it may have stopped firing), then a fresh read of the coin's
 * venue. Only a pump.fun curve or the canonical PumpSwap pool is bought (the series only has volume there). The
 * venue's own buy math must quote the ticket: a mayhem-mode or cashback venue, another quote mint, a buy past the
 * curve's real tokens are skipped HERE, before any attempt (the executor's recheck only runs on retries). The ticket's
 * impact must be within `maxImpactBps`. The verdict's expected fill is the venue's own value for the ticket, never a
 * lower one (the engine keeps the smaller of this and its own read; a low value would loosen the drift check).
 *
 * Pair with EngineDeps `pumpBuys: true`, `series`, `venues: { pump: true }` and ExecutorDeps `pumpBuys: true` (the
 * bots built on this always set them).
 */
import { lamportsOf } from "./engine.ts";
import type { Logger } from "./log.ts";
import { decodeMint } from "./market/mint.ts";
import { buyQuote, readMarkets, type MarketRead } from "./market/reader.ts";
import type { CandleFeed } from "./sources/candleFeed.ts";
import type { SeriesSource, SeriesView } from "./sources/series.ts";
import type { Watchlist } from "./sources/watchlist.ts";
import type { Candidate, PendingInfo, Trigger, TriggerContext, Verdict } from "./trigger.ts";

/** What a rule says about one coin now: null (no signal), or why it fires, with the numbers it read (logged). */
export type RuleHit = { reason: string; numbers: Record<string, number | string | boolean> } | null;

export type SeriesRule = (view: SeriesView, mint: string, feed: CandleFeed | null) => RuleHit;

export interface SeriesBuyOptions {
  /** The ticket's impact on the venue, bps (the fee apart). Also the retry recheck's limit. */
  maxImpactBps: number;
  /** A coin whose rule fired is not a candidate again for this long (min), bought or not. */
  cooldownMin: number;
  /** No attempt of a buy is built more than this many seconds after its decision. */
  buyWithinSec: number;
  /** Held coins stay on the watchlist this long after each poll (ms; default 10 min). */
  holdWatchMs?: number;
}

export interface SeriesBuyDeps {
  ticketSol: number;
  series: SeriesSource & { tick?(force?: boolean): Promise<void>; status?(): Record<string, unknown>; stop?(): void };
  watchlist: Watchlist;
  feed: CandleFeed | null;
  log: Logger;
  now?: () => number;
}

export class SeriesBuyTrigger implements Trigger {
  readonly name: string;
  readonly candidateLabel = "signals";
  readonly buyIdPrefix: string;
  readonly sellIdPrefix: string;
  protected d: SeriesBuyDeps;
  protected o: SeriesBuyOptions;
  private rule: SeriesRule;
  private now: () => number;
  private cooled = new Map<string, number>();
  private hits = new Map<string, RuleHit>();
  private decimals = new Map<string, number>();
  stats = { fired: 0, bought: 0, skipped: 0 };
  last: Array<{ mint: string; at: number; decision: string; reason: string }> = [];

  constructor(name: string, prefixes: { buy: string; sell: string }, d: SeriesBuyDeps, rule: SeriesRule, o: SeriesBuyOptions) {
    this.name = name;
    this.buyIdPrefix = prefixes.buy;
    this.sellIdPrefix = prefixes.sell;
    this.d = d;
    this.rule = rule;
    this.o = o;
    this.now = d.now ?? Date.now;
  }

  stop(): void {
    this.d.series.stop?.();
  }

  private held(ctx: TriggerContext): string[] {
    return [...new Set(ctx.ledger.positions("opening", "open", "exit_stuck").map((p) => p.mint))];
  }

  async poll(ctx: TriggerContext): Promise<Candidate[]> {
    const held = this.held(ctx);
    for (const m of held) this.d.watchlist.push(m, this.o.holdWatchMs ?? 600_000);
    await this.d.watchlist.step();
    if (ctx.shouldStop()) return [];
    await this.d.series.tick?.();
    const now = this.now();
    const out: Candidate[] = [];
    for (const mint of this.d.watchlist.watched()) {
      if (held.includes(mint)) continue;
      if ((this.cooled.get(mint) ?? 0) > now) continue;
      const v = this.d.series.series(mint);
      if (!v) continue;
      const hit = this.rule(v, mint, this.d.feed);
      if (!hit) continue;
      this.cooled.set(mint, now + this.o.cooldownMin * 60_000);
      this.hits.set(mint, hit);
      this.stats.fired++;
      this.d.log.info("signal", { trigger: this.name, mint, reason: hit.reason, ...hit.numbers });
      out.push({ mint, chain: "solana", seenAtMs: now, source: "series", reason: hit.reason, meta: { rule: this.name, ...hit.numbers } });
    }
    for (const [m, until] of this.cooled) if (until <= now) this.cooled.delete(m);
    return out;
  }

  /** Decimals from the mint account (byte 44 via decodeMint), read once per coin; 6 when unreadable. */
  private async decimalsOf(mint: string, ctx: TriggerContext): Promise<number> {
    const have = this.decimals.get(mint);
    if (have !== undefined) return have;
    let d = 6;
    try {
      d = decodeMint((await ctx.rpc.call<any>("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }]))?.value).decimals;
      this.decimals.set(mint, d);
    } catch {
      /* decimals only scale prices; quantities are raw */
    }
    return d;
  }

  async decide(c: Candidate, ctx: TriggerContext): Promise<Verdict> {
    const caps = ctx.caps(c.mint);
    if (caps.paused) return { verdict: "skip", reason: "PAUSE_BUYS" };
    if (caps.entriesForMint >= ctx.cfg.buy.maxPerCoin) return { verdict: "skip", reason: `maxPerCoin ${ctx.cfg.buy.maxPerCoin}` };
    if (caps.open >= ctx.cfg.buy.maxOpen) return { verdict: "skip", reason: `maxOpen ${ctx.cfg.buy.maxOpen}` };
    const ticket = lamportsOf(this.d.ticketSol);
    if (caps.lifetimeLamports + ticket > lamportsOf(ctx.cfg.buy.lifetimeSol)) return { verdict: "skip", reason: `lifetimeSol ${ctx.cfg.buy.lifetimeSol}` };
    // The signal must still hold on the series as it is now.
    const v = this.d.series.series(c.mint);
    const hit = v ? this.rule(v, c.mint, this.d.feed) : null;
    if (!hit) return { verdict: "skip", reason: "signal gone" };
    const decimals = await this.decimalsOf(c.mint, ctx);
    let m: MarketRead | null = null;
    try {
      m = (await readMarkets(ctx.rpc, [{ mint: c.mint, decimals }], this.now(), { pump: true })).get(c.mint) ?? null;
    } catch {
      m = null;
    }
    if (!m) return { verdict: "skip", reason: "venue not readable" };
    if (m.venue !== "pump-curve" && m.venue !== "pumpswap") return { verdict: "skip", reason: `not a pump.fun venue (${m.problem ?? m.venue})` };
    const q = buyQuote(m, ticket);
    if ("why" in q) return { verdict: "skip", reason: `venue refused: ${q.why}` };
    if (q.impactBps > this.o.maxImpactBps) return { verdict: "skip", reason: `impact ${q.impactBps} bps > ${this.o.maxImpactBps}` };
    return {
      verdict: "buy",
      reason: `${hit.reason}; impact ${q.impactBps} bps on ${q.venue}`,
      lamports: ticket,
      deadlineAtMs: this.now() + this.o.buyWithinSec * 1000,
      expectedOutRaw: q.expectedOutRaw,
      decimals,
      context: { rule: this.name, venue: q.venue, impactBps: q.impactBps, ...hit.numbers },
      log: { venue: q.venue, impactBps: q.impactBps, reason: hit.reason },
    };
  }

  onVerdict(c: Candidate, v: Verdict, _ctx: TriggerContext, _p: PendingInfo): void {
    if (v.verdict === "wait") return;
    this.hits.delete(c.mint);
    if (v.verdict === "buy") this.stats.bought++;
    else {
      this.stats.skipped++;
      this.d.log.info("signal_skip", { trigger: this.name, mint: c.mint, reason: v.reason });
    }
    this.last.push({ mint: c.mint, at: this.now(), decision: v.verdict, reason: v.reason });
    if (this.last.length > 20) this.last.shift();
  }

  status(): Record<string, unknown> {
    return { [this.name]: { ...this.stats, cooling: this.cooled.size, watchlist: this.d.watchlist.status(), series: this.d.series.status?.() ?? null, feed: this.d.feed?.status() ?? null, recent: this.last } };
  }
}
