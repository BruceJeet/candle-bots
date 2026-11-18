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
 *   coin quoted in something other than SOL.
 * - (0.8.0) A coin with no trade-log source is logged once per coin (`series_no_log_source`) and listed by
 *   `unreadable()`, not alerted: the watchlist drops such feed coins, and alerts a listed or pushed one itself. A
 *   transaction log that cannot be read to its end is logged once per coin (`series_log_unreadable`, with why it
 *   stopped, its line count and bytes) and counted in status (`logReads`: transactions read, partial, and partial by
 *   reason, all since start); its minute stays a gap.
 * - Stream cost: every notification's bytes are counted per coin (10 s buckets), and the socket's whole stream (every
 *   frame). A metered RPC bills that stream (Helius: 2 credits per 0.1 MB, uncompressed). Status `stream` gives the
 *   last hour's rate as MB and credits a day, and the busiest coins. With `maxCoinKbPerMin` set, a coin whose stream
 *   averaged more than that over the last `busyWindowMs` (or since it was subscribed, once that is `busyMinObsMs`) is
 *   listed by `busy()`: the watchlist drops such feed coins (a cost verdict, not a data gap; its bars are not touched).
 * Nothing is backfilled: a gap stays a gap.
 */
import type { Alerter } from "../alerts.ts";
import type { Logger } from "../log.ts";
import type { Rpc } from "../solana/rpc.ts";
import { readMarkets, type MarketRead } from "../market/reader.ts";
import { pumpCurve, pumpSwapPool } from "../solana/pda.ts";
import { readTrades, curveTradePrice, WSOL_MINT } from "../market/pumpEvents.ts";
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
  /** How often the chain's slot is read (getSlot, the same RPC) to judge how far the socket lags. */
  slotEveryMs?: number;
  /** A notification more than this many slots behind the chain marks every coin's bars incomplete (about 400 ms a slot). */
  maxSlotLag?: number;
  /**
   * A subscribed coin whose market price moved more than `silencePct` % from its price at the last trade log and stayed
   * moved for `silenceMs` with no log, has trades this socket did not deliver (a subscription the server dropped without saying): its bars
   * since the last log are a gap ("logs silent"), and it is subscribed again. Defaults 45 s and 1 %.
   */
  silenceMs?: number;
  silencePct?: number;
  /** A coin streaming more than this (KB a minute, averaged) is busy (see `busy()`). Unset or 0: never busy. */
  maxCoinKbPerMin?: number;
  /** The window the busy rate is averaged over (ms, default 10 min). */
  busyWindowMs?: number;
  /** A coin is judged busy only once this much of its stream is in the judged span (ms, default 60 s). */
  busyMinObsMs?: number;
  /**
   * The last this-long of the stream is left out of the busy rate (ms, default 3 min): a coin spiking now is judged on
   * its stream before the spike, so the cap never drops the coin the rule is about to fire on.
   */
  busySkipRecentMs?: number;
}

/** Stream bytes are counted in buckets this long (ms). */
const STREAM_BUCKET_MS = 10_000;

/** Socket gap reasons, closed when the subscription is confirmed. */
const SOCKET_REASONS = ["subscribing", "reconnect", "stalled", "subscription not confirmed", "subscription refused"];
/** Venue gap reasons (each "no trade log for venue X"): all closed once the coin has a log source. */
const VENUES = ["unknown", "curve", "damm", "pump-curve", "pumpswap"];

/** Reader problems that are verdicts on the coin (market/reader, market/pump), not read failures. */
const SETTLED_PROBLEMS = new Set(["no_venue", "pump_quote_not_sol", "pump_mayhem", "pump_pool_mismatch"]);

