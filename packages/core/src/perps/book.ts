/**
 * (batch 6) The hedge book: every perps order the hedger sends (written BEFORE the call, under a fresh client id),
 * what it came to, the fills and funding the venue charged for the hedger's coins, and the price samples a beta fit
 * reads. One SQLite file per state dir.
 *
 * Restart safety: an order row is `sent` before the venue is asked and becomes `filled`, `rejected`, `unknown`,
 * `not_placed` or `accepted` after. While a coin has a `sent` or `unknown` row it is frozen: the hedger only reads
 * the venue's record of that client id until it knows the outcome. A restart therefore never sends a second order
 * for an order whose fate it does not know. The book's position per coin (the sum of its filled orders) is checked
 * against the venue's each step; a difference it cannot explain also freezes the coin.
 */
import { DatabaseSync } from "node:sqlite";
import type { PerpFill, PerpFunding, PerpOrderResult, PerpOrderStatus } from "./venue.ts";

export type HedgeOrderStatus = "sent" | "filled" | "rejected" | "unknown" | "not_placed" | "accepted";

export interface HedgeOrderRow {
  id: number;
  coin: string;
  action: "open" | "close" | "accept";
  side: "long" | "short";
  size: string | null;
  reduce_only: number;
  reason: string;
  client_id: string;
  status: HedgeOrderStatus;
  oid: number | null;
  /** Signed: what this order moved the position by (negative: more short). */
  filled_sz: number | null;
  avg_px: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface Totals {
  fees: number;
  builderFees: number;
  closedPnl: number;
  funding: number;
  fills: number;
  foreignFills: number;
}

const TABLES = `
pragma journal_mode = wal;
create table if not exists hedge_meta (k text primary key, v text not null);
create table if not exists hedge_orders (
  id integer primary key autoincrement, coin text not null, action text not null, side text not null, size text,
  reduce_only integer not null, reason text not null, client_id text not null unique, status text not null,
  oid integer, filled_sz real, avg_px real, error text, created_at integer not null, updated_at integer not null
);
create index if not exists hedge_orders_status on hedge_orders (status);
create table if not exists hedge_fills (
  tid integer primary key, oid integer not null, coin text not null, px real not null, sz real not null, side text not null,
  time integer not null, fee real not null, builder_fee real not null, closed_pnl real not null, ours integer not null
);
create table if not exists hedge_funding (time integer not null, coin text not null, usdc real not null, szi real not null, rate real not null, primary key (time, coin));
create table if not exists hedge_samples (mint text not null, t integer not null, coin_usd real not null, proxy_px real not null, primary key (mint, t));
`;

export class HedgeBook {
  private db: DatabaseSync;
  private now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(TABLES);
    this.now = now;
    if (this.meta("started_at") === null) this.setMeta("started_at", String(now()));
  }

  close(): void {
    this.db.close();
  }

  meta(k: string): string | null {
    return (this.db.prepare("select v from hedge_meta where k = ?").get(k) as any)?.v ?? null;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare("insert into hedge_meta (k, v) values (?, ?) on conflict(k) do update set v = excluded.v").run(k, v);
  }

  /** A state dir belongs to one mode, network and perps account: anything else is refused. */
  checkIdentity(id: { mode: string; network: string; account: string }): void {
    for (const [k, v] of Object.entries(id)) {
      const have = this.meta(`identity_${k}`);
      if (have === null) this.setMeta(`identity_${k}`, v);
      else if (have !== v) throw new Error(`this state dir holds a hedge book for ${k} ${have}, not ${v}: use another stateDir`);
    }
  }

  /** Written before the venue is asked. */
  intent(o: { coin: string; action: "open" | "close"; side: "long" | "short"; size: string | null; reduceOnly: boolean; reason: string; clientId: string }): number {
    const t = this.now();
    const r = this.db.prepare("insert into hedge_orders (coin, action, side, size, reduce_only, reason, client_id, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)").run(o.coin, o.action, o.side, o.size, o.reduceOnly ? 1 : 0, o.reason, o.clientId, t, t);
    return Number(r.lastInsertRowid);
  }

