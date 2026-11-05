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
 *   - devDump: each part (sold, floor) fires once per position. The creator's highest holding since the position was
 *     watched is kept in the ledger (per position: a coin watched again later starts again).
 *   - holderExit: once per wallet per position, confirmed by a read of the wallet's whole balance before it fires.
 * One of our own sells filling restarts the price and pool windows (its own impact is not a crash).
 */
import type { Alerter, Logger } from "candle-bot-core";
import type { Ledger, PositionRow } from "candle-bot-core/ledger";
import type { MarketRead } from "candle-bot-core/market/reader";
import { CreatorReadError, type BalanceAt, type HolderSource } from "candle-bot-core/sources/holders";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Action, Config } from "./config.ts";
import { devTrips, fmtSol, fmtPrice, holderTrips, prune, watchedHolders, windowDrop, type HolderSample, type Sample, type Trip } from "./rules.ts";

const TABLES = `
create table if not exists rug_events (
  id integer primary key, position_id integer not null, mint text not null, rule text not null, key text not null,
  fired_at integer not null, numbers text not null, sell real not null, alert_only integer not null, done_at integer,
  outcome text, unique (position_id, key)
);
create table if not exists rug_creators (
  mint text primary key, creator text not null, source text not null, updated_at integer not null
);
create table if not exists rug_dev (
  position_id integer primary key, mint text not null, max_raw text not null, updated_at integer not null
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
  /** Why the event owes nothing more: sold, position closed, dismissed (by hand, or the rule is now off or alertOnly). */
  outcome: string | null;
}

/** Venues whose SOL is a pool someone can pull (a bonding curve's SOL only leaves through sells). */
const POOL_VENUES = new Set(["damm", "pumpswap"]);
/** A failing holder read is alerted after this many polls in a row. */
export const HOLDER_FAIL_ALERT = 3;
/** A creator that could not be found is looked for again after this long. */
export const CREATOR_RETRY_MS = 3_600_000;
/** Price and pool samples kept per coin at most (besides the window). */
export const MAX_SAMPLES = 600;

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
  /** Elapsed-time clock for the poll budget (default performance.now). */
  clock?: () => number;
}

interface CoinState {
  venue: string;
  lastAt: number;
  price: Sample[];
  liq: Sample[];
  holders: HolderSample[];
  nextPollAt: number;
  holderFails: number;
  /** Filled sells of the position seen at the last sample (-1: not counted yet). */
  filledSells: number;
  /** Where the next poll starts its direct reads (they rotate, so no wallet is starved). */
  rot: number;
  /** The highest RPC slot a holder or balance read of this coin answered at: an older answer is stale. */
  lastSlot: number;
}

export class RugWatch {
  private d: WatchDeps;
  private now: () => number;
  private coins = new Map<number, CoinState>();
  private creatorMiss = new Map<string, number>();
  /** Real elapsed time (ms) for the poll budget. */
  private clock: () => number;

  constructor(d: WatchDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.clock = d.clock ?? (() => performance.now());
    d.ledger.db.exec(TABLES);
  }

  private state(positionId: number): CoinState {
    let s = this.coins.get(positionId);
    if (!s) {
      s = { venue: "", lastAt: -1, price: [], liq: [], holders: [], nextPollAt: 0, holderFails: 0, filledSells: -1, rot: 0, lastSlot: 0 };
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
    this.dismissRequests();
    this.settleEvents();
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
      const filled = this.d.ledger.ordersFor(p.id).filter((o) => o.side === "sell" && o.status === "filled").length;
      if (st.filledSells >= 0 && filled !== st.filledSells) {
        // One of our sells filled since the last sample: its impact on price and pool is ours, not a rug.
        st.price = [];
        st.liq = [];
      }
      st.filledSells = filled;
      // A sell of this position pending or in flight: its own impact may already show in the pool before the fill is
      // booked. No sample now; the fill restarts the windows.
      if (this.d.ledger.openOrderFor(p.id)) {
        st.price = [];
        st.liq = [];
        return;
      }
      if (m.problem) return;
      if (m.venue !== st.venue) {
        // A migration moves the SOL from the curve to a pool: not a pull. Both windows start again on a new venue.
        st.venue = m.venue;
        st.price = [];
        st.liq = [];
      }
      if (r.priceCrash && m.priceSol !== null && m.priceSol > 0) {
        st.price = prune([...st.price, { at: m.nowMs, value: m.priceSol }], m.nowMs, r.priceCrash.windowSec).slice(-MAX_SAMPLES);
        const trip = windowDrop(st.price, m.nowMs, r.priceCrash, "price", fmtPrice);
        if (trip) {
          this.fireSeq(p, "priceCrash", trip, r.priceCrash);
          st.price = st.price.slice(-1);
        }
      }
      const liq = m.quoteLiquidityLamports;
      if (r.liquidityPull && POOL_VENUES.has(m.venue) && typeof liq === "bigint") {
        st.liq = prune([...st.liq, { at: m.nowMs, value: Number(liq) / 1e9 }], m.nowMs, r.liquidityPull.windowSec).slice(-MAX_SAMPLES);
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
    const t0 = this.clock();
    for (const { p, st } of due) {
      if (shouldStop()) return;
      // A time budget per poll: the coins left keep their place (they are due first next cycle).
      if (this.clock() - t0 > this.d.cfg.watch.pollBudgetMs) {
        this.d.log.info("rug_poll_budget", { left: due.length - due.findIndex((x) => x.p.id === p.id) });
        return;
      }
      st.nextPollAt = now + this.d.cfg.watch.holdersPollMs;
      try {
        const failed = await this.pollOne(p, st);
        if (failed.length) throw new Error(failed.join("; "));
        st.holderFails = 0;
      } catch (e) {
        // Any read of the poll that failed (a snapshot, the creator, its balance, a direct or confirming read) counts:
        // the backoff and the alert see a 429 on any of them.
        st.holderFails++;
        // Back off a failing coin (2x, 4x ... up to 16x the interval): a rate-limited RPC is not hammered.
        st.nextPollAt = now + this.d.cfg.watch.holdersPollMs * Math.min(2 ** st.holderFails, 16);
        const why = String((e as Error)?.message ?? e).slice(0, 160);
        this.d.log.warn("rug_holders_unreadable", { position: p.id, mint: p.mint, error: why, inARow: st.holderFails });
        if (st.holderFails >= HOLDER_FAIL_ALERT) this.d.alerter.raise(`rug:${p.id}:holders_unreadable`, `rug watcher: holders of ${p.mint} (position ${p.id}) unreadable ${st.holderFails} polls in a row (${why}); the dev and holder rules cannot see this coin`);
      }
    }
  }

  /** A balance read with its slot; a read at an older slot than this coin has seen is stale (null). */
  private async balance(owner: string, p: PositionRow, st: CoinState): Promise<BalanceAt | null> {
    const h = this.d.holders;
    const r = h.balanceAt ? await h.balanceAt(owner, p.mint) : await h.balanceOf(owner, p.mint).then((a) => (a === null ? null : { amount: a, slot: null }));
    if (!r) return null;
    if (r.slot !== null) {
      if (r.slot < st.lastSlot) return null;
      st.lastSlot = r.slot;
    }
    return r;
  }

  /** One coin's holder and creator reads. Returns what failed (empty: all read). */
  private async pollOne(p: PositionRow, st: CoinState): Promise<string[]> {
    const r = this.d.cfg.rules;
    const failed: string[] = [];
    const snap = await this.d.holders.snapshot(p.mint);
    let snapOk = true;
    if (typeof snap.slot === "number") {
      if (snap.slot < st.lastSlot) {
        snapOk = false;
        failed.push(`holder list at slot ${snap.slot}, older than ${st.lastSlot}`);
      } else st.lastSlot = snap.slot;
    }
    let creator: string | null = null;
    if (r.devDump) {
      const c = await this.creator(p.mint);
      if ("error" in c) failed.push(`creator: ${c.error}`);
      else if ("wallet" in c) creator = c.wallet;
    }
    if (r.devDump && creator === this.d.cfg.wallet) {
      // Our own wallet launched it: our own sells would read as the dev selling. The dev rule is off for this coin.
      this.d.alerter.raise(`rug:${p.id}:creator_is_us`, `rug watcher: the creator of ${p.mint} is this bot's own wallet; the dev rule does not run for it (its own sells would read as the dev selling)`);
    } else if (r.devDump && creator) {
      const first = await this.balance(creator, p, st);
      if (!first) failed.push("creator balance unreadable or stale");
      else {
        const row = this.d.ledger.db.prepare("select max_raw from rug_dev where position_id = ?").get(p.id) as { max_raw: string } | undefined;
        const prevMax = row ? BigInt(row.max_raw) : 0n;
        const max = first.amount > prevMax ? first.amount : prevMax;
        if (!row || max !== prevMax) this.d.ledger.db.prepare("insert into rug_dev (position_id, mint, max_raw, updated_at) values (?, ?, ?, ?) on conflict(position_id) do update set max_raw = excluded.max_raw, updated_at = excluded.updated_at").run(p.id, p.mint, max.toString(), this.now());
        // A creator that holds none of the coin when first read: the dev rule can only fire if it buys. Said once.
        if (!row && first.amount === 0n) this.d.alerter.raise(`rug:${p.id}:creator_empty`, `rug watcher: the creator found for ${p.mint} (${creator}) holds none of it; the dev rule fires only if it buys some. If that is the wrong wallet, name the right one in rules.devDump.creators`);
        const trips = devTrips(r.devDump, { maxRaw: max }, first.amount, snap.supply, p.decimals);
        if (trips.length) {
          // A single read never fires: a second read (at the same or a later slot) must show it too. An empty answer
          // from a lagging node reads as 0; it has to say so twice.
          const second = await this.balance(creator, p, st);
          if (!second) failed.push("creator confirming read unreadable or stale");
          else {
            const again = new Set(devTrips(r.devDump, { maxRaw: max }, second.amount, snap.supply, p.decimals).map((t) => t.part));
            for (const t of devTrips(r.devDump, { maxRaw: max }, second.amount, snap.supply, p.decimals)) if (again.has(t.part) && trips.some((x) => x.part === t.part)) this.fire(p, "devDump", `dev:${t.part}`, { ...t.trip, numbers: { creator, ...t.trip.numbers } }, r.devDump);
            if (!trips.every((t) => again.has(t.part))) this.d.log.info("rug_dev_unconfirmed", { position: p.id, mint: p.mint, creator, firstRaw: first.amount.toString(), secondRaw: second.amount.toString() });
          }
        }
      }
    }
    if (r.holderExit && snapOk) {
      const rule = r.holderExit;
      const skip = new Set([this.d.cfg.wallet, ...rule.exclude, ...(r.devDump && creator ? [creator] : [])]);
      const list = snap.holders.filter((h) => !skip.has(h.owner));
      const sample: HolderSample = { at: snap.atMs, amounts: new Map(list.map((h) => [h.owner, h.amount])), top: list.slice(0, rule.topN).map((h) => h.owner) };
      st.holders = [...st.holders, sample].filter((s) => s.at >= snap.atMs - rule.windowSec * 1000).slice(-MAX_SAMPLES);
      const nowAmounts = new Map<string, bigint | null>();
      let direct = 0;
      const watched = [...watchedHolders(st.holders)].filter((o) => !skip.has(o));
      const start = watched.length ? st.rot % watched.length : 0;
      st.rot++;
      for (const owner of [...watched.slice(start), ...watched.slice(0, start)]) {
        const a = sample.amounts.get(owner);
        if (a !== undefined) nowAmounts.set(owner, a);
        else if (direct < rule.topN) {
          // Out of the largest accounts now: its balance is read directly (unknown on a failed read, never zero).
          direct++;
          const b = await this.balance(owner, p, st);
          if (!b) failed.push(`balance of ${owner} unreadable or stale`);
          nowAmounts.set(owner, b ? b.amount : null);
        }
      }
      for (const t of holderTrips(rule, st.holders, nowAmounts, snap.supply, p.decimals)) {
        // The largest-accounts list shows only some of a wallet's accounts: confirm on the wallet's whole balance
        // (all its accounts) before firing. Unreadable: unknown, no firing this poll.
        const full = await this.balance(t.owner, p, st);
        if (!full) {
          failed.push(`confirming read of ${t.owner} unreadable or stale`);
          continue;
        }
        const ok = holderTrips(rule, st.holders, new Map([[t.owner, full.amount]]), snap.supply, p.decimals)[0];
        if (ok) this.fire(p, "holderExit", `holder:${t.owner}`, ok.trip, rule);
        else this.d.log.info("rug_holder_unconfirmed", { position: p.id, mint: p.mint, owner: t.owner, wholeBalanceRaw: full.amount.toString() });
      }
    }
    return failed;
  }

  /**
   * The coin's creator: from config, else from chain (kept in the ledger once found). `none`: chain names none (looked
   * for again after CREATOR_RETRY_MS, alerted). `error`: a read failed (tried again next poll; nothing is kept).
   */
  private async creator(mint: string): Promise<{ wallet: string } | { none: true } | { error: string }> {
    const given = this.d.cfg.rules.devDump?.creators[mint];
    const row = this.d.ledger.db.prepare("select creator, source from rug_creators where mint = ?").get(mint) as { creator: string; source: string } | undefined;
    if (given) {
      if (!row || row.creator !== given) {
        this.d.ledger.db.prepare("insert into rug_creators (mint, creator, source, updated_at) values (?, ?, 'config', ?) on conflict(mint) do update set creator = excluded.creator, source = 'config', updated_at = excluded.updated_at").run(mint, given, this.now());
        // Another wallet: the highs kept for the old one do not apply.
        if (row) this.d.ledger.db.prepare("delete from rug_dev where mint = ?").run(mint);
      }
      return { wallet: given };
    }
    if (row && row.source !== "config") return { wallet: row.creator };
    if ((this.creatorMiss.get(mint) ?? 0) > this.now()) return { none: true };
    let found: { creator: string; source: string } | null;
    try {
      found = await this.d.creatorOf(mint);
    } catch (e) {
      const why = e instanceof CreatorReadError ? e.message : String((e as Error)?.message ?? e).slice(0, 160);
      return { error: why };
    }
    if (!found) {
      this.creatorMiss.set(mint, this.now() + CREATOR_RETRY_MS);
      this.d.alerter.raise(`rug:creator_unknown:${mint}`, `rug watcher: no creator found on chain for ${mint}; the dev rule does not run for it (set rules.devDump.creators to name one)`);
      return { none: true };
    }
    this.d.ledger.db.prepare("insert into rug_creators (mint, creator, source, updated_at) values (?, ?, ?, ?) on conflict(mint) do update set creator = excluded.creator, source = excluded.source, updated_at = excluded.updated_at").run(mint, found.creator, found.source, this.now());
    this.d.log.info("rug_creator", { mint, creator: found.creator, source: found.source });
    return { wallet: found.creator };
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
    this.d.log.warn("rug_rule", { position: p.id, mint: p.mint, rule, key, eventId: Number(res.lastInsertRowid), alertOnly: a.alertOnly, sell: a.sell, ...trip.numbers });
    this.d.alerter.raise(`rug:${p.id}:${key}`, msg, { mint: p.mint, rule, ...trip.numbers });
    return true;
  }

  /** Every firing, newest first (status). */
  events(positionId?: number): EventRow[] {
    return (positionId === undefined
      ? this.d.ledger.db.prepare("select * from rug_events order by id desc limit 50").all()
      : this.d.ledger.db.prepare("select * from rug_events where position_id = ? order by id desc").all(positionId)) as unknown as EventRow[];
  }

  creatorRow(mint: string): { creator: string; source: string } | undefined {
    return this.d.ledger.db.prepare("select creator, source from rug_creators where mint = ?").get(mint) as any;
  }

  /** The creator's highest holding while this position was watched (raw), or null before the first read. */
  devHigh(positionId: number): string | null {
    const r = this.d.ledger.db.prepare("select max_raw from rug_dev where position_id = ?").get(positionId) as { max_raw: string } | undefined;
    return r ? r.max_raw : null;
  }

  /** Whether a sell with this event's reason filled. */
  soldFor(e: EventRow): boolean {
    return this.d.ledger.ordersFor(e.position_id).some((o) => o.side === "sell" && o.status === "filled" && o.reason === `rug:${e.rule}#${e.id}`);
  }

  /**
   * Events that owe nothing more: their sell filled, or their position is no longer watched (closed by that sell or
   * another, or released). Marked done.
   */
  settleEvents(): void {
    const rows = this.d.ledger.db.prepare("select * from rug_events where alert_only = 0 and done_at is null").all() as unknown as EventRow[];
    for (const e of rows) {
      const p = this.d.ledger.position(e.position_id);
      if (this.soldFor(e)) this.settle(e.id, "sold");
      else if (!p || (p.status !== "open" && p.status !== "exit_stuck" && p.status !== "opening")) this.settle(e.id, `position ${p?.status ?? "gone"}`);
    }
  }

  /** Close an event that owes nothing more, with why. */
  private settle(id: number, outcome: string): void {
    this.d.ledger.db.prepare("update rug_events set done_at = ?, outcome = ? where id = ? and done_at is null").run(this.now(), outcome, id);
  }

  /**
   * The sell a firing still owes this position: the oldest selling event whose sell has not filled. Its reason
   * (`rug:<rule>#<event id>`) ties the order to the event. Null while that sell is in flight, or when none is owed.
   * Checked against the rules as configured NOW: a rule since turned off or set to alertOnly owes nothing (the event is
   * dismissed), and the share sold is the rule's current `sell`. A share that rounds to nothing of what remains is
   * settled, so it never holds the configured exit back.
   */
  pendingSell(positionId: number, remainingRaw?: bigint): { fraction: number; reason: string } | null {
    const rows = this.d.ledger.db.prepare("select * from rug_events where position_id = ? and alert_only = 0 and done_at is null order by id").all(positionId) as unknown as EventRow[];
    if (!rows.length) return null;
    const sells = this.d.ledger.ordersFor(positionId).filter((o) => o.side === "sell");
    for (const e of rows) {
      const reason = `rug:${e.rule}#${e.id}`;
      const mine = sells.filter((o) => o.reason === reason);
      if (mine.some((o) => o.status === "filled")) {
        this.settle(e.id, "sold");
        continue;
      }
      if (mine.some((o) => o.status === "pending" || o.status === "inflight")) return null;
      const rule = this.d.cfg.rules[e.rule] as Action | undefined;
      if (!rule || rule.alertOnly) {
        this.settle(e.id, `dismissed: the rule is now ${rule ? "alertOnly" : "off"}`);
        this.d.log.info("rug_event_dismissed", { event: e.id, position: positionId, why: rule ? "alertOnly" : "rule off" });
        continue;
      }
      if (remainingRaw !== undefined && (rule.sell >= 1 ? remainingRaw : (remainingRaw * BigInt(Math.round(rule.sell * 1e6))) / 1_000_000n) <= 0n) {
        this.settle(e.id, "nothing left to sell");
        continue;
      }
      return { fraction: rule.sell, reason };
    }
    return null;
  }

  /** Dismiss an event by hand: it owes no sell; the coin stays watched. */
  dismiss(eventId: number): string {
    const e = this.d.ledger.db.prepare("select * from rug_events where id = ?").get(eventId) as unknown as EventRow | undefined;
    if (!e) return `no event ${eventId}`;
    if (e.done_at !== null) return `event ${eventId} is already settled (${e.outcome ?? "done"})`;
    this.settle(eventId, "dismissed by hand");
    this.d.log.info("rug_event_dismissed", { event: eventId, position: e.position_id, why: "by hand" });
    return `dismissed event ${eventId}`;
  }

  /** `dismiss` request files (written by the command line while the watcher runs). */
  private dismissRequests(): void {
    const dir = join(this.d.cfg.stateDir, "requests");
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => /^dismiss-.*\.json$/.test(n)).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const f = join(dir, n);
      try {
        const req = JSON.parse(readFileSync(f, "utf8"));
        this.d.log.info("dismiss_request", { file: n, result: this.dismiss(Number(req.event)) });
      } catch (e) {
        this.d.log.warn("dismiss_request_unreadable", { file: n, error: String((e as Error)?.message ?? e) });
      }
      try {
        unlinkSync(f);
      } catch {
        /* gone */
      }
    }
  }
}
