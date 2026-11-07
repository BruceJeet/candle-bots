/**
 * The hedger: one step reads the perps venue and the spot wallet, reconciles any order whose outcome it does not
 * know, books fills and funding, plans (candle-bot-core/perps/planner) and sends at most one order per coin.
 *
 * Money rules:
 *  - No venue read, no order: a step that cannot read the markets or the account sends nothing.
 *  - Every order is written to the book under a fresh client id BEFORE the venue is asked.
 *  - A coin with an order whose outcome is not known (sent, or answered unknown) is frozen: the step only asks the
 *    venue for that client id's record, until it is filled, refused, or (after perps.settleSec with no record) written
 *    off as not placed. A restart reads the same book, so it never sends a second order for an order in doubt.
 *  - The venue's position on each managed coin is checked against the book's (the sum of its fills); a difference
 *    seen for perps.mismatchSec on two reads freezes the coin and is alerted (`accept <coin>` takes it over).
 *  - Opens: never while PAUSE_OPENS exists. FLATTEN closes every managed position (reduce-only) while it exists.
 *  - The coin's leverage and margin mode are set once per run before its first open; a refusal skips the open.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Alerter } from "candle-bot-core/alerts";
import type { Logger } from "candle-bot-core/log";
import type { Rpc } from "candle-bot-core/solana/rpc";
import { HedgeBook } from "candle-bot-core/perps/book";
import { fitBeta, planHedge, type BagIn, type Plan, type PlanOrder } from "candle-bot-core/perps/planner";
import { readSpotBags, type SpotBag, type SpotReadOptions } from "candle-bot-core/perps/spot";
import { newClientId, type PerpAccount, type PerpMarket, type PerpsVenue } from "candle-bot-core/perps/venue";
import type { Config } from "./config.ts";

export interface HedgerDeps {
  cfg: Config;
  venue: PerpsVenue;
  book: HedgeBook;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  now?: () => number;
  /** The spot read (default: the core's wallet reader). */
  spot?: (rpc: Rpc, o: SpotReadOptions) => Promise<SpotBag[]>;
}

interface BagState {
  bag: SpotBag;
  /** USD per whole token at the last good price, and when it was read. */
  coinUsd: number | null;
  pricedAt: number | null;
}

export class Hedger {
  private d: HedgerDeps;
  private now: () => number;
  private bags = new Map<string, BagState>();
  private leverageSet = new Set<string>();
  private mismatch = new Map<string, { since: number; reads: number; venue: number; book: number }>();
  private nextFillsAt = 0;
  private nextSampleAt = 0;
  private spotOkAt: number | null = null;
  private readonly startedAt: number;
  /** Bags left out this read: a venue thinner than spot.minLiquiditySol. */
  thin: Array<{ mint: string; liquiditySol: number }> = [];
  lastPlan: Plan | null = null;
  lastAccount: PerpAccount | null = null;
  lastMarkets: Map<string, PerpMarket> | null = null;
  frozen = new Map<string, string>();
  steps = 0;
  sent = 0;

  constructor(d: HedgerDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.startedAt = this.now();
    d.book.checkIdentity({ mode: d.cfg.mode, network: d.cfg.network, account: d.venue.kind === "live" ? d.cfg.perps.wallet ?? "" : `paper:${d.cfg.perps.wallet ?? "none"}` });
  }

  private control(name: string): boolean {
    return existsSync(join(this.d.cfg.stateDir, name));
  }

  /** The coins the hedger may trade: the proxy, configured perps, and every coin the book ever traded. */
  managed(): Set<string> {
    const s = new Set<string>([this.d.cfg.hedge.proxy, ...this.d.book.coins()]);
    for (const c of Object.values(this.d.cfg.hedge.coins)) if (c.perp) s.add(c.perp);
    return s;
  }

