/**
 * (0.6.0) Which coins a series source watches: a fixed list, coins a bot pushes (a new launch it saw, for a while), and
 * a Candle feed bucket (CandleFeed), within one cap.
 *
 * - Order when the cap bites: the list first (never dropped), then pushed coins (newest first), then feed coins by
 *   their 5 m volume (highest first; no volume last).
 * - A feed coin leaves once it has been out of the feed for `dropAfterMs`; a pushed coin after its `ttlMs`.
 * - Hysteresis for feed coins near the cut: watched coins rank by their 5 m volume times `feedStickiness` (default
 *   1.25), so a newcomer takes a place only by trading 25 % more than the coin it displaces. Coins at the edge do not
 *   churn (and lose their bars); a hot newcomer gets in at once.
 * - Coins the cap leaves out are alerted (once per change of the count) and listed in status.
 */
import type { Alerter } from "../alerts.ts";
import type { Logger } from "../log.ts";
import type { CandleFeed } from "./candleFeed.ts";
import type { SeriesSource } from "./series.ts";

export interface WatchlistOptions {
  mints?: string[];
  maxCoins: number;
  /** Feed coins at most (within maxCoins). */
  maxFeedCoins?: number;
  /** A feed coin absent this long leaves (ms). */
  dropAfterMs?: number;
  /** A pushed coin's default stay (ms). */
  pushTtlMs?: number;
  /**
   * Hysteresis: coins already watched rank by their 5 m volume times this (default 1.25), so a newcomer replaces one only
   * when it trades at least that much more. Coins near the cut do not churn; a much hotter coin gets in at once.
   */
  feedStickiness?: number;
}

export interface WatchlistDeps {
  series: SeriesSource;
  feed?: CandleFeed | null;
  alerter: Alerter;
  log: Logger;
  now?: () => number;
}

export class Watchlist {
  private d: WatchlistDeps;
  private o: Required<WatchlistOptions>;
  private now: () => number;
  private pushed = new Map<string, { at: number; until: number }>();
  /** Feed coins: when last seen in the feed. */
  private feedSeen = new Map<string, number>();
  private current = new Set<string>();
  /** Feed coins chosen, and when each came in (hysteresis). */
  private feedIn = new Map<string, number>();
  left: string[] = [];
  private lastLeftCount = 0;

  constructor(d: WatchlistDeps, o: WatchlistOptions) {
    this.d = d;
    this.now = d.now ?? Date.now;
    const maxFeed = o.maxFeedCoins ?? o.maxCoins;
    this.o = { mints: [...new Set(o.mints ?? [])], maxCoins: o.maxCoins, maxFeedCoins: maxFeed, dropAfterMs: o.dropAfterMs ?? 900_000, pushTtlMs: o.pushTtlMs ?? 3_600_000, feedStickiness: o.feedStickiness ?? 1.25 };
  }

  /** Watch a coin for a while (a new launch a bot detected, a coin a rule wants a closer look at). */
  push(mint: string, ttlMs = this.o.pushTtlMs): void {
    const now = this.now();
    this.pushed.set(mint, { at: now, until: Math.max(this.pushed.get(mint)?.until ?? 0, now + ttlMs) });
  }

  /** Recompute the set and tell the series source what was added and removed. */
  async step(): Promise<{ added: string[]; removed: string[] }> {
    const now = this.now();
    const feed = this.d.feed;
    if (feed) {
      await feed.poll();
      for (const c of feed.coins()) this.feedSeen.set(c.mint, now);
    }
    for (const [m, at] of this.feedSeen) if (now - at > this.o.dropAfterMs) this.feedSeen.delete(m);
    for (const [m, p] of this.pushed) if (p.until <= now) this.pushed.delete(m);
    const vol = (m: string) => feed?.coin(m)?.volume5m?.value ?? -1;
    const eligible = [...this.feedSeen.keys()].filter((m) => !this.o.mints.includes(m) && !this.pushed.has(m));
    // Score: 5 m volume, an incumbent's raised by the stickiness (no volume known: last).
    const score = (m: string) => (vol(m) < 0 ? -1 : vol(m) * (this.feedIn.has(m) ? this.o.feedStickiness : 1));
    const feedCoins = eligible.sort((a, b) => score(b) - score(a) || (this.feedIn.has(b) ? 1 : 0) - (this.feedIn.has(a) ? 1 : 0)).slice(0, this.o.maxFeedCoins);
    const pushed = [...this.pushed].sort((a, b) => b[1].at - a[1].at).map(([m]) => m).filter((m) => !this.o.mints.includes(m));
    const ordered = [...this.o.mints, ...pushed, ...feedCoins];
    const want = ordered.slice(0, this.o.maxCoins);
    // Stickiness only for feed coins actually watched (one the cap left out is not an incumbent).
    const inWant = new Set(want);
    const nextIn = new Map<string, number>();
    for (const m of feedCoins) if (inWant.has(m)) nextIn.set(m, this.feedIn.get(m) ?? now);
    this.feedIn = nextIn;
    this.left = ordered.slice(this.o.maxCoins);
    if (this.left.length && this.left.length !== this.lastLeftCount) this.d.alerter.raise(`watchlist:cap:${this.left.length}`, `watchlist: the cap of ${this.o.maxCoins} coins leaves ${this.left.length} coins unwatched (list first, then pushed coins, then the feed by 5 m volume)`);
    this.lastLeftCount = this.left.length;
    const wantSet = new Set(want);
    const added = want.filter((m) => !this.current.has(m));
    const removed = [...this.current].filter((m) => !wantSet.has(m));
    if (removed.length) this.d.series.unsubscribe(removed);
    if (added.length) this.d.series.subscribe(added);
    this.current = wantSet;
    if (added.length || removed.length) this.d.log.info("watchlist_changed", { added: added.length, removed: removed.length, watched: want.length, left: this.left.length });
    return { added, removed };
  }

  watched(): string[] {
    return [...this.current];
  }

  status(): Record<string, unknown> {
    return { watched: this.current.size, list: this.o.mints.length, pushed: this.pushed.size, feed: this.feedSeen.size, leftByCap: this.left.length, maxCoins: this.o.maxCoins };
  }
}
