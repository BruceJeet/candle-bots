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
 * - (0.8.0) Only coins the series can read: a feed coin the series source reports unreadable (no trade-log source on
 *   its venue, `SeriesSource.unreadable`) is dropped and the place goes to the next feed coin. It is logged once per
 *   coin (`watchlist_dropped_unreadable`), not alerted, and looked at again after `recheckMs` (default 60 min) or when
 *   it comes back to the feed after leaving it. A listed or pushed coin is never dropped: it is alerted once per coin
 *   instead (its volume is unknown). `dropUnreadable: false` keeps the old behaviour. Rechecks are one coin a step.
 * - (0.8.0) A feed coin pushed out of the set stays subscribed for `lingerMs` (default 2 min, while the series has
 *   room), so if the coin that displaced it turns out unreadable it comes back with its bars. It is not in `watched()`
 *   meanwhile.
 * - A feed coin the series source reports busy (`SeriesSource.busy`: its trade-log stream costs more than the source's
 *   limit) is dropped the same way, logged once per coin (`watchlist_dropped_busy`), and looked at again after
 *   `busyRecheckMs` (default 3 h). A listed or pushed coin (a held coin is pushed) is never dropped for it, and not
 *   alerted.
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
  /** (0.8.0) Drop feed coins the series cannot read and fill from the feed (default true). */
  dropUnreadable?: boolean;
  /** (0.8.0) A dropped coin is tried again after this long while still in the feed (ms, default 60 min). */
  recheckMs?: number;
  /** (0.8.0) A displaced feed coin stays subscribed this long (ms, default 120 s; 0: unsubscribed at once). */
  lingerMs?: number;
  /** A feed coin dropped as busy is tried again after this long while still in the feed (ms, default 3 h). */
  busyRecheckMs?: number;
}

export interface WatchlistDeps {
  series: SeriesSource;
  feed?: CandleFeed | null;
  alerter: Alerter;
  log: Logger;
  now?: () => number;
}

