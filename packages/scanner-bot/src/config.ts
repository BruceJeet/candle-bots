/**
 * The scanner's config: the core's watch-only keys (no wallet, no key, nothing that trades) plus `watchlist`, `series`
 * and `rules`. Unknown keys are refused at every level.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseWatchConfig, ConfigError, isObj, only, num, bool, str, strList, asAddress, type SectionParser, type WatchConfig } from "candle-bot-core";
import { FEED_BUCKETS, type FeedBucket } from "candle-bot-core/sources/candleFeed";

export { ConfigError } from "candle-bot-core/config";

export interface WatchlistSection {
  mints: string[];
  feed: { buckets: FeedBucket[]; where?: Record<string, unknown>; maxCoins: number; everySec: number } | null;
  maxCoins: number;
  dropAfterMin: number;
}

export interface SeriesSection {
  /** Trade-log subscriptions on the one websocket (one per coin). */
  maxSubscriptions: number;
  /** Bars kept per coin (1 min each). */
  maxBars: number;
  /** A trade notification more than this many slots behind the chain marks the bars incomplete (about 400 ms a slot). */
  maxSlotLag: number;
}

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

const parseWatchlist: SectionParser<WatchlistSection> = (raw) => {
  const w = "config.watchlist";
  if (!isObj(raw)) throw new ConfigError(`${w}: required, with mints and/or feed`);
  only(raw, ["mints", "feed", "maxCoins", "dropAfterMin"], w);
  const mints = strList(raw, "mints", w, { def: [], address: true })!;
  let feed: WatchlistSection["feed"] = null;
  if (raw.feed !== undefined) {
    const f = raw.feed;
    if (!isObj(f)) throw new ConfigError(`${w}.feed: { buckets, where?, maxCoins?, everySec? }`);
    only(f, ["buckets", "where", "maxCoins", "everySec"], `${w}.feed`);
    const buckets = strList(f, "buckets", `${w}.feed`)!;
    if (!buckets?.length) throw new ConfigError(`${w}.feed.buckets: one or more of ${FEED_BUCKETS.join(", ")}`);
    for (const b of buckets) if (!(FEED_BUCKETS as readonly string[]).includes(b)) throw new ConfigError(`${w}.feed.buckets: "${b}" is not one of ${FEED_BUCKETS.join(", ")}`);
    if (f.where !== undefined && !isObj(f.where)) throw new ConfigError(`${w}.feed.where: the feed's JSON filter, e.g. { "marketCap": { "lt": 150000 } }`);
    feed = { buckets: buckets as FeedBucket[], ...(f.where ? { where: f.where as Record<string, unknown> } : {}), maxCoins: num(f, "maxCoins", `${w}.feed`, { min: 1, max: 500, int: true, def: 30 }), everySec: num(f, "everySec", `${w}.feed`, { min: 10, max: 3600, int: true, def: 30 }) };
  }
  if (!mints.length && !feed) throw new ConfigError(`${w}: give mints, a feed, or both`);
  return { mints, feed, maxCoins: num(raw, "maxCoins", w, { min: 1, max: 1000, int: true, def: 40 }), dropAfterMin: num(raw, "dropAfterMin", w, { min: 1, max: 1440, int: true, def: 15 }) };
};

const parseSeries: SectionParser<SeriesSection> = (raw) => {
  const r = raw === undefined ? {} : raw;
  if (!isObj(r)) throw new ConfigError("config.series: an object");
  only(r, ["maxSubscriptions", "maxBars", "maxSlotLag"], "config.series");
  return {
    maxSubscriptions: num(r, "maxSubscriptions", "config.series", { min: 1, max: 500, int: true, def: 50 }),
    maxBars: num(r, "maxBars", "config.series", { min: 10, max: 1440, int: true, def: 1440 }),
    maxSlotLag: num(r, "maxSlotLag", "config.series", { min: 10, max: 100_000, int: true, def: 150 }),
  };
};

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

export const SECTIONS = { watchlist: parseWatchlist, series: parseSeries, rules: parseRules };
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
