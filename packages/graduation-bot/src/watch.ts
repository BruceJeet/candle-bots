/**
 * Graduation detection. Coins come from the core's Candle launch source (Candle's token list and the chain); their
 * curves are read together every `curvePollMs` (getMultipleAccounts, 100 a call). A coin graduates when its curve says
 * migrated and its DAMM v2 pool (the PDA Candle's keeper creates) exists with the curve's authority as creator. The
 * graduation time is the block time of the pool's activation slot; when that cannot be read, the time the bot first
 * saw the coin migrated, but only if it saw the same coin still on its curve before (so a restart never mistakes an old
 * graduation for a new one). Each mint is reported once. Nothing here can throw into the engine loop.
 */
import { decodeCandleCurve, decodeDamm, type CandleCurve, type DammPool } from "candle-bot-core/market/curve";
import { candleCurve, dammPool } from "candle-bot-core/solana/pda";
import { getAccounts, type Rpc } from "candle-bot-core/solana/rpc";
import type { Launch } from "candle-bot-core/sources/candleLaunches";
import type { Logger } from "candle-bot-core/log";

/** What the watch needs from a launch source (the core's CandleLaunches; a fake in tests). */
export interface LaunchSource {
  start(): Promise<void>;
  stop(): void;
  drain(): Launch[];
  get(mint: string): Launch | undefined;
  onNew: (() => void) | null;
  readonly stats?: unknown;
}

export interface Graduation {
  mint: string;
  /** The pool's opening (block time of its activation slot), else when the bot saw it migrated; null if unknown. */
  graduatedAtMs: number | null;
  graduatedAtSource: "activation_slot" | "first_seen" | null;
  detectedAtMs: number;
  launch: Launch;
  pool: string;
  curve: string;
}

interface Watched {
  launch: Launch;
  addedAtMs: number;
  /** The bot read this coin's curve before it migrated. */
  seenOnCurve: boolean;
  /** Reads that found no curve account yet (a launch just seen may not be served yet). */
  missing: number;
}

export interface WatchOptions {
  curvePollMs: number;
  watchHours: number;
  maxWatched: number;
}

export interface WatchDeps {
  rpc: Rpc;
  source: LaunchSource;
  log: Logger;
  now?: () => number;
}

const MISSING_DROP = 30;

