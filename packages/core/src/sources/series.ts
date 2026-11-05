/**
 * (0.6.0) A rolling price and volume series per coin: trades and price ticks folded into bars (1 m by default), at most
 * `maxBars` per coin (24 h by default) and `maxCoins` coins. In memory; bounded.
 *
 * What a bar says:
 *  - `complete`: true only when its minute has ended, lies wholly inside the time the coin was watched, and touches no
 *    gap. A quiet minute with no gap is a true zero (complete, volume 0). A minute before watching began is not a bar.
 *  - `gaps`: the reasons any gap touched it (a reconnect, a stall, a subscription that could not be held, the watch cap,
 *    a feed outage). A gap is unknown, never zero volume.
 *  - `source`: where its trades came from (e.g. "logs"); `backfilled` when any trade came from a later backfill.
 *
 * Feeders (sources/logsSeries, the Candle feed) write into a store; triggers read it through `SeriesSource`.
 */

export interface Bar {
  /** Start of the bar (ms, aligned to barMs). */
  t: number;
  /** SOL per whole token; null when no price was seen in the bar. */
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /** Quote volume (SOL for a SOL coin), fees excluded. */
  volume: number;
  buyVolume: number;
  sellVolume: number;
  buys: number;
  sells: number;
  complete: boolean;
  gaps: string[];
  source: string;
  backfilled: boolean;
}

export interface Gap {
  from: number;
  /** null: still open. */
  to: number | null;
  reason: string;
}

export interface SeriesView {
  mint: string;
  source: string;
  /** When watching began (ms); bars start at that minute. */
  watchedSince: number;
  barMs: number;
  /** Oldest first; the last bar is the one in progress (never complete). */
  bars: Bar[];
  lastTick: { at: number; price: number } | null;
  gaps: Gap[];
}

/** What a trigger reads. A streamed or recorded source answers the same calls. */
export interface SeriesSource {
  series(mint: string): SeriesView | null;
  /** Ask for these coins to be watched (a source may refuse past its cap; `watched()` says what is). */
  subscribe(mints: string[]): void;
  unsubscribe(mints: string[]): void;
  watched(): string[];
}

interface Agg {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  buys: number;
  sells: number;
  backfilled: boolean;
}

interface Coin {
  source: string;
  since: number;
  aggs: Map<number, Agg>;
  gaps: Gap[];
  lastTick: { at: number; price: number } | null;
}

export interface SeriesStoreOptions {
  barMs?: number;
  maxBars?: number;
  maxCoins?: number;
  /** Gaps kept per coin at most (oldest dropped; a dropped gap's bars are older than maxBars anyway). */
  maxGaps?: number;
  now?: () => number;
}

export class SeriesStore {
  readonly barMs: number;
  readonly maxBars: number;
  readonly maxCoins: number;
  private maxGaps: number;
  private now: () => number;
  private coins = new Map<string, Coin>();

  constructor(o: SeriesStoreOptions = {}) {
    this.barMs = o.barMs ?? 60_000;
    this.maxBars = o.maxBars ?? 1440;
    this.maxCoins = o.maxCoins ?? 200;
    this.maxGaps = o.maxGaps ?? 200;
    this.now = o.now ?? Date.now;
  }

  private slot(at: number): number {
    return at - (at % this.barMs);
  }

  /** Start watching a coin (bars begin now). False when the coin cap is reached (the coin is not watched). */
  watch(mint: string, source: string): boolean {
    if (this.coins.has(mint)) return true;
    if (this.coins.size >= this.maxCoins) return false;
    this.coins.set(mint, { source, since: this.now(), aggs: new Map(), gaps: [], lastTick: null });
    return true;
  }

  unwatch(mint: string): void {
    this.coins.delete(mint);
  }

  watched(): string[] {
    return [...this.coins.keys()];
  }

  isWatched(mint: string): boolean {
    return this.coins.has(mint);
  }

  private agg(c: Coin, at: number): Agg {
    const k = this.slot(at);
    let a = c.aggs.get(k);
    if (!a) {
      a = { open: null, high: null, low: null, close: null, volume: 0, buyVolume: 0, sellVolume: 0, buys: 0, sells: 0, backfilled: false };
      c.aggs.set(k, a);
      // Bounded: drop bars older than the window.
      const oldest = this.slot(this.now()) - (this.maxBars - 1) * this.barMs;
      for (const t of c.aggs.keys()) if (t < oldest) c.aggs.delete(t);
    }
    return a;
  }

