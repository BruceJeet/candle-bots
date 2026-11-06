/**
 * The one config file: the core's shared sections (candle-bot-core) plus `watchlist` and `series` (the coins and
 * their trade-log series, shared with the scanner) and `spike` (the rule and the entry limits). Unknown keys are refused
 * at every level.
 */
import { parseConfig as parseCore, loadConfig as loadCore, ConfigError, isObj, only, num, bool, strList, type Config as CoreConfig } from "candle-bot-core/config";
import { checkWindows, parseSeriesSection, parseWatchlistSection, type SeriesSection, type WatchlistSection } from "candle-bot-core/sources/stack";
import type { SpikeRule } from "./rule.ts";

export { ConfigError } from "candle-bot-core/config";

export interface Spike extends SpikeRule {
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

export type Config = CoreConfig & { watchlist: WatchlistSection; series: SeriesSection; spike: Spike };

function parseSpike(raw: unknown): Spike {
  const w = "config.spike";
  const d = raw === undefined ? {} : raw;
  if (!isObj(d)) throw new ConfigError(`${w}: must be an object`);
  only(d, ["recentBars", "baselineBars", "minRatio", "minVolumeSol", "minBuyShare", "minRisePct", "maxRisePct", "allowIncomplete", "maxImpactBps", "cooldownMin", "buyWithinSec", "checkPrograms", "extraPrograms", "sellFloorMarginBps", "buyFloorMarginBps"], w);
  const out: Spike = {
    recentBars: num(d, "recentBars", w, { min: 1, max: 60, int: true, def: 2 }),
    baselineBars: num(d, "baselineBars", w, { min: 3, max: 720, int: true, def: 20 }),
    minRatio: num(d, "minRatio", w, { min: 1.1, max: 1000, def: 5 }),
    minVolumeSol: num(d, "minVolumeSol", w, { min: 0, max: 1e7, def: 5 }),
    minBuyShare: num(d, "minBuyShare", w, { min: 0, max: 1, def: 0.55 }),
    minRisePct: num(d, "minRisePct", w, { min: -99, max: 10_000, def: 3 }),
    maxRisePct: num(d, "maxRisePct", w, { min: 0, max: 100_000, def: 60 }),
    allowIncomplete: bool(d, "allowIncomplete", w, false),
    maxImpactBps: num(d, "maxImpactBps", w, { min: 0, max: 10_000, def: 300 }),
    cooldownMin: num(d, "cooldownMin", w, { min: 1, max: 10_080, int: true, def: 60 }),
    buyWithinSec: num(d, "buyWithinSec", w, { min: 5, max: 3600, int: true, def: 20 }),
    checkPrograms: bool(d, "checkPrograms", w, true),
    extraPrograms: strList(d, "extraPrograms", w, { def: [], address: true })!,
    sellFloorMarginBps: num(d, "sellFloorMarginBps", w, { min: 0, max: 10_000, int: true, def: 200 }),
    buyFloorMarginBps: num(d, "buyFloorMarginBps", w, { min: 0, max: 10_000, int: true, def: 200 }),
  };
  if (out.minRisePct >= out.maxRisePct) throw new ConfigError(`${w}: minRisePct must be under maxRisePct`);
  return out;
}

export const SECTIONS = { watchlist: parseWatchlistSection, series: parseSeriesSection, spike: parseSpike };

/** The rule's and the exit's windows must fit in the bars the series keeps. */
function checked(c: Config): Config {
  checkWindows(c.series.maxBars, [{ key: "spike.recentBars + spike.baselineBars", bars: c.spike.recentBars + c.spike.baselineBars }], c.exit as Record<string, unknown>);
  return c;
}

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  return checked(parseCore(raw, baseDir, SECTIONS) as Config);
}

export function loadConfig(path: string): Config {
  return checked(loadCore(path, SECTIONS) as Config);
}
