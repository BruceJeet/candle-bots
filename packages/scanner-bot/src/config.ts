/**
 * The scanner's config: the core's watch-only keys (no wallet, no key, nothing that trades) plus `watchlist`, `series`
 * and `rules`. Unknown keys are refused at every level.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseWatchConfig, ConfigError, isObj, only, num, bool, str, strList, asAddress, type SectionParser, type WatchConfig } from "candle-bot-core";
import { parseWatchlistSection, parseSeriesSection } from "candle-bot-core/sources/stack";

export { ConfigError } from "candle-bot-core/config";

export type { WatchlistSection, SeriesSection } from "candle-bot-core/sources/stack";

interface Cooldown {
  cooldownMin: number;
}
export interface Rules {
  volumeSpike?: Cooldown & { recentBars: number; baselineBars: number; minRatio: number; minVolumeSol: number };
  dip?: Cooldown & { windowBars: number; minFallPct: number };
  breakout?: Cooldown & { windowBars: number; minRisePct: number };
  feedVolume?: Cooldown & { minVolume5mUsd: number };
  /** Let a rule fire on bars with a gap (default false: a gap means the numbers are not known). */
  allowIncomplete: boolean;
  /** A link in each alert ({mint} is replaced); "" for none. */
  link: string;
}

const parseRules: SectionParser<Rules> = (raw) => {
  const w = "config.rules";
  if (!isObj(raw)) throw new ConfigError(`${w}: required, with at least one of volumeSpike, dip, breakout, feedVolume`);
  only(raw, ["volumeSpike", "dip", "breakout", "feedVolume", "allowIncomplete", "link"], w);
  const out: Rules = { allowIncomplete: bool(raw, "allowIncomplete", w, false), link: str(raw, "link", w, { def: "https://alpha.candle.tv/token/{mint}" })! };
  const cd = (o: Record<string, unknown>, k: string) => num(o, "cooldownMin", `${w}.${k}`, { min: 1, max: 10_080, int: true, def: 30 });
  const sec = (k: string, keys: string[]) => {
    const o = raw[k];
    if (o === undefined) return null;
    if (!isObj(o)) throw new ConfigError(`${w}.${k}: an object`);
    only(o, [...keys, "cooldownMin"], `${w}.${k}`);
    return o;
  };
  const vs = sec("volumeSpike", ["recentBars", "baselineBars", "minRatio", "minVolumeSol"]);
  if (vs) out.volumeSpike = { recentBars: num(vs, "recentBars", `${w}.volumeSpike`, { min: 1, max: 60, int: true, def: 1 }), baselineBars: num(vs, "baselineBars", `${w}.volumeSpike`, { min: 3, max: 720, int: true, def: 15 }), minRatio: num(vs, "minRatio", `${w}.volumeSpike`, { min: 1.1, max: 1000, def: 5 }), minVolumeSol: num(vs, "minVolumeSol", `${w}.volumeSpike`, { min: 0, max: 100_000, def: 1 }), cooldownMin: cd(vs, "volumeSpike") };
  const dip = sec("dip", ["windowBars", "minFallPct"]);
  if (dip) out.dip = { windowBars: num(dip, "windowBars", `${w}.dip`, { min: 2, max: 1440, int: true, def: 30 }), minFallPct: num(dip, "minFallPct", `${w}.dip`, { min: 1, max: 99, def: 30 }), cooldownMin: cd(dip, "dip") };
  const bo = sec("breakout", ["windowBars", "minRisePct"]);
  if (bo) out.breakout = { windowBars: num(bo, "windowBars", `${w}.breakout`, { min: 2, max: 1440, int: true, def: 30 }), minRisePct: num(bo, "minRisePct", `${w}.breakout`, { min: 1, max: 100_000, def: 50 }), cooldownMin: cd(bo, "breakout") };
  const fv = sec("feedVolume", ["minVolume5mUsd"]);
  if (fv) out.feedVolume = { minVolume5mUsd: num(fv, "minVolume5mUsd", `${w}.feedVolume`, { min: 1, max: 1e12, def: 50_000 }), cooldownMin: cd(fv, "feedVolume") };
  if (!out.volumeSpike && !out.dip && !out.breakout && !out.feedVolume) throw new ConfigError(`${w}: at least one rule`);
  return out;
};

export const SECTIONS = { watchlist: parseWatchlistSection, series: parseSeriesSection, rules: parseRules };
export type Config = WatchConfig<typeof SECTIONS>;

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  const c = parseWatchConfig(raw, baseDir, SECTIONS);
  if (c.rules.feedVolume && !c.watchlist.feed) throw new ConfigError("config.rules.feedVolume: needs watchlist.feed (the feed's own values)");
  void asAddress;
  return c;
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read config ${path}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`config ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw, dirname(resolve(path)));
}