  /** Spot: a failed read keeps the last bags (and their price times, so the kill rule runs on them). */
  private async readSpot(solUsd: number | null): Promise<void> {
    const t = this.now();
    let fresh: SpotBag[];
    try {
      fresh = await (this.d.spot ?? readSpotBags)(this.d.rpc, { wallet: this.d.cfg.spot.wallet, mode: this.d.cfg.spot.mode, mints: this.d.cfg.spot.mints, exclude: new Set(this.d.cfg.spot.exclude), maxBags: this.d.cfg.spot.maxBags, now: this.now, onTruncated: (n) => this.d.alerter.raise("spot:truncated", `the wallet holds ${n} candidate coins; only ${this.d.cfg.spot.maxBags} are read (spot.maxBags): list the coins to hedge (spot.mode "list")`) });
    } catch (e) {
      this.d.log.warn("spot_read_failed", { error: String((e as Error)?.message ?? e).slice(0, 300) });
      return;
    }
    this.spotOkAt = t;
    const next = new Map<string, BagState>();
    this.thin = [];
    for (const b of fresh) {
      if (b.qtyRaw === 0n) continue; // sold or sent away: no hedge needed
      if (b.liquiditySol !== null && b.liquiditySol < this.d.cfg.spot.minLiquiditySol) {
        this.thin.push({ mint: b.mint, liquiditySol: b.liquiditySol });
        continue; // a thin venue: its mid is no value to hedge (an airdrop, a drained pool)
      }
      const prev = this.bags.get(b.mint);
      const usd = b.priceSol !== null && solUsd !== null && solUsd > 0 ? b.priceSol * solUsd : null;
      if (usd !== null) next.set(b.mint, { bag: b, coinUsd: usd, pricedAt: t });
      // Unpriced now: the last good price stays, with its time (the planner's kill rule decides).
      else next.set(b.mint, { bag: b, coinUsd: prev?.coinUsd ?? null, pricedAt: prev?.pricedAt ?? null });
    }
    this.bags = next;
  }

  /** Orders whose outcome is not known: ask the venue for each client id. */
  private async reconcile(): Promise<void> {
    for (const row of this.d.book.unresolved()) {
      try {
        const st = await this.d.venue.orderStatus(row.client_id);
        if (!st.found && this.now() - row.created_at >= this.d.cfg.perps.settleSec * 1000) {
          // Before writing it off: no fill on the coin since the order from an order the book does not know (a
          // signed order that landed late would show there).
          const odd = (await this.d.venue.fills(row.created_at - 5_000)).filter((f) => f.coin === row.coin && !this.d.book.hasOid(f.oid));
          if (odd.length) {
            this.d.alerter.raise(`perps:unexplained-fill:${row.coin}`, `${row.coin}: order ${row.id} (client id ${row.client_id}) has no venue record, but ${odd.length} fill(s) on ${row.coin} since it came from orders the book does not know (oid ${odd.map((f) => f.oid).join(", ")}): it stays in doubt and ${row.coin} stays frozen`, { coin: row.coin });
            continue;
          }
        }
        const done = this.d.book.resolve(row.id, st, this.d.cfg.perps.settleSec * 1000);
        if (done) {
          const r = this.d.book.order(row.id)!;
          this.d.log.info("order_reconciled", { id: row.id, coin: row.coin, status: r.status, filledSz: r.filled_sz, clientId: row.client_id });
        }
      } catch (e) {
        this.d.log.warn("order_status_failed", { id: row.id, coin: row.coin, error: String((e as Error)?.message ?? e).slice(0, 300) });
      }
    }
    this.d.book.reattribute();
  }

