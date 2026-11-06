/**
 * The dip rule (pure): a coin down at least `minFallPct` % from the high of its last `windowBars` ended bars, with at
 * least `minWindowVolumeSol` traded in that window (a coin still trading, not abandoned), and, when `bounceBars` is
 * set, up at least `minBouncePct` % from the low of its last `bounceBars` bars (buy the first turn up, not the fall).
 * Every number is on complete bars only (no gap), unless `allowIncomplete`.
 */
import { fallFromHigh, lastEnded, riseFromLow } from "candle-bot-core/market/indicators";
import type { RuleHit } from "candle-bot-core/seriesBuy";
import type { SeriesView } from "candle-bot-core/sources/series";

export interface DipRule {
  windowBars: number;
  minFallPct: number;
  /** Optional ceiling: a fall deeper than this is a collapse, not a dip (default 95). */
  maxFallPct: number;
  minWindowVolumeSol: number;
  bounceBars: number | null;
  minBouncePct: number;
  allowIncomplete: boolean;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const sig = (x: number) => Number(x.toPrecision(4));

export function dipRule(r: DipRule): (v: SeriesView) => RuleHit {
  return (v) => {
    const f = fallFromHigh(v.bars, r.windowBars);
    if (!f || f.bars < r.windowBars) return null;
    if (!f.complete && !r.allowIncomplete) return null;
    if (f.value < r.minFallPct || f.value > r.maxFallPct) return null;
    const vol = lastEnded(v.bars, r.windowBars).reduce((s, b) => s + b.volume, 0);
    if (vol < r.minWindowVolumeSol) return null;
    const numbers: Record<string, number | string | boolean> = { fallPct: r2(f.value), high: sig(f.high), last: sig(f.last), windowVolumeSol: sig(vol), complete: f.complete };
    let why = `down ${r2(f.value)} % from its ${r.windowBars}-min high`;
    if (r.bounceBars !== null) {
      const b = riseFromLow(v.bars, r.bounceBars);
      if (!b || (!b.complete && !r.allowIncomplete) || b.value < r.minBouncePct) return null;
      numbers.bouncePct = r2(b.value);
      why += `, up ${r2(b.value)} % from its ${r.bounceBars}-min low`;
    }
    return { reason: why, numbers };
  };
}
