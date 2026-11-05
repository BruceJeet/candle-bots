/**
 * (0.6.0) Candle's public market feed (`GET {apiUrl}/api/v1/markets/feed`, no key) as a coarse, rolling source.
 *
 * What it is (probed Nov 5 2026): buckets `new`, `graduated`, `onfire`, `bluechip`, `finalstretch` (a few hundred coins
 * in all); rows with rolling `volume5m` / `volume1h` / `volume24h` in USD, `buyCount5m` / `sellCount5m`, `priceUsd`, a
 * per-field `marketObservedAt`; an incremental `since_seq` cursor (changed rows plus `removed`; `reset: true` means
 * replace what you hold). Many rows carry no volume.
 *
 * Observed times: `marketObservedAt` covers price, market cap, volume24h, change1h and change24h (on most rows, not all);
 * `volume5m` and `volume1h` have none, so their time is the row's `updatedAt`.
 *
 * What this source keeps: per coin, each window's value WITH its own observed time, labelled `candle-feed` and never
 * complete. Windows are never mixed (a 1 h value is not a bar, and never folded with the 24 h one). It does not write
 * bars. A 503 (`FEED_UNAVAILABLE`, after a server restart) or any failed poll is an outage: alerted, backed off, and the
 * coins' values age (`stale` once older than `staleMs`).
 */
import type { Alerter } from "../alerts.ts";
import type { Logger } from "../log.ts";

export const FEED_BUCKETS = ["new", "graduated", "onfire", "bluechip", "finalstretch"] as const;
export type FeedBucket = (typeof FEED_BUCKETS)[number];

export interface RollingValue {
  value: number;
  /**
   * When the feed says this window was observed (ms): its own marketObservedAt, else the row's updatedAt. Null when the
   * feed gave neither (unknown time: never stale-checked as fresh, never used to fire).
   */
  observedAt: number | null;
}

export interface FeedCoin {
  mint: string;
  symbol: string | null;
  launchpad: string | null;
  buckets: FeedBucket[];
  /** USD, each its own rolling window. */
  volume5m: RollingValue | null;
  volume1h: RollingValue | null;
  volume24h: RollingValue | null;
  priceUsd: RollingValue | null;
  priceChange5m: RollingValue | null;
  buys5m: number | null;
  sells5m: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  /** When this source last saw the row. */
  seenAt: number;
  source: "candle-feed";
  complete: false;
}

export interface CandleFeedDeps {
  apiUrl: string;
  log: Logger;
  alerter: Alerter;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface CandleFeedOptions {
  buckets: FeedBucket[];
  /** A server-side filter (the feed's `where`), e.g. { marketCap: { lt: 150000 } }. */
  where?: Record<string, unknown>;
  everyMs?: number;
  /** A value older than this is stale. */
  staleMs?: number;
  /** Polls failing in a row before the outage is alerted. */
  alertAfter?: number;
}

// Full rows, no `fields=`: the feed refuses `buckets` and `marketObservedAt` as selectable fields (HTTP 400, checked
// Nov 5 2026), and the per-window observed times are what this source keeps. A full onfire answer was about 124 KB.

export class CandleFeed {
  private d: CandleFeedDeps;
  private o: Required<Omit<CandleFeedOptions, "where">> & { where?: Record<string, unknown> };
  private now: () => number;
  private cursors = new Map<FeedBucket, string>();
  private rows = new Map<FeedBucket, Map<string, FeedCoin>>();
  private fails = 0;
  private nextAt = 0;
  lastOkAt = 0;

  constructor(d: CandleFeedDeps, o: CandleFeedOptions) {
    for (const b of o.buckets) if (!FEED_BUCKETS.includes(b)) throw new Error(`candle feed: unknown bucket ${b}`);
    if (!o.buckets.length) throw new Error("candle feed: at least one bucket");
    this.d = d;
    this.now = d.now ?? Date.now;
    this.o = { buckets: o.buckets, everyMs: o.everyMs ?? 30_000, staleMs: o.staleMs ?? 600_000, alertAfter: o.alertAfter ?? 3, ...(o.where ? { where: o.where } : {}) };
  }

  /** Coins in the configured buckets (one row per coin; buckets merged). */
  coins(): FeedCoin[] {
    const by = new Map<string, FeedCoin>();
    for (const b of this.o.buckets) for (const c of this.rows.get(b)?.values() ?? []) {
      const prev = by.get(c.mint);
      by.set(c.mint, prev && prev.seenAt > c.seenAt ? { ...prev, buckets: [...new Set([...prev.buckets, b])] } : { ...c, buckets: [...new Set([...(prev?.buckets ?? []), ...c.buckets, b])] as FeedBucket[] });
    }
    return [...by.values()];
  }

  coin(mint: string): FeedCoin | null {
    return this.coins().find((c) => c.mint === mint) ?? null;
  }

  /** Whether a value is older than staleMs. */
  isStale(v: RollingValue | null): boolean {
    return !v || v.observedAt === null || this.now() - v.observedAt > this.o.staleMs;
  }