  private async bookHistory(coins: Set<string>): Promise<void> {
    const t = this.now();
    if (t < this.nextFillsAt) return;
    this.nextFillsAt = t + this.d.cfg.perps.fillsEverySec * 1000;
    const started = Number(this.d.book.meta("started_at"));
    for (const kind of ["fills", "funding"] as const) {
      const key = `${kind}_since`;
      const since = Math.max(started, Number(this.d.book.meta(key) ?? started) - 300_000);
      try {
        if (kind === "fills") {
          const added = this.d.book.addFills(await this.d.venue.fills(since), coins);
          for (const f of added) {
            if (!f.ours) this.d.alerter.raise(`perps:foreign-fill:${f.coin}`, `a fill on ${f.coin} that is not one of the hedger's orders (oid ${f.oid}, ${f.side} ${f.sz} at ${f.px}): another tool is trading this account's ${f.coin}`, { coin: f.coin, oid: f.oid });
            this.d.log.info("fill_booked", { coin: f.coin, oid: f.oid, tid: f.tid, side: f.side, sz: f.sz, px: f.px, fee: f.fee, ours: f.ours });
          }
        } else {
          for (const r of this.d.book.addFunding(await this.d.venue.funding(since), coins)) this.d.log.info("funding_booked", { coin: r.coin, usdc: r.usdc, rate: r.rate, szi: r.szi, time: r.time });
        }
        this.d.book.setMeta(key, String(t));
      } catch (e) {
        this.d.log.warn(`${kind}_read_failed`, { error: String((e as Error)?.message ?? e).slice(0, 300) });
      }
    }
  }

  /** Coins frozen this step: an unresolved order, or a position the book cannot explain (confirmed over time). */
  private freeze(account: PerpAccount, markets: Map<string, PerpMarket>, managed: Set<string>): Map<string, string> {
    const frozen = new Map<string, string>();
    for (const r of this.d.book.unresolved()) if (!frozen.has(r.coin)) frozen.set(r.coin, `order ${r.id} (${r.status}) not reconciled yet`);
    const t = this.now();
    for (const coin of managed) {
      const venue = account.positions.find((p) => p.coin === coin)?.szi ?? 0;
      const book = this.d.book.expected(coin);
      const step = 10 ** -(markets.get(coin)?.szDecimals ?? 6);
      if (Math.abs(venue - book) < step / 2 || frozen.has(coin)) {
        this.mismatch.delete(coin);
        continue;
      }
      const m = this.mismatch.get(coin);
      if (!m) {
        this.mismatch.set(coin, { since: t, reads: 1, venue, book });
        // Not confirmed yet: no order on it either, until the reads agree or the difference holds.
        frozen.set(coin, `position ${venue} differs from the book's ${book}: checking`);
        continue;
      }
      // The timer runs while the two differ at all (a position changing on every read, as in a liquidation in steps,
      // still alerts).
      m.reads++;
      m.venue = venue;
      m.book = book;
      frozen.set(coin, `position ${venue} differs from the book's ${book}`);
      if (t - m.since >= this.d.cfg.perps.mismatchSec * 1000)
        this.d.alerter.raise(`perps:mismatch:${coin}`, `${coin}: the account holds ${venue} but the hedge book made ${book}. The hedger leaves ${coin} alone until this is explained; \`accept ${coin}\` (bot stopped) takes the position over as the hedger's`, { coin, venue, book });
    }
    return frozen;
  }

  private samples(markets: Map<string, PerpMarket>): Map<string, number | null> {
    const beta = this.d.cfg.hedge.beta;
    const out = new Map<string, number | null>();
    if (!beta) return out;
    const t = this.now();
    const proxy = markets.get(this.d.cfg.hedge.proxy)?.markPx ?? null;
    if (t >= this.nextSampleAt && proxy !== null) {
      this.nextSampleAt = t + beta.everySec * 1000;
      const bucket = Math.floor(t / (beta.everySec * 1000)) * beta.everySec * 1000;
      for (const s of this.bags.values()) if (s.coinUsd !== null && s.pricedAt === t) this.d.book.addSample(s.bag.mint, bucket, s.coinUsd, proxy);
      this.d.book.pruneSamples(t - 2 * beta.windowMin * 60_000);
    }
    for (const mint of this.bags.keys()) out.set(mint, fitBeta(this.d.book.samples(mint, t - beta.windowMin * 60_000), beta));
    return out;
  }

