/**
 * The graduation sniper's trigger on the core engine (candle-bot-core): graduations come from the watch (watch.ts),
 * each is checked against the `graduation` filters on a fresh read of its curve and pool, and a buy fills on the DAMM v2
 * pool (Candle routes a graduated coin's trade there; the engine bounds the expected fill with its own pool read).
 * Every decision is a row in `graduations`.
 */
import { Engine as CoreEngine, lamportsOf } from "candle-bot-core/engine";
import type { Candidate, PendingInfo, Trigger, TriggerContext, Verdict } from "candle-bot-core/trigger";
import type { Alerter } from "candle-bot-core/alerts";
import type { Executor } from "candle-bot-core/exec/executor";
import type { Logger } from "candle-bot-core/log";
import { dammBuy } from "candle-bot-core/market/curve";
import { readMarkets, type MarketRead } from "candle-bot-core/market/reader";
import { WSOL } from "candle-bot-core/solana/pda";
import type { Rpc } from "candle-bot-core/solana/rpc";
import type { ExitStrategy } from "candle-bot-core/strategies/types";
import type { Config } from "./config.ts";
import type { Ledger } from "./ledger.ts";
import type { Graduation, GraduationWatch } from "./watch.ts";

/** Candle coins have 6 decimals; used only when neither the launch source nor the mint account says otherwise. */
export const DEFAULT_DECIMALS = 6;

export type GradVerdict = { verdict: "buy"; impactBps: number; expectedOutRaw: bigint; roomAboveFloor: number | null } | { verdict: "skip"; reason: string } | { verdict: "wait"; reason: string };

export interface EntryCapsView {
  open: number;
  entriesForMint: number;
  lifetimeLamports: bigint;
  paused: boolean;
}

/**
 * The filters (pure). A field a filter needs that is not known yet waits; unknown never passes. The market read is the
 * coin's curve and pool as read now (core readMarkets).
 */
export function evaluate(cfg: Config, g: Graduation, m: MarketRead | null, caps: EntryCapsView, nowMs: number): GradVerdict {
  const f = cfg.graduation;
  const l = g.launch;
  if (g.graduatedAtMs === null) return { verdict: "skip", reason: "graduation time unknown" };
  const since = (nowMs - g.graduatedAtMs) / 1000;
  if (since < -5) return { verdict: "wait", reason: "pool not open yet" };
  if (since > f.maxSecondsSinceGraduation) return { verdict: "skip", reason: `graduated ${Math.round(since)}s ago > ${f.maxSecondsSinceGraduation}s` };
  if (f.minLaunchToGraduationSec !== undefined || f.maxLaunchToGraduationSec !== undefined) {
    if (l.launchedAtMs === null) return { verdict: "skip", reason: "launch time unknown" };
    const took = (g.graduatedAtMs - l.launchedAtMs) / 1000;
    if (f.minLaunchToGraduationSec !== undefined && took < f.minLaunchToGraduationSec) return { verdict: "skip", reason: `graduated in ${Math.round(took)}s < ${f.minLaunchToGraduationSec}s` };
    if (f.maxLaunchToGraduationSec !== undefined && took > f.maxLaunchToGraduationSec) return { verdict: "skip", reason: `graduated in ${Math.round(took)}s > ${f.maxLaunchToGraduationSec}s` };
  }
  if (l.creator === cfg.wallet || l.signer === cfg.wallet) return { verdict: "skip", reason: "own wallet's launch" };
  const who = [l.creator, l.signer].filter(Boolean) as string[];
  if (f.creatorDeny?.length) {
    if (who.some((w) => f.creatorDeny!.includes(w))) return { verdict: "skip", reason: "creator denied" };
    if (!l.creator) return { verdict: "skip", reason: "creator unknown (deny list)" };
  }
  if (f.creatorAllow?.length && !who.some((w) => f.creatorAllow!.includes(w))) return { verdict: "skip", reason: l.creator ? "creator not allowed" : "creator unknown (allow list)" };

  if (caps.paused) return { verdict: "skip", reason: "PAUSE_BUYS" };
  if (caps.entriesForMint >= cfg.buy.maxPerCoin) return { verdict: "skip", reason: `maxPerCoin ${cfg.buy.maxPerCoin}` };
  if (caps.open >= cfg.buy.maxOpen) return { verdict: "skip", reason: `maxOpen ${cfg.buy.maxOpen}` };
  const ticket = lamportsOf(cfg.buy.sol);
  if (caps.lifetimeLamports + ticket > lamportsOf(cfg.buy.lifetimeSol)) return { verdict: "skip", reason: `lifetimeSol ${cfg.buy.lifetimeSol}` };

  if (!m) return { verdict: "wait", reason: "market not readable yet" };
  if (m.problem && /missing|migrating/.test(m.problem)) return { verdict: "wait", reason: `market ${m.problem}` };
  if (m.problem) return { verdict: "skip", reason: `market ${m.problem}` };
  // Never on the curve: only a graduated coin with its pool read.
  if (!m.migrated || m.venue !== "damm" || !m.pool) return { verdict: "skip", reason: "not on its pool" };
  const pool = m.pool;
  if ((pool.tokenA === g.mint ? pool.tokenB : pool.tokenA) !== WSOL) return { verdict: "skip", reason: "pool is not SOL-quoted" };
  if (f.minRoomAboveFloor !== undefined) {
    if (m.roomAboveFloor === null) return { verdict: "skip", reason: "pool floor unknown" };
    if (m.roomAboveFloor < f.minRoomAboveFloor) return { verdict: "skip", reason: `room above floor ${m.roomAboveFloor.toFixed(3)} < ${f.minRoomAboveFloor}` };
  }
  let r;
  try {
    r = dammBuy(pool, g.mint, ticket);
  } catch (e) {
    return { verdict: "skip", reason: (e as Error).message };
  }
  if (r.impactBps > f.maxImpactBps) return { verdict: "skip", reason: `impact ${r.impactBps} bps > ${f.maxImpactBps}` };
  return { verdict: "buy", impactBps: r.impactBps, expectedOutRaw: r.expectedOutRaw, roomAboveFloor: m.roomAboveFloor };
}

