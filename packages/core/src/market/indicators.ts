/**
 * (0.6.0) Indicators over a coin's bars (sources/series), pure. Each takes the bars and a window in bars, uses only
 * bars that have ENDED (the bar in progress is left out), and returns the value with `complete`: true only when every
 * bar it used was complete (no gap, watched for the whole bar). A caller decides whether an incomplete value may act.
 * A value that cannot be computed (no price in the window, no volume baseline) is null.
 */
import type { Bar } from "../sources/series.ts";

export interface Reading {
  value: number;
  complete: boolean;
  bars: number;
}

/** The last `n` ended bars: a series always ends with the bar in progress, which is dropped. */
export function lastEnded(bars: Bar[], n: number): Bar[] {
  return bars.slice(0, -1).slice(-n);
}

const allComplete = (w: Bar[]) => w.every((b) => b.complete);

/** The fall from the window's high to its last close, in % (0 when the last close is the high). */
export function fallFromHigh(bars: Bar[], windowBars: number): (Reading & { high: number; last: number }) | null {
  const w = lastEnded(bars, windowBars);
  const highs = w.map((b) => b.high).filter((x): x is number => x !== null);
  const last = [...w].reverse().find((b) => b.close !== null)?.close ?? null;
  if (!highs.length || last === null) return null;
  const high = Math.max(...highs);
  return { value: high > 0 ? (1 - last / high) * 100 : 0, high, last, complete: allComplete(w), bars: w.length };
}

/** The rise from the window's low to its last close, in % (0 when the last close is the low). */
export function riseFromLow(bars: Bar[], windowBars: number): (Reading & { low: number; last: number }) | null {
  const w = lastEnded(bars, windowBars);
  const lows = w.map((b) => b.low).filter((x): x is number => x !== null);
  const last = [...w].reverse().find((b) => b.close !== null)?.close ?? null;
  if (!lows.length || last === null) return null;
  const low = Math.min(...lows);
  return { value: low > 0 ? (last / low - 1) * 100 : 0, low, last, complete: allComplete(w), bars: w.length };
}

/**
 * Volume in the last `recentBars` against the `baselineBars` before them: the ratio of the per-bar means, and the
 * z-score of the recent mean against the baseline's per-bar spread. Null when the baseline has no volume or too few bars.
 */
export function volumeVsBaseline(bars: Bar[], recentBars: number, baselineBars: number): (Reading & { recentMean: number; baselineMean: number; z: number | null }) | null {
  const w = lastEnded(bars, recentBars + baselineBars);
  if (w.length < recentBars + Math.max(2, Math.ceil(baselineBars / 2))) return null;
  const recent = w.slice(-recentBars);
  const base = w.slice(0, w.length - recentBars);
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const rm = mean(recent.map((b) => b.volume));
  const bm = mean(base.map((b) => b.volume));
  if (!(bm > 0)) return null;
  const sd = Math.sqrt(mean(base.map((b) => (b.volume - bm) ** 2)));
  return { value: rm / bm, recentMean: rm, baselineMean: bm, z: sd > 0 ? (rm - bm) / sd : null, complete: allComplete(w), bars: w.length };
}

/** Volume-weighted average price over the window (typical price (h+l+c)/3 per bar, weighted by its volume). */
export function vwap(bars: Bar[], windowBars: number): Reading | null {
  const w = lastEnded(bars, windowBars);
  let pv = 0;
  let v = 0;
  for (const b of w) {
    if (b.high === null || b.low === null || b.close === null || !(b.volume > 0)) continue;
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
  }
  if (!(v > 0)) return null;
  return { value: pv / v, complete: allComplete(w), bars: w.length };
}
