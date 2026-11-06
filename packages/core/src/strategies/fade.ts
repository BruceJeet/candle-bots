/**
 * (0.6.0) fade: a series-aware exit. Sells the whole remaining position on the first of:
 *  - takeProfit / stopLoss: multiples of the entry price (as tpsl);
 *  - volume fade: the last `fadeRecentBars` bars traded under `fadeBelowRatio` times the `fadeBaselineBars` before them
 *    (the move ran out of buyers);
 *  - drop from high: the last close is `dropFromHighPct` % under the high of the last `dropWindowBars` bars;
 *  - maxHoldMin: minutes since entry.
 *   { "strategy": "fade", "stopLoss": 0.7, "fadeRecentBars": 3, "fadeBaselineBars": 10, "fadeBelowRatio": 0.3,
 *     "dropWindowBars": 15, "dropFromHighPct": 25, "minHoldMin": 3, "maxHoldMin": 240 }
 * The series rules act only on complete bars (no gap) and only after `minHoldMin`; the fade rule's recent bars and the
 * drop rule's window are bars wholly after entry. With no series (the bot did not opt in, or the coin is not watched)
 * or a gap they hold, and the price rules still apply: with a series rule, stopLoss or maxHoldMin is required. Needs
 * EngineDeps.exitSeries and a series that keeps the held coin watched.
 */
import { fallFromHigh, volumeVsBaseline } from "../market/indicators.ts";
import { HOLD, checkParams, multiple, param, StrategyConfigError, type ExitStrategy } from "./types.ts";

const KEYS = ["takeProfit", "stopLoss", "fadeRecentBars", "fadeBaselineBars", "fadeBelowRatio", "dropWindowBars", "dropFromHighPct", "minHoldMin", "maxHoldMin"];

export function create(params: Record<string, unknown>): ExitStrategy {
  checkParams(params, KEYS, "fade");
  const has = (k: string) => params[k] !== undefined;
  const tp = has("takeProfit") ? param(params, "takeProfit", "fade", { exclusiveMin: 1 }) : Infinity;
  const sl = has("stopLoss") ? param(params, "stopLoss", "fade", { min: 0, max: 1 }) : 0;
  const fade = has("fadeBelowRatio") || has("fadeRecentBars") || has("fadeBaselineBars");
  const fr = fade ? param(params, "fadeRecentBars", "fade", { min: 1, max: 60, def: 3 }) : 0;
  const fb = fade ? param(params, "fadeBaselineBars", "fade", { min: 3, max: 720, def: 10 }) : 0;
  const fbr = fade ? param(params, "fadeBelowRatio", "fade", { exclusiveMin: 0, max: 1 }) : 0;
  const drop = has("dropFromHighPct") || has("dropWindowBars");
  const dw = drop ? param(params, "dropWindowBars", "fade", { min: 2, max: 1440, def: 15 }) : 0;
  const dp = drop ? param(params, "dropFromHighPct", "fade", { exclusiveMin: 0, max: 99 }) : 0;
  const minHoldMs = param(params, "minHoldMin", "fade", { min: 0, max: 10_080, def: 0 }) * 60_000;
  const maxHoldMs = has("maxHoldMin") ? param(params, "maxHoldMin", "fade", { exclusiveMin: 0, max: 525_600 }) * 60_000 : Infinity;
  if (fade && (!Number.isInteger(fr) || !Number.isInteger(fb))) throw new StrategyConfigError("exit (fade): fadeRecentBars and fadeBaselineBars are whole bars");
  if (drop && !Number.isInteger(dw)) throw new StrategyConfigError("exit (fade): dropWindowBars is whole bars");
  if (tp === Infinity && sl === 0 && !fade && !drop && maxHoldMs === Infinity) throw new StrategyConfigError("exit (fade): set at least one of takeProfit, stopLoss, the fade rule, the drop rule, maxHoldMin");
  // The series rules hold on a gap or an unwatched coin: with them, a price rule must be able to end the position.
  if ((fade || drop) && sl === 0 && maxHoldMs === Infinity) throw new StrategyConfigError("exit (fade): the series rules hold while the series is unknown; set stopLoss or maxHoldMin too");
  return {
    name: "fade",
    needsBasis: tp !== Infinity || sl > 0,
    onTick(p, m) {
      const held = m.nowMs - p.openedAtMs;
      const x = multiple(p, m);
      if (x !== null && x >= tp) return { action: "sell", fraction: 1, reason: `take_profit ${x.toFixed(3)}x` };
      if (x !== null && sl > 0 && x <= sl) return { action: "sell", fraction: 1, reason: `stop_loss ${x.toFixed(3)}x` };
      if (held >= maxHoldMs) return { action: "sell", fraction: 1, reason: `max_hold ${Math.round(held / 60_000)} min` };
      if (held < minHoldMs) return HOLD;
      const v = m.series;
      if (!v) return HOLD;
      // The drop rule reads only bars wholly after entry (a fall the position bought into is not a reason to sell). The
      // fade rule's baseline may be before entry (the move it bought), but its recent bars must all be after entry.
      const firstAfter = p.openedAtMs - (p.openedAtMs % v.barMs) + v.barMs;
      const bars = v.bars.filter((b) => b.t >= firstAfter || b === v.bars[v.bars.length - 1]);
      const endedAfter = bars.length - 1;
      if (fade && endedAfter >= fr) {
        const r = volumeVsBaseline(v.bars, fr, fb);
        if (r && r.complete && r.value < fbr) return { action: "sell", fraction: 1, reason: `volume_fade ${r.value.toFixed(3)}x baseline` };
      }
      if (drop) {
        const r = fallFromHigh(bars, dw);
        if (r && r.complete && r.bars >= 2 && r.value >= dp) return { action: "sell", fraction: 1, reason: `drop_from_high ${r.value.toFixed(1)} %` };
      }
      return HOLD;
    },
  };
}