  private priceInto(a: Agg, price: number): void {
    if (!(price > 0) || !Number.isFinite(price)) return;
    if (a.open === null) a.open = price;
    a.high = a.high === null ? price : Math.max(a.high, price);
    a.low = a.low === null ? price : Math.min(a.low, price);
    a.close = price;
  }

  /** One trade (quote volume in whole SOL; price after it when known). Ignored for an unwatched coin or a trade before watching. */
  trade(mint: string, t: { at: number; volume: number; side: "buy" | "sell"; price?: number | null; backfilled?: boolean }): void {
    const c = this.coins.get(mint);
    if (!c || t.at < c.since || !(t.volume >= 0)) return;
    const a = this.agg(c, t.at);
    a.volume += t.volume;
    if (t.side === "buy") {
      a.buys++;
      a.buyVolume += t.volume;
    } else {
      a.sells++;
      a.sellVolume += t.volume;
    }
    if (t.backfilled) a.backfilled = true;
    if (t.price != null) this.price(mint, t.at, t.price);
  }

  /** A price tick (a market read, or a trade's post-trade price). */
  price(mint: string, at: number, price: number): void {
    const c = this.coins.get(mint);
    if (!c || at < c.since || !(price > 0) || !Number.isFinite(price)) return;
    this.priceInto(this.agg(c, at), price);
    if (!c.lastTick || at >= c.lastTick.at) c.lastTick = { at, price };
  }

  /** Open a gap (for one coin, or every watched coin when `mint` is null). A second open gap for a coin is not added. */
  gapStart(mint: string | null, reason: string, at = this.now()): void {
    for (const [m, c] of this.coins) {
      if (mint !== null && m !== mint) continue;
      if (c.gaps.some((g) => g.to === null && g.reason === reason)) continue;
      c.gaps.push({ from: at, to: null, reason });
      if (c.gaps.length > this.maxGaps) c.gaps.splice(0, c.gaps.length - this.maxGaps);
    }
  }

  /** Close the open gaps with this reason (or every open gap when `reason` is omitted). */
  gapEnd(mint: string | null, reason?: string, at = this.now()): void {
    for (const [m, c] of this.coins) {
      if (mint !== null && m !== mint) continue;
      for (const g of c.gaps) if (g.to === null && (reason === undefined || g.reason === reason)) g.to = at;
    }
  }

  /** A closed gap over a known span (a stall found afterwards, a missed slot range). */
  gap(mint: string | null, from: number, to: number, reason: string): void {
    for (const [m, c] of this.coins) {
      if (mint !== null && m !== mint) continue;
      c.gaps.push({ from, to, reason });
      if (c.gaps.length > this.maxGaps) c.gaps.splice(0, c.gaps.length - this.maxGaps);
    }
  }

  series(mint: string): SeriesView | null {
    const c = this.coins.get(mint);
    if (!c) return null;
    const now = this.now();
    const cur = this.slot(now);
    const first = Math.max(this.slot(c.since), cur - (this.maxBars - 1) * this.barMs);
    const bars: Bar[] = [];
    for (let t = first; t <= cur; t += this.barMs) {
      const a = c.aggs.get(t);
      const end = t + this.barMs;
      const touching = c.gaps.filter((g) => g.from < end && (g.to === null || g.to > t)).map((g) => g.reason);
      const ended = end <= now;
      const whole = t >= c.since;
      bars.push({
        t,
        open: a?.open ?? null, high: a?.high ?? null, low: a?.low ?? null, close: a?.close ?? null,
        volume: a?.volume ?? 0, buyVolume: a?.buyVolume ?? 0, sellVolume: a?.sellVolume ?? 0, buys: a?.buys ?? 0, sells: a?.sells ?? 0,
        complete: ended && whole && touching.length === 0,
        gaps: [...new Set([...touching, ...(whole ? [] : ["before watching"])])],
        source: c.source,
        backfilled: a?.backfilled ?? false,
      });
    }
    return { mint, source: c.source, watchedSince: c.since, barMs: this.barMs, bars, lastTick: c.lastTick, gaps: c.gaps.map((g) => ({ ...g })) };
  }
}
