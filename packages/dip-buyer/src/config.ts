/**
 * The one config file: the core's shared sections (candle-bot-core) plus `watchlist` and `series` (the coins and
 * their trade-log series, shared with the scanner) and `dip` (the rule and the entry limits). Unknown keys are refused
 * at every level.
 */
import { parseConfig as parseCore, loadConfig as loadCore, ConfigError, isObj, only, num, bool, strList, type Config as CoreConfig } from "candle-bot-core/config";
import { parseSeriesSection, parseWatchlistSection, type SeriesSection, type WatchlistSection } from "candle-bot-core/sources/stack";
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
  /** Linked payer: a sell is never signed below the venue's own expected out less sell.maxSlippageBps and this. */
  sellFloorMarginBps: number;
}

export type Config = CoreConfig & { watchlist: WatchlistSection; series: SeriesSection; dip: Dip };

function parseDip(raw: unknown): Dip {
  const w = "config.dip";
  const d = raw === undefined ? {} : raw;
  if (!isObj(d)) throw new ConfigError(`${w}: must be an object`);
  only(d, ["windowBars", "minFallPct", "maxFallPct", "minWindowVolumeSol", "bounceBars", "minBouncePct", "allowIncomplete", "maxImpactBps", "cooldownMin", "buyWithinSec", "checkPrograms", "extraPrograms", "sellFloorMarginBps"], w);
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
  };
  if (out.minFallPct >= out.maxFallPct) throw new ConfigError(`${w}: minFallPct must be under maxFallPct`);
  if (out.bounceBars !== null && out.bounceBars >= out.windowBars) throw new ConfigError(`${w}: bounceBars must be under windowBars`);
  return out;
}

export const SECTIONS = { watchlist: parseWatchlistSection, series: parseSeriesSection, dip: parseDip };

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  return parseCore(raw, baseDir, SECTIONS) as Config;
}

export function loadConfig(path: string): Config {
  return loadCore(path, SECTIONS) as Config;
}
