/**
 * The spike rule (pure): the last `recentBars` ended bars traded at least `minRatio` times the per-bar volume of the
 * `baselineBars` before them, at least `minVolumeSol` in all, mostly buys (`minBuyShare` of the recent volume), with
 * the price up `minRisePct` to `maxRisePct` % over the recent bars (riding a move with buyers behind it, not one that
 * has already run, and not a dump on volume). Every number is on complete bars only (no gap), unless `allowIncomplete`.
 */
import { volumeVsBaseline } from "candle-bot-core/market/indicators";
import type { RuleHit } from "candle-bot-core/seriesBuy";
import type { SeriesView } from "candle-bot-core/sources/series";

export interface SpikeRule {
  recentBars: number;
  baselineBars: number;
  minRatio: number;
  minVolumeSol: number;
  minBuyShare: number;
  minRisePct: number;
  maxRisePct: number;
  allowIncomplete: boolean;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const sig = (x: number) => Number(x.toPrecision(4));

export function spikeRule(r: SpikeRule): (v: SeriesView) => RuleHit {
  return (v) => {
    const x = volumeVsBaseline(v.bars, r.recentBars, r.baselineBars);
    if (!x || (!x.complete && !r.allowIncomplete)) return null;
    // The whole baseline must have been watched (volumeVsBaseline itself accepts half of it).
    if (x.bars < r.recentBars + r.baselineBars) return null;
    if (x.value < r.minRatio) return null;
    const ended = v.bars.slice(0, -1);
    const recent = ended.slice(-r.recentBars);
    if (recent.length < r.recentBars) return null;
    const sol = recent.reduce((s, b) => s + b.volume, 0);
    if (sol < r.minVolumeSol) return null;
    const buys = recent.reduce((s, b) => s + b.buyVolume, 0);
    const share = sol > 0 ? buys / sol : 0;
    if (share < r.minBuyShare) return null;
    // The price over the recent bars: from the last close before them (a quiet minute just before a burst has none,
    // so look further back, within the baseline) to the last close.
    const before = ended.slice(-(r.recentBars + r.baselineBars), -r.recentBars);
    const from = [...before].reverse().find((b) => b.close !== null)?.close ?? null;
    const to = [...recent].reverse().find((b) => b.close !== null)?.close ?? null;
    if (from === null || to === null || !(from > 0)) return null;
    const rise = (to / from - 1) * 100;
    if (rise < r.minRisePct || rise > r.maxRisePct) return null;
    return {
      reason: `volume ${r2(x.value)}x its baseline (${sig(sol)} SOL in ${r.recentBars} min, ${Math.round(share * 100)} % buys), price up ${r2(rise)} %`,
      numbers: { ratio: r2(x.value), recentSol: sig(sol), buyShare: r2(share), risePct: r2(rise), baselineSolPerMin: sig(x.baselineMean), complete: x.complete },
    };
  };
}