  private signed(side: "long" | "short", sz: number): number {
    return side === "long" ? sz : -sz;
  }

  /** What the venue answered. */
  result(id: number, r: PerpOrderResult): void {
    const row = this.order(id);
    if (!row) throw new Error(`no hedge order ${id}`);
    const t = this.now();
    if (r.status === "filled") {
      this.db.prepare("update hedge_orders set status = 'filled', oid = ?, filled_sz = ?, avg_px = ?, error = null, updated_at = ? where id = ?").run(r.oid, this.signed(row.side, Number(r.filledSz)), r.avgPx, t, id);
    } else {
      this.db.prepare("update hedge_orders set status = ?, error = ?, updated_at = ? where id = ?").run(r.status, r.error.slice(0, 500), t, id);
    }
  }

  /**
   * The venue's record of an unresolved order by its client id. Found: filled with what the venue says filled (0 is a
   * fill of nothing). Not found: `not_placed` once the order is older than `settleMs` (until then it stays as it is).
   * Returns whether the row is now resolved.
   */
  resolve(id: number, st: PerpOrderStatus, settleMs: number): boolean {
    const row = this.order(id);
    if (!row || (row.status !== "sent" && row.status !== "unknown")) return true;
    const t = this.now();
    if (st.found) {
      if (st.status === "open" || st.status === "triggered") return false; // resting: wait for the venue to finish it
      const filled = Number(st.filledSz);
      if (!(filled > 0)) {
        this.db.prepare("update hedge_orders set status = 'rejected', oid = ?, filled_sz = 0, error = ?, updated_at = ? where id = ?").run(st.oid, `reconciled: venue ${st.status}, nothing filled`, t, id);
        return true;
      }
      this.db.prepare("update hedge_orders set status = 'filled', oid = ?, filled_sz = ?, avg_px = coalesce(?, avg_px), error = ?, updated_at = ? where id = ?").run(st.oid, this.signed(st.side, Number(st.filledSz)), st.avgPx, `reconciled: venue ${st.status}`, t, id);
      return true;
    }
    if (t - row.created_at < settleMs) return false;
    this.db.prepare("update hedge_orders set status = 'not_placed', error = coalesce(error, '') || ' | reconciled: the venue has no order with this client id', updated_at = ? where id = ?").run(t, id);
    return true;
  }

  /** A position the book did not make, taken over on request (the `accept` command): booked as its own row. */
  accept(coin: string, delta: number, note: string, clientId: string): void {
    const t = this.now();
    this.db.prepare("insert into hedge_orders (coin, action, side, size, reduce_only, reason, client_id, status, filled_sz, created_at, updated_at) values (?, 'accept', ?, ?, 0, ?, ?, 'accepted', ?, ?, ?)").run(coin, delta >= 0 ? "long" : "short", String(Math.abs(delta)), note.slice(0, 200), clientId, delta, t, t);
  }

  order(id: number): HedgeOrderRow | null {
    return (this.db.prepare("select * from hedge_orders where id = ?").get(id) as any) ?? null;
  }

  unresolved(): HedgeOrderRow[] {
    return this.db.prepare("select * from hedge_orders where status in ('sent', 'unknown') order by id").all() as any[];
  }

  recent(n = 20): HedgeOrderRow[] {
    return this.db.prepare("select * from hedge_orders order by id desc limit ?").all(n) as any[];
  }

  /** The book's position per coin: the sum of its filled and accepted rows. */
  expected(coin: string): number {
    const v = Number((this.db.prepare("select coalesce(sum(filled_sz), 0) as s from hedge_orders where coin = ? and status in ('filled', 'accepted')").get(coin) as any).s);
    return +v.toPrecision(12);
  }

  coins(): string[] {
    return (this.db.prepare("select distinct coin from hedge_orders order by coin").all() as any[]).map((r) => r.coin);
  }

