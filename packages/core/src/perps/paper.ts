/**
 * (batch 6) The paper venue for dry runs: real market reads (Hyperliquid's public /info, no key), paper positions.
 * An order fills at once, all of it, at the mark moved against it by `slippageBps`, and pays `feeBps` of its notional
 * (Hyperliquid's taker fee plus Candle's builder fee by default). Funding accrues at each hour boundary on the paper
 * position at the rate the last market read gave. Everything is kept in SQLite (its own `paper_*` tables), so a dry
 * restart sees the same positions, orders and fills.
 */
import { DatabaseSync } from "node:sqlite";
import { type PerpAccount, type PerpFill, type PerpFunding, type PerpMarket, type PerpNetwork, type PerpOrderRequest, type PerpOrderResult, type PerpOrderStatus, type PerpsVenue } from "./venue.ts";

export interface PaperOptions {
  network: PerpNetwork;
  /** SQLite file (shared with the bot's book is fine: tables are prefixed paper_). */
  path: string;
  /** Market reads (the real ones in a dry run; fixed ones in a test). */
  markets: () => Promise<Map<string, PerpMarket>>;
  /** Paper account value in USD (what the caps are checked against). Default 1,000. */
  startUsd?: number;
  /** Fill price: the mark moved against the order by this many bps. Default 5. */
  slippageBps?: number;
  /** Fee per fill, bps of notional: Hyperliquid's base taker 4.5 plus Candle's builder fee 10. Default 14.5. */
  feeBps?: number;
  /** Venue minimum order value in USD for an open (Hyperliquid: 10). */
  minOrderUsd?: number;
  now?: () => number;
}

const HOUR = 3_600_000;

export class PaperPerpsVenue implements PerpsVenue {
  readonly kind = "paper" as const;
  readonly network: PerpNetwork;
  private db: DatabaseSync;
  private o: Required<Omit<PaperOptions, "path">>;
  private last: { at: number; m: Map<string, PerpMarket> } | null = null;

  constructor(o: PaperOptions) {
    this.network = o.network;
    this.o = { network: o.network, markets: o.markets, startUsd: o.startUsd ?? 1000, slippageBps: o.slippageBps ?? 5, feeBps: o.feeBps ?? 14.5, minOrderUsd: o.minOrderUsd ?? 10, now: o.now ?? Date.now };
    this.db = new DatabaseSync(o.path);
    this.db.exec(`pragma journal_mode = wal;
create table if not exists paper_positions (coin text primary key, szi real not null, entry_px real, leverage real);
create table if not exists paper_orders (client_id text primary key, oid integer not null, coin text not null, side text not null, sz real not null, px real not null, status text not null, at integer not null);
create table if not exists paper_fills (tid integer primary key, oid integer not null, coin text not null, px real not null, sz real not null, side text not null, time integer not null, fee real not null, closed_pnl real not null);
create table if not exists paper_funding (time integer not null, coin text not null, usdc real not null, szi real not null, rate real not null, primary key (time, coin));
create table if not exists paper_meta (k text primary key, v text not null);`);
    if (!this.meta("funded_to")) this.setMeta("funded_to", String(Math.floor(this.o.now() / HOUR) * HOUR));
  }

  close_(): void {
    this.db.close();
  }

  private meta(k: string): string | null {
    return (this.db.prepare("select v from paper_meta where k = ?").get(k) as any)?.v ?? null;
  }
  private setMeta(k: string, v: string): void {
    this.db.prepare("insert into paper_meta (k, v) values (?, ?) on conflict(k) do update set v = excluded.v").run(k, v);
  }

  async markets(): Promise<Map<string, PerpMarket>> {
    const m = await this.o.markets();
    this.last = { at: this.o.now(), m };
    return m;
  }

  private async fresh(): Promise<Map<string, PerpMarket>> {
    if (this.last && this.o.now() - this.last.at < 10_000) return this.last.m;
    return this.markets();
  }

  private positions(): Array<{ coin: string; szi: number; entry_px: number | null; leverage: number | null }> {
    return this.db.prepare("select coin, szi, entry_px, leverage from paper_positions where szi != 0").all() as any[];
  }

  /** Funding for each whole hour since the last accrual, at the last read's rate and mark. */
  private accrue(): void {
    if (!this.last) return;
    const to = Math.floor(this.o.now() / HOUR) * HOUR;
    let at = Number(this.meta("funded_to"));
    const ins = this.db.prepare("insert or ignore into paper_funding (time, coin, usdc, szi, rate) values (?, ?, ?, ?, ?)");
    while (at + HOUR <= to) {
      at += HOUR;
      for (const p of this.positions()) {
        const m = this.last.m.get(p.coin);
        if (!m || m.markPx === null || m.fundingRate === null) continue;
        // Hyperliquid's sign: a positive rate has longs pay shorts.
        ins.run(at, p.coin, -p.szi * m.markPx * m.fundingRate, p.szi, m.fundingRate);
      }
    }
    this.setMeta("funded_to", String(at));
  }

