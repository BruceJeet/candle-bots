/**
 * (batch 4) Follow chosen wallets on chain and decode their buys and sells (market/walletTrade).
 *
 *   const src = new WalletSource({ rpc, wsUrl, log });
 *   src.subscribe(["<wallet>", ...]);  await src.start();
 *   src.onNew = () => { for (const e of src.drain()) ...; for (const g of src.drainGaps()) ... };
 *
 * How it sees a wallet's transactions:
 *   - logsSubscribe with `mentions: [wallet]` (one subscription per wallet, core solana/logs-multi). A notification's
 *     logs are checked first: only a transaction that invokes a known venue or router is fetched (`prefilter`).
 *   - When a subscription is confirmed (at start, and after every reconnect), the signatures since the wallet's
 *     verified point are read with getSignaturesForAddress and fetched (`via: "backfill"`). The verified point is the
 *     newest signature up to which every signature of the wallet was listed by such a read (`since` at a restart).
 *     With no point yet (a first start), the newest signature at confirmation becomes it: watching starts there.
 *   - Without a websocket, the same read runs every `pollMs` (`via: "poll"`); with one, every `reconcileMs` as a safety
 *     net (a transaction the socket missed is logged, wallet_logs_missed).
 *   - Every fetch goes through one paced queue (`fetchPerSec`, a burst of `fetchBurst`, backoff on HTTP 429): the public
 *     RPC allowed a burst of about 10 getTransaction calls and then 1 per second (probe, Nov 7 2026).
 *
 * Gaps: a time the source could not see a wallet (socket down, a subscription not confirmed, a failed read) is a gap.
 * When the backfill reaches the anchor (or a signature older than the gap's start), the gap is recovered and nothing was
 * missed. When it cannot (more than `backfillLimit` signatures, a read that keeps failing, a transaction the node never
 * returns), the gap is reported unrecovered (drainGaps) and the wallet's next event says `complete: false`. A gap is
 * never reported as "no trades".
 *
 * Every (wallet, signature) is handled once per process (a bounded seen set): a transaction that touches two followed
 * wallets is decoded for each of them (fetched once: recent transactions are kept in a small cache). A consumer that must never act twice across
 * restarts keeps its own record of what it acted on (the mirror's ledger does) and passes the newest signature it
 * handled per wallet as `since`, so a restart backfills from there.
 */
import type { Logger } from "../log.ts";
import { multiLogs, type MultiLogsHandlers, type MultiLogsOptions, type MultiLogsSocket } from "../solana/logs-multi.ts";
import type { Rpc } from "../solana/rpc.ts";
import { decodeWalletTrade, logsInvokeVenue, logsShowTransfer, walletTokenDeltas, type WalletTrade } from "../market/walletTrade.ts";

export interface WalletEvent extends WalletTrade {
  /** False when the source missed something of this wallet (an unrecovered gap, an unread transaction) since its previous event. */
  complete: boolean;
  /** When the source decoded it (ms). */
  seenAtMs: number;
  via: "logs" | "backfill" | "poll" | "replay";
}

export interface WalletGap {
  wallet: string;
  /** When the source stopped seeing the wallet (ms; for an unanchored start, when watching began). */
  fromMs: number;
  /** When it could see it again (ms). */
  toMs: number;
  reason: string;
  /** True: the backfill read every transaction of the gap. False: some may be missing. */
  recovered: boolean;
  /** For an unrecovered gap: what was not read. */
  missing?: string;
}

/** (opt-in `transfers`) A followed wallet's token balance fell in a transaction that is not a trade (a transfer out). */
export interface WalletMove {
  wallet: string;
  mint: string;
  beforeRaw: bigint;
  afterRaw: bigint;
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Why the decoder did not take it as a trade. */
  reason: string;
}

/** A transaction of a followed wallet that is not a trade the decoder classifies (logged; counted per reason). */
export interface WalletSkip {
  wallet: string;
  signature: string;
  reason: string;
}