  private ourOids(): Set<number> {
    return new Set((this.db.prepare("select oid from hedge_orders where oid is not null").all() as any[]).map((r) => Number(r.oid)));
  }

  /** Fills on the given coins, deduplicated by trade id. `ours`: the fill's order is one of the book's. Returns the new rows. */
  addFills(fills: PerpFill[], coins: ReadonlySet<string>): Array<PerpFill & { ours: boolean }> {
    const ours = this.ourOids();
    const ins = this.db.prepare("insert or ignore into hedge_fills (tid, oid, coin, px, sz, side, time, fee, builder_fee, closed_pnl, ours) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const added: Array<PerpFill & { ours: boolean }> = [];
    for (const f of fills) {
      if (!coins.has(f.coin)) continue;
      const o = ours.has(f.oid);
      if (Number(ins.run(f.tid, f.oid, f.coin, f.px, f.sz, f.side, f.time, f.fee, f.builderFee, f.closedPnl, o ? 1 : 0).changes) > 0) added.push({ ...f, ours: o });
    }
    // An order's average price from its fills when the answer gave none.
    this.db.exec("update hedge_orders set avg_px = (select sum(px * sz) / sum(sz) from hedge_fills where hedge_fills.oid = hedge_orders.oid) where avg_px is null and oid is not null and exists (select 1 from hedge_fills where hedge_fills.oid = hedge_orders.oid)");
    return added;
  }

  /** A fill booked as someone else's may turn out ours once its order is reconciled. */
  reattribute(): void {
    this.db.exec("update hedge_fills set ours = 1 where ours = 0 and oid in (select oid from hedge_orders where oid is not null)");
  }

  /** Funding on the given coins, deduplicated by (time, coin). Returns the new rows. */
  addFunding(rows: PerpFunding[], coins: ReadonlySet<string>): PerpFunding[] {
    const ins = this.db.prepare("insert or ignore into hedge_funding (time, coin, usdc, szi, rate) values (?, ?, ?, ?, ?)");
    const added: PerpFunding[] = [];
    for (const r of rows) if (coins.has(r.coin) && Number(ins.run(r.time, r.coin, r.usdc, r.szi, r.rate).changes) > 0) added.push(r);
    return added;
  }

  totals(coin?: string): Totals {
    const w = coin ? " and coin = ?" : "";
    const a = coin ? [coin] : [];
    const f = this.db.prepare(`select coalesce(sum(fee), 0) as fee, coalesce(sum(builder_fee), 0) as bf, coalesce(sum(closed_pnl), 0) as pnl, count(*) as n from hedge_fills where ours = 1${w}`).get(...a) as any;
    const foreign = this.db.prepare(`select count(*) as n from hedge_fills where ours = 0${w}`).get(...a) as any;
    const fu = this.db.prepare(`select coalesce(sum(usdc), 0) as s from hedge_funding where 1 = 1${w}`).get(...a) as any;
    return { fees: Number(f.fee), builderFees: Number(f.bf), closedPnl: Number(f.pnl), funding: Number(fu.s), fills: Number(f.n), foreignFills: Number(foreign.n) };
  }

  /** One price pair for a beta fit: the coin's USD price per whole token and the proxy's mark, at time t. */
  addSample(mint: string, t: number, coinUsd: number, proxyPx: number): void {
    this.db.prepare("insert or ignore into hedge_samples (mint, t, coin_usd, proxy_px) values (?, ?, ?, ?)").run(mint, t, coinUsd, proxyPx);
  }

  samples(mint: string, since: number): Array<{ bag: number; proxy: number }> {
    return (this.db.prepare("select coin_usd, proxy_px from hedge_samples where mint = ? and t >= ? order by t").all(mint, since) as any[]).map((r) => ({ bag: r.coin_usd, proxy: r.proxy_px }));
  }

  pruneSamples(before: number): void {
    this.db.prepare("delete from hedge_samples where t < ?").run(before);
  }
}