  /** One step. Never throws for a failed read (logged, alerted when it lasts); a thrown bug is the loop's to log. */
  async step(shouldStop: () => boolean = () => false): Promise<void> {
    this.steps++;
    let markets: Map<string, PerpMarket>;
    let account: PerpAccount;
    try {
      markets = await this.d.venue.markets();
      account = await this.d.venue.account();
    } catch (e) {
      this.d.log.warn("perps_read_failed", { error: String((e as Error)?.message ?? e).slice(0, 300) });
      this.d.alerter.raise("perps:read", `cannot read the perps venue (${String((e as Error)?.message ?? e).slice(0, 200)}): no hedge orders until it reads again`);
      return;
    }
    this.lastMarkets = markets;
    this.lastAccount = account;
    const solUsd = markets.get("SOL")?.markPx ?? null;
    await this.readSpot(solUsd);
    const graceMs = this.d.cfg.hedge.unpricedCloseSec * 1000;
    const lastOk = this.spotOkAt ?? this.startedAt;
    if (this.now() - lastOk > graceMs)
      this.d.alerter.raise("spot:read", `cannot read the spot wallet since ${this.spotOkAt === null ? "the start" : new Date(this.spotOkAt).toISOString()}: its bags count as unpriced and their hedges are closed`);
    // Never read the wallet since the start: no bags known yet, so no plan (it would close every hedge) until the
    // grace runs out; then the kill rule applies as for an unpriced bag.
    const blind = this.spotOkAt === null && this.now() - this.startedAt <= graceMs;
    await this.reconcile();
    const managed = this.managed();
    await this.bookHistory(managed);
    this.frozen = this.freeze(account, markets, managed);
    const betas = this.samples(markets);
    const t = this.now();
    const bags: BagIn[] = [...this.bags.values()].map((s) => ({
      mint: s.bag.mint,
      valueUsd: s.coinUsd === null ? null : (Number(s.bag.qtyRaw) / 10 ** s.bag.decimals) * s.coinUsd,
      pricedAt: s.pricedAt,
      beta: betas.get(s.bag.mint) ?? null,
    }));
    const positions = new Map(account.positions.map((p) => [p.coin, p.szi]));
    const plan = planHedge({ now: t, bags, markets, positions, accountValueUsd: account.accountValueUsd, frozen: this.frozen, managed, flatten: this.control("FLATTEN"), pauseOpens: this.control("PAUSE_OPENS"), cfg: this.d.cfg.hedge });
    this.lastPlan = plan;
    if (blind) {
      this.d.log.warn("spot_not_read_yet", { sinceStartMs: this.now() - this.startedAt });
      return;
    }
    if (plan.capped) this.d.alerter.raise("perps:capped", `hedge capped by ${plan.capped.by}: targets at ${(plan.capped.factor * 100).toFixed(1)} %`, plan.capped);
    for (const b of plan.bags) if (b.status === "unpriced" && b.coin) this.d.alerter.raise(`spot:unpriced:${b.mint}`, `${b.mint} cannot be priced: its hedge on ${b.coin} is closed`, { mint: b.mint });
    for (const l of plan.lines) if (l.status === "no_market") this.d.alerter.raise(`perps:no-market:${l.coin}`, `${l.coin}: ${l.note}; no orders on it`, { coin: l.coin });
    for (const o of plan.orders) {
      if (shouldStop()) break;
      await this.send(o, markets);
    }
  }

