/**
 * The spread watcher: every step reads each coin's venues (candle-bot-core/market/venues) and, every perps.everySec,
 * Hyperliquid's marks (one public read); finds the widest gap between two venues deep enough to count; and alerts once
 * per coin per cooldown when the gap has held at or above rules.minSpreadBps for rules.minReads reads in a row. The
 * alert names both venues, their prices and their SOL depth. It never trades.
 */
import type { Alerter } from "candle-bot-core/alerts";
import type { Ledger } from "candle-bot-core/ledger";
import type { Logger } from "candle-bot-core/log";
import type { Rpc } from "candle-bot-core/solana/rpc";
import type { Watcher } from "candle-bot-core/watch";
import { perpUnits, readVenuePrices, spreadOf, type Spread, type VenuePrice } from "candle-bot-core/market/venues";
import type { PerpMarket } from "candle-bot-core/perps/venue";
import type { Config } from "./config.ts";

const TABLE = "create table if not exists spread_fired (mint text primary key, at integer not null, bps integer not null)";

export interface SpreadWatcherDeps {
  cfg: Config;
  rpc: Rpc;
  ledger: Ledger;
  alerter: Alerter;
  log: Logger;
  /** Hyperliquid's markets (the public read); only called when a coin names a perp. */
  perpMarkets: () => Promise<Map<string, PerpMarket>>;
  now?: () => number;
}

interface CoinState {
  prices: VenuePrice[];
  spread: Spread | null;
  streak: number;
  readAt: number | null;
  problem?: string;
}

const fmt = (x: number | null) => (x === null ? "n/a" : x.toPrecision(5));

export class SpreadWatcher implements Watcher {
  private d: SpreadWatcherDeps;
  private now: () => number;
  private state = new Map<string, CoinState>();
  private marks: { at: number; m: Map<string, PerpMarket> } | null = null;
  private nextMarksAt = 0;
  fired = 0;

  constructor(d: SpreadWatcherDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    (d.ledger as any).db.exec(TABLE);
    for (const c of d.cfg.coins) this.state.set(c.mint, { prices: [], spread: null, streak: 0, readAt: null });
  }

  private async readMarks(): Promise<void> {
    if (!this.d.cfg.coins.some((c) => c.perp) || this.now() < this.nextMarksAt) return;
    this.nextMarksAt = this.now() + this.d.cfg.perps.everySec * 1000;
    try {
      this.marks = { at: this.now(), m: await this.d.perpMarkets() };
    } catch (e) {
      this.d.log.warn("perp_marks_failed", { error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }

  /** A perp's price per whole coin in SOL: its mark over the units per contract, over SOL's own mark. Stale marks are dropped. */
  private perpPrice(perp: string, units: number | null): VenuePrice {
    const row: VenuePrice = { venue: "perp", source: "perp", address: perp, priceSol: null, depthSol: null };
    const m = this.marks;
    if (!m || this.now() - m.at > 3 * this.d.cfg.perps.everySec * 1000) return { ...row, problem: "no recent marks" };
    const coin = m.m.get(perp);
    const sol = m.m.get("SOL")?.markPx ?? null;
    if (!coin || coin.delisted || coin.markPx === null) return { ...row, problem: !coin ? "not listed" : coin.delisted ? "delisted" : "no mark" };
    if (sol === null || !(sol > 0)) return { ...row, problem: "no SOL mark" };
    return { ...row, priceSol: coin.markPx / (units ?? perpUnits(perp)) / sol };
  }

  async step(shouldStop: () => boolean = () => false): Promise<void> {
    await this.readMarks();
    const cfg = this.d.cfg;
    let reads;
    try {
      reads = await readVenuePrices(this.d.rpc, cfg.coins.map((c) => ({ mint: c.mint, pools: c.pools, own: c.own })), this.now());
    } catch (e) {
      this.d.log.warn("venue_read_failed", { error: String((e as Error)?.message ?? e).slice(0, 300) });
      for (const s of this.state.values()) s.streak = 0; // a gap breaks the streak: it must hold on consecutive reads
      return;
    }
    for (const c of cfg.coins) {
      if (shouldStop()) return;
      const s = this.state.get(c.mint)!;
      const prices = [...(reads.get(c.mint)?.prices ?? [])];
      if (c.perp) prices.push(this.perpPrice(c.perp, c.perpUnits));
      s.prices = prices;
      s.readAt = this.now();
      s.spread = spreadOf(prices, cfg.rules.minDepthSol, cfg.rules.perps);
      s.streak = s.spread && s.spread.bps >= cfg.rules.minSpreadBps ? s.streak + 1 : 0;
      if (s.streak >= cfg.rules.minReads) this.fire(c.mint, c.label, s);
    }
  }

  private fire(mint: string, label: string, s: CoinState): void {
    const t = this.now();
    const db = (this.d.ledger as any).db;
    const row = db.prepare("select at from spread_fired where mint = ?").get(mint) as { at: number } | undefined;
    if (row && t - row.at < this.d.cfg.rules.cooldownMin * 60_000) return;
    db.prepare("insert into spread_fired (mint, at, bps) values (?, ?, ?) on conflict(mint) do update set at = excluded.at, bps = excluded.bps").run(mint, t, s.spread!.bps);
    const sp = s.spread!;
    const side = (p: VenuePrice) => `${p.venue}${p.address && p.source !== "perp" ? ` ${p.address.slice(0, 6)}…` : p.source === "perp" ? ` ${p.address}` : ""} at ${fmt(p.priceSol)} SOL${p.depthSol !== null ? ` (${p.depthSol.toFixed(1)} SOL deep)` : ""}`;
    const link = this.d.cfg.rules.link ? ` ${this.d.cfg.rules.link.replace("{mint}", mint)}` : "";
    const msg = `${label}: ${sp.bps} bps spread for ${s.streak} reads: high ${side(sp.hi)}, low ${side(sp.lo)}.${link}`;
    // The alerter's own dedupe would hold a repeat for renotifyMs: the key carries the time so the cooldown decides.
    this.d.alerter.raise(`spread:${mint}:${t}`, msg, { mint, bps: sp.bps, hi: sp.hi, lo: sp.lo, reads: s.streak });
    this.fired++;
  }

  status(): Record<string, unknown> {
    return {
      fired: this.fired,
      marksAt: this.marks ? new Date(this.marks.at).toISOString() : null,
      coins: this.d.cfg.coins.map((c) => {
        const s = this.state.get(c.mint)!;
        return { mint: c.mint, label: c.label, readAt: s.readAt ? new Date(s.readAt).toISOString() : null, spreadBps: s.spread?.bps ?? null, streak: s.streak, venues: s.prices };
      }),
    };
  }
}
