/**
 * The watcher: samples price and pool SOL from the engine's market reads, polls holders and the creator's holding,
 * runs the rules (rules.ts) and records each firing once (table `rug_events`, created on first use). A firing that
 * sells stays pending until a sell with its reason has filled; the exit strategy (RugExit) asks the engine for that
 * sell, so it goes through the engine's whole exit path (one exit in flight, backoff, exit_stuck, PAUSE_SELLS, the
 * adopter's sell check, the balance clamp).
 *
 * Once per event:
 *   - priceCrash, liquidityPull: after a firing the window starts again from the value then, so the next firing needs
 *     a new fall of dropPct from there. Samples live in memory: after a restart the window starts empty.
 *   - devDump: each part (sold, floor) fires once per position. The creator's highest holding is kept in the ledger.
 *   - holderExit: once per wallet per position.
 */
import type { Alerter, Logger } from "candle-bot-core";
import type { Ledger, PositionRow } from "candle-bot-core/ledger";
import type { MarketRead } from "candle-bot-core/market/reader";
import type { HolderSource } from "candle-bot-core/sources/holders";
import type { Action, Config } from "./config.ts";
import { devTrips, fmtSol, fmtPrice, holderTrips, prune, watchedHolders, windowDrop, type HolderSample, type Sample, type Trip } from "./rules.ts";

const TABLES = `
create table if not exists rug_events (
  id integer primary key, position_id integer not null, mint text not null, rule text not null, key text not null,
  fired_at integer not null, numbers text not null, sell real not null, alert_only integer not null, done_at integer,
  unique (position_id, key)
);
create table if not exists rug_creators (
  mint text primary key, creator text not null, source text not null, max_raw text not null, updated_at integer not null
);
`;

export type RuleName = "priceCrash" | "liquidityPull" | "devDump" | "holderExit";

export interface EventRow {
  id: number;
  position_id: number;
  mint: string;
  rule: RuleName;
  key: string;
  fired_at: number;
  numbers: string;
  sell: number;
  alert_only: number;
  done_at: number | null;
}

/** Venues whose SOL is a pool someone can pull (a bonding curve's SOL only leaves through sells). */
const POOL_VENUES = new Set(["damm", "pumpswap"]);
/** A failing holder read is alerted after this many polls in a row. */
export const HOLDER_FAIL_ALERT = 3;
/** A creator that could not be found is looked for again after this long. */
export const CREATOR_RETRY_MS = 3_600_000;

export interface WatchDeps {
  cfg: Config;
  ledger: Ledger;
  log: Logger;
  alerter: Alerter;
  holders: HolderSource;
  creatorOf: (mint: string) => Promise<{ creator: string; source: string } | null>;
  /** Positions watched now (the adopter's managed bags). */
  managed: () => PositionRow[];
  market: (mint: string) => Readonly<MarketRead> | undefined;
  sellsPaused: () => boolean;
  now?: () => number;
}

interface CoinState {
  venue: string;
  lastAt: number;
  price: Sample[];
  liq: Sample[];
  holders: HolderSample[];
  nextPollAt: number;
  holderFails: number;
}

export class RugWatch {
  private d: WatchDeps;
  private now: () => number;
  private coins = new Map<number, CoinState>();
  private creatorMiss = new Map<string, number>();

  constructor(d: WatchDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    d.ledger.db.exec(TABLES);
  }

  private state(positionId: number): CoinState {
    let s = this.coins.get(positionId);
    if (!s) {
      s = { venue: "", lastAt: -1, price: [], liq: [], holders: [], nextPollAt: 0, holderFails: 0 };
      this.coins.set(positionId, s);
    }
    return s;
  }

  // ------------------------------------------------------------------ price and pool SOL (from the engine's reads)

  /** Every watched position against the engine's latest market read (each read sampled once). Never throws. */
  observe(): void {
    let open: PositionRow[];
    try {
      open = this.d.managed();
    } catch (e) {
      this.d.log.error("rug_observe_failed", { error: String((e as Error)?.message ?? e) });
      return;
    }
    const live = new Set(open.map((p) => p.id));
    for (const id of this.coins.keys()) if (!live.has(id)) this.coins.delete(id);
    for (const p of open) {
      const m = this.d.market(p.mint);
      if (m) this.observeOne(p, m);
    }
  }

