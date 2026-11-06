/**
 * The event bot's trigger: each listed coin is a candidate while its buy window is open (from `entry.fromHours` before
 * its event to `entry.untilMin` before it) and the bot has not bought it (the engine's maxPerCoin). decide() reads the
 * coin's venue fresh: the Candle curve, its DAMM v2 pool, the pump.fun curve or the canonical PumpSwap pool, quoted by
 * that venue's own math (buyQuote). A venue the math refuses (mayhem-mode, cashback, another quote mint, a buy past
 * the curve's tokens, a venue it does not know) is skipped before any attempt; so is an impact over `maxImpactBps`.
 * The verdict's expected fill is the venue's quote, with a deadline: `buyWithinSec`, never past the window.
 */
import { lamportsOf } from "candle-bot-core/engine";
import type { Logger } from "candle-bot-core/log";
import { decodeMint } from "candle-bot-core/market/mint";
import { buyQuote, readMarkets, type MarketRead } from "candle-bot-core/market/reader";
import type { Candidate, PendingInfo, Trigger, TriggerContext, Verdict } from "candle-bot-core/trigger";
import type { Config, EventItem } from "./config.ts";

export interface TriggerDeps {
  cfg: Config;
  log: Logger;
  now?: () => number;
}

/** The buy window of an event: [opens, closes) in ms. */
export function windowOf(cfg: Config, e: EventItem): { opens: number; closes: number } {
  return { opens: e.atMs - cfg.entry.fromHours * 3_600_000, closes: e.atMs - cfg.entry.untilMin * 60_000 };
}

export class EventTrigger implements Trigger {
  readonly name = "event";
  readonly candidateLabel = "events";
  readonly buyIdPrefix = "ceb";
  readonly sellIdPrefix = "ces";
  private d: TriggerDeps;
  private now: () => number;
  private nextLook = new Map<string, number>();
  private decimals = new Map<string, number>();
  last: Array<{ mint: string; label: string; at: number; decision: string; reason: string }> = [];

  constructor(d: TriggerDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  poll(ctx: TriggerContext): Candidate[] {
    const now = this.now();
    const out: Candidate[] = [];
    for (const e of this.d.cfg.events) {
      const w = windowOf(this.d.cfg, e);
      if (now < w.opens || now >= w.closes) continue;
      if ((this.nextLook.get(e.mint) ?? 0) > now) continue;
      if (ctx.caps(e.mint).entriesForMint >= this.d.cfg.buy.maxPerCoin) continue;
      this.nextLook.set(e.mint, now + this.d.cfg.entry.retryMin * 60_000);
      out.push({ mint: e.mint, chain: "solana", seenAtMs: now, source: "event", reason: `${e.label || e.mint} in ${Math.round((e.atMs - now) / 60_000)} min`, meta: { label: e.label, eventAt: new Date(e.atMs).toISOString() } });
    }
    return out;
  }

  private async decimalsOf(mint: string, ctx: TriggerContext): Promise<number> {
    const have = this.decimals.get(mint);
    if (have !== undefined) return have;
    let d = 6;
    try {
      d = decodeMint((await ctx.rpc.call<any>("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }]))?.value).decimals;
      this.decimals.set(mint, d);
    } catch {
      /* decimals only scale prices */
    }
    return d;
  }

  async decide(c: Candidate, ctx: TriggerContext): Promise<Verdict> {
    const e = this.d.cfg.events.find((x) => x.mint === c.mint);
    if (!e) return { verdict: "skip", reason: "not an event coin" };
    const now = this.now();
    const w = windowOf(this.d.cfg, e);
    if (now < w.opens || now >= w.closes) return { verdict: "skip", reason: "outside its buy window" };
    const caps = ctx.caps(c.mint);
    if (caps.paused) return { verdict: "skip", reason: "PAUSE_BUYS" };
    if (caps.entriesForMint >= ctx.cfg.buy.maxPerCoin) return { verdict: "skip", reason: `maxPerCoin ${ctx.cfg.buy.maxPerCoin}` };
    if (caps.open >= ctx.cfg.buy.maxOpen) return { verdict: "skip", reason: `maxOpen ${ctx.cfg.buy.maxOpen}` };
    const ticket = lamportsOf(ctx.cfg.buy.sol);
    if (caps.lifetimeLamports + ticket > lamportsOf(ctx.cfg.buy.lifetimeSol)) return { verdict: "skip", reason: `lifetimeSol ${ctx.cfg.buy.lifetimeSol}` };
    const decimals = await this.decimalsOf(c.mint, ctx);
    let m: MarketRead | null = null;
    try {
      m = (await readMarkets(ctx.rpc, [{ mint: c.mint, decimals }], now, { pump: true })).get(c.mint) ?? null;
    } catch {
      m = null;
    }
    if (!m) return { verdict: "skip", reason: "venue not readable" };
    const q = buyQuote(m, ticket);
    if ("why" in q) return { verdict: "skip", reason: `venue refused: ${q.why}` };
    if (q.impactBps > this.d.cfg.entry.maxImpactBps) return { verdict: "skip", reason: `impact ${q.impactBps} bps > ${this.d.cfg.entry.maxImpactBps}` };
    return {
      verdict: "buy",
      reason: `${e.label || "event"} at ${new Date(e.atMs).toISOString()}; impact ${q.impactBps} bps on ${q.venue}`,
      lamports: ticket,
      deadlineAtMs: Math.min(now + this.d.cfg.entry.buyWithinSec * 1000, w.closes),
      expectedOutRaw: q.expectedOutRaw,
      decimals,
      context: { label: e.label, eventAt: new Date(e.atMs).toISOString(), venue: q.venue, impactBps: q.impactBps },
      log: { label: e.label, venue: q.venue, impactBps: q.impactBps, eventInMin: Math.round((e.atMs - now) / 60_000) },
    };
  }

  onVerdict(c: Candidate, v: Verdict, _ctx: TriggerContext, _p: PendingInfo): void {
    if (v.verdict === "wait") return;
    const e = this.d.cfg.events.find((x) => x.mint === c.mint);
    if (v.verdict === "skip") this.d.log.info("event_skip", { mint: c.mint, label: e?.label, reason: v.reason });
    this.last.push({ mint: c.mint, label: e?.label ?? "", at: this.now(), decision: v.verdict, reason: v.reason });
    if (this.last.length > 20) this.last.shift();
  }

  status(): Record<string, unknown> {
    const now = this.now();
    return {
      events: this.d.cfg.events.map((e) => {
        const w = windowOf(this.d.cfg, e);
        return { mint: e.mint, label: e.label, at: new Date(e.atMs).toISOString(), window: now < w.opens ? "not open" : now >= w.closes ? "closed" : "open", inMin: Math.round((e.atMs - now) / 60_000) };
      }),
      recent: this.last,
    };
  }
}
