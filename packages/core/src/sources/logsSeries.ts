/**
 * (0.6.0) A SeriesSource fed by on-chain trade logs (pump curve and PumpSwap) and on-chain market reads.
 *
 * - Volume: each coin's own subscription (its pump curve PDA while on the curve, its canonical PumpSwap pool once
 *   migrated), the trade events in each successful transaction (a failed one counts nothing). Commitment: confirmed.
 * - Price: the core's market reads (readMarkets with pump venues: the curve's and the pool's effective reserves), every
 *   `priceEveryMs`, for every watched coin in one batch. A curve trade's own post-trade price is used too.
 * - The pool-to-mint map comes from the pool account as read (its base mint must be the coin, its quote WSOL), never
 *   from an event.
 * - Gaps (sources/series): a coin still subscribing, a reconnect, a subscription refused or not confirmed, the
 *   subscription cap, the coin cap, a venue with no trade-log source in this version (the Candle curve, DAMM v2), a
 *   coin quoted in something other than SOL. Each is alerted once per coin and reason.
 * Nothing is backfilled: a gap stays a gap.
 */
import type { Alerter } from "../alerts.ts";
import type { Logger } from "../log.ts";
import type { Rpc } from "../solana/rpc.ts";
import { readMarkets, type MarketRead } from "../market/reader.ts";
import { pumpCurve, pumpSwapPool } from "../solana/pda.ts";
import { tradesFromLogs, curveTradePrice, WSOL_MINT } from "../market/pumpEvents.ts";
import { multiLogs, DEFAULT_MAX_SUBSCRIPTIONS, type MultiLogsOptions, type MultiLogsSocket, type MultiLogsHandlers } from "../solana/logs-multi.ts";
import { SeriesStore, type SeriesSource, type SeriesView } from "./series.ts";

export interface LogsSeriesDeps {
  rpc: Rpc;
  wsUrl: string;
  log: Logger;
  alerter: Alerter;
  store?: SeriesStore;
  now?: () => number;
  /** Test seam: the socket. */
  socket?: (h: MultiLogsHandlers, o: MultiLogsOptions) => MultiLogsSocket;
  decimalsOf?: (mint: string) => number;
}

export interface LogsSeriesOptions {
  maxSubscriptions?: number;
  maxCoins?: number;
  maxBars?: number;
  priceEveryMs?: number;
  /** How often each coin's venue is read again (a curve coin migrates to its pool). */
  venueEveryMs?: number;
}

/** Socket gap reasons, closed when the subscription is confirmed. */
const SOCKET_REASONS = ["subscribing", "reconnect", "subscription not confirmed", "subscription refused"];