  /** One position against one market read (the exit tick calls this too, so a crash is seen on the tick it shows). */
  observeOne(p: PositionRow, m: Readonly<MarketRead>): void {
    try {
      const r = this.d.cfg.rules;
      const st = this.state(p.id);
      if (m.nowMs === st.lastAt) return;
      st.lastAt = m.nowMs;
      if (m.problem) return;
      if (m.venue !== st.venue) {
        // A migration moves the SOL from the curve to a pool: not a pull. Both windows start again on a new venue.
        st.venue = m.venue;
        st.price = [];
        st.liq = [];
      }
      if (r.priceCrash && m.priceSol !== null && m.priceSol > 0) {
        st.price = prune([...st.price, { at: m.nowMs, value: m.priceSol }], m.nowMs, r.priceCrash.windowSec);
        const trip = windowDrop(st.price, m.nowMs, r.priceCrash, "price", fmtPrice);
        if (trip) {
          this.fireSeq(p, "priceCrash", trip, r.priceCrash);
          st.price = st.price.slice(-1);
        }
      }
      const liq = m.quoteLiquidityLamports;
      if (r.liquidityPull && POOL_VENUES.has(m.venue) && typeof liq === "bigint") {
        st.liq = prune([...st.liq, { at: m.nowMs, value: Number(liq) / 1e9 }], m.nowMs, r.liquidityPull.windowSec);
        const trip = windowDrop(st.liq, m.nowMs, r.liquidityPull, `pool SOL (${m.venue})`, fmtSol);
        if (trip) {
          this.fireSeq(p, "liquidityPull", trip, r.liquidityPull);
          st.liq = st.liq.slice(-1);
        }
      }
    } catch (e) {
      this.d.log.error("rug_observe_failed", { position: p.id, error: String((e as Error)?.message ?? e) });
    }
  }

  // ------------------------------------------------------------------ holders and the creator (polled)

  /** Holder and creator reads for the coins that are due (at most watch.maxCoinsPerPoll). */
  async poll(shouldStop: () => boolean = () => false): Promise<void> {
    const r = this.d.cfg.rules;
    if (!r.devDump && !r.holderExit) return;
    const now = this.now();
    const due = this.d.managed()
      .map((p) => ({ p, st: this.state(p.id) }))
      .filter((x) => x.st.nextPollAt <= now)
      .sort((a, b) => a.st.nextPollAt - b.st.nextPollAt)
      .slice(0, this.d.cfg.watch.maxCoinsPerPoll);
    for (const { p, st } of due) {
      if (shouldStop()) return;
      st.nextPollAt = now + this.d.cfg.watch.holdersPollMs;
      try {
        await this.pollOne(p, st);
        st.holderFails = 0;
      } catch (e) {
        st.holderFails++;
        const why = String((e as Error)?.message ?? e).slice(0, 160);
        this.d.log.warn("rug_holders_unreadable", { position: p.id, mint: p.mint, error: why, inARow: st.holderFails });
        if (st.holderFails >= HOLDER_FAIL_ALERT) this.d.alerter.raise(`rug:${p.id}:holders_unreadable`, `rug watcher: holders of ${p.mint} (position ${p.id}) unreadable ${st.holderFails} polls in a row (${why}); the dev and holder rules cannot see this coin`);
      }
    }
  }

  private async pollOne(p: PositionRow, st: CoinState): Promise<void> {
    const r = this.d.cfg.rules;
    const snap = await this.d.holders.snapshot(p.mint);
    const creator = r.devDump ? await this.creator(p.mint) : null;
    if (r.devDump && creator) {
      const held = await this.d.holders.balanceOf(creator, p.mint);
      if (held !== null) {
        const row = this.d.ledger.db.prepare("select max_raw from rug_creators where mint = ?").get(p.mint) as { max_raw: string } | undefined;
        const prevMax = row ? BigInt(row.max_raw) : 0n;
        const max = held > prevMax ? held : prevMax;
        if (max !== prevMax) this.d.ledger.db.prepare("update rug_creators set max_raw = ?, updated_at = ? where mint = ?").run(max.toString(), this.now(), p.mint);
        for (const t of devTrips(r.devDump, { maxRaw: max }, held, snap.supply, p.decimals)) this.fire(p, "devDump", `dev:${t.part}`, { ...t.trip, numbers: { creator, ...t.trip.numbers } }, r.devDump);
      }
    }
    if (r.holderExit) {
      const rule = r.holderExit;
      const skip = new Set([this.d.cfg.wallet, ...rule.exclude, ...(r.devDump && creator ? [creator] : [])]);
      const list = snap.holders.filter((h) => !skip.has(h.owner));
      const sample: HolderSample = { at: snap.atMs, amounts: new Map(list.map((h) => [h.owner, h.amount])), top: list.slice(0, rule.topN).map((h) => h.owner) };
      st.holders = [...st.holders, sample].filter((s) => s.at >= snap.atMs - rule.windowSec * 1000);
      const nowAmounts = new Map<string, bigint | null>();
      let direct = 0;
      for (const owner of watchedHolders(st.holders)) {
        const a = sample.amounts.get(owner);
        if (a !== undefined) nowAmounts.set(owner, a);
        else if (direct < rule.topN) {
          // Out of the largest accounts now: its balance is read directly (unknown on a failed read, never zero).
          direct++;
          nowAmounts.set(owner, await this.d.holders.balanceOf(owner, p.mint));
        }
      }
      for (const t of holderTrips(rule, st.holders, nowAmounts, snap.supply, p.decimals)) this.fire(p, "holderExit", `holder:${t.owner}`, t.trip, rule);
    }
  }