  /** One poll of every bucket (incremental after the first), on its own clock. Never throws. */
  async poll(force = false): Promise<void> {
    const now = this.now();
    if (!force && now < this.nextAt) return;
    this.nextAt = now + this.o.everyMs * Math.min(2 ** this.fails, 16);
    try {
      for (const b of this.o.buckets) await this.pollBucket(b);
      if (this.fails >= this.o.alertAfter) this.d.log.info("candle_feed_back", { after: this.fails });
      this.fails = 0;
      this.nextAt = now + this.o.everyMs;
      this.lastOkAt = this.now();
    } catch (e) {
      this.fails++;
      const why = String((e as Error)?.message ?? e).slice(0, 160);
      this.d.log.warn("candle_feed_failed", { error: why, inARow: this.fails });
      if (this.fails >= this.o.alertAfter) this.d.alerter.raise("series:candle_feed_down", `Candle feed unavailable ${this.fails} polls in a row (${why}); its rolling values age and turn stale`);
    }
  }

  private async pollBucket(b: FeedBucket): Promise<void> {
    const f = this.d.fetch ?? fetch;
    const q = new URLSearchParams({ bucket: b, limit: "500" });
    if (this.o.where) q.set("where", JSON.stringify(this.o.where));
    const cur = this.cursors.get(b);
    if (cur) q.set("since_seq", cur);
    const r = await f(`${this.d.apiUrl.replace(/\/$/, "")}/api/v1/markets/feed?${q}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`feed ${b}: HTTP ${r.status}${r.status === 503 ? " (FEED_UNAVAILABLE)" : ""}`);
    const body: any = await r.json();
    if (!body?.success || !Array.isArray(body.tokens)) throw new Error(`feed ${b}: bad response`);
    if (body.warming) this.d.log.info("candle_feed_warming", { bucket: b });
    const now = this.now();
    let held = this.rows.get(b);
    if (!held || !cur || body.reset) {
      held = new Map();
      this.rows.set(b, held);
    }
    for (const k of Array.isArray(body.removed) ? body.removed : []) {
      const mint = String(k).includes(":") ? String(k).split(":").pop()! : String(k);
      held.delete(mint);
    }
    for (const t of body.tokens) {
      if (!t || t.chain !== "solana" || typeof t.address !== "string") continue;
      const obs = (t.marketObservedAt && typeof t.marketObservedAt === "object" ? t.marketObservedAt : {}) as Record<string, number>;
      // The feed's own times only, never this poll's: the window's marketObservedAt, else the row's updatedAt.
      const upd = typeof t.updatedAt === "number" ? t.updatedAt : null;
      const rv = (k: string, obsKey = k): RollingValue | null => (typeof t[k] === "number" && Number.isFinite(t[k]) ? { value: t[k], observedAt: typeof obs[obsKey] === "number" ? obs[obsKey] : upd } : null);
      const prev = held.get(t.address);
      const merged: FeedCoin = {
        mint: t.address,
        symbol: typeof t.symbol === "string" ? t.symbol : prev?.symbol ?? null,
        launchpad: typeof t.launchpad === "string" ? t.launchpad : prev?.launchpad ?? null,
        buckets: Array.isArray(t.buckets) ? t.buckets.filter((x: string) => (FEED_BUCKETS as readonly string[]).includes(x)) : prev?.buckets ?? [b],
        // An incremental row carries only what changed: keep the older value of a window it leaves out.
        volume5m: rv("volume5m") ?? prev?.volume5m ?? null,
        volume1h: rv("volume1h") ?? prev?.volume1h ?? null,
        volume24h: rv("volume24h") ?? prev?.volume24h ?? null,
        priceUsd: rv("priceUsd") ?? prev?.priceUsd ?? null,
        priceChange5m: rv("priceChange5m") ?? prev?.priceChange5m ?? null,
        buys5m: typeof t.buyCount5m === "number" ? t.buyCount5m : prev?.buys5m ?? null,
        sells5m: typeof t.sellCount5m === "number" ? t.sellCount5m : prev?.sells5m ?? null,
        liquidityUsd: typeof t.liquidityUsd === "number" ? t.liquidityUsd : prev?.liquidityUsd ?? null,
        marketCap: typeof t.marketCap === "number" ? t.marketCap : prev?.marketCap ?? null,
        seenAt: now,
        source: "candle-feed",
        complete: false,
      };
      held.set(t.address, merged);
    }
    if (typeof body.cursor === "string") this.cursors.set(b, body.cursor);
    // A full page may have left rows out: read the bucket in full next time, and say so.
    if (body.tokens.length >= 500) {
      this.cursors.delete(b);
      this.d.alerter.raise(`series:candle_feed_full_page:${b}`, `Candle feed: bucket ${b} answered a full page (500 rows); some rows may be missing until the next full read`);
    }
  }

  status(): Record<string, unknown> {
    return { buckets: this.o.buckets, coins: this.coins().length, lastOkAt: this.lastOkAt ? new Date(this.lastOkAt).toISOString() : null, failsInARow: this.fails };
  }
}