/** One fetched transaction as the recorder writes it (one JSON line each; ReplayWallets reads them back). */
export interface RecordedTx {
  at: number;
  wallet: string;
  signature: string;
  via: WalletEvent["via"];
  tx: unknown;
}

export interface Anchor {
  signature: string;
  /** Block time of that signature, seconds (lets a backfill stop by time when the anchor is far back). */
  blockTime?: number | null;
}

export interface WalletSourceOptions {
  rpc: Rpc;
  /** The RPC's websocket URL; absent or null: poll only. */
  wsUrl?: string | null;
  log: Logger;
  now?: () => number;
  /** Paced fetches: calls per second once the burst is spent (default 1), and the burst (default 8). */
  fetchPerSec?: number;
  fetchBurst?: number;
  /** Poll interval without a websocket (default 15 s). */
  pollMs?: number;
  /** With a websocket: a poll of each wallet this often, as a safety net (default 300 s; 0 = off). */
  reconcileMs?: number;
  /** Most signatures one backfill reads before it gives up and reports the gap (default 300). */
  backfillLimit?: number;
  /** Fetch only transactions whose logs invoke a known venue or router (default true; a backfill has no logs and fetches all). */
  prefilter?: boolean;
  /**
   * Also report token balances that fall without a trade (drainMoves): the pre-filter then lets token transfers through
   * too (more reads: any transfer to or from the wallet is fetched). Default false.
   */
  transfers?: boolean;
  /** Where each wallet's backfill starts at start (the consumer's newest handled signature). */
  since?: Record<string, Anchor>;
  /** getTransaction tries for a signature the node does not return yet (default 5, waits 0.5, 1, 2, 4 s). */
  fetchTries?: number;
  /** Most signatures remembered as handled (default 50,000). */
  maxSeen?: number;
  /** Called with each fetched transaction (a recorder). Must not throw (a throw is logged). */
  record?: (r: RecordedTx) => void;
  /** Tests: the socket factory (default core multiLogs) and its options. */
  socket?: (url: string, h: MultiLogsHandlers, o: MultiLogsOptions) => MultiLogsSocket;
  socketOptions?: MultiLogsOptions;
  /** Tests: the timer (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

interface WalletState {
  /** The newest signature known (queued or handled), with its slot; reads start after it. */
  head: Anchor & { slot: number } | null;
  /** Something of this wallet was missed since its last event. */
  dirty: boolean;
  /** An open gap: since when, why, and the head when it began (the backfill reads back to it); `ended`: it can be read now. */
  gap: Gap | null;
  /** A new gap that opened while the last one was being read: it becomes `gap` once that read is done. */
  nextGap: Gap | null;
  /** A backfill or poll of this wallet is running. */
  reading: boolean;
  /** Last poll or reconcile started (ms), and the last one that read everything. */
  polledAt: number;
  okAt: number;
  /** Every signature of the wallet up to this one was listed by a read (backfill, poll, reconcile): reads start here. */
  verified: Anchor | null;
  /** Jobs of this wallet in the fetch queue. */
  pending: number;
  /** The verified point at a moment no job of the wallet was queued: everything up to it was handled (restart point). */
  checkpoint: Anchor | null;
}

interface Gap {
  fromMs: number;
  reason: string;
  anchor: Anchor | null;
  ended: boolean;
  /** Failed reads of this gap so far, and when the next may run (ms). */
  tries: number;
  retryAt: number;
}

interface Job {
  wallet: string;
  signature: string;
  via: WalletEvent["via"];
  tries: number;
  notBefore: number;
}

const isRateLimit = (e: unknown) => {
  const c = (e as { code?: unknown })?.code;
  return c === "HTTP_429" || c === 429 || /429|rate/i.test(String((e as Error)?.message ?? ""));
};

