/**
 * The one config file: the core's shared sections (candle-bot-core) plus `watchlist` and `series` (the coins and
 * their trade-log series, shared with the scanner) and `dip` (the rule and the entry limits). Unknown keys are refused
 * at every level.
 */
import { parseConfig as parseCore, loadConfig as loadCore, ConfigError, isObj, only, num, bool, strList, type Config as CoreConfig } from "candle-bot-core/config";
import { checkWindows, parseSeriesSection, parseWatchlistSection, type SeriesSection, type WatchlistSection } from "candle-bot-core/sources/stack";
import type { DipRule } from "./rule.ts";

export { ConfigError } from "candle-bot-core/config";

export interface Dip extends DipRule {
  /** The ticket's price impact on the venue, bps (the fee apart). Also the buy-retry limit. */
  maxImpactBps: number;
  /** A coin whose rule fired is not looked at again for this long (min). */
  cooldownMin: number;
  /** No attempt of a buy is built more than this many seconds after the decision. */
  buyWithinSec: number;
  /** Linked payer: sign only builds whose programs are known (the core's list plus extraPrograms). Default true. */
  checkPrograms: boolean;
  extraPrograms: string[];
  /**
   * Linked payer: a sell is never signed below the venue's own expected out less sell.maxSlippageBps and this (pump.fun
   * venues only; on another venue, or when the read fails, only Candle's own floor applies).
   */
  sellFloorMarginBps: number;
  /** Linked payer: a buy is never signed with a floor under the decision fill less buy.maxSlippageBps and this. */
  buyFloorMarginBps: number;
}

export type Config = CoreConfig & { watchlist: WatchlistSection; series: SeriesSection; dip: Dip };

function parseDip(raw: unknown): Dip {
  const w = "config.dip";
  const d = raw === undefined ? {} : raw;
  if (!isObj(d)) throw new ConfigError(`${w}: must be an object`);
  only(d, ["windowBars", "minFallPct", "maxFallPct", "minWindowVolumeSol", "bounceBars", "minBouncePct", "allowIncomplete", "maxImpactBps", "cooldownMin", "buyWithinSec", "checkPrograms", "extraPrograms", "sellFloorMarginBps", "buyFloorMarginBps"], w);
  const out: Dip = {
    windowBars: num(d, "windowBars", w, { min: 2, max: 1440, int: true, def: 30 }),
    minFallPct: num(d, "minFallPct", w, { min: 1, max: 99, def: 30 }),
    maxFallPct: num(d, "maxFallPct", w, { min: 1, max: 99.9, def: 95 }),
    minWindowVolumeSol: num(d, "minWindowVolumeSol", w, { min: 0, max: 1e7, def: 5 }),
    bounceBars: d.bounceBars === undefined ? null : num(d, "bounceBars", w, { min: 1, max: 60, int: true }),
    minBouncePct: num(d, "minBouncePct", w, { min: 0, max: 1000, def: 5 }),
    allowIncomplete: bool(d, "allowIncomplete", w, false),
    maxImpactBps: num(d, "maxImpactBps", w, { min: 0, max: 10_000, def: 300 }),
    cooldownMin: num(d, "cooldownMin", w, { min: 1, max: 10_080, int: true, def: 60 }),
    buyWithinSec: num(d, "buyWithinSec", w, { min: 5, max: 3600, int: true, def: 30 }),
    checkPrograms: bool(d, "checkPrograms", w, true),
    extraPrograms: strList(d, "extraPrograms", w, { def: [], address: true })!,
    sellFloorMarginBps: num(d, "sellFloorMarginBps", w, { min: 0, max: 10_000, int: true, def: 200 }),
    buyFloorMarginBps: num(d, "buyFloorMarginBps", w, { min: 0, max: 10_000, int: true, def: 200 }),
  };
  if (out.minFallPct >= out.maxFallPct) throw new ConfigError(`${w}: minFallPct must be under maxFallPct`);
  if (out.bounceBars !== null && out.bounceBars >= out.windowBars) throw new ConfigError(`${w}: bounceBars must be under windowBars`);
  return out;
}

export const SECTIONS = { watchlist: parseWatchlistSection, series: parseSeriesSection, dip: parseDip };

/**
 * (0.2.0) The fade exit's volume rule against a dip entry: its baseline bars, read back from now, must lie wholly after
 * entry. Otherwise the baseline holds the fall the bot bought (the busiest minutes), and any calm after the dip reads as
 * "the buyers are gone": in the step 0 dry run (Nov 2026) every one of 8 trades was sold that way 6-9 min after entry.
 * So with the volume rule, exit.minHoldMin must cover fadeRecentBars + fadeBaselineBars + 1 (1 min bars; the entry
 * minute's own bar is the +1). No volume rule
 * (stop loss, take profit, drop from high, max hold): nothing to check.
 */
function checkDipFade(exit: Record<string, unknown>): void {
  if (exit.strategy !== "fade") return;
  if (exit.fadeBelowRatio === undefined && exit.fadeRecentBars === undefined && exit.fadeBaselineBars === undefined) return;
  const n = (k: string, def: number) => (typeof exit[k] === "number" ? (exit[k] as number) : def);
  // +1: the ended bars still include the entry minute's bar (the bounce before the fill) until one more bar ends.
  const need = n("fadeRecentBars", 3) + n("fadeBaselineBars", 10) + 1;
  const hold = n("minHoldMin", 0);
  if (hold < need) throw new ConfigError(`config.exit: the volume fade (fadeRecentBars + fadeBaselineBars + the entry bar = ${need} bars) would compare against the fall the dip bought; set exit.minHoldMin to ${need} or more, or drop the fade rule (stopLoss, takeProfit and maxHoldMin still apply)`);
}

/** The rule's and the exit's windows must fit in the bars the series keeps; the fade rule must not read the dip. */
function checked(c: Config): Config {
  checkWindows(c.series.maxBars, [{ key: "dip.windowBars", bars: c.dip.windowBars }], c.exit as Record<string, unknown>);
  checkDipFade(c.exit as Record<string, unknown>);
  return c;
}

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  return checked(parseCore(raw, baseDir, SECTIONS) as Config);
}

export function loadConfig(path: string): Config {
  return checked(loadCore(path, SECTIONS) as Config);
}
