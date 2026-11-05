/**
 * The global filters (launch mode, age, impact of the creator's ticket on the curve), as candle-launch-bot's: a
 * verdict is `buy`, `skip` (final) or `wait` (a field is not known yet). Unknown never passes. A copy of the launch
 * bot's checks for these three filters (this bot installs alone, without the launch bot).
 */
import type { CandleCurve } from "candle-bot-core/market/curve";
import { buyImpact, curveClass } from "candle-bot-core/market/curve";
import { WSOL } from "candle-bot-core/solana/pda";
import type { Launch } from "candle-bot-core/sources/candleLaunches";
import type { Follow } from "./config.ts";

export type FilterVerdict = { verdict: "buy"; impactBps: number; expectedOutRaw: bigint } | { verdict: "skip"; reason: string } | { verdict: "wait"; reason: string };

/** Age and launch mode: what needs no curve read (a chain-first launch's mode may need it: then it waits for one). */
export function ageAndMode(f: Follow, l: Launch, curve: CandleCurve | null | "unreadable", nowMs: number): Exclude<FilterVerdict, { verdict: "buy" }> | null {
  if (l.chain !== "solana") return { verdict: "skip", reason: `chain ${l.chain}` };
  if (l.launchedAtMs === null) return { verdict: "skip", reason: "launch time unknown" };
  const ageSec = (nowMs - l.launchedAtMs) / 1000;
  if (ageSec > f.maxAgeSec) return { verdict: "skip", reason: `age ${Math.round(ageSec)}s > ${f.maxAgeSec}s` };
  if (!l.launchMode) {
    if (!f.inferModeFromCurve) return { verdict: "wait", reason: "launch mode unknown" };
    if (curve === null) return { verdict: "wait", reason: "curve not readable yet" };
    if (curve === "unreadable") return { verdict: "skip", reason: "curve unreadable" };
    // Only a full match of the open preset decides here; every other curve waits for Candle's `tier`.
    if (curveClass(curve) !== "open") return { verdict: "wait", reason: "launch mode unknown" };
    if (!f.launchModes.includes("open")) return { verdict: "skip", reason: "mode open (from the curve preset)" };
  } else if (!f.launchModes.includes(l.launchMode)) return { verdict: "skip", reason: `mode ${l.launchMode}` };
  return null;
}

/** The curve checks and the impact of `lamports` on it. */
export function onCurve(f: Follow, l: Launch, curve: CandleCurve | null | "unreadable", lamports: bigint): FilterVerdict {
  if (curve === null) return { verdict: "wait", reason: "curve not readable yet" };
  if (curve === "unreadable") return { verdict: "skip", reason: "curve unreadable" };
  if (curve.baseMint !== l.mint) return { verdict: "skip", reason: "curve names another mint" };
  if (curve.quoteMint !== WSOL) return { verdict: "skip", reason: "curve is not SOL-quoted" };
  if (curve.migrated) return { verdict: "skip", reason: "already graduated" };
  if (curve.quoteReserve >= curve.migrationThreshold) return { verdict: "skip", reason: "curve full (migrating)" };
  let r;
  try {
    r = buyImpact(curve, lamports);
  } catch (e) {
    return { verdict: "skip", reason: (e as Error).message };
  }
  if (r.impactBps > f.maxImpactBps) return { verdict: "skip", reason: `impact ${r.impactBps} bps > ${f.maxImpactBps}` };
  return { verdict: "buy", impactBps: r.impactBps, expectedOutRaw: r.expectedOutRaw };
}
