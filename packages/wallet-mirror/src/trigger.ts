/**
 * The mirror on the core engine (candle-bot-core):
 *
 *   the wallet source (core sources/wallets) -> every leader trade is recorded once (leader_trades) and applied to the
 *   leader book (core sources/walletPositions):
 *     a buy  -> a candidate (an open by default; `mirror.copy: "buys"` takes any buy), judged in decide(): its age at
 *               detection, the venue, the leader's size, once per (leader, coin), the leader's caps, a venue the bot
 *               can price (so its exits can run), then the ticket. The engine's caps come after (maxOpen, lifetimeSol,
 *               maxPerCoin, PAUSE_BUYS).
 *     a sell -> each of our positions in that coin (from that leader, by default) owes a sell of the same share of
 *               what the leader held (a close: everything). MirrorExit asks the engine for it, so it goes through the
 *               engine's whole exit path; the configured exit strategy runs alongside for everything else.
 *
 * Restart safety: the source backfills from each leader's last handled signature (mirror_cursor); a trade already in
 * leader_trades is dropped before anything else; a coin copied from a leader (mirror_copies) is never copied from it
 * again; an owed sell is one row per (position, leader signature).
 */
import { Engine, Executor, loadStrategy, type Alerter, type Candidate, type ExitStrategy, type PendingInfo, type Trigger, type TriggerContext, type Verdict } from "candle-bot-core";
import { lamportsOf } from "candle-bot-core/engine";
import { KNOWN_PROGRAMS } from "candle-bot-core/exec/trader";
import type { Logger } from "candle-bot-core/log";
import { buyQuote, readMarkets, sellFloor, type MarketRead } from "candle-bot-core/market/reader";
import { parts, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import type { Rpc } from "candle-bot-core/solana/rpc";
import { LeaderBook } from "candle-bot-core/sources/walletPositions";
import type { WalletEvent, WalletFeed, WalletGap } from "candle-bot-core/sources/wallets";
import type { Config, Leader } from "./config.ts";
import type { Ledger, PositionRow } from "./ledger.ts";

type Ctx = CoreCtx<Config>;

/** What a copy candidate carries (strings for the raw amounts: it is stored as JSON with the position). */
export interface LeaderBuy {
  leader: string;
  label: string | null;
  signature: string;
  slot: number;
  blockTime: number | null;
  venue: string;
  kind: string;
  leaderSolRaw: string;
  leaderTokenRaw: string;
  /** The leader's balance after this buy (raw), to order same-slot sells after it. */
  leaderHeldAfterRaw?: string;
  decimals: number;
}

/** Reads a coin's market (the engine's reader, pump venues on): a stub in tests. */
export type MarketReader = (mint: string, decimals: number) => Promise<MarketRead | undefined>;

export interface MirrorDeps {
  cfg: Config;
  ledger: Ledger;
  source: WalletFeed;
  log: Logger;
  alerter: Alerter;
  rpc: Rpc;
  readMarket?: MarketReader;
  now?: () => number;
}

const sol = (lamports: bigint | string) => Number(BigInt(lamports)) / 1e9;
const fmt = (x: number) => (x >= 1 ? x.toFixed(3) : x.toPrecision(3));
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export class MirrorTrigger implements Trigger {
  readonly name = "wallet-mirror";
  readonly candidateLabel = "leaderBuys";
  readonly buyIdPrefix = "cwmb";
  readonly sellIdPrefix = "cwms";
  readonly concurrency = 4;
  private d: MirrorDeps;
  private now: () => number;
  private leaders: Map<string, Leader>;
  book: LeaderBook;
  /** Events drained from the source and not yet recorded. */
  private buffer: WalletEvent[] = [];
  /** Buys decided and not yet booked, per coin: they count toward their leader's caps until the ledger shows them. */
  private reserved = new Map<string, { leader: string; lamports: bigint }>();
  private readMarket: MarketReader;
  readonly stats = { leaderTrades: 0, repeats: 0, buysSeen: 0, sellsSeen: 0, sellsOwed: 0, gapsRecovered: 0, gapsUnrecovered: 0 };
  private lastGaps: WalletGap[] = [];

  constructor(d: MirrorDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.leaders = new Map(d.cfg.leaders.map((l) => [l.address, l]));
    this.book = LeaderBook.fromJSON(d.ledger.leaderBook(), { openDustPct: d.cfg.mirror.openDustPct });
    this.readMarket = d.readMarket ?? (async (mint, decimals) => (await readMarkets(d.rpc, [{ mint, decimals }], this.now(), { pump: true })).get(mint));
  }

  private label(w: string): string {
    return this.leaders.get(w)?.label ?? short(w);
  }

  async start(ctx: TriggerContext): Promise<void> {
    this.d.source.subscribe([...this.leaders.keys()]);
    this.d.source.onNew = () => ctx.wake();
    await this.d.source.start();
  }

  async stop(): Promise<void> {
    await this.d.source.stop();
  }

  poll(ctx: TriggerContext): Candidate[] {
    for (const g of this.d.source.drainGaps()) this.onGap(g);
    this.buffer.push(...this.d.source.drain());
    const out: Candidate[] = [];
    // One event at a time: an event leaves the buffer only once it is recorded (or dropped as a repeat), so a failed
    // write (a busy or full disk) keeps it and the rest for the next poll.
    while (this.buffer.length) {
      const e = this.buffer[0];
      let c: Candidate | null;
      try {
        c = this.take(e);
      } catch (err) {
        // The book was changed in memory before the write failed: back to what the ledger holds.
        this.book = LeaderBook.fromJSON(this.d.ledger.leaderBook(), { openDustPct: this.d.cfg.mirror.openDustPct });
        this.d.log.error("leader_trade_record_failed", { leader: e.wallet, signature: e.signature, error: String((err as Error)?.message ?? err).slice(0, 300), left: this.buffer.length });
        break;
      }
      this.buffer.shift();
      if (c) out.push(c);
    }
    this.owed(ctx);
    // The restart point: what the source has read and handled for each leader, never past a queued transaction, and
    // not for a leader with events still waiting here (a failed write): a restart then reads them again.
    const waiting = new Set(this.buffer.map((e) => e.wallet));
    for (const w of this.leaders.keys()) {
      if (waiting.has(w)) continue;
      const cp = this.d.source.checkpoint?.(w) ?? null;
      if (cp) this.d.ledger.putCursor(w, cp.signature, cp.blockTime ?? null, this.now());
    }
    return out;
  }

  /** Record one leader trade (once) and say whether it is a copy candidate. */
  private take(e: WalletEvent): Candidate | null {
    if (!this.leaders.has(e.wallet)) return null;
    if (this.d.ledger.hasLeaderTrade(e.wallet, e.signature)) {
      this.stats.repeats++;
      return null;
    }
    const move = this.book.apply(e);
    if (!this.d.ledger.recordLeaderTrade(e, move, this.book.toJSON())) {
      this.stats.repeats++;
      return null;
    }
    this.stats.leaderTrades++;
    this.d.log.info("leader_trade", { leader: e.wallet, mint: e.mint, side: e.side, kind: move.kind, sol: sol(e.solRaw), venue: e.venue, signature: e.signature, via: e.via, complete: e.complete, fraction: move.fraction, tracked: move.tracked });
    if (e.side === "sell") {
      this.stats.sellsSeen++;
      return null;
    }
    this.stats.buysSeen++;
    if (this.d.cfg.mirror.copy === "opens" && move.kind !== "open") {
      this.d.log.info("leader_buy_not_copied", { leader: e.wallet, mint: e.mint, why: "an add to a bag the leader already held (mirror.copy: opens)" });
      return null;
    }
    const meta: LeaderBuy = { leader: e.wallet, label: this.leaders.get(e.wallet)?.label ?? null, signature: e.signature, slot: e.slot, blockTime: e.blockTime, venue: e.venue, kind: move.kind, leaderSolRaw: e.solRaw.toString(), leaderTokenRaw: e.tokenRaw.toString(), leaderHeldAfterRaw: e.heldAfterRaw.toString(), decimals: e.decimals };
    return { mint: e.mint, chain: "solana", seenAtMs: e.seenAtMs, source: "chain", reason: `${this.label(e.wallet)} ${move.kind} ${fmt(sol(e.solRaw))} SOL on ${e.venue}`, meta };
  }

  /**
   * The sells our positions owe, from the leader trades recorded (not from the events as they come): every leader sell
   * of the coin after the buy we copied (later slot), by the copied leader (or any listed leader with sellsFrom any),
   * is owed once per position. So a sell that arrived before our position was booked (in the same batch, while the
   * buy was being decided, or by a backfill) is owed as soon as the position exists. Owed sells of a position that
   * closed or failed are finished.
   */
  private owed(ctx: TriggerContext): void {
    const m = this.d.cfg.mirror;
    const now = this.now();
    for (const s of this.d.ledger.allPendingMirrorSells()) {
      const p = this.d.ledger.position(s.position_id);
      if (!p || p.status === "closed" || p.status === "failed") this.d.ledger.finishMirrorSell(s.id, "position closed", now);
    }
    if (!m.sells) return;
    for (const p of ctx.ledger.positions("opening", "open", "exit_stuck")) {
      let entry: Partial<LeaderBuy> = {};
      try {
        entry = JSON.parse(p.launch_json) ?? {};
      } catch {
        /* a position without a leader context: not ours to mirror */
      }
      if (!entry.leader || typeof entry.slot !== "number") continue;
      const from = m.sellsFrom === "copied" ? [entry.leader] : [...this.leaders.keys()];
      const buy = { leader: entry.leader, slot: entry.slot, signature: entry.signature ?? "", heldAfterRaw: BigInt(entry.leaderHeldAfterRaw ?? "0") };
      // Small sells (under minSellFraction) add up: once what they leave together falls to 1 - minSellFraction, they
      // are owed together (and compound in the exit). Recomputed from the ledger each poll: the same trades give the
      // same groups, and a row already owed is not owed again.
      let small: Array<{ t: (typeof rows)[number]; f: number }> = [];
      const rows = this.d.ledger.leaderSellsAfter(p.mint, from, buy);
      const oweOne = (t: (typeof rows)[number], fraction: number) => {
        if (this.d.ledger.addMirrorSell({ positionId: p.id, leader: t.leader, signature: t.signature, mint: p.mint, fraction, kind: t.kind, now })) {
          this.stats.sellsOwed++;
          this.d.log.info("mirror_sell_owed", { position: p.id, mint: p.mint, leader: t.leader, kind: t.kind, fraction, signature: t.signature });
        }
      };
      for (const t of rows) {
        const fraction = t.kind === "close" ? 1 : t.fraction ?? 1;
        if (t.kind === "close" || fraction >= m.minSellFraction) {
          for (const x of small) oweOne(x.t, x.f);
          small = [];
          oweOne(t, fraction);
          continue;
        }
        small.push({ t, f: fraction });
        const keep = small.reduce((k, x) => k * (1 - x.f), 1);
        if (1 - keep >= m.minSellFraction) {
          for (const x of small) oweOne(x.t, x.f);
          small = [];
        }
      }
    }
  }

  private onGap(g: WalletGap): void {
    this.lastGaps = [...this.lastGaps.slice(-19), g];
    if (g.recovered) {
      this.stats.gapsRecovered++;
      this.d.log.info("leader_gap_recovered", { leader: g.wallet, reason: g.reason, from: new Date(g.fromMs).toISOString(), to: new Date(g.toMs).toISOString() });
      return;
    }
    this.stats.gapsUnrecovered++;
    const dry = this.d.cfg.mode === "dry" ? 1 : 0;
    const held = this.d.ledger.positionsByStatus("opening", "open", "exit_stuck").filter((p) => {
      if (p.dry !== dry) return false;
      try {
        return JSON.parse(p.launch_json)?.leader === g.wallet;
      } catch {
        return false;
      }
    }).length;
    this.d.alerter.raise(`leader:${g.wallet}:gap`, `leader ${this.label(g.wallet)}: trades from ${new Date(g.fromMs).toISOString()} to ${new Date(g.toMs).toISOString()} may be missing (${g.reason}; ${g.missing ?? "not read"})${held ? `; ${held} open copy position(s) may have missed a mirror sell` : ""}`);
  }

  async decide(c: Candidate, ctx: TriggerContext, _pending: PendingInfo): Promise<Verdict> {
    const m = this.d.cfg.mirror;
    const b = c.meta as LeaderBuy;
    const skip = (reason: string): Verdict => ({ verdict: "skip", reason });
    if (!b || !this.leaders.has(b.leader)) return skip("not a listed leader");
    if (b.blockTime === null) return skip("leader trade has no block time (age unknown)");
    const ageMs = ctx.now() - b.blockTime * 1000;
    if (ageMs > m.maxAgeSec * 1000) return skip(`stale: the leader traded ${Math.round(ageMs / 1000)} s ago (mirror.maxAgeSec ${m.maxAgeSec})`);
    if (!m.venues.includes(b.venue)) return skip(`venue ${b.venue} not in mirror.venues`);
    const leaderSol = sol(b.leaderSolRaw);
    if (leaderSol < m.minLeaderSol) return skip(`leader bought ${fmt(leaderSol)} SOL < mirror.minLeaderSol ${m.minLeaderSol}`);
    if (this.d.ledger.copied(b.leader, c.mint)) return skip("this coin was copied from this leader before");
    // What the leader did with this bag since the buy (recorded trades after it, in chain order: same-slot ones by the
    // leader's balances). Sold out: nothing left to follow. Sold below minLeaderHeldFraction of its peak: not copied.
    const after = this.d.ledger.leaderTradesFrom(b.leader, c.mint, b.slot).filter((t) => t.signature !== b.signature && (t.slot > b.slot || BigInt(t.held_before) >= BigInt(b.leaderHeldAfterRaw ?? "0")));
    if (after.length) {
      after.sort((x, y) => x.slot - y.slot || (BigInt(y.held_before) > BigInt(x.held_before) ? 1 : BigInt(y.held_before) < BigInt(x.held_before) ? -1 : 0));
      const now = BigInt(after[after.length - 1].held_after);
      if (now === 0n) return skip("the leader already sold out of this coin");
      let peak = BigInt(b.leaderHeldAfterRaw ?? "0");
      for (const t of after) for (const v of [BigInt(t.held_before), BigInt(t.held_after)]) if (v > peak) peak = v;
      if (peak > 0n && Number((now * 1_000_000n) / peak) / 1e6 < m.minLeaderHeldFraction) return skip(`the leader already sold down to ${Math.round(Number((now * 10_000n) / peak) / 100)} % of its peak (mirror.minLeaderHeldFraction ${m.minLeaderHeldFraction})`);
    }
    const l = this.leaders.get(b.leader)!;
    // A venue the bot can price: without one, its exits (and the mirrored sells) would be held.
    let mk: MarketRead | undefined;
    try {
      mk = await this.readMarket(c.mint, b.decimals);
    } catch (e) {
      return { verdict: "wait", reason: `market read failed (${String((e as Error)?.message ?? e).slice(0, 80)})` };
    }
    if (!mk || mk.priceSol === null || mk.problem) return skip(`no venue the bot can price (${mk?.problem ?? (mk ? "no price" : "unread")}); its exits would be held`);
    // From here to the reservation nothing awaits: decides run side by side (concurrency), and each must see the
    // others' reserved tickets in its leader's caps.
    const used = this.usage(b.leader, ctx.dry);
    if (l.maxEntries !== undefined && used.entries >= l.maxEntries) return skip(`leader cap: ${used.entries} entries (maxEntries ${l.maxEntries})`);
    const cap = this.d.cfg.buy.sol;
    let want: number;
    if (m.ticket.mode === "fixed") want = l.sol ?? cap;
    else want = Math.min(cap, leaderSol * (l.fraction ?? m.ticket.fraction));
    if (l.maxSol !== undefined) want = Math.min(want, l.maxSol - sol(used.lamports));
    if (!(want >= m.ticket.minSol)) return skip(l.maxSol !== undefined && l.maxSol - sol(used.lamports) < m.ticket.minSol ? `leader cap: ${fmt(sol(used.lamports))} SOL used (maxSol ${l.maxSol})` : `ticket ${fmt(want)} SOL < mirror.ticket.minSol ${m.ticket.minSol}`);
    const lamports = lamportsOf(want);
    // The price guard: our fill (the venue's quote for our ticket, else its spot price) against the leader's own fill
    // (its SOL leg over its token leg; the SOL leg is all-in: venue fees, tips and platform fees it paid).
    const over = this.overLeaderBps(mk, lamports, b);
    if (over !== null && over > m.maxOverLeaderBps) return skip(`our price is ${over} bps over the leader's fill (mirror.maxOverLeaderBps ${m.maxOverLeaderBps})`);
    this.reserved.set(c.mint, { leader: b.leader, lamports });
    // The leader's own price as the trigger's expected fill (the engine keeps the smaller of this and its own read).
    const expectedOutRaw = BigInt(b.leaderSolRaw) > 0n ? (BigInt(b.leaderTokenRaw) * lamports) / BigInt(b.leaderSolRaw) : null;
    return {
      verdict: "buy",
      reason: `copy ${this.label(b.leader)} ${b.kind} ${fmt(leaderSol)} SOL on ${b.venue}`,
      lamports,
      deadlineAtMs: b.blockTime * 1000 + m.maxAgeSec * 1000,
      expectedOutRaw,
      decimals: b.decimals,
      context: { ...b, leaderAgeMsAtDecision: ageMs },
      log: { leader: b.leader, leaderSignature: b.signature, leaderSol, venue: b.venue, ageMs },
    };
  }

  /** Our price over the leader's, bps (null when neither a quote nor a spot price can say). */
  private overLeaderBps(mk: MarketRead, lamports: bigint, b: LeaderBuy): number | null {
    const lsol = BigInt(b.leaderSolRaw);
    const ltok = BigInt(b.leaderTokenRaw);
    if (!(lsol > 0n && ltok > 0n)) return null;
    const leader = Number(lsol) / Number(ltok); // lamports per raw token
    let ours: number | null = null;
    const q = buyQuote(mk, lamports);
    if (!("why" in q) && q.expectedOutRaw > 0n) ours = Number(lamports) / Number(q.expectedOutRaw);
    else if (mk.priceSol !== null && mk.priceSol > 0) ours = (mk.priceSol * 1e9) / 10 ** b.decimals;
    if (ours === null) return null;
    return Math.round((ours / leader - 1) * 10_000);
  }

  /** A leader's usage: the ledger's, plus buys decided and not yet booked (dropped once the ledger has the coin). */
  private usage(leader: string, dry: boolean): { entries: number; lamports: bigint } {
    const u = this.d.ledger.leaderUsage(leader, dry);
    let entries = u.entries;
    let lamports = u.lamports;
    for (const [mint, r] of this.reserved) {
      if (this.d.ledger.positionsByStatus("opening", "open", "exit_stuck", "closed", "failed").some((p) => p.mint === mint && (p.dry === 1) === dry)) {
        this.reserved.delete(mint);
        continue;
      }
      if (r.leader !== leader) continue;
      entries++;
      lamports += r.lamports;
    }
    return { entries, lamports };
  }

  onVerdict(c: Candidate, v: Verdict, ctx: TriggerContext): void {
    const b = c.meta as LeaderBuy;
    if (!b) return;
    // Not bought (a skip here includes a buy the engine's caps refused): its reservation goes.
    if (v.verdict !== "buy") this.reserved.delete(c.mint);
    if (v.verdict === "wait") return;
    this.d.ledger.recordCopy(b.leader, c.mint, b.signature, v.verdict, v.reason, ctx.now());
    this.d.log.info(v.verdict === "buy" ? "copy_buy" : "copy_skip", { leader: b.leader, mint: c.mint, signature: b.signature, reason: v.reason });
  }

  status(): Record<string, unknown> {
    const src = this.d.source;
    return {
      leaders: [...this.leaders.values()].map((l) => ({ address: l.address, label: l.label ?? null, cursor: this.d.ledger.cursors()[l.address]?.signature ?? null })),
      source: { stats: src.stats ?? null, openGaps: src.openGaps().map((g) => ({ ...g, from: new Date(g.fromMs).toISOString() })), recentGaps: this.lastGaps.map((g) => ({ leader: g.wallet, from: new Date(g.fromMs).toISOString(), to: new Date(g.toMs).toISOString(), reason: g.reason, recovered: g.recovered, missing: g.missing ?? null })) },
      mirror: { ...this.stats, owedSells: this.d.ledger.allPendingMirrorSells().map((s) => ({ position: s.position_id, mint: s.mint, leader: s.leader, fraction: s.fraction, kind: s.kind, since: new Date(s.created_at).toISOString() })) },
      recentCopies: this.d.ledger.recentCopies(10),
    };
  }
}

/**
 * Sells owed for a leader's sells first; otherwise the configured exit decides. An owed sell is done once a sell whose
 * reason names it has filled, or the position is closed; one that failed is asked for again (on the engine's backoff).
 * Several owed at once are sold together: the remaining share is the product of what each leaves.
 */
// The position is found by coin: the core allows one entry per coin (buy.maxPerCoin is 1). Raising that cap would
// need the position id in the strategy's view.
export class MirrorExit implements ExitStrategy {
  readonly name: string;
  readonly trailMark: boolean;
  readonly needsBasis: boolean;
  readonly fallback: ExitStrategy;
  private ledger: Ledger;
  private dry: boolean;
  private now: () => number;
  constructor(fallback: ExitStrategy, ledger: Ledger, dry: boolean, now: () => number = Date.now) {
    this.fallback = fallback;
    this.ledger = ledger;
    this.dry = dry;
    this.now = now;
    this.name = `mirror+${fallback.name}`;
    this.trailMark = fallback.trailMark === true;
    this.needsBasis = fallback.needsBasis !== false;
  }

  /** Close owed sells whose sell filled or whose position closed. */
  settle(positionId: number): ReturnType<Ledger["pendingMirrorSells"]> {
    const pending = this.ledger.pendingMirrorSells(positionId);
    if (!pending.length) return pending;
    const p = this.ledger.position(positionId);
    if (!p || p.status === "closed" || p.status === "failed") {
      for (const s of pending) this.ledger.finishMirrorSell(s.id, "position closed", this.now());
      return [];
    }
    const filled = new Set<number>();
    for (const o of this.ledger.ordersFor(positionId)) {
      if (o.side !== "sell" || o.status !== "filled") continue;
      const m = /^mirror:([\d,]+) /.exec(o.reason ?? "");
      if (m) for (const id of m[1].split(",")) filled.add(Number(id));
    }
    const left = [];
    for (const s of pending) {
      if (filled.has(s.id)) this.ledger.finishMirrorSell(s.id, "sold", this.now());
      else left.push(s);
    }
    return left;
  }

  onTick(p: Parameters<ExitStrategy["onTick"]>[0], m: Parameters<ExitStrategy["onTick"]>[1]) {
    const row = this.ledger.positionsByStatus("open", "exit_stuck").find((x) => x.mint === p.mint && (x.dry === 1) === this.dry);
    if (row) {
      const owed = this.settle(row.id);
      if (owed.length) {
        const keep = owed.reduce((k, s) => k * (1 - Math.min(1, Math.max(0, s.fraction))), 1);
        const fraction = owed.some((s) => s.kind === "close") ? 1 : Math.min(1, Math.max(1e-6, 1 - keep));
        const what = owed.some((s) => s.kind === "close") ? "the leader sold out" : `the leader sold ${(Math.round((1 - keep) * 10_000) / 100).toString()} %`;
        return { action: "sell" as const, fraction, reason: `mirror:${owed.map((s) => s.id).join(",")} ${what}` };
      }
    }
    return this.fallback.onTick(p, m);
  }
}

export interface Built {
  engine: Engine;
  trigger: MirrorTrigger;
  exit: MirrorExit;
}

/** Linked wallet with checkPrograms on: the programs it may sign for (core KNOWN_PROGRAMS plus extraPrograms). */
export function knownProgramsFor(cfg: Config): Set<string> | undefined {
  return cfg.payer === "linked" && cfg.mirror.checkPrograms ? new Set([...KNOWN_PROGRAMS, ...cfg.mirror.extraPrograms]) : undefined;
}

/** The engine for this config: executor (pump buys, graduated-pool buys; the signing checks for a TEE wallet), trigger, exit. */
export async function makeMirror(ctx: Ctx, ledger: Ledger, source: WalletFeed, o: { now?: () => number; readMarket?: MarketReader } = {}): Promise<Built> {
  const cfg = ctx.cfg;
  const linked = cfg.payer === "linked";
  const known = knownProgramsFor(cfg);
  const floor = linked ? sellFloor(ctx.rpc, cfg.sell.maxSlippageBps, cfg.mirror.sellFloorMarginBps) : undefined;
  const { strategy, alerter, executor } = await parts(ctx, ledger, {
    maxBuyImpactBps: cfg.mirror.maxImpactBps,
    executor: (x) => new Executor({ ...x, pumpBuys: true, dammBuys: true, ...(known ? { knownPrograms: known } : {}), ...(floor ? { sellFloor: floor, buyFloorMarginBps: cfg.mirror.buyFloorMarginBps } : {}) }),
    venues: { pump: true },
    ...(o.now ? { now: o.now } : {}),
  });
  return assemble({ cfg, ledger, source, rpc: ctx.rpc, log: ctx.log, alerter, executor, fallback: strategy, ...o });
}

/** The trigger, exit and engine around an executor (a library user, or a test, brings its own parts). */
export function assemble(d: { cfg: Config; ledger: Ledger; source: WalletFeed; rpc: Rpc; log: Logger; alerter: Alerter; executor: Executor; fallback: ExitStrategy; now?: () => number; readMarket?: MarketReader }): Built {
  const trigger = new MirrorTrigger({ cfg: d.cfg, ledger: d.ledger, source: d.source, log: d.log, alerter: d.alerter, rpc: d.rpc, ...(d.readMarket ? { readMarket: d.readMarket } : {}), ...(d.now ? { now: d.now } : {}) });
  const exit = new MirrorExit(d.fallback, d.ledger, d.cfg.mode === "dry", d.now);
  const engine = new Engine({ cfg: d.cfg, ledger: d.ledger, trigger, executor: d.executor, strategy: exit, rpc: d.rpc, log: d.log, alerter: d.alerter, venues: { pump: true }, pumpBuys: true, ...(d.now ? { now: d.now } : {}) });
  return { engine, trigger, exit };
}

export { loadStrategy };
export type { PositionRow };