export interface TriggerDeps {
  cfg: Config;
  ledger: Ledger;
  watch: GraduationWatch;
  rpc: Rpc;
  log: Logger;
  now?: () => number;
}

export class GraduationTrigger implements Trigger {
  readonly name = "graduation";
  readonly candidateLabel = "graduations";
  readonly buyIdPrefix = "cgb";
  readonly sellIdPrefix = "cgs";
  private d: TriggerDeps;
  private now: () => number;
  private grads = new Map<string, Graduation>();
  private impact = new Map<string, number>();
  private decimals = new Map<string, number>();

  constructor(d: TriggerDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  async start(ctx?: TriggerContext): Promise<void> {
    if (ctx?.wake) this.d.watch.onNew = () => ctx.wake();
    await this.d.watch.start();
  }

  stop(): void {
    this.d.watch.stop();
  }

  poll(): Candidate[] {
    const out: Candidate[] = [];
    for (const g of this.d.watch.drain()) {
      this.d.log.info("graduation_detected", { mint: g.mint, symbol: g.launch.symbol, graduatedAtMs: g.graduatedAtMs, graduatedAt: g.graduatedAtSource, lagMs: g.graduatedAtMs === null ? null : g.detectedAtMs - g.graduatedAtMs });
      this.grads.set(g.mint, g);
      out.push({ mint: g.mint, chain: "solana", seenAtMs: g.detectedAtMs, source: "graduation", reason: "graduated", meta: { mint: g.mint, graduatedAtMs: g.graduatedAtMs, graduatedAtSource: g.graduatedAtSource, launchedAtMs: g.launch.launchedAtMs, symbol: g.launch.symbol ?? null, creator: g.launch.creator ?? null, signer: g.launch.signer ?? null, pool: g.pool } });
    }
    return out;
  }

  /** Decimals: the launch source's, else the mint account's (byte 44), else 6. Read once per coin. */
  private async decimalsOf(g: Graduation, ctx: TriggerContext): Promise<number> {
    if (typeof g.launch.decimals === "number") return g.launch.decimals;
    const have = this.decimals.get(g.mint);
    if (have !== undefined) return have;
    let d = DEFAULT_DECIMALS;
    try {
      const v = (await ctx.rpc.call<any>("getAccountInfo", [g.mint, { encoding: "base64", commitment: "confirmed" }]))?.value;
      const b = v?.data?.[0] ? Buffer.from(v.data[0], "base64") : null;
      if (b && b.length >= 45) d = b[44];
    } catch {
      /* the default; decimals only scale prices, quantities are raw */
    }
    this.decimals.set(g.mint, d);
    return d;
  }

  async decide(c: Candidate, ctx: TriggerContext): Promise<Verdict> {
    const g = this.grads.get(c.mint);
    if (!g) return { verdict: "skip", reason: "unknown graduation" };
    const caps = ctx.caps(g.mint);
    // The filters that need no market read first: an old or denied graduation costs no RPC call.
    const pre = evaluate(this.d.cfg, g, null, caps, this.now());
    if (pre.verdict !== "wait") return pre.verdict === "buy" ? { verdict: "skip", reason: "unreachable" } : pre;
    const decimals = await this.decimalsOf(g, ctx);
    let m: MarketRead | null = null;
    try {
      m = (await readMarkets(ctx.rpc, [{ mint: g.mint, decimals }], this.now())).get(g.mint) ?? null;
    } catch {
      m = null;
    }
    const v = evaluate(this.d.cfg, g, m, caps, this.now());
    if (v.verdict !== "buy") return v;
    this.impact.set(g.mint, v.impactBps);
    return {
      verdict: "buy",
      reason: `graduated, impact ${v.impactBps} bps`,
      lamports: lamportsOf(this.d.cfg.buy.sol),
      // No attempt is built once the graduation is older than the filter allows.
      deadlineAtMs: g.graduatedAtMs! + this.d.cfg.graduation.maxSecondsSinceGraduation * 1000,
      expectedOutRaw: v.expectedOutRaw,
      decimals,
      context: { ...(c.meta as object), roomAboveFloor: v.roomAboveFloor, impactBps: v.impactBps },
      log: (now) => ({ symbol: g.launch.symbol, sol: this.d.cfg.buy.sol, impactBps: v.impactBps, sinceGraduationMs: now - g.graduatedAtMs! }),
    };
  }

  onVerdict(c: Candidate, v: Verdict, _ctx: TriggerContext, pending: PendingInfo): void {
    if (v.verdict === "wait") {
      if (v.reason !== pending.lastReason) this.d.log.info("graduation_wait", { mint: c.mint, reason: v.reason });
      return;
    }
    const g = this.grads.get(c.mint);
    this.grads.delete(c.mint);
    const impact = this.impact.get(c.mint);
    this.impact.delete(c.mint);
    if (!g) return;
    this.d.ledger.recordGraduation({
      mint: c.mint, graduated_at: g.graduatedAtMs, graduated_at_source: g.graduatedAtSource, detected_at: g.detectedAtMs, launched_at: g.launch.launchedAtMs,
      symbol: g.launch.symbol ?? null, creator: g.launch.creator ?? g.launch.signer ?? null, decision: v.verdict, reason: v.verdict === "skip" ? v.reason : `impact ${impact} bps`,
    });
    if (v.verdict === "skip") this.d.log.info("graduation_skip", { mint: c.mint, symbol: g.launch.symbol, reason: v.reason });
  }

  status(pending: Array<{ candidate: Candidate } & PendingInfo>): Record<string, unknown> {
    return {
      graduation: {
        watch: { ...this.d.watch.stats, watching: this.d.watch.watching() },
        pending: pending.map((p) => ({ mint: p.candidate.mint, waiting: p.lastReason })),
        recent: this.d.ledger.recentGraduations(10),
      },
    };
  }
}

export interface EngineDeps {
  cfg: Config;
  ledger: Ledger;
  watch: GraduationWatch;
  executor: Executor;
  strategy: ExitStrategy;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  now?: () => number;
}

/** The graduation sniper's engine: the core engine with the graduation trigger. */
export class Engine extends CoreEngine {
  constructor(d: EngineDeps) {
    super({ cfg: d.cfg, ledger: d.ledger, trigger: new GraduationTrigger(d), executor: d.executor, strategy: d.strategy, rpc: d.rpc, log: d.log, alerter: d.alerter, now: d.now });
  }
}