/** Remember a coin; bounded (past 5,000 the oldest is forgotten). */
function remember(set: Set<string>, mint: string): void {
  set.add(mint);
  if (set.size > 5000) set.delete(set.values().next().value as string);
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
  /** Feed coins dropped as unreadable or busy: mint -> when, why, and when it may be tried again. */
  private skipped = new Map<string, { at: number; why: string; recheckMs: number }>();
  /** Coins logged (dropped) or alerted (listed/pushed) once already; bounded. */
  private loggedDrop = new Set<string>();
  private alertedKept = new Set<string>();
  droppedUnreadable = 0;
  droppedBusy = 0;
  private loggedBusy = new Set<string>();
  /** Displaced feed coins still subscribed: mint -> until (ms). */
  private lingering = new Map<string, number>();

  constructor(d: WatchlistDeps, o: WatchlistOptions) {
    this.d = d;
    this.now = d.now ?? Date.now;
    const maxFeed = o.maxFeedCoins ?? o.maxCoins;
    this.o = { mints: [...new Set(o.mints ?? [])], maxCoins: o.maxCoins, maxFeedCoins: maxFeed, dropAfterMs: o.dropAfterMs ?? 900_000, pushTtlMs: o.pushTtlMs ?? 3_600_000, feedStickiness: o.feedStickiness ?? 1.25, dropUnreadable: o.dropUnreadable ?? true, recheckMs: o.recheckMs ?? 3_600_000, lingerMs: o.lingerMs ?? 120_000, busyRecheckMs: o.busyRecheckMs ?? 10_800_000 };
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
    this.noteUnreadable(now);
    const vol = (m: string) => feed?.coin(m)?.volume5m?.value ?? -1;
    const eligible = [...this.feedSeen.keys()].filter((m) => !this.o.mints.includes(m) && !this.pushed.has(m) && !this.skipped.has(m));
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
    const wasFeed = this.feedIn;
    this.feedIn = nextIn;
    this.left = ordered.slice(this.o.maxCoins);
    if (this.left.length && this.left.length !== this.lastLeftCount) this.d.alerter.raise(`watchlist:cap:${this.left.length}`, `watchlist: the cap of ${this.o.maxCoins} coins leaves ${this.left.length} coins unwatched (list first, then pushed coins, then the feed by 5 m volume)`);
    this.lastLeftCount = this.left.length;
    const wantSet = new Set(want);
    // Lingering coins back in the set are still subscribed (bars kept); the rest leave when their time is up.
    const unsub: string[] = [];
    const stillSubscribed = new Set(this.lingering.keys());
    for (const [m, until] of [...this.lingering]) {
      if (wantSet.has(m)) this.lingering.delete(m);
      else if (until <= now) {
        this.lingering.delete(m);
        unsub.push(m);
      }
    }
    const added = want.filter((m) => !this.current.has(m) && !stillSubscribed.has(m));
    const removed = [...this.current].filter((m) => !wantSet.has(m));
    for (const m of removed) {
      // A readable feed coin pushed out (still in the feed) lingers while the series has room (the set plus lingering within the cap).
      if (this.o.lingerMs > 0 && wasFeed.has(m) && this.feedSeen.has(m) && !this.skipped.has(m) && want.length + this.lingering.size < this.o.maxCoins) this.lingering.set(m, now + this.o.lingerMs);
      else unsub.push(m);
    }
    // The set and the lingering coins together never pass the cap (the series refuses a coin past it): when the set
    // grew (a pushed coin, more feed coins), the lingering coins nearest their end leave first, before the new coins are
    // subscribed.
    if (want.length + this.lingering.size > this.o.maxCoins) {
      const byEnd = [...this.lingering].sort((a, b) => a[1] - b[1]);
      for (const [m] of byEnd) {
        if (want.length + this.lingering.size <= this.o.maxCoins) break;
        this.lingering.delete(m);
        unsub.push(m);
      }
    }
    if (unsub.length) this.d.series.unsubscribe(unsub);
    if (added.length) this.d.series.subscribe(added);
    this.current = wantSet;
    if (added.length || removed.length) this.d.log.info("watchlist_changed", { added: added.length, removed: removed.length, watched: want.length, left: this.left.length });
    return { added, removed };
  }

  /**
   * The series source's settled verdicts: a watched feed coin it cannot read is skipped (logged once per coin); a
   * listed or pushed one is kept and alerted once per coin. A skip ends after recheckMs, or once the coin left the feed.
   */
  private noteUnreadable(now: number): void {
    // A coin out of the feed is forgotten; a recheck lets one coin back a step (the oldest skip), so rechecks never
    // push many readable coins out at once.
    let oldest: string | null = null;
    for (const [m, s] of this.skipped) {
      if (!this.feedSeen.has(m)) this.skipped.delete(m);
      else if (now - s.at >= s.recheckMs && (oldest === null || s.at < this.skipped.get(oldest)!.at)) oldest = m;
    }
    if (oldest !== null) this.skipped.delete(oldest);
    // Busy feed coins (a cost verdict): dropped whatever dropUnreadable says; listed and pushed coins stay, quietly.
    const busy = this.d.series.busy?.();
    if (busy?.size) for (const [m, why] of busy) {
      if (!this.current.has(m) || this.o.mints.includes(m) || this.pushed.has(m) || this.skipped.has(m)) continue;
      this.skipped.set(m, { at: now, why, recheckMs: this.o.busyRecheckMs });
      this.droppedBusy++;
      if (!this.loggedBusy.has(m)) {
        remember(this.loggedBusy, m);
        this.d.log.info("watchlist_dropped_busy", { mint: m, why, dropped: this.droppedBusy });
      }
    }
    if (!this.o.dropUnreadable) return;
    const bad = this.d.series.unreadable?.();
    if (!bad?.size) return;
    for (const [m, why] of bad) {
      if (!this.current.has(m)) continue;
      if (this.o.mints.includes(m) || this.pushed.has(m)) {
        if (!this.alertedKept.has(m)) {
          remember(this.alertedKept, m);
          this.d.alerter.raise(`watchlist:unreadable:${m}`, `watchlist: ${m} is on the list or pushed, but the series cannot read its volume (${why}); it stays watched, price only`);
        }
        continue;
      }
      if (this.skipped.has(m)) continue;
      this.skipped.set(m, { at: now, why, recheckMs: this.o.recheckMs });
      this.droppedUnreadable++;
      if (!this.loggedDrop.has(m)) {
        remember(this.loggedDrop, m);
        this.d.log.info("watchlist_dropped_unreadable", { mint: m, why, dropped: this.droppedUnreadable });
      }
    }
  }

  watched(): string[] {
    return [...this.current];
  }

  status(): Record<string, unknown> {
    return { watched: this.current.size, list: this.o.mints.length, pushed: this.pushed.size, feed: this.feedSeen.size, leftByCap: this.left.length, maxCoins: this.o.maxCoins, skippedUnreadable: this.skipped.size, droppedUnreadable: this.droppedUnreadable, droppedBusy: this.droppedBusy, busyRecheckMin: Math.round(this.o.busyRecheckMs / 60_000), lingering: this.lingering.size };
  }
}