/** What a consumer needs from a wallet source (WalletSource, or ReplayWallets in tests and replays). */
export interface WalletFeed {
  subscribe(wallets: string[]): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  drain(): WalletEvent[];
  drainGaps(): WalletGap[];
  /** (opt-in) Token balances that fell without a trade. */
  drainMoves?(): WalletMove[];
  /** Stop following these wallets. */
  unsubscribe?(wallets: string[]): void;
  onNew: (() => void) | null;
  head(wallet: string): Anchor | null;
  /** Where a restart should read back from (everything up to it read and handled). Optional: a feed without one is never resumed. */
  checkpoint?(wallet: string): Anchor | null;
  openGaps(): Array<{ wallet: string; fromMs: number; reason: string }>;
  watched(): string[];
  readonly stats?: unknown;
}

const key = (wallet: string, signature: string) => `${wallet}:${signature}`;

export class WalletSource implements WalletFeed {
  readonly o: Required<Pick<WalletSourceOptions, "fetchPerSec" | "fetchBurst" | "pollMs" | "reconcileMs" | "backfillLimit" | "prefilter" | "fetchTries" | "maxSeen">> & WalletSourceOptions;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private wallets = new Map<string, WalletState>();
  private seen = new Set<string>();
  /** Recently fetched transactions by signature: a transaction that touches several followed wallets is fetched once. */
  private txCache = new Map<string, unknown>();
  private queue: Job[] = [];
  private events: WalletEvent[] = [];
  private gapsOut: WalletGap[] = [];
  private movesOut: WalletMove[] = [];
  private socket: MultiLogsSocket | null = null;
  private running = false;
  private stopped = false;
  private tokens: number;
  private refillAt: number;
  private pausedUntil = 0;
  private backoffMs = 0;
  private wakeQueue: (() => void) | null = null;
  private loops: Promise<void>[] = [];
  private timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  /** Called (not awaited) when events or gaps are ready to drain. */
  onNew: (() => void) | null = null;
  readonly stats = { notifications: 0, prefiltered: 0, fetched: 0, trades: 0, skipped: 0, unread: 0, rateLimited: 0, readErrors: 0, backfills: 0, gapsRecovered: 0, gapsUnrecovered: 0, missedByLogs: 0, skipReasons: {} as Record<string, number> };