export class LogsSeries implements SeriesSource {
  readonly store: SeriesStore;
  private d: LogsSeriesDeps;
  private o: Required<LogsSeriesOptions>;
  private now: () => number;
  private socket: MultiLogsSocket;
  /** mint -> the address its logs come from; address -> mint. */
  private addrOf = new Map<string, string>();
  private mintOf = new Map<string, string>();
  /** Verified PumpSwap pool -> its coin (from the pool account). */
  private poolMint = new Map<string, string>();
  private venueOf = new Map<string, string>();
  private venueAt = new Map<string, number>();
  private wanted: string[] = [];
  private seen = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(d: LogsSeriesDeps, o: LogsSeriesOptions = {}) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.o = { maxSubscriptions: o.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS, maxCoins: o.maxCoins ?? 200, maxBars: o.maxBars ?? 1440, priceEveryMs: o.priceEveryMs ?? 5_000, venueEveryMs: o.venueEveryMs ?? 60_000 };
    this.store = d.store ?? new SeriesStore({ maxCoins: this.o.maxCoins, maxBars: this.o.maxBars, now: this.now });
    const handlers: MultiLogsHandlers = {
      onLogs: (e) => this.onLogs(e.address, e.signature, e.err, e.logs),
      onGapStart: (a, reason, at) => {
        const m = this.mintOf.get(a);
        if (m) this.store.gapStart(m, reason.startsWith("subscription refused") ? "subscription refused" : reason, at);
      },
      onGapEnd: (a, at) => {
        const m = this.mintOf.get(a);
        if (m) for (const r of SOCKET_REASONS) this.store.gapEnd(m, r, at);
      },
      onState: (up, why) => {
        if (!up && this.wanted.length) this.d.alerter.raise("series:logs_down", `trade-log socket down (${why ?? "?"}): ${this.wanted.length} coins have a gap until it reconnects`);
        this.d.log.info("series_logs_state", { up, why });
      },
    };
    const opts: MultiLogsOptions = { maxSubscriptions: this.o.maxSubscriptions, commitment: "confirmed", now: this.now };
    this.socket = d.socket ? d.socket(handlers, opts) : multiLogs(d.wsUrl, handlers, opts);
  }

  /** Start the price and venue polls (a test drives `tick()` itself instead). */
  start(): void {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), this.o.priceEveryMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket.close();
  }

  series(mint: string): SeriesView | null {
    return this.store.series(mint);
  }

  watched(): string[] {
    return this.store.watched();
  }

  subscribe(mints: string[]): void {
    const next = [...new Set([...this.wanted, ...mints])];
    this.wanted = next;
    for (const m of mints) {
      if (!this.store.watch(m, "logs")) this.d.alerter.raise(`series:coin_cap:${m}`, `series: the coin cap (${this.o.maxCoins}) leaves ${m} unwatched`);
    }
    void this.tick(true);
  }

  unsubscribe(mints: string[]): void {
    const drop = new Set(mints);
    this.wanted = this.wanted.filter((m) => !drop.has(m));
    for (const m of mints) {
      this.store.unwatch(m);
      const a = this.addrOf.get(m);
      if (a) this.mintOf.delete(a);
      this.addrOf.delete(m);
      this.seen.delete(m);
    }
    this.applySockets();
  }

  /** One poll: venues (new coins, and every venueEveryMs), then prices, then the subscriptions. Never throws. */
  tick(force = false): Promise<void> {
    // One poll at a time; a caller during one waits for it (and a forced one runs right after).
    if (this.inflight) return force ? this.inflight.then(() => this.tick(true)) : this.inflight;
    this.inflight = this.poll(force).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async poll(force: boolean): Promise<void> {
    try {
      const coins = this.store.watched();
      if (!coins.length) return;
      const markets = await readMarkets(this.d.rpc, coins.map((m) => ({ mint: m, decimals: this.d.decimalsOf?.(m) ?? 6 })), this.now(), { pump: true });
      for (const m of coins) {
        const r = markets.get(m);
        if (!r) continue;
        if (r.priceSol !== null && !r.problem) this.store.price(m, r.nowMs, r.priceSol);
        if (force || !this.venueAt.has(m) || this.now() - (this.venueAt.get(m) ?? 0) >= this.o.venueEveryMs || this.venueOf.get(m) !== r.venue) this.resolve(m, r);
      }
      this.applySockets();
    } catch (e) {
      this.d.log.warn("series_read_failed", { error: String((e as Error)?.message ?? e).slice(0, 160) });
    }
  }

  /** The address a coin's trade logs come from, from its market read (venue found on chain). */
  private resolve(mint: string, r: MarketRead): void {
    this.venueAt.set(mint, this.now());
    const prev = this.venueOf.get(mint);
    this.venueOf.set(mint, r.venue);
    let addr: string | null = null;
    if (r.venue === "pump-curve") addr = pumpCurve(mint);
    else if (r.venue === "pumpswap" && r.pumpPool) {
      const p = r.pumpPool.pool;
      // The pool's own account names its coin: only then is the pool mapped to it.
      // The reader reads the canonical pool PDA; its account must name this coin as base and WSOL as quote.
      if (p.baseMint === mint && p.quoteMint === WSOL_MINT) {
        addr = pumpSwapPool(mint);
        this.poolMint.set(addr, mint);
      }
    }
    if (prev && prev !== r.venue) this.d.log.info("series_venue_changed", { mint, from: prev, to: r.venue });
    if (!addr) {
      // No trade-log source for this venue in this version: price only, volume unknown.
      this.store.gapStart(mint, `no trade log for venue ${r.venue}`);
      this.d.alerter.raise(`series:no_log_source:${mint}:${r.venue}`, `series: ${mint} is on ${r.venue}; this version reads trade logs for pump.fun curves and PumpSwap only, so its volume is unknown`);
    } else this.store.gapEnd(mint, `no trade log for venue ${prev ?? r.venue}`);
    const old = this.addrOf.get(mint);
    if (old !== addr) {
      if (old) this.mintOf.delete(old);
      if (addr) {
        this.addrOf.set(mint, addr);
        this.mintOf.set(addr, mint);
      } else this.addrOf.delete(mint);
    }
  }

  private applySockets(): void {
    const addrs = this.store.watched().map((m) => this.addrOf.get(m)).filter((a): a is string => !!a);
    const { overCap } = this.socket.set(addrs);
    const over = new Set(overCap);
    for (const [m, a] of this.addrOf) {
      if (over.has(a)) {
        this.store.gapStart(m, "subscription cap");
        this.d.alerter.raise(`series:sub_cap:${m}`, `series: the subscription cap (${this.o.maxSubscriptions}) leaves ${m}'s trades unwatched (volume unknown)`);
      } else this.store.gapEnd(m, "subscription cap");
    }
  }

  private onLogs(address: string, signature: string, err: unknown, logs: string[]): void {
    const mint = this.mintOf.get(address);
    if (!mint || err) return; // a failed transaction counts no volume
    const seen = this.seen.get(mint) ?? new Set<string>();
    if (seen.has(signature)) return; // one transaction, counted once
    seen.add(signature);
    if (seen.size > 2000) seen.delete(seen.values().next().value as string);
    this.seen.set(mint, seen);
    const at = this.now();
    for (const t of tradesFromLogs(logs, err)) {
      if (t.kind === "pump-curve") {
        if (t.mint !== mint) continue;
        if (t.quoteMint !== WSOL_MINT) {
          this.store.gapStart(mint, "not quoted in SOL");
          continue;
        }
        this.store.trade(mint, { at, volume: Number(t.quoteAmount) / 1e9, side: t.side, price: curveTradePrice(t, this.d.decimalsOf?.(mint) ?? 6) });
      } else {
        if (this.poolMint.get(t.pool) !== mint) continue; // another pool in the same transaction
        this.store.trade(mint, { at, volume: Number(t.quoteAmount) / 1e9, side: t.side });
      }
    }
  }

  status(): Record<string, unknown> {
    return { watched: this.store.watched().length, subscribed: this.socket.held().length, up: this.socket.isUp(), maxSubscriptions: this.o.maxSubscriptions, maxCoins: this.o.maxCoins };
  }
}