  private async send(o: PlanOrder, markets: Map<string, PerpMarket>): Promise<void> {
    const cfg = this.d.cfg;
    if (o.action === "open" && !this.leverageSet.has(o.coin)) {
      const lev = Math.max(1, Math.min(cfg.hedge.maxLeverage, markets.get(o.coin)?.maxLeverage ?? 1));
      const mode = markets.get(o.coin)?.onlyIsolated ? "isolated" : cfg.perps.marginMode;
      try {
        await this.d.venue.setLeverage(o.coin, lev, mode);
        this.leverageSet.add(o.coin);
        this.d.log.info("leverage_set", { coin: o.coin, leverage: lev, mode });
      } catch (e) {
        this.d.log.warn("leverage_failed", { coin: o.coin, error: String((e as Error)?.message ?? e).slice(0, 300) });
        this.d.alerter.raise(`perps:leverage:${o.coin}`, `${o.coin}: setting ${lev}x ${mode} failed (${String((e as Error)?.message ?? e).slice(0, 160)}); no open on it until it succeeds`);
        return;
      }
    }
    const clientId = newClientId();
    const id = this.d.book.intent({ coin: o.coin, action: o.action, side: o.side, size: o.size, reduceOnly: o.reduceOnly, reason: o.reason, clientId });
    this.d.log.info("order_sent", { id, coin: o.coin, action: o.action, side: o.side, size: o.size, reduceOnly: o.reduceOnly, reason: o.reason, usd: +o.usd.toFixed(2), clientId });
    this.sent++;
    const req = { coin: o.coin, side: o.side, size: o.size, reduceOnly: o.reduceOnly, clientId, slippageBps: cfg.perps.slippageBps };
    let r;
    try {
      r = o.action === "open" ? await this.d.venue.open(req) : await this.d.venue.close(req);
    } catch (e) {
      r = { status: "unknown" as const, error: String((e as Error)?.message ?? e).slice(0, 300) };
    }
    this.d.book.result(id, r);
    this.d.log.info("order_result", { id, coin: o.coin, status: r.status, ...(r.status === "filled" ? { filledSz: r.filledSz, avgPx: r.avgPx, oid: r.oid } : { error: r.error }) });
    if (r.status === "rejected") this.d.alerter.raise(`perps:rejected:${o.coin}`, `${o.coin} ${o.action} ${o.side} ${o.size ?? "all"} refused: ${r.error.slice(0, 200)}`, { coin: o.coin });
    if (r.status === "unknown") this.d.alerter.raise(`perps:unknown:${o.coin}`, `${o.coin} ${o.action} ${o.side} ${o.size ?? "all"}: no clear answer (${r.error.slice(0, 160)}); the coin is frozen until the venue's record of client id ${clientId} is read`, { coin: o.coin, clientId });
  }

  status(): Record<string, unknown> {
    const book = this.d.book;
    const tot = book.totals();
    return {
      network: this.d.cfg.network,
      venue: this.d.venue.kind,
      perpsWallet: this.d.cfg.perps.wallet,
      spotWallet: this.d.cfg.spot.wallet,
      paused: { opens: this.control("PAUSE_OPENS"), flatten: this.control("FLATTEN") },
      account: this.lastAccount ? { readAt: new Date(this.lastAccount.readAt).toISOString(), valueUsd: this.lastAccount.accountValueUsd, marginUsedUsd: this.lastAccount.marginUsedUsd, positions: this.lastAccount.positions } : null,
      lines: this.lastPlan?.lines ?? [],
      bags: (this.lastPlan?.bags ?? []).map((b) => ({ ...b, venue: this.bags.get(b.mint)?.bag.venue ?? null, pricedAt: this.bags.get(b.mint)?.pricedAt ? new Date(this.bags.get(b.mint)!.pricedAt!).toISOString() : null })),
      capped: this.lastPlan?.capped ?? null,
      frozen: Object.fromEntries(this.frozen),
      thin: this.thin,
      unresolved: book.unresolved().map((r) => ({ id: r.id, coin: r.coin, status: r.status, clientId: r.client_id })),
      book: Object.fromEntries([...this.managed()].map((c) => [c, book.expected(c)])),
      totals: { ...tot, net: tot.closedPnl - tot.fees + tot.funding },
      recentOrders: book.recent(10).map((r) => ({ id: r.id, coin: r.coin, action: r.action, side: r.side, size: r.size, status: r.status, filledSz: r.filled_sz, avgPx: r.avg_px, reason: r.reason, at: new Date(r.created_at).toISOString(), ...(r.error ? { error: r.error } : {}) })),
      ordersSent: this.sent,
      hedgerSteps: this.steps,
    };
  }
}