  constructor(o: WalletSourceOptions) {
    // An option given as undefined keeps its default.
    const given = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as WalletSourceOptions;
    this.o = { fetchPerSec: 1, fetchBurst: 8, pollMs: 15_000, reconcileMs: 300_000, backfillLimit: 300, prefilter: true, fetchTries: 5, maxSeen: 50_000, ...given };
    if (!(this.o.backfillLimit >= 1)) throw new Error("backfillLimit must be >= 1");
    if (!(this.o.fetchPerSec > 0)) throw new Error("fetchPerSec must be > 0");
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => this.timer(ms));
    this.tokens = this.o.fetchBurst;
    this.refillAt = this.now();
  }

  // ---------------------------------------------------------------- the interface

  /** Follow these wallets (added to those already followed). */
  subscribe(wallets: string[]): void {
    let added = false;
    for (const w of wallets) {
      if (this.wallets.has(w)) continue;
      const since = this.o.since?.[w];
      this.wallets.set(w, { head: since ? { ...since, slot: 0 } : null, dirty: false, gap: null, nextGap: null, reading: false, polledAt: 0, okAt: this.now(), verified: since ?? null, pending: 0, checkpoint: since ?? null });
      added = true;
    }
    if (added && this.running) this.attach();
  }

  unsubscribe(wallets: string[]): void {
    for (const w of wallets) this.wallets.delete(w);
    this.queue = this.queue.filter((j) => this.wallets.has(j.wallet));
    if (this.running) this.socket?.set([...this.wallets.keys()]);
  }

  watched(): string[] {
    return [...this.wallets.keys()];
  }

  /** The newest signature handled or queued per wallet (persist it; pass it back as `since`). */
  head(wallet: string): Anchor | null {
    const h = this.wallets.get(wallet)?.head;
    return h ? { signature: h.signature, blockTime: h.blockTime ?? null } : null;
  }

  /**
   * The point a restart should read back from (`since`): every signature of the wallet up to it was read and handled.
   * Behind `head` by design: it moves only when the wallet has nothing queued.
   */
  checkpoint(wallet: string): Anchor | null {
    const c = this.wallets.get(wallet)?.checkpoint;
    return c ? { signature: c.signature, blockTime: c.blockTime ?? null } : null;
  }

  /** Open gaps now (wallet, since when, why). */
  openGaps(): Array<{ wallet: string; fromMs: number; reason: string }> {
    return [...this.wallets].filter(([, s]) => s.gap).map(([w, s]) => ({ wallet: w, fromMs: s.gap!.fromMs, reason: s.gap!.reason }));
  }

  drain(): WalletEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  drainGaps(): WalletGap[] {
    const g = this.gapsOut;
    this.gapsOut = [];
    return g;
  }

  drainMoves(): WalletMove[] {
    const m = this.movesOut;
    this.movesOut = [];
    return m;
  }

  queued(): number {
    return this.queue.length;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.attach();
    this.loops.push(this.fetchLoop(), this.pollLoop());
  }

  /** Stop: the socket closes, timers end; an RPC call in flight is not waited for past `waitMs` (default 3 s). */
  async stop(waitMs = 3_000): Promise<void> {
    this.stopped = true;
    this.running = false;
    this.socket?.close();
    this.socket = null;
    for (const [t, r] of this.timers) {
      clearTimeout(t);
      r();
    }
    this.timers.clear();
    this.wakeQueue?.();
    let cap: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled(this.loops), new Promise<void>((r) => { cap = setTimeout(r, waitMs); })]);
    clearTimeout(cap);
  }

  /** A sleep that stop() ends early. */
  private timer(ms: number): Promise<void> {
    return new Promise<void>((r) => {
      if (this.stopped) return r();
      const t = setTimeout(() => {
        this.timers.delete(t);
        r();
      }, ms);
      this.timers.set(t, r);
    });
  }

  // ---------------------------------------------------------------- sources of signatures

  private attach(): void {
    const all = [...this.wallets.keys()];
    if (!this.o.wsUrl) {
      // Poll only: each wallet starts with a gap that its first poll closes (from its anchor, or from now).
      for (const w of all) this.openGap(w, "starting", this.now());
      return;
    }
    if (!this.socket) {
      const make = this.o.socket ?? multiLogs;
      this.socket = make(this.o.wsUrl, {
        onLogs: (e) => this.onLogs(e.address, e.signature, e.err, e.logs, e.slot),
        onGapStart: (a, reason, at) => this.openGap(a, reason, at),
        onGapEnd: (a) => {
          const g = this.state(a)?.gap;
          if (g) g.ended = true;
          void this.closeGap(a);
        },
        onState: (up, why) => this.o.log.info(up ? "wallets_socket_up" : "wallets_socket_down", why ? { why } : {}),
        onTrouble: (a, tries, why) => this.o.log.warn("wallets_subscribe_trouble", { wallet: a, tries, why }),
      }, { maxSubscriptions: 100, ...this.o.socketOptions });
    }
    const { overCap } = this.socket.set(all);
    for (const w of overCap) {
      this.o.log.warn("wallets_over_cap", { wallet: w });
      this.openGap(w, "over the subscription cap", this.now());
    }
  }

  private state(w: string): WalletState | undefined {
    return this.wallets.get(w);
  }

  private onLogs(wallet: string, signature: string, err: unknown, logs: string[], slot: number): void {
    const s = this.state(wallet);
    if (!s || this.seen.has(key(wallet, signature))) return;
    this.stats.notifications++;
    if (err !== null && err !== undefined) {
      this.markSeen(key(wallet, signature));
      this.advance(s, { signature, slot });
      return;
    }
    if (this.o.prefilter && !logsInvokeVenue(logs) && !(this.o.transfers && logsShowTransfer(logs)) && !logs.some((l) => l === "Log truncated")) {
      this.stats.prefiltered++;
      this.markSeen(key(wallet, signature));
      this.advance(s, { signature, slot });
      return;
    }
    // Arriving while a gap is open: the backfill will read back to the gap's anchor; this one is queued now.
    this.enqueue(wallet, signature, "logs", slot);
  }

  private openGap(wallet: string, reason: string, at: number): void {
    const s = this.state(wallet);
    if (!s) return;
    if (s.gap && !s.gap.ended) return; // still open: the first reason and start stand
    if (s.gap) {
      // The last gap is being read now: this one follows it, from the same anchor (what that read finds is skipped as seen).
      if (!s.nextGap) s.nextGap = { fromMs: at, reason, anchor: s.gap.anchor, ended: false, tries: 0, retryAt: 0 };
      return;
    }
    s.gap = { fromMs: at, reason, anchor: s.verified ?? (s.head ? { signature: s.head.signature, blockTime: s.head.blockTime ?? null } : null), ended: !this.o.wsUrl, tries: 0, retryAt: 0 };
    if (reason !== "subscribing" && reason !== "starting") this.o.log.info("wallet_gap_open", { wallet, reason, from: new Date(at).toISOString() });
  }

  /** The wallet can be seen again: read what happened since the gap's anchor. */
  private async closeGap(wallet: string): Promise<void> {
    const s = this.state(wallet);
    if (!s || !s.gap || !s.gap.ended || s.reading || this.now() < s.gap.retryAt) return;
    const gap = s.gap;
    s.reading = true;
    try {
      this.stats.backfills++;
      const r = await this.readSince(wallet, gap.anchor, "backfill");
      if (this.state(wallet) !== s) return;
      if (!r.ok && r.retry) {
        // The read itself failed (RPC down, rate limit past the pacer): the gap stays open and is read again later.
        gap.tries++;
        gap.retryAt = this.now() + Math.min(30_000, 1_000 * 2 ** Math.min(gap.tries - 1, 5));
        this.o.log.warn("wallet_backfill_retry", { wallet, tries: gap.tries, why: r.why });
        return;
      }
      const to = this.now();
      s.gap = s.nextGap;
      s.nextGap = null;
      if (r.ok) {
        s.okAt = to;
        s.verified = r.newest ?? gap.anchor ?? s.verified;
        this.mark(s);
      }
      if (r.ok) {
        // A start with no anchor reads nothing back: there is nothing before watching began to miss.
        if (gap.anchor || (gap.reason !== "subscribing" && gap.reason !== "starting")) {
          this.stats.gapsRecovered++;
          this.gapsOut.push({ wallet, fromMs: gap.fromMs, toMs: to, reason: gap.reason, recovered: true });
        }
      } else {
        // Reported once; the newest signatures were queued, and reads go on from the newest listed (not the old anchor,
        // which would report the same hole on every read).
        this.stats.gapsUnrecovered++;
        s.dirty = true;
        s.verified = r.newest ?? s.verified;
        this.mark(s);
        this.gapsOut.push({ wallet, fromMs: gap.fromMs, toMs: to, reason: gap.reason, recovered: false, missing: r.why });
        this.o.log.warn("wallet_gap_unrecovered", { wallet, reason: gap.reason, from: new Date(gap.fromMs).toISOString(), missing: r.why });
      }
      this.notify();
    } finally {
      s.reading = false;
    }
  }

  /**
   * Read the wallet's signatures newer than `anchor` (or, with no anchor, the newest one only, as the new anchor) and
   * queue those not seen, oldest first. ok: every signature since the anchor (or since `fromMs`) was listed.
   */
  private async readSince(wallet: string, anchor: Anchor | null, via: WalletEvent["via"]): Promise<{ ok: true; newest: Anchor | null } | { ok: false; why: string; retry: boolean; newest?: Anchor | null }> {
    const s = this.state(wallet);
    if (!s) return { ok: true, newest: null };
    const found: Array<{ signature: string; slot: number; err: unknown; blockTime: number | null }> = [];
    let before: string | undefined;
    let reached = false;
    const limit = anchor ? Math.min(100, this.o.backfillLimit) : 1;
    for (;;) {
      let page: any[];
      try {
        page = await this.call<any[]>("getSignaturesForAddress", [wallet, { limit, commitment: "confirmed", ...(anchor ? { until: anchor.signature } : {}), ...(before ? { before } : {}) }]);
      } catch (e) {
        return { ok: false, why: `signature list unreadable (${String((e as Error)?.message ?? e).slice(0, 120)})`, retry: true };
      }
      if (!Array.isArray(page)) return { ok: false, why: "signature list: bad answer", retry: true };
      for (const x of page) {
        if (typeof x?.signature !== "string") return { ok: false, why: "signature list: bad entry", retry: true };
        found.push({ signature: x.signature, slot: Number(x.slot ?? 0), err: x.err ?? null, blockTime: typeof x.blockTime === "number" ? x.blockTime : null });
      }
      if (!anchor) {
        reached = true;
        break;
      }
      if (page.length < limit) {
        reached = true; // the list ran out at the anchor
        break;
      }
      if (found.length >= this.o.backfillLimit) break;
      before = found[found.length - 1].signature;
    }
    if (!anchor) {
      // No anchor: the newest signature becomes it (nothing older is read: watching starts now).
      const n = found[0];
      if (n) this.advance(s, { signature: n.signature, slot: n.slot, blockTime: n.blockTime });
      for (const x of found) this.markSeen(key(wallet, x.signature));
      return { ok: true, newest: n ? { signature: n.signature, blockTime: n.blockTime } : null };
    }
    const newest = found[0] ? { signature: found[0].signature, blockTime: found[0].blockTime } : null;
    for (const x of found.reverse()) {
      if (this.seen.has(key(wallet, x.signature))) continue;
      if (x.err !== null) {
        this.markSeen(key(wallet, x.signature));
        this.advance(s, { signature: x.signature, slot: x.slot, blockTime: x.blockTime });
        continue;
      }
      if (via === "poll" && s.gap === null && this.o.wsUrl) {
        this.stats.missedByLogs++;
        this.o.log.warn("wallet_logs_missed", { wallet, signature: x.signature });
      }
      this.enqueue(wallet, x.signature, via, x.slot, x.blockTime);
    }
    return reached ? { ok: true, newest } : { ok: false, why: `more than ${this.o.backfillLimit} signatures since the last one read`, retry: false, newest };
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      const every = this.o.wsUrl ? this.o.reconcileMs : this.o.pollMs;
      if (every > 0) {
        for (const [w, s] of this.wallets) {
          if (this.stopped) return;
          if (s.reading) continue;
          // A gap whose end has come (socket confirmed again, or poll mode) is read now, whatever the interval.
          if (s.gap) {
            if (s.gap.ended) await this.closeGap(w);
            continue;
          }
          if (this.now() - s.polledAt < every) continue;
          s.polledAt = this.now();
          s.reading = true;
          let failed: { why: string; retry: boolean; newest?: Anchor | null } | null = null;
          const from = s.okAt;
          try {
            // From the verified point, not the head: a signature the socket skipped behind a newer one is still listed.
            const r = await this.readSince(w, s.verified ?? s.head, "poll");
            if (r.ok) {
              s.okAt = this.now();
              s.verified = r.newest ?? s.verified;
              this.mark(s);
            } else failed = r;
          } finally {
            s.reading = false;
          }
          if (!failed) continue;
          if (!failed.retry) {
            // More signatures than one read may take: the newest were queued, the rest are lost. Reported once; reads
            // go on from the newest listed.
            s.dirty = true;
            s.verified = failed.newest ?? s.verified;
            this.mark(s);
            s.okAt = this.now();
            this.stats.gapsUnrecovered++;
            this.gapsOut.push({ wallet: w, fromMs: from, toMs: this.now(), reason: this.o.wsUrl ? "reconcile" : "poll", recovered: false, missing: failed.why });
            this.o.log.warn("wallet_gap_unrecovered", { wallet: w, reason: "poll", missing: failed.why });
            this.notify();
          } else if (!this.o.wsUrl) {
            // Poll only: the failed read is a gap from the last read that covered everything; it is read back later.
            this.openGap(w, "poll failed", from);
          } else this.o.log.warn("wallet_reconcile_failed", { wallet: w, why: failed.why });
        }
      }
      await this.sleep(Math.max(250, Math.min(every || 1000, 1000)));
    }
  }

  // ---------------------------------------------------------------- the fetch queue

  /** The checkpoint follows the verified point whenever the wallet has nothing queued. */
  private mark(s: WalletState): void {
    if (s.pending === 0 && s.verified) s.checkpoint = s.verified;
  }

  private done(job: Job): void {
    const s = this.state(job.wallet);
    if (!s) return;
    s.pending = Math.max(0, s.pending - 1);
    this.mark(s);
  }

  private markSeen(sig: string): void {
    this.seen.add(sig);
    if (this.seen.size > this.o.maxSeen) {
      const drop = this.seen.size - this.o.maxSeen;
      let i = 0;
      for (const k of this.seen) {
        if (i++ >= drop) break;
        this.seen.delete(k);
      }
    }
  }

  private advance(s: WalletState, a: Anchor & { slot: number }): void {
    if (!s.head || a.slot >= s.head.slot) s.head = { signature: a.signature, slot: a.slot, blockTime: a.blockTime ?? s.head?.blockTime ?? null };
  }

  private enqueue(wallet: string, signature: string, via: WalletEvent["via"], slot: number, blockTime: number | null = null): void {
    const s = this.state(wallet);
    if (!s || this.seen.has(key(wallet, signature))) return;
    this.markSeen(key(wallet, signature));
    this.advance(s, { signature, slot, blockTime });
    this.queue.push({ wallet, signature, via, tries: 0, notBefore: 0 });
    s.pending++;
    this.wakeQueue?.();
  }

  /** One RPC call through the pacer: waits for a token; a 429 empties the bucket and backs off. */
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    for (;;) {
      if (this.stopped) throw new Error("stopped");
      const t = this.now();
      if (t < this.pausedUntil) {
        await this.sleep(this.pausedUntil - t);
        continue;
      }
      const refill = ((t - this.refillAt) / 1000) * this.o.fetchPerSec;
      if (refill > 0) {
        this.tokens = Math.min(this.o.fetchBurst, this.tokens + refill);
        this.refillAt = t;
      }
      if (this.tokens < 1) {
        await this.sleep(Math.ceil(((1 - this.tokens) / this.o.fetchPerSec) * 1000));
        continue;
      }
      this.tokens -= 1;
      try {
        const r = await this.o.rpc.call<T>(method, params);
        this.backoffMs = 0;
        return r;
      } catch (e) {
        if (!isRateLimit(e)) throw e;
        this.stats.rateLimited++;
        this.tokens = 0;
        this.backoffMs = Math.min(30_000, this.backoffMs ? this.backoffMs * 2 : 2_000);
        this.pausedUntil = this.now() + this.backoffMs;
        this.o.log.info("wallets_rate_limited", { method, backoffMs: this.backoffMs });
      }
    }
  }

  private async fetchLoop(): Promise<void> {
    while (!this.stopped) {
      const t = this.now();
      // Live notifications first: a long backfill must not age a fresh trade past a consumer's limit.
      let i = this.queue.findIndex((j) => j.notBefore <= t && j.via === "logs");
      if (i < 0) i = this.queue.findIndex((j) => j.notBefore <= t);
      if (i < 0) {
        const next = this.queue.length ? Math.max(10, Math.min(...this.queue.map((j) => j.notBefore)) - t) : 1000;
        await new Promise<void>((r) => {
          this.wakeQueue = r;
          void this.timer(next).then(r);
        });
        this.wakeQueue = null;
        continue;
      }
      const job = this.queue.splice(i, 1)[0];
      if (!this.wallets.has(job.wallet)) continue;
      await this.fetchOne(job);
    }
  }

  private async fetchOne(job: Job): Promise<void> {
    let tx: any = this.txCache.get(job.signature);
    if (tx) return this.deliver(job, tx);
    try {
      tx = await this.call("getTransaction", [job.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    } catch (e) {
      if (this.stopped) return;
      this.stats.readErrors++;
      return this.retry(job, `read failed (${String((e as Error)?.message ?? e).slice(0, 120)})`);
    }
    if (!tx) return this.retry(job, "not found");
    this.txCache.set(job.signature, tx);
    if (this.txCache.size > 256) this.txCache.delete(this.txCache.keys().next().value!);
    return this.deliver(job, tx);
  }

  private deliver(job: Job, tx: any): void {
    this.stats.fetched++;
    if (this.o.record) {
      try {
        this.o.record({ at: this.now(), wallet: job.wallet, signature: job.signature, via: job.via, tx });
      } catch (e) {
        this.o.log.warn("wallets_record_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }
    try {
      this.handle(job.wallet, job.signature, job.via, tx);
    } finally {
      this.done(job);
    }
  }

  private retry(job: Job, why: string): void {
    job.tries++;
    if (job.tries >= this.o.fetchTries) {
      this.stats.unread++;
      const s = this.state(job.wallet);
      if (s) s.dirty = true;
      this.o.log.warn("wallet_tx_unread", { wallet: job.wallet, signature: job.signature, why });
      this.gapsOut.push({ wallet: job.wallet, fromMs: this.now(), toMs: this.now(), reason: "transaction unread", recovered: false, missing: `${job.signature}: ${why}` });
      this.notify();
      this.done(job);
      return;
    }
    job.notBefore = this.now() + 500 * 2 ** (job.tries - 1);
    this.queue.push(job);
  }

  /** Decode one fetched transaction for its wallet (also the replay's entry point). */
  handle(wallet: string, signature: string, via: WalletEvent["via"], tx: any): WalletEvent | null {
    const s = this.state(wallet);
    if (!s) return null;
    const d = decodeWalletTrade(tx, wallet, signature);
    if (!d.ok) {
      this.stats.skipped++;
      this.stats.skipReasons[d.reason.replace(/ \(.*$/, "")] = (this.stats.skipReasons[d.reason.replace(/ \(.*$/, "")] ?? 0) + 1;
      this.o.log.info("wallet_tx_skipped", { wallet, signature, reason: d.reason });
      if (this.o.transfers) {
        for (const x of walletTokenDeltas(tx, wallet)) {
          if (x.afterRaw >= x.beforeRaw) continue;
          this.movesOut.push({ wallet, mint: x.mint, beforeRaw: x.beforeRaw, afterRaw: x.afterRaw, signature, slot: Number(tx?.slot ?? 0), blockTime: typeof tx?.blockTime === "number" ? tx.blockTime : null, reason: d.reason });
          this.notify();
        }
      }
      return null;
    }
    const e: WalletEvent = { ...d.trade, complete: !s.dirty, seenAtMs: this.now(), via };
    s.dirty = false;
    if (s.head && s.head.signature === signature && s.head.blockTime == null) s.head.blockTime = e.blockTime;
    this.stats.trades++;
    this.events.push(e);
    this.notify();
    return e;
  }

  private notify(): void {
    try {
      this.onNew?.();
    } catch (e) {
      this.o.log.warn("wallets_onnew_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
}
