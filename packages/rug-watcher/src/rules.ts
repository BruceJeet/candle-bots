/**
 * The four rules as pure functions (no I/O, no clock): each takes what was read and says whether it trips, with the
 * numbers that tripped it. The watcher (watch.ts) keeps the samples, makes the reads and records each firing once.
 */
import type { DevRule, HolderRule, WindowRule } from "./config.ts";

export interface Sample {
  at: number;
  value: number;
}

/** A trip: the numbers are what the alert prints and the event row keeps. */
export interface Trip {
  numbers: Record<string, string | number>;
  text: string;
}

/** Samples kept for a window: drop those older than the window (the newest is always kept). */
export function prune(samples: Sample[], now: number, windowSec: number): Sample[] {
  const from = now - windowSec * 1000;
  const kept = samples.filter((s) => s.at >= from);
  return kept.length ? kept : samples.slice(-1);
}

/**
 * Price crash or liquidity pull: the newest sample against the highest in the window. Trips when the fall is at least
 * dropPct. Fewer than two samples: no verdict.
 */
export function windowDrop(samples: Sample[], now: number, rule: WindowRule, what: string, unit: (v: number) => string): Trip | null {
  const w = prune(samples, now, rule.windowSec);
  if (w.length < 2) return null;
  const cur = w[w.length - 1];
  let hi = w[0];
  for (const s of w) if (s.value > hi.value) hi = s;
  if (!(hi.value > 0) || hi.at >= cur.at) return null;
  const drop = (1 - cur.value / hi.value) * 100;
  if (!(drop >= rule.dropPct)) return null;
  const secs = Math.round((cur.at - hi.at) / 1000);
  return {
    numbers: { from: unit(hi.value), to: unit(cur.value), dropPct: round(drop), overSec: secs, ruleDropPct: rule.dropPct, windowSec: rule.windowSec },
    text: `${what} fell ${round(drop)} % in ${secs} s (${unit(hi.value)} to ${unit(cur.value)}; rule ${rule.dropPct} % in ${rule.windowSec} s)`,
  };
}

/** What the watcher keeps per creator: the highest holding seen since watching began. */
export interface DevState {
  maxRaw: bigint;
}

/**
 * Dev dump: `soldPct` trips when the creator's holding is at least that share under the highest seen; `floorPct` trips
 * when the holding falls under that share of supply after it was seen at or over it. Returns each part that trips.
 */
export function devTrips(rule: DevRule, st: DevState, nowRaw: bigint, supply: bigint, decimals: number): Array<{ part: "sold" | "floor"; trip: Trip }> {
  const out: Array<{ part: "sold" | "floor"; trip: Trip }> = [];
  const tok = (x: bigint) => fmtTokens(x, decimals);
  if (rule.soldPct !== undefined && st.maxRaw > 0n && nowRaw < st.maxRaw) {
    const sold = pct(st.maxRaw - nowRaw, st.maxRaw);
    if (sold >= rule.soldPct) out.push({ part: "sold", trip: { numbers: { maxHeld: tok(st.maxRaw), held: tok(nowRaw), soldPct: round(sold), ruleSoldPct: rule.soldPct }, text: `the creator sold ${round(sold)} % of its holding (${tok(st.maxRaw)} to ${tok(nowRaw)}; rule ${rule.soldPct} %)` } });
  }
  if (rule.floorPct !== undefined && supply > 0n) {
    const held = pct(nowRaw, supply);
    const max = pct(st.maxRaw, supply);
    if (max >= rule.floorPct && held < rule.floorPct) out.push({ part: "floor", trip: { numbers: { maxHeldPctOfSupply: round(max), heldPctOfSupply: round(held), ruleFloorPct: rule.floorPct }, text: `the creator holds ${round(held)} % of supply, under the floor of ${rule.floorPct} % (was ${round(max)} %)` } });
  }
  return out;
}

/** One holder poll: each wallet's raw amount, and which wallets were among the top N then. */
export interface HolderSample {
  at: number;
  amounts: Map<string, bigint>;
  top: string[];
}

/**
 * Large-holder exit: a wallet that was among the top N in any poll of the window and now holds at least
 * soldPctOfSupply % of supply less than its highest in the window. `now` gives each such wallet's amount now (from the
 * newest poll, or a direct read for a wallet that fell out of the largest list; null: unknown, no verdict).
 */
export function holderTrips(rule: HolderRule, window: HolderSample[], nowAmounts: Map<string, bigint | null>, supply: bigint, decimals: number): Array<{ owner: string; trip: Trip }> {
  const out: Array<{ owner: string; trip: Trip }> = [];
  if (!(supply > 0n)) return out;
  for (const [owner, cur] of nowAmounts) {
    if (cur === null) continue;
    let hi = -1n;
    let hiAt = 0;
    for (const s of window) {
      if (!s.top.includes(owner)) continue;
      const a = s.amounts.get(owner);
      if (a !== undefined && a > hi) {
        hi = a;
        hiAt = s.at;
      }
    }
    if (hi <= cur) continue;
    const soldPct = pct(hi - cur, supply);
    if (soldPct < rule.soldPctOfSupply) continue;
    const last = window[window.length - 1]?.at ?? hiAt;
    out.push({
      owner,
      trip: {
        numbers: { owner, from: fmtTokens(hi, decimals), to: fmtTokens(cur, decimals), soldPctOfSupply: round(soldPct), overSec: Math.round((last - hiAt) / 1000), ruleSoldPctOfSupply: rule.soldPctOfSupply, topN: rule.topN, windowSec: rule.windowSec },
        text: `top-${rule.topN} holder ${owner} sold ${round(soldPct)} % of supply (${fmtTokens(hi, decimals)} to ${fmtTokens(cur, decimals)}; rule ${rule.soldPctOfSupply} % in ${rule.windowSec} s)`,
      },
    });
  }
  return out;
}

/** Which wallets the holder rule watches now: those among the top N of any poll in the window, less the excluded. */
export function watchedHolders(window: HolderSample[]): Set<string> {
  const s = new Set<string>();
  for (const w of window) for (const o of w.top) s.add(o);
  return s;
}

/** a / b as a percentage, exact enough for thresholds (bigint ratio in ppm). */
export function pct(a: bigint, b: bigint): number {
  if (b <= 0n) return 0;
  return Number((a * 100_000_000n) / b) / 1_000_000;
}

export function round(x: number): number {
  return Math.round(x * 100) / 100;
}

export function fmtTokens(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "").slice(0, 4);
  return frac ? `${whole}.${frac}` : whole;
}

export const fmtSol = (v: number) => `${v.toPrecision(4)} SOL`;
export const fmtPrice = (v: number) => `${v.toPrecision(4)} SOL/token`;