  async account(): Promise<PerpAccount> {
    const m = await this.fresh();
    this.accrue();
    const sum = (q: string) => Number((this.db.prepare(q).get() as any)?.s ?? 0);
    const realized = sum("select coalesce(sum(closed_pnl - fee), 0) as s from paper_fills") + sum("select coalesce(sum(usdc), 0) as s from paper_funding");
    let upnl = 0;
    let margin = 0;
    const positions = this.positions().map((p) => {
      const mk = m.get(p.coin)?.markPx ?? null;
      const u = mk !== null && p.entry_px !== null ? (mk - p.entry_px) * p.szi : null;
      if (u !== null) upnl += u;
      if (mk !== null) margin += (Math.abs(p.szi) * mk) / (p.leverage ?? 1);
      return { coin: p.coin, szi: p.szi, entryPx: p.entry_px, unrealizedPnl: u, leverage: p.leverage ? { type: "isolated" as const, value: p.leverage } : null };
    });
    return { readAt: this.o.now(), accountValueUsd: this.o.startUsd + realized + upnl, marginUsedUsd: margin, positions };
  }

  async setLeverage(coin: string, leverage: number): Promise<void> {
    this.db.prepare("insert into paper_positions (coin, szi, entry_px, leverage) values (?, 0, null, ?) on conflict(coin) do update set leverage = excluded.leverage").run(coin, leverage);
  }

  private nextId(): number {
    const v = Number(this.meta("next_id") ?? "1");
    this.setMeta("next_id", String(v + 1));
    return v;
  }

  private async fill(req: PerpOrderRequest): Promise<PerpOrderResult> {
    if (this.db.prepare("select 1 from paper_orders where client_id = ?").get(req.clientId)) return { status: "rejected", error: "duplicate client id" };
    const m = (await this.fresh()).get(req.coin);
    if (!m || (m.delisted && !req.reduceOnly)) return { status: "rejected", error: `no market ${req.coin}` };
    if (m.markPx === null) return { status: "rejected", error: `no mark for ${req.coin}` };
    this.accrue();
    const pos = (this.db.prepare("select szi, entry_px from paper_positions where coin = ?").get(req.coin) as any) ?? { szi: 0, entry_px: null };
    const dir = req.side === "long" ? 1 : -1;
    let sz: number;
    if (req.reduceOnly) {
      // Reduce-only: only against the position, never past it.
      if (pos.szi === 0 || Math.sign(pos.szi) === dir) return { status: "rejected", error: "reduce only would increase the position" };
      sz = req.size === null ? Math.abs(pos.szi) : Math.min(Number(req.size), Math.abs(pos.szi));
    } else sz = Number(req.size);
    if (!(sz > 0)) return { status: "rejected", error: "size 0" };
    const px = m.markPx * (1 + (dir * this.o.slippageBps) / 10_000);
    if (!req.reduceOnly && sz * px < this.o.minOrderUsd) return { status: "rejected", error: `order under ${this.o.minOrderUsd} USD` };
    const fee = (sz * px * this.o.feeBps) / 10_000;
    const newSzi = +(pos.szi + dir * sz).toFixed(m.szDecimals + 2);
    let closed = 0;
    let entry: number | null = pos.entry_px;
    if (pos.szi !== 0 && Math.sign(pos.szi) !== dir) {
      closed = (px - (pos.entry_px ?? px)) * -dir * Math.min(sz, Math.abs(pos.szi));
      if (newSzi === 0) entry = null;
    } else entry = ((pos.entry_px ?? px) * Math.abs(pos.szi) + px * sz) / (Math.abs(pos.szi) + sz);
    const oid = this.nextId();
    const t = this.o.now();
    this.db.prepare("insert into paper_positions (coin, szi, entry_px, leverage) values (?, ?, ?, null) on conflict(coin) do update set szi = excluded.szi, entry_px = excluded.entry_px").run(req.coin, newSzi, entry);
    this.db.prepare("insert into paper_orders (client_id, oid, coin, side, sz, px, status, at) values (?, ?, ?, ?, ?, ?, 'filled', ?)").run(req.clientId, oid, req.coin, req.side, sz, px, t);
    this.db.prepare("insert into paper_fills (tid, oid, coin, px, sz, side, time, fee, closed_pnl) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(oid, oid, req.coin, px, sz, req.side, t, fee, closed);
    return { status: "filled", oid, filledSz: String(+sz.toFixed(m.szDecimals + 2)), avgPx: px };
  }

  open(req: PerpOrderRequest) {
    return this.fill(req);
  }
  close(req: PerpOrderRequest) {
    return this.fill(req);
  }

  async orderStatus(clientId: string): Promise<PerpOrderStatus> {
    const r = this.db.prepare("select oid, coin, side, sz, px from paper_orders where client_id = ?").get(clientId) as any;
    if (!r) return { found: false };
    return { found: true, oid: r.oid, status: "filled", filledSz: String(r.sz), avgPx: r.px, side: r.side, coin: r.coin };
  }

  async fills(sinceMs: number): Promise<PerpFill[]> {
    return (this.db.prepare("select * from paper_fills where time >= ? order by time, tid").all(sinceMs) as any[]).map((f) => ({ tid: f.tid, oid: f.oid, coin: f.coin, px: f.px, sz: f.sz, side: f.side, time: f.time, fee: f.fee, builderFee: 0, closedPnl: f.closed_pnl }));
  }

  async funding(sinceMs: number): Promise<PerpFunding[]> {
    this.accrue();
    return (this.db.prepare("select * from paper_funding where time >= ? order by time").all(sinceMs) as any[]).map((r) => ({ time: r.time, coin: r.coin, usdc: r.usdc, szi: r.szi, rate: r.rate }));
  }
}