export class GraduationWatch {
  private watched = new Map<string, Watched>();
  private reported = new Set<string>();
  private queue: Graduation[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  readonly stats = { ticks: 0, errors: 0, graduations: 0, lastOkMs: 0, watched: 0 };
  /** Called when a graduation is queued (the trigger wakes the engine with it). Never throws into the watch. */
  onNew: (() => void) | null = null;
  private d: WatchDeps;
  private o: WatchOptions;
  private now: () => number;

  constructor(d: WatchDeps, o: WatchOptions) {
    this.d = d;
    this.o = o;
    this.now = d.now ?? Date.now;
  }

  async start(opts: { timer?: boolean } = {}): Promise<void> {
    await this.d.source.start();
    if (opts.timer === false) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.o.curvePollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.d.source.stop();
  }

  drain(): Graduation[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  watching(): number {
    return this.watched.size;
  }

  /** One round: take new launches, read every watched curve, report graduations. Single flight. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } finally {
      this.ticking = false;
    }
  }

  private add(l: Launch): void {
    if (this.reported.has(l.mint) || this.watched.has(l.mint)) return;
    this.watched.set(l.mint, { launch: l, addedAtMs: this.now(), seenOnCurve: false, missing: 0 });
    // Bounded: the oldest watched coins go first.
    while (this.watched.size > this.o.maxWatched) {
      const first = this.watched.keys().next().value as string;
      this.watched.delete(first);
    }
  }

  private async tickOnce(): Promise<void> {
    this.stats.ticks++;
    for (const l of this.d.source.drain()) this.add(this.d.source.get(l.mint) ?? l);
    const now = this.now();
    const maxAge = this.o.watchHours * 3_600_000;
    for (const [mint, w] of this.watched) {
      const born = w.launch.launchedAtMs ?? w.addedAtMs;
      if (now - born > maxAge) this.watched.delete(mint);
    }
    this.stats.watched = this.watched.size;
    if (!this.watched.size) return;
    const mints = [...this.watched.keys()];
    let curves: Array<unknown>;
    try {
      curves = await getAccounts(this.d.rpc, mints.map((m) => this.watched.get(m)!.launch.curve ?? candleCurve(m)));
    } catch (e) {
      this.stats.errors++;
      if (this.stats.errors % 20 === 1) this.d.log.warn("curve_poll_failed", { error: String((e as Error)?.message ?? e).slice(0, 200), errors: this.stats.errors });
      return;
    }
    this.stats.lastOkMs = this.now();
    const migrated: Array<{ mint: string; curve: CandleCurve }> = [];
    mints.forEach((mint, i) => {
      const w = this.watched.get(mint)!;
      if (!curves[i]) {
        if (++w.missing >= MISSING_DROP) this.watched.delete(mint);
        return;
      }
      let c: CandleCurve;
      try {
        c = decodeCandleCurve(curves[i] as any);
      } catch {
        this.watched.delete(mint); // not a Candle curve: never one
        return;
      }
      if (c.baseMint !== mint) {
        this.watched.delete(mint);
        return;
      }
      if (!c.migrated) w.seenOnCurve = true;
      else migrated.push({ mint, curve: c });
    });
    if (!migrated.length) return;
    let pools: Array<unknown>;
    try {
      pools = await getAccounts(this.d.rpc, migrated.map((m) => dammPool(m.mint)));
    } catch (e) {
      this.stats.errors++;
      return;
    }
    for (let i = 0; i < migrated.length; i++) {
      const { mint, curve } = migrated[i];
      const w = this.watched.get(mint);
      if (!w || !pools[i]) continue; // migrating: the pool is not there yet; read again next round
      let pool: DammPool;
      try {
        pool = decodeDamm(pools[i] as any);
      } catch {
        continue;
      }
      if (pool.creator !== curve.authority) {
        this.d.log.warn("graduation_pool_mismatch", { mint });
        this.watched.delete(mint);
        continue;
      }
      this.watched.delete(mint);
      this.reported.add(mint);
      const g = await this.graduationTime(mint, pools[i] as any, w);
      const out: Graduation = { mint, graduatedAtMs: g.atMs, graduatedAtSource: g.source, detectedAtMs: this.now(), launch: w.launch, pool: dammPool(mint), curve: w.launch.curve ?? candleCurve(mint) };
      this.stats.graduations++;
      this.queue.push(out);
      try {
        this.onNew?.();
      } catch {
        /* a wake that fails waits for the next cycle */
      }
    }
  }

  /** The block time of the pool's activation slot (activation_type 0); else first seen migrated, if seen on the curve. */
  private async graduationTime(mint: string, poolAcct: { data: [string, string] | string[] }, w: Watched): Promise<{ atMs: number | null; source: Graduation["graduatedAtSource"] }> {
    try {
      const b = Buffer.from(String(poolAcct.data[0]), "base64");
      const type = b[480];
      const point = b.readBigUInt64LE(472);
      if (type === 0 && point > 0n) {
        const t = await this.d.rpc.call<number | null>("getBlockTime", [Number(point)]);
        if (typeof t === "number" && t > 0) return { atMs: t * 1000, source: "activation_slot" };
      } else if (type === 1 && point > 0n) {
        return { atMs: Number(point) * 1000, source: "activation_slot" };
      }
    } catch (e) {
      this.d.log.info("graduation_time_unread", { mint, error: String((e as Error)?.message ?? e).slice(0, 120) });
    }
    return w.seenOnCurve ? { atMs: this.now(), source: "first_seen" } : { atMs: null, source: null };
  }
}
