/**
 * (0.6.0) The config sections and the wiring a series bot shares: `watchlist` (which coins) and `series` (the trade-log
 * series), parsed the same way in every bot, and `seriesStack` building the LogsSeries, the Candle feed and the
 * Watchlist from them.
 */
import type { Alerter } from "../alerts.ts";
import { ConfigError, isObj, num, only, strList, type SectionParser } from "../config.ts";
import type { Logger } from "../log.ts";
import type { Rpc } from "../solana/rpc.ts";
import { CandleFeed, FEED_BUCKETS, type FeedBucket } from "./candleFeed.ts";
import { LogsSeries } from "./logsSeries.ts";
import { Watchlist } from "./watchlist.ts";

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

export const parseWatchlistSection: SectionParser<WatchlistSection> = (raw) => {
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

export const parseSeriesSection: SectionParser<SeriesSection> = (raw) => {
  const r = raw === undefined ? {} : raw;
  if (!isObj(r)) throw new ConfigError("config.series: an object");
  only(r, ["maxSubscriptions", "maxBars", "maxSlotLag"], "config.series");
  return {
    maxSubscriptions: num(r, "maxSubscriptions", "config.series", { min: 1, max: 500, int: true, def: 50 }),
    maxBars: num(r, "maxBars", "config.series", { min: 10, max: 1440, int: true, def: 1440 }),
    maxSlotLag: num(r, "maxSlotLag", "config.series", { min: 10, max: 100_000, int: true, def: 150 }),
  };
};

export interface StackDeps {
  rpc: Rpc;
  wsUrl: string;
  apiUrl: string;
  log: Logger;
  alerter: Alerter;
  now?: () => number;
  fetch?: typeof fetch;
  /** A test's socket (solana/logs-multi shape). */
  socket?: any;
}

/** The LogsSeries, the Candle feed (when the watchlist names buckets) and the Watchlist over them. */
export function seriesStack(d: StackDeps, w: WatchlistSection, s: SeriesSection): { series: LogsSeries; feed: CandleFeed | null; watchlist: Watchlist } {
  const now = d.now ?? Date.now;
  const series = new LogsSeries({ rpc: d.rpc, wsUrl: d.wsUrl, log: d.log, alerter: d.alerter, now, ...(d.socket ? { socket: d.socket } : {}) }, { maxSubscriptions: s.maxSubscriptions, maxCoins: w.maxCoins, maxBars: s.maxBars, maxSlotLag: s.maxSlotLag });
  const f = w.feed;
  const feed = f ? new CandleFeed({ apiUrl: d.apiUrl, log: d.log, alerter: d.alerter, now, ...(d.fetch ? { fetch: d.fetch } : {}) }, { buckets: f.buckets, ...(f.where ? { where: f.where } : {}), everyMs: f.everySec * 1000 }) : null;
  const watchlist = new Watchlist({ series, feed, alerter: d.alerter, log: d.log, now }, { mints: w.mints, maxCoins: w.maxCoins, ...(f ? { maxFeedCoins: f.maxCoins } : {}), dropAfterMs: w.dropAfterMin * 60_000 });
  return { series, feed, watchlist };
}

/**
 * (0.6.0) A rule window must fit in the bars the series keeps (each window counts ended bars, plus the one in
 * progress): refused at config load otherwise, since the rule could never read a full window. The fade exit's windows
 * are checked too when it is the exit (its defaults when a rule is on: fade 3 + 10 bars, drop 15).
 */
export function checkWindows(maxBars: number, windows: Array<{ key: string; bars: number }>, exit?: Record<string, unknown>): void {
  const all = [...windows];
  if (exit && exit.strategy === "fade") {
    const n = (k: string, def: number) => (typeof exit[k] === "number" ? (exit[k] as number) : def);
    if (exit.fadeBelowRatio !== undefined || exit.fadeRecentBars !== undefined || exit.fadeBaselineBars !== undefined) all.push({ key: "exit.fadeRecentBars + exit.fadeBaselineBars", bars: n("fadeRecentBars", 3) + n("fadeBaselineBars", 10) });
    if (exit.dropFromHighPct !== undefined || exit.dropWindowBars !== undefined) all.push({ key: "exit.dropWindowBars", bars: n("dropWindowBars", 15) });
  }
  for (const w of all) if (w.bars + 1 > maxBars) throw new ConfigError(`config.${w.key}: ${w.bars} bars do not fit in series.maxBars ${maxBars} (a window needs its bars ended, plus the one in progress)`);
}