  /** The coin's creator: from config, else from chain (kept in the ledger); null when it cannot be found. */
  private async creator(mint: string): Promise<string | null> {
    const given = this.d.cfg.rules.devDump?.creators[mint];
    const row = this.d.ledger.db.prepare("select creator, source from rug_creators where mint = ?").get(mint) as { creator: string; source: string } | undefined;
    if (given) {
      if (!row || row.creator !== given) this.d.ledger.db.prepare("insert into rug_creators (mint, creator, source, max_raw, updated_at) values (?, ?, 'config', '0', ?) on conflict(mint) do update set creator = excluded.creator, source = 'config', max_raw = '0', updated_at = excluded.updated_at").run(mint, given, this.now());
      return given;
    }
    if (row) return row.creator;
    if ((this.creatorMiss.get(mint) ?? 0) > this.now()) return null;
    const found = await this.d.creatorOf(mint);
    if (!found) {
      this.creatorMiss.set(mint, this.now() + CREATOR_RETRY_MS);
      this.d.alerter.raise(`rug:creator_unknown:${mint}`, `rug watcher: no creator found on chain for ${mint}; the dev rule does not run for it (set rules.devDump.creators to name one)`);
      return null;
    }
    this.d.ledger.db.prepare("insert or ignore into rug_creators (mint, creator, source, max_raw, updated_at) values (?, ?, ?, '0', ?)").run(mint, found.creator, found.source, this.now());
    this.d.log.info("rug_creator", { mint, creator: found.creator, source: found.source });
    return found.creator;
  }

  // ------------------------------------------------------------------ firings

  /** priceCrash / liquidityPull: a new event each time (the window restarts after a firing). */
  private fireSeq(p: PositionRow, rule: RuleName, trip: Trip, a: Action): void {
    const n = (this.d.ledger.db.prepare("select count(*) n from rug_events where position_id = ? and rule = ?").get(p.id, rule) as { n: number }).n;
    this.fire(p, rule, `${rule}#${n + 1}`, trip, a);
  }

  /** Records the firing once (by position and key), alerts with its numbers, and (unless alertOnly) leaves a sell pending. */
  fire(p: PositionRow, rule: RuleName, key: string, trip: Trip, a: Action): boolean {
    const now = this.now();
    const res = this.d.ledger.db.prepare("insert or ignore into rug_events (position_id, mint, rule, key, fired_at, numbers, sell, alert_only) values (?, ?, ?, ?, ?, ?, ?, ?)").run(p.id, p.mint, rule, key, now, JSON.stringify(trip.numbers), a.sell, a.alertOnly ? 1 : 0);
    if (!res.changes) return false;
    const paused = !a.alertOnly && this.d.sellsPaused();
    const act = a.alertOnly ? "alert only" : `selling ${Math.round(a.sell * 10_000) / 100} % of what remains${paused ? " (held while PAUSE_SELLS is set)" : ""}`;
    const msg = `rug watcher, ${rule} on ${p.mint} (position ${p.id}): ${trip.text}. ${act}`;
    this.d.log.warn("rug_rule", { position: p.id, mint: p.mint, rule, key, event: Number(res.lastInsertRowid), alertOnly: a.alertOnly, sell: a.sell, ...trip.numbers });
    this.d.alerter.raise(`rug:${p.id}:${key}`, msg, { mint: p.mint, rule, ...trip.numbers });
    return true;
  }

  /** Every firing, newest first (status). */
  events(positionId?: number): EventRow[] {
    return (positionId === undefined
      ? this.d.ledger.db.prepare("select * from rug_events order by id desc limit 50").all()
      : this.d.ledger.db.prepare("select * from rug_events where position_id = ? order by id desc").all(positionId)) as unknown as EventRow[];
  }

  creatorRow(mint: string): { creator: string; source: string; max_raw: string } | undefined {
    return this.d.ledger.db.prepare("select creator, source, max_raw from rug_creators where mint = ?").get(mint) as any;
  }

  /**
   * The sell a firing still owes this position: the oldest selling event whose sell has not filled. Its reason
   * (`rug:<rule>#<event id>`) ties the order to the event. Null while that sell is in flight, or when none is owed.
   */
  pendingSell(positionId: number): { fraction: number; reason: string } | null {
    const rows = this.d.ledger.db.prepare("select * from rug_events where position_id = ? and alert_only = 0 and done_at is null order by id").all(positionId) as unknown as EventRow[];
    if (!rows.length) return null;
    const sells = this.d.ledger.ordersFor(positionId).filter((o) => o.side === "sell");
    for (const e of rows) {
      const reason = `rug:${e.rule}#${e.id}`;
      const mine = sells.filter((o) => o.reason === reason);
      if (mine.some((o) => o.status === "filled")) {
        this.d.ledger.db.prepare("update rug_events set done_at = ? where id = ?").run(this.now(), e.id);
        continue;
      }
      if (mine.some((o) => o.status === "pending" || o.status === "inflight")) return null;
      return { fraction: e.sell, reason };
    }
    return null;
  }
}