/** Remember a coin as logged; bounded (past 5,000 the oldest is forgotten, so it may be logged once more). */
function once(set: Set<string>, mint: string): void {
  set.add(mint);
  if (set.size > 5000) set.delete(set.values().next().value as string);
}

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
  /** Coins with no trade-log source (mint -> why). */
  private noSource = new Map<string, string>();
  /** Of those, the settled verdicts (not a curve between curve and pool): what `unreadable()` gives. */
  private settled = new Set<string>();
  /** Coins already logged once (no log source; a partial log), bounded. */
  private loggedNoSource = new Set<string>();
  private loggedPartial = new Set<string>();
  /** Since start: transactions read from the logs, how many only in part, and why (readTrades' reason). */
  private reads = { txs: 0, partial: 0, byReason: {} as Record<string, number> };
  /** Coins subscribed and not yet resolved (resolved on the next poll, without re-reading every coin's venue). */
  private fresh = new Set<string>();
  /** Transactions whose log could not be read to its end. */
  partialLogs = 0;
  /** The chain's slot as last read, and when; the socket's lag state. */
  private chainSlot: { slot: number; at: number } | null = null;
  private slotReadAt = 0;
  private behind = false;
  /** Per coin: the last trade log (any, a failed transaction too), the price then, and whether it is silent now. */
  private lastLogAt = new Map<string, number>();
  private refPrice = new Map<string, number>();
  private silent = new Set<string>();
  /** When the price first moved past silencePct since the last log (cleared by a log, or a return within the band). */
  private movedAt = new Map<string, number>();
  silentResubscribes = 0;
  /** Per coin: when its stream count began (its log address set), and bytes per STREAM_BUCKET_MS bucket. */
  private stream = new Map<string, { since: number; buckets: Map<number, number> }>();
  /** The socket's whole stream: (when, bytes received so far) samples, the last hour's. */
  private streamSamples: Array<{ at: number; bytes: number }> = [];

  constructor(d: LogsSeriesDeps, o: LogsSeriesOptions = {}) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.o = { maxSubscriptions: o.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS, maxCoins: o.maxCoins ?? 200, maxBars: o.maxBars ?? 1440, priceEveryMs: o.priceEveryMs ?? 5_000, venueEveryMs: o.venueEveryMs ?? 60_000, slotEveryMs: o.slotEveryMs ?? 30_000, maxSlotLag: o.maxSlotLag ?? 150, silenceMs: o.silenceMs ?? 45_000, silencePct: o.silencePct ?? 1, maxCoinKbPerMin: o.maxCoinKbPerMin ?? 0, busyWindowMs: o.busyWindowMs ?? 600_000, busyMinObsMs: o.busyMinObsMs ?? 60_000, busySkipRecentMs: o.busySkipRecentMs ?? 180_000 };
    this.store = d.store ?? new SeriesStore({ maxCoins: this.o.maxCoins, maxBars: this.o.maxBars, now: this.now });
    const handlers: MultiLogsHandlers = {
      onLogs: (e) => {
        this.countStream(e.address, e.bytes ?? 0);
        this.checkLag(e.slot);
        this.onLogs(e.address, e.signature, e.err, e.logs);
      },
      onGapStart: (a, reason, at) => {
        const m = this.mintOf.get(a);
        if (m) this.store.gapStart(m, reason.startsWith("subscription refused") ? "subscription refused" : reason, at);
      },
      onGapEnd: (a, at) => {
        const m = this.mintOf.get(a);
        if (m) for (const r of SOCKET_REASONS) this.store.gapEnd(m, r, at);
        // A silent coin's new subscription is confirmed: the missed span ends here (it is re-detected if it recurs).
        if (m && this.silent.delete(m)) {
          this.store.gapEnd(m, "logs silent", at);
          this.lastLogAt.set(m, at);
          this.refPrice.delete(m);
          this.movedAt.delete(m);
        }
      },
      onTrouble: (a, tries, why) => {
        const m = this.mintOf.get(a);
        this.d.alerter.raise(`series:sub_trouble:${a}`, `series: the trade-log subscription for ${m ?? a} failed ${tries} times in a row (${why}); its volume is unknown while it keeps retrying`);
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
      if (!this.store.watch(m, "logs")) {
        this.d.alerter.raise(`series:coin_cap:${m}`, `series: the coin cap (${this.o.maxCoins}) leaves ${m} unwatched`);
        continue;
      }
      // Until its address is known, a coin's minutes are a gap (a failed read must not leave them as true zeros).
      if (!this.addrOf.has(m)) this.store.gapStart(m, "resolving");
      // Watched while the socket is behind the chain: in that gap too.
      if (this.behind) this.store.gapStart(m, "socket behind chain");
      this.fresh.add(m);
    }
    // Only the new coins are resolved now; the others keep their own schedule.
    void this.tick();
  }

  unsubscribe(mints: string[]): void {
    const drop = new Set(mints);
    this.wanted = this.wanted.filter((m) => !drop.has(m));
    for (const m of mints) {
      this.store.unwatch(m);
      const a = this.addrOf.get(m);
      if (a) {
        this.mintOf.delete(a);
        this.poolMint.delete(a);
      }
      this.addrOf.delete(m);
      this.seen.delete(m);
      this.venueOf.delete(m);
      this.venueAt.delete(m);
      this.noSource.delete(m);
      this.settled.delete(m);
      this.fresh.delete(m);
      this.lastLogAt.delete(m);
      this.refPrice.delete(m);
      this.silent.delete(m);
      this.movedAt.delete(m);
      this.stream.delete(m);
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
      this.sampleStream();
      const coins = this.store.watched();
      if (!coins.length) return;
      await this.readSlot();
      const markets = await readMarkets(this.d.rpc, coins.map((m) => ({ mint: m, decimals: this.d.decimalsOf?.(m) ?? 6 })), this.now(), { pump: true });
      for (const m of coins) {
        const r = markets.get(m);
        if (!r) continue;
        if (r.priceSol !== null && !r.problem) {
          this.store.price(m, r.nowMs, r.priceSol);
          this.checkSilence(m, r.priceSol);
        }
        if (force || this.fresh.has(m) || !this.venueAt.has(m) || this.now() - (this.venueAt.get(m) ?? 0) >= this.o.venueEveryMs || this.venueOf.get(m) !== r.venue) this.resolve(m, r);
      }
      this.applySockets();
    } catch (e) {
      this.d.log.warn("series_read_failed", { error: String((e as Error)?.message ?? e).slice(0, 160) });
    }
  }

  /** The address a coin's trade logs come from, from its market read (venue found on chain). */
  private resolve(mint: string, r: MarketRead): void {
    this.fresh.delete(mint);
    // The venue is known now: the "resolving" gap ends (a missing log source keeps its own gap below).
    this.store.gapEnd(mint, "resolving");
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
      // No trade-log source for this venue in this version: price only (when readable), volume unknown.
      const why = r.venue === "unknown" ? `no pump.fun curve or canonical PumpSwap pool found${r.problem ? ` (${r.problem})` : ""}` : `on ${r.venue === "curve" ? "the Candle curve" : r.venue === "damm" ? "a DAMM v2 pool" : r.venue}`;
      this.store.gapStart(mint, `no trade log for venue ${r.venue}`);
      this.noSource.set(mint, why);
      // Settled only on what the chain said: a Candle curve or DAMM v2 venue read, or a pump verdict (no curve or pool,
      // quoted in another token, mayhem, a pool of another coin). A failed or partial read (an RPC error, a vault batch
      // that did not come back, a decode error) and a migrating curve are not verdicts: the coin stays.
      if (r.venue === "curve" || r.venue === "damm" || (r.venue === "unknown" && SETTLED_PROBLEMS.has(r.problem ?? ""))) this.settled.add(mint);
      else this.settled.delete(mint);
      if (!this.loggedNoSource.has(mint)) {
        once(this.loggedNoSource, mint);
        this.d.log.info("series_no_log_source", { mint, venue: r.venue, why, settled: this.settled.has(mint) });
      }
    } else {
      // A log source now: every venue gap closes (a coin can pass through several, e.g. unknown, then the pool).
      for (const v of VENUES) this.store.gapEnd(mint, `no trade log for venue ${v}`);
      this.noSource.delete(mint);
      this.settled.delete(mint);
    }
    const old = this.addrOf.get(mint);
    if (old !== addr) {
      if (old) this.mintOf.delete(old);
      if (addr) {
        this.addrOf.set(mint, addr);
        this.mintOf.set(addr, mint);
        // A new log address: its stream is counted from here (a venue change starts the count again).
        this.stream.set(mint, { since: this.now(), buckets: new Map() });
      } else {
        this.addrOf.delete(mint);
        this.stream.delete(mint);
      }
    }
  }

  /**
   * A subscribed coin whose price has stayed more than silencePct away from its price at the last log for silenceMs,
   * with no log since it moved: trades the socket did not deliver. The clock starts when the price first moves (a
   * quiet coin's first trade after a long silence moves the price a poll before its log arrives: not a verdict). The gap
   * starts at the last log (honest if the subscription really dropped); the coin is subscribed again in place.
   */
  private checkSilence(mint: string, price: number): void {
    const addr = this.addrOf.get(mint);
    if (!addr || !this.socket.held().includes(addr)) return;
    const now = this.now();
    if (!this.lastLogAt.has(mint)) this.lastLogAt.set(mint, now);
    const ref = this.refPrice.get(mint);
    if (ref === undefined || !(ref > 0)) {
      this.refPrice.set(mint, price);
      return;
    }
    if (this.silent.has(mint)) return;
    if (Math.abs(price / ref - 1) * 100 <= this.o.silencePct) {
      this.movedAt.delete(mint); // back within the band: not a move
      return;
    }
    const moved = this.movedAt.get(mint) ?? now;
    this.movedAt.set(mint, moved);
    if (now - moved < this.o.silenceMs) return;
    const since = this.lastLogAt.get(mint)!;
    this.silent.add(mint);
    this.movedAt.delete(mint);
    this.silentResubscribes++;
    this.store.gapStart(mint, "logs silent", since);
    this.d.alerter.raise(`series:logs_silent:${mint}`, `series: ${mint}'s price moved ${(Math.abs(price / ref - 1) * 100).toFixed(1)} % and stayed moved ${Math.round((now - moved) / 1000)} s with no trade log (last ${Math.round((now - since) / 1000)} s ago: a subscription the server dropped?): its bars since its last log are a gap; subscribing again`);
    this.d.log.warn("series_logs_silent", { mint, movedForMs: now - moved, sinceLogMs: now - since, ref, price });
    if (this.socket.resubscribe) this.socket.resubscribe(addr);
    else {
      this.socket.set(this.socket.held().filter((a) => a !== addr));
      this.applySockets();
    }
  }

  /** The chain's slot, every slotEveryMs (a failed read leaves the last one; no verdict without one). */
  private async readSlot(): Promise<void> {
    if (this.now() - this.slotReadAt < this.o.slotEveryMs) return;
    this.slotReadAt = this.now();
    try {
      const v = await this.d.rpc.call<number>("getSlot", [{ commitment: "confirmed" }]);
      if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) this.chainSlot = { slot: v, at: this.now() };
    } catch (e) {
      this.d.log.warn("series_slot_unreadable", { error: String((e as Error)?.message ?? e).slice(0, 160) });
    }
  }

  /**
   * A notification's slot against the chain's (the last getSlot, moved on at about 400 ms a slot). Past maxSlotLag: the
   * socket is behind, every coin's bars are incomplete until a notification comes in within the limit again.
   */
  private checkLag(slot: number): void {
    if (!this.chainSlot || !(slot > 0)) return;
    const est = this.chainSlot.slot + Math.floor((this.now() - this.chainSlot.at) / 400);
    const lag = est - slot;
    if (lag > this.o.maxSlotLag) {
      if (!this.behind) {
        this.behind = true;
        // The lag says how long the socket has been behind: the gap starts that long ago (about 400 ms a slot).
        this.store.gapStart(null, "socket behind chain", this.now() - lag * 400);
        this.d.alerter.raise("series:socket_behind", `trade-log socket is ${lag} slots behind the chain (limit ${this.o.maxSlotLag}, about ${Math.round((lag * 0.4))} s): every coin's bars are incomplete until it catches up`);
        this.d.log.warn("series_socket_behind", { lag, slot, chainSlot: est });
      }
    } else if (this.behind) {
      this.behind = false;
      this.store.gapEnd(null, "socket behind chain");
      this.d.log.info("series_socket_caught_up", { lag });
    }
  }

  /** A notification's bytes, on its coin's current bucket (a failed transaction's too: it is billed). */
  private countStream(address: string, bytes: number): void {
    const mint = this.mintOf.get(address);
    const s = mint ? this.stream.get(mint) : undefined;
    if (!s || !(bytes > 0)) return;
    const now = this.now();
    const b = now - (now % STREAM_BUCKET_MS);
    s.buckets.set(b, (s.buckets.get(b) ?? 0) + bytes);
    // Keep the window's buckets only (and the one in progress).
    const keep = now - this.o.busyWindowMs - STREAM_BUCKET_MS;
    for (const k of s.buckets.keys()) {
      if (k >= keep) break;
      s.buckets.delete(k);
    }
  }

  /**
   * A coin's stream rate, KB a minute: over [the window's start (or when its count began), now], or with `skipRecent`
   * over the same span less its last busySkipRecentMs. Whole buckets only. Null while the span is under busyMinObsMs.
   */
  private kbPerMin(mint: string, skipRecent = false): number | null {
    const s = this.stream.get(mint);
    if (!s) return null;
    const now = this.now();
    const end = skipRecent ? now - this.o.busySkipRecentMs : now;
    const start = Math.max(s.since, now - this.o.busyWindowMs);
    const span = end - start;
    if (span < this.o.busyMinObsMs) return null;
    let bytes = 0;
    // A bucket counts when it ends inside the span (without skipRecent, the one in progress too).
    for (const [k, v] of s.buckets) if (k + STREAM_BUCKET_MS > start && (!skipRecent || k + STREAM_BUCKET_MS <= end)) bytes += v;
    return bytes / 1024 / (span / 60_000);
  }

  /** The socket's bytes so far, sampled each poll; samples older than an hour are dropped (one kept as the base). */
  private sampleStream(): void {
    const total = this.socket.bytesReceived?.();
    if (typeof total !== "number") return;
    const now = this.now();
    this.streamSamples.push({ at: now, bytes: total });
    while (this.streamSamples.length > 2 && now - this.streamSamples[1].at >= 3_600_000) this.streamSamples.shift();
  }

  /**
   * Watched coins whose stream averaged more than maxCoinKbPerMin (mint -> why). A cost verdict for the watchlist: a
   * feed coin here is dropped and looked at again later; a listed or pushed (held) coin is kept. Empty when unset.
   */
  busy(): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    const cap = this.o.maxCoinKbPerMin;
    if (!(cap > 0)) return out;
    for (const m of this.stream.keys()) {
      if (!this.store.isWatched(m)) continue;
      const r = this.kbPerMin(m, true);
      if (r !== null && r > cap) out.set(m, `stream ${Math.round(r)} KB/min over ${cap} KB/min`);
    }
    return out;
  }

  /** The stream's cost: since start, the last hour as MB and Helius credits a day, the busiest coins now. */
  private streamStatus(): Record<string, unknown> {
    const total = this.socket.bytesReceived?.() ?? null;
    const a = this.streamSamples[0];
    const z = this.streamSamples[this.streamSamples.length - 1];
    const span = a && z ? z.at - a.at : 0;
    const mbPerDay = span >= 60_000 ? Math.round((((z.bytes - a.bytes) / span) * 86_400_000) / 1e6) : null;
    const top = [...this.stream.keys()]
      .map((m) => ({ mint: m, kbPerMin: this.kbPerMin(m) }))
      .filter((x): x is { mint: string; kbPerMin: number } => x.kbPerMin !== null)
      .sort((x, y) => y.kbPerMin - x.kbPerMin)
      .slice(0, 5)
      .map((x) => ({ mint: x.mint, kbPerMin: Math.round(x.kbPerMin) }));
    return { mbSinceStart: total === null ? null : Math.round(total / 1e6), mbPerDay, heliusCreditsPerDay: mbPerDay === null ? null : mbPerDay * 20, overMinutes: Math.round(span / 60_000), maxCoinKbPerMin: this.o.maxCoinKbPerMin || null, busy: this.busy().size, top };
  }

  /** Watched coins with no trade-log source, settled verdicts only (see SeriesSource.unreadable). */
  unreadable(): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const m of this.settled) if (this.store.isWatched(m) && this.noSource.has(m)) out.set(m, this.noSource.get(m)!);
    return out;
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
    if (mint) {
      // The subscription delivers: the silence clock restarts at the price now.
      this.lastLogAt.set(mint, this.now());
      this.refPrice.delete(mint);
      this.movedAt.delete(mint);
      if (this.silent.delete(mint)) this.store.gapEnd(mint, "logs silent");
    }
    if (!mint || err) return; // a failed transaction counts no volume
    const seen = this.seen.get(mint) ?? new Set<string>();
    if (seen.has(signature)) return; // one transaction, counted once
    seen.add(signature);
    if (seen.size > 2000) seen.delete(seen.values().next().value as string);
    this.seen.set(mint, seen);
    const at = this.now();
    const read = readTrades(logs, err);
    this.reads.txs++;
    if (read.partial) {
      // Part of this transaction's log could not be read: a trade may be missing, so this minute is unknown.
      const m0 = at - (at % this.store.barMs);
      this.store.gap(mint, m0, m0 + this.store.barMs, "log unreadable");
      this.partialLogs++;
      this.reads.partial++;
      const reason = read.reason ?? "unknown";
      this.reads.byReason[reason] = (this.reads.byReason[reason] ?? 0) + 1;
      // Logged once per coin (the counts are in status), not alerted: a data gap, not something to act on.
      if (!this.loggedPartial.has(mint)) {
        once(this.loggedPartial, mint);
        this.d.log.info("series_log_unreadable", { mint, signature, reason, lines: logs.length, bytes: logs.reduce((n, l) => n + l.length + 1, 0), tradesBeforeStop: read.trades.length, partialLogs: this.partialLogs });
      }
    }
    for (const t of read.trades) {
      if (t.kind === "pump-curve") {
        if (t.mint !== mint) continue;
        if (t.quoteMint === "") {
          // One event this reader could not read to its quote: that minute is unknown (a closed gap, as a partial log).
          const m0 = at - (at % this.store.barMs);
          this.store.gap(mint, m0, m0 + this.store.barMs, "trade quote unreadable");
          continue;
        }
        if (t.quoteMint !== WSOL_MINT) {
          // The coin trades against another quote: its SOL volume is never known while watched (an open gap by design).
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
    return { watched: this.store.watched().length, subscribed: this.socket.held().length, up: this.socket.isUp(), maxSubscriptions: this.o.maxSubscriptions, maxCoins: this.o.maxCoins, behindChain: this.behind, partialLogs: this.partialLogs, logReads: { txs: this.reads.txs, partial: this.reads.partial, byReason: { ...this.reads.byReason } }, silent: [...this.silent], silentResubscribes: this.silentResubscribes, noTradeLogSource: Object.fromEntries(this.noSource), stream: this.streamStatus() };
  }
}
