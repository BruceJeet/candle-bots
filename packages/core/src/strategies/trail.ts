/**
 * (0.5.0) trail: a trailing stop from the high-water mark.
 *   { "strategy": "trail", "trailBps": 2000, "activate": 1.5, "sell": 0.5 }
 * trailBps: sell when the price falls this many bps under the highest price since entry or adoption (2000 = 20 %).
 * activate (optional): the trail is armed only once the high-water mark has reached this multiple of the entry price
 *   (needs a cost basis). Without it the trail is armed from the start and needs no basis.
 * sell (optional, default 1): the share of the REMAINING position each trail hit sells. After a partial hit the mark
 *   restarts at the price then, so the next hit needs another fall of trailBps from a new high since that sell.
 * The mark is the engine's (kept in the ledger: a restart does not reset it). A gap down through the trail in one
 * tick sells at the price then, like any stop.
 */
import { HOLD, checkParams, param, type ExitStrategy } from "./types.ts";

export function create(params: Record<string, unknown>): ExitStrategy {
  checkParams(params, ["trailBps", "activate", "sell"], "trail");
  const bps = param(params, "trailBps", "trail", { exclusiveMin: 0, max: 9_999 });
  if (!Number.isInteger(bps)) throw new Error("exit (trail).trailBps: must be an integer");
  const activate = params.activate === undefined ? null : param(params, "activate", "trail", { exclusiveMin: 0 });
  const fraction = param(params, "sell", "trail", { exclusiveMin: 0, max: 1, def: 1 });
  return {
    name: "trail",
    needsBasis: activate !== null,
    trailMark: true,
    onTick(p, m) {
      if (m.priceSol === null || p.remainingRaw <= 0n) return HOLD;
      const peak = Math.max(p.trailPeakSol ?? p.peakPriceSol, m.priceSol);
      if (!(peak > 0)) return HOLD;
      if (activate !== null) {
        // Armed once the position's own high-water mark (since entry, never reset) reached the activation multiple.
        if (!(p.entryPriceSol > 0) || Math.max(p.peakPriceSol, m.priceSol) < p.entryPriceSol * activate) return HOLD;
      }
      if (m.priceSol > peak * (1 - bps / 10_000)) return HOLD;
      return { action: "sell", fraction, reason: `trail ${(m.priceSol / peak).toFixed(3)} of mark`, resetTrail: fraction < 1 };
    },
  };
}
