/**
 * (batch 5) Lots: for a bot that buys or sells one coin many times (the DCA bot, the rebalancer). Each buy is its own
 * position (a lot), so every buy keeps its own fill, cost and exit; a bag the wallet held before the bot's first trade
 * of a coin becomes one more lot (a wallet lot). Everything here goes through the engine and the executor: a sell is
 * `Engine.placeSell` on a lot (the core's clamp, one attempt per coin, the retries), never an order of its own.
 *
 * Several positions in one coin are handled by the core already: the sell clamp counts the other positions'
 * tokens, the surplus check and the uncertain-buy recovery sum or subtract them, and one attempt per coin runs at a
 * time. The core config keeps `buy.maxPerCoin` at 1 for every other bot; a lots bot sets it itself (`withLots`).
 *
 * `WalletLots` is the engine's adoption hook (EngineDeps.adopter) for such a bot:
 *  - **A wallet lot** is booked for a configured coin only while the bot has never had a position in it (this mode):
 *    the wallet's balance on chain, the mint passing the junk check (market/mint.ts), a venue the core can price, worth
 *    at least `minValueSol`. Its cost is its value at the mark then (`basis: "mark"`, recorded in the entry). Once a
 *    coin has any position it is never booked again: tokens that turn up later are alerted (below), never booked.
 *  - **Before a wallet lot is sold** its mint passes the junk check again (cached 60 s).
 *  - **Surplus** (live only): the wallet holding more of a coin than the bot's lots, on two reads at least a minute
 *    apart with nothing of the coin in flight, is alerted (`coin:<mint>:surplus`), as the engine's own check does (an
 *    adoption hook replaces it).
 * `ready` turns true after the first step: a bot places no order before its wallet lots are booked.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Alerter } from "./alerts.ts";
import { ConfigError, deepFreeze, type Config } from "./config.ts";
import { readControl, TRIGGER_TIMEOUT_MS, type AdoptionHook, type Engine } from "./engine.ts";
import type { Ledger, OrderRow, PositionRow } from "./ledger.ts";
import type { Logger } from "./log.ts";
import { decodeMint, junkReason } from "./market/mint.ts";
import { readMarkets, type ReadOptions } from "./market/reader.ts";
import { tokenBalance, type Rpc } from "./solana/rpc.ts";
import { HOLD, type ExitStrategy, type MarketView, type PositionView } from "./strategies/types.ts";

/** buy.maxPerCoin for a lots bot: one position per buy, any number per coin. */
export const LOTS_PER_COIN = Number.MAX_SAFE_INTEGER;

/** The config with `buy.maxPerCoin` lifted for a lots bot (a new frozen object; the parser keeps 1 for every other bot). */
export function withLots<C extends Config>(cfg: C): C {
  return deepFreeze({ ...cfg, buy: { ...cfg.buy, maxPerCoin: LOTS_PER_COIN } });
}

/** The positions of a coin that hold tokens (open, exit_stuck), this mode, oldest first. */
export function lotsOf(ledger: Ledger, dry: boolean, mint: string): PositionRow[] {
  return ledger.positionsByStatus("open", "exit_stuck").filter((p) => p.mint === mint && !!p.dry === dry);
}

/** Whether a position is a wallet lot (booked from the wallet, not bought). */
export function isWalletLot(p: Pick<PositionRow, "launch_json">): boolean {
  try {
    return JSON.parse(p.launch_json)?.from === "wallet";
  } catch {
    return false;
  }
}

const ENDED = new Set(["filled", "rejected", "reverted", "failed"]);

/** Whether every order in the list has ended (a missing id counts as ended). */
export function ordersEnded(ledger: Ledger, ids: number[]): boolean {
  return ids.every((id) => {
    const o = ledger.order(id);
    return !o || ENDED.has(o.status);
  });
}

/**
 * The buy orders of positions booked with an entry context naming this schedule and run (`{ schedule, run }` in the
 * buy verdict's context): how a run finds its orders again, after a restart too.
 */
export function runBuyOrders(ledger: Ledger, dry: boolean, schedule: string, run: number): OrderRow[] {
  return ledger.db
    .prepare("select o.* from orders o join positions p on p.id = o.position_id where o.side = 'buy' and p.dry = ? and json_valid(p.launch_json) and json_extract(p.launch_json, '$.schedule') = ? and json_extract(p.launch_json, '$.run') = ? order by o.id")
    .all(dry ? 1 : 0, schedule, run) as unknown as OrderRow[];
}

/**
 * Lamports committed to buys by one schedule, all runs (as `Ledger.lifetimeBuyLamports` counts them: every buy except
 * a revert and a rejection proven unspent; a double execution counts each transaction).
 */
export function scheduleBuyLamports(ledger: Ledger, dry: boolean, schedule: string): bigint {
  const rows = ledger.db
    .prepare("select o.amount_raw a, o.extra_signatures x from orders o join positions p on p.id = o.position_id where o.side = 'buy' and o.status != 'reverted' and not (o.status = 'rejected' and o.ever_signed = 0) and p.dry = ? and json_valid(p.launch_json) and json_extract(p.launch_json, '$.schedule') = ?")
    .all(dry ? 1 : 0, schedule) as Array<{ a: string; x: string | null }>;
  return rows.reduce((s, r) => s + BigInt(r.a) * BigInt(1 + (r.x ? (JSON.parse(r.x) as unknown[]).length : 0)), 0n);
}

/** What a run's orders did, in words and numbers (the run's result). */
export function ordersSummary(ledger: Ledger, ids: number[]): { status: "done" | "failed"; detail: string; filled: number } {
  const parts: string[] = [];
  let filled = 0;
  for (const id of ids) {
    const o = ledger.order(id);
    if (!o) continue;
    const p = ledger.position(o.position_id);
    if (o.status === "filled") filled++;
    let what = "";
    if (o.status === "filled" && o.fill_json) {
      try {
        const f = JSON.parse(o.fill_json)?.fill;
        if (f) what = o.side === "buy" ? ` +${f.tokenDeltaRaw} raw for ${Number(-BigInt(f.swapLamports)) / 1e9} SOL` : ` ${f.tokenDeltaRaw} raw for ${Number(BigInt(f.swapLamports)) / 1e9} SOL`;
      } catch {
        /* the status alone */
      }
    }
    parts.push(`${o.side} ${id} ${p?.mint ?? "?"} ${o.status}${o.last_error_code ? ` (${o.last_error_code})` : ""}${what}`);
  }
  return { status: filled > 0 || !ids.length ? "done" : "failed", detail: parts.join("; ") || "no orders", filled };
}

/**
 * Sell `amountRaw` of a coin over its lots, the largest first (fewest orders), each through `Engine.placeSell` (the
 * core's balance clamp and booking). A lot with an order in flight is passed over. A lot sold in part is the last
 * one (the part is a fraction to 1e-6, so up to 1e-6 of that lot may stay unsold). Returns the orders booked and the
 * raw amount they cover.
 */
export async function sellLots(engine: Engine, ledger: Ledger, dry: boolean, mint: string, amountRaw: bigint, reason: string, manual = false, onOrder?: (id: number) => void, shouldStop?: () => boolean): Promise<{ orders: number[]; placedRaw: bigint; why: string[]; stopped?: boolean }> {
  const lots = lotsOf(ledger, dry, mint).sort((a, b) => {
    const d = BigInt(b.remaining_raw) - BigInt(a.remaining_raw);
    return d > 0n ? 1 : d < 0n ? -1 : a.id - b.id;
  });
  const orders: number[] = [];
  const why: string[] = [];
  let left = amountRaw;
  let placed = 0n;
  for (const lot of lots) {
    if (left <= 0n) break;
    const rem = BigInt(lot.remaining_raw);
    if (rem <= 0n) continue;
    if (ledger.openOrderFor(lot.id)) {
      why.push(`lot ${lot.id}: an order in flight`);
      continue;
    }
    const take = left < rem ? left : rem;
    const fraction = take >= rem ? 1 : Number((take * 1_000_000n) / rem) / 1_000_000;
    if (!(fraction > 0)) continue;
    // STOP: nothing more is booked (an order booked now would run at the next start, its guards stale by then).
    if (shouldStop?.()) return { orders, placedRaw: placed, why: [...why, "STOP"], stopped: true };
    const id = await engine.placeSell(lot, fraction, reason, manual);
    if (id === null) {
      why.push(`lot ${lot.id}: sell not booked (see alerts)`);
      continue;
    }
    orders.push(id);
    // The caller records each order at once (a run's ref), so a restart mid-way still finds every order booked.
    onOrder?.(id);
    const booked = BigInt(ledger.order(id)!.amount_raw);
    // A part of a lot is the last order: what the fraction's rounding (1e-6 of the lot) left is not sold from another lot.
    left = take < rem ? 0n : left - booked;
    placed += booked;
  }
  return { orders, placedRaw: placed, why };
}

/** A sell-over-lots request written while the bot runs (the bots' `sell` command): `<stateDir>/requests/lots-sell-*.json`. */
export const LOTS_SELL_REQUEST = /^lots-sell-[A-Za-z0-9-]+\.json$/;

export interface WalletLotsDeps {
  cfg: Config;
  ledger: Ledger;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  /** The executor's coin holds (no attempt on the coin while a lot is booked). */
  holds: { reserveMint(mint: string): boolean; releaseMint(mint: string): void; mintBusy(mint: string): boolean; mintEpoch(mint: string): number };
  /** The coins whose wallet bags become lots. */
  mints: string[];
  /** Wallet lots on (default true). Off: no bag is ever booked; `ready` at once; surplus alerts still run. */
  enabled?: boolean;
  /**
   * Other bots' state folders sharing this wallet: a coin any of them holds is never booked here, and a wallet lot of
   * it is never sold here. A ledger that cannot be read stops both (fail closed), as the core Adopter does.
   */
  excludeStateDirs?: string[];
  /** Smallest bag booked, SOL at the mark (default 0.001). */
  minValueSol?: number;
  /** Transfer-fee mints up to this many bps pass the junk check (default 0). */
  maxTransferFeeBps?: number;
  /** How often the step looks (ms, default 15 000). */
  everyMs?: number;
  now?: () => number;
  venues?: ReadOptions;
}

/** A coin's wallet bag is looked at again after this long when it was skipped (junk, unpriced, dust, unreadable). */
export const LOT_RETRY_MS = 600_000;
/** Surplus check per coin. */
export const LOT_SURPLUS_MS = 600_000;

/** Another bot's ledger last read good is trusted this long for a sell check when a fresh read fails. */
export const LOT_OTHERS_GRACE_MS = 300_000;
/** A coin whose wallet read failed is read again after this long. */
export const LOT_READ_RETRY_MS = 60_000;
/** Not ready (a coin's wallet bag still unread) for this long: alerted. */
export const LOT_NOT_READY_ALERT_MS = 300_000;

/**
 * The mints other bots hold, from their ledgers (read-only, a 250 ms busy timeout, closed at once): open positions and
 * failed buys that may have landed. The same query as the core Adopter's `otherBotsMints`. Throws when one cannot be
 * read (missing, busy, another layout): the caller fails closed.
 */
export function otherBotsMints(dirs: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const dir of dirs) {
    const path = join(dir, "ledger.sqlite");
    if (!existsSync(path)) throw new Error(`no ledger.sqlite in ${dir}`);
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("pragma busy_timeout = 250");
      const rows = db.prepare(
        `select distinct p.mint mint from positions p where p.status in ('opening','open','exit_stuck')
           or (p.status = 'failed' and exists (select 1 from orders o where o.position_id = p.id and o.side = 'buy'
                 and (o.signature is not null or o.ever_signed = 1) and o.status in ('failed','rejected')))`,
      ).all() as Array<{ mint: string }>;
      for (const r of rows) out.add(String(r.mint));
    } catch (e) {
      throw new Error(`${dir}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    } finally {
      try {
        db?.close();
      } catch {
        /* closed */
      }
    }
  }
  return out;
}

/** Every excludeStateDirs entry must hold a ledger at start, and none may be the bot's own state folder. */
export function checkExcludeDirs(dirs: readonly string[], ownStateDir: string, where: string): void {
  for (const d of dirs) {
    if (d === ownStateDir) throw new ConfigError(`${where}: "${d}" is this bot's own stateDir`);
    if (!existsSync(join(d, "ledger.sqlite"))) throw new ConfigError(`${where}: no ledger.sqlite in ${d}`);
  }
}

/** The wallet's holding of one mint (both token programs) and whether any of its accounts is frozen; null: unreadable. */
export async function walletHolding(rpc: Rpc, owner: string, mint: string): Promise<{ amount: bigint; frozen: boolean } | null> {
  try {
    const r = await rpc.call<any>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    if (!r || !Array.isArray(r.value)) return null;
    let amount = 0n;
    let frozen = false;
    for (const a of r.value) {
      const info = a?.account?.data?.parsed?.info;
      const amt = info?.tokenAmount?.amount;
      if (typeof amt !== "string" || !/^\d+$/.test(amt)) return null;
      amount += BigInt(amt);
      if (info?.state === "frozen" && BigInt(amt) > 0n) frozen = true;
    }
    return { amount, frozen };
  } catch {
    return null;
  }
}

export class WalletLots implements AdoptionHook {
  private d: WalletLotsDeps;
  private now: () => number;
  private dry: boolean;
  private nextAt = 0;
  private skipped = new Map<string, { until: number; why: string }>();
  private checks = new Map<string, { at: number; why: string | null }>();
  private surplusAt = new Map<string, number>();
  private surplusSeen = new Map<string, { at: number; bal: bigint; epoch: number }>();
  /** True once every configured coin has had a definite answer (booked, or not to be booked); never before. */
  ready = false;
  /** Coins with a definite answer (L4: a failed read is not one). */
  private settled = new Set<string>();
  private firstStepAt: number | null = null;
  private othersOk: Set<string> | null = null;
  private othersOkAt = 0;
  /** Positions booked as wallet lots, `mint:openedAt:qty` (the exit wrapper holds them). */
  readonly keys = new Set<string>();

  constructor(d: WalletLotsDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.dry = d.cfg.mode === "dry";
    for (const p of d.ledger.allPositions()) if (!!p.dry === this.dry && isWalletLot(p)) this.keys.add(WalletLots.key(p.mint, p.opened_at, BigInt(p.qty_raw)));
  }

  static key(mint: string, openedAt: number, qtyRaw: bigint): string {
    return `${mint}:${openedAt}:${qtyRaw}`;
  }

  /** The skips as they stand (status.json). */
  skips(): Array<{ mint: string; why: string; until: string }> {
    return [...this.skipped].map(([mint, s]) => ({ mint, why: s.why, until: new Date(s.until).toISOString() }));
  }

  /** A coin not booked now. `transient`: a read failed (looked at again soon; the coin is not settled). */
  private skip(mint: string, why: string, transient = false): { ok: false; reason: string } {
    const prev = this.skipped.get(mint);
    this.skipped.set(mint, { until: this.now() + (transient ? LOT_READ_RETRY_MS : LOT_RETRY_MS), why });
    if (!transient) this.settled.add(mint);
    if (prev?.why !== why) this.d.log.info("wallet_lot_skip", { mint, why, ...(transient ? { transient } : {}) });
    return { ok: false, reason: why };
  }

  /** Other bots' mints read now (null when a ledger cannot be read: alerted; the caller fails closed). */
  private readOthers(): Set<string> | null {
    const dirs = this.d.excludeStateDirs ?? [];
    if (!dirs.length) return new Set();
    try {
      const got = otherBotsMints(dirs);
      this.othersOk = got;
      this.othersOkAt = this.now();
      return got;
    } catch (e) {
      const why = String((e as Error)?.message ?? e);
      this.d.log.warn("lots_exclude_unreadable", { why });
      this.d.alerter.raise(`lots:exclude_unreadable`, `cannot read another bot's ledger (${why}): no wallet lot is booked and no wallet lot is sold until it can be read`);
      return null;
    }
  }

  async step(shouldStop: () => boolean = () => false): Promise<void> {
    if (this.now() < this.nextAt) return;
    this.nextAt = this.now() + (this.d.everyMs ?? 15_000);
    this.firstStepAt ??= this.now();
    for (const mint of this.d.mints) {
      if (shouldStop()) return;
      try {
        await this.bookOne(mint);
      } catch (e) {
        this.skip(mint, `read failed (${String((e as Error)?.message ?? e).slice(0, 80)})`, true);
      }
    }
    // Ready only when every coin has a definite answer: a bag whose read failed could still be booked, and a run before
    // that would buy or sell as if the bag were not there.
    if (!this.ready) {
      const open = this.d.enabled === false ? [] : this.d.mints.filter((m) => !this.settled.has(m));
      if (!open.length) this.ready = true;
      else if (this.now() - this.firstStepAt >= LOT_NOT_READY_ALERT_MS) this.d.alerter.raise("lots:not_ready", `no run yet: the wallet's bag of ${open.join(", ")} could not be read (${open.map((m) => this.skipped.get(m)?.why ?? "?").join("; ")})`);
    }
    if (!this.dry) await this.surplus(shouldStop);
  }

  /** The junk check of a mint, read now. */
  private async mintCheck(mint: string): Promise<{ why: string | null; decimals?: number }> {
    let v: any;
    try {
      v = (await this.d.rpc.call<any>("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }]))?.value;
    } catch (e) {
      return { why: `mint unreadable (${String((e as Error)?.message ?? e).slice(0, 80)})` };
    }
    try {
      const m = decodeMint(v);
      const why = junkReason(m, { maxTransferFeeBps: this.d.maxTransferFeeBps ?? 0 });
      this.checks.set(mint, { at: this.now(), why });
      return { why, decimals: m.decimals };
    } catch (e) {
      return { why: `mint ${(e as Error).message}` };
    }
  }

  /** Book the coin's wallet bag as a lot, if the bot never had a position in it. */
  async bookOne(mint: string): Promise<{ ok: true; positionId: number } | { ok: false; reason: string }> {
    if (this.d.enabled === false) {
      this.settled.add(mint);
      return { ok: false, reason: "wallet lots off" };
    }
    if (this.d.ledger.entriesForMint(mint, this.dry) > 0) {
      this.settled.add(mint);
      return { ok: false, reason: "the bot has had a position in this coin" };
    }
    const s = this.skipped.get(mint);
    if (s && s.until > this.now()) return { ok: false, reason: s.why };
    const others = this.readOthers();
    if (others === null) return this.skip(mint, "another bot's ledger could not be read", true);
    if (others.has(mint)) return this.skip(mint, "another bot holds an open position in this coin");
    if (!this.d.holds.reserveMint(mint)) return { ok: false, reason: "mint_busy" };
    try {
      const h = await walletHolding(this.d.rpc, this.d.cfg.wallet, mint);
      if (h === null) return this.skip(mint, "balance unreadable", true);
      if (h.amount <= 0n) {
        this.settled.add(mint);
        return { ok: false, reason: "not in the wallet" };
      }
      if (h.frozen) return this.skip(mint, "token account frozen");
      const bal = h.amount;
      const mc = await this.mintCheck(mint);
      if (mc.why) return this.skip(mint, `junk or unreadable: ${mc.why}`, mc.why.startsWith("mint unreadable"));
      const decimals = mc.decimals!;
      const m = (await readMarkets(this.d.rpc, [{ mint, decimals }], this.now(), this.d.venues ?? { pump: true })).get(mint);
      if (!m || m.priceSol === null || m.problem) return this.skip(mint, `unpriceable: ${m?.problem ?? "no price"}`);
      const valueLamports = BigInt(Math.floor((Number(bal) / 10 ** decimals) * m.priceSol * 1e9));
      if (Number(valueLamports) / 1e9 < (this.d.minValueSol ?? 0.001)) return this.skip(mint, `dust (${Number(valueLamports) / 1e9} SOL)`);
      // The other bots' ledgers once more right before booking (the reads above take a while).
      const again = this.readOthers();
      if (again === null) return this.skip(mint, "another bot's ledger could not be read", true);
      if (again.has(mint)) return this.skip(mint, "another bot holds an open position in this coin");
      const now = this.now();
      const id = this.d.ledger.tx(() => {
        if (this.d.ledger.entriesForMint(mint, this.dry) > 0) return null;
        const pid = this.d.ledger.createPosition({ mint, chain: "solana", dry: this.dry, now, decimals, strategy: "hold", entry: { from: "wallet", basis: "mark", markSol: m.priceSol, venue: m.venue } });
        this.d.ledger.updatePosition(pid, { status: "open", qty_raw: bal.toString(), qty_source: "wallet", remaining_raw: bal.toString(), cost_lamports: valueLamports.toString(), peak_price: m.priceSol ?? 0, last_price: m.priceSol, note: "wallet lot (basis: mark)" });
        return pid;
      });
      this.settled.add(mint);
      if (id === null) return { ok: false, reason: "the bot has had a position in this coin" };
      this.keys.add(WalletLots.key(mint, now, bal));
      this.skipped.delete(mint);
      this.d.log.info(this.dry ? "dry_wallet_lot" : "wallet_lot", { position: id, mint, qtyRaw: bal, markSol: m.priceSol, valueSol: Number(valueLamports) / 1e9, venue: m.venue });
      this.d.alerter.raise(`position:${id}:wallet_lot`, `${mint}: the wallet's ${bal} raw booked as lot ${id} (worth ${Number(valueLamports) / 1e9} SOL at the mark, ${m.venue})`);
      return { ok: true, positionId: id };
    } finally {
      this.d.holds.releaseMint(mint);
    }
  }

  /**
   * Before a wallet lot's sell: no other bot holds the coin (their ledgers read now; the last good read for
   * LOT_OTHERS_GRACE_MS when a read fails; past that the sell is refused), and its mint passes the junk check again
   * (cached 60 s). Lots the bot bought: no check here.
   */
  async sellCheck(p: PositionRow): Promise<string | null> {
    if (!isWalletLot(p)) return null;
    const fresh = this.readOthers();
    const known = fresh ?? (this.now() - this.othersOkAt <= LOT_OTHERS_GRACE_MS ? this.othersOk : null);
    if (known === null) return "another bot's ledger could not be read";
    if (known.has(p.mint)) return "another bot holds an open position in this coin";
    const c = this.checks.get(p.mint);
    if (c && this.now() - c.at < 60_000) return c.why;
    return (await this.mintCheck(p.mint)).why;
  }

  /** The wallet holding more of a coin than the bot's lots, on two reads a minute apart: alerted, never booked. */
  private async surplus(shouldStop: () => boolean): Promise<void> {
    const live = this.d.ledger.positionsByStatus("opening", "open", "exit_stuck").filter((p) => !!p.dry === this.dry);
    for (const mint of new Set(live.map((p) => p.mint))) {
      if (shouldStop()) return;
      if ((this.surplusAt.get(mint) ?? 0) > this.now()) continue;
      const ps = live.filter((p) => p.mint === mint);
      if (ps.some((p) => p.status === "opening" || this.d.ledger.openOrderFor(p.id)) || this.d.holds.mintBusy(mint)) continue;
      const epoch = this.d.holds.mintEpoch(mint);
      const bal = await tokenBalance(this.d.rpc, this.d.cfg.wallet, mint);
      if (bal === null || this.d.holds.mintBusy(mint) || this.d.holds.mintEpoch(mint) !== epoch) continue;
      const booked = ps.reduce((t, p) => t + BigInt(p.remaining_raw), 0n);
      if (bal <= booked) {
        this.surplusSeen.delete(mint);
        this.surplusAt.set(mint, this.now() + LOT_SURPLUS_MS);
        continue;
      }
      const seen = this.surplusSeen.get(mint);
      if (!seen || seen.bal !== bal || seen.epoch !== epoch) {
        this.surplusSeen.set(mint, { at: this.now(), bal, epoch });
        this.surplusAt.set(mint, this.now() + 60_000);
        continue;
      }
      this.surplusAt.set(mint, this.now() + LOT_SURPLUS_MS);
      this.d.alerter.raise(`coin:${mint}:surplus`, `${mint}: the wallet holds ${bal} raw, ${bal - booked} more than this bot's lots (${ps.map((p) => p.id).join(", ")}); not booked`);
    }
  }
}

/** A request file for a sell over lots (the bots' `sell` command while the bot runs). */
export function lotsSellRequestName(): string {
  return `lots-sell-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}.json`;
}

/** The `sell` requests written while the bot runs (`{ mint, fraction }`): each a manual sell over every lot of the coin. */
export async function lotsSellRequests(engine: Engine, ledger: Ledger, dry: boolean, stateDir: string, log: Logger): Promise<void> {
  const dir = join(stateDir, "requests");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => LOTS_SELL_REQUEST.test(n));
  } catch {
    return;
  }
  for (const n of names) {
    const path = join(dir, n);
    const text = readControl(path);
    try {
      unlinkSync(path);
    } catch {
      /* gone */
    }
    try {
      const req = JSON.parse(text ?? "") as { mint: string; fraction: number };
      if (typeof req.mint !== "string" || !(req.fraction > 0 && req.fraction <= 1)) throw new Error("bad request");
      const held = lotsOf(ledger, dry, req.mint).reduce((t, p) => t + BigInt(p.remaining_raw), 0n);
      const r = await sellLots(engine, ledger, dry, req.mint, (held * BigInt(Math.round(req.fraction * 1e6))) / 1_000_000n, "manual", true);
      log.info("manual_sell_request", { mint: req.mint, fraction: req.fraction, orders: r.orders, why: r.why });
    } catch (e) {
      log.warn("manual_sell_request_bad", { file: n, error: String((e as Error).message) });
    }
  }
}

/** The bot's exit for the lots it bought; a wallet lot holds (it was not bought by the bot: only its runs sell it). */
export class LotExits implements ExitStrategy {
  readonly name: string;
  readonly needsBasis?: boolean;
  readonly trailMark?: boolean;
  private base: ExitStrategy;
  private lots: { keys: ReadonlySet<string> };
  constructor(base: ExitStrategy, lots: { keys: ReadonlySet<string> }) {
    this.base = base;
    this.lots = lots;
    this.name = base.name;
    if (base.needsBasis !== undefined) this.needsBasis = base.needsBasis;
    if (base.trailMark !== undefined) this.trailMark = base.trailMark;
  }
  onTick(p: PositionView, m: MarketView) {
    return this.lots.keys.has(WalletLots.key(p.mint, p.openedAtMs, p.qtyRaw)) ? HOLD : this.base.onTick(p, m);
  }
}

/** How long a poll of a lots bot waits for its run work before it returns (capped at half the engine's trigger timeout). */
export const POLL_BUDGET_MS = 5_000;

/**
 * A trigger's run work (reads, sells, plans) outside the engine's trigger timeout: one piece of work at a time (a
 * poll never starts a second while one runs), awaited by `poll` for at most `budgetMs`. Work that takes longer goes
 * on in the background; the candidates it makes wait in the queue for the next poll (and wake the engine), so a slow
 * RPC never drops a buy. `stop()` waits for the work in hand (the runtime awaits it before the ledger closes).
 */
export class PollWork<T> {
  private work: Promise<void> | null = null;
  private queue: T[] = [];
  private stopping = false;
  private budgetMs: number;
  private log: Logger;
  /** The budget is at most half the engine's trigger timeout (default TRIGGER_TIMEOUT_MS, 10 s), so a poll always answers in time. */
  constructor(log: Logger, budgetMs = POLL_BUDGET_MS, triggerTimeoutMs = TRIGGER_TIMEOUT_MS) {
    this.log = log;
    this.budgetMs = Math.max(0, Math.min(budgetMs, Math.floor(triggerTimeoutMs / 2)));
  }
  get budget(): number {
    return this.budgetMs;
  }
  /** Start `step` unless work is in hand; wait for it up to the budget; return what is queued. */
  async poll(step: (push: (c: T) => void) => Promise<void>, wake: () => void): Promise<T[]> {
    if (!this.work && !this.stopping) {
      this.work = step((c) => this.queue.push(c))
        .catch((e) => this.log.error("poll_work_failed", { error: String((e as Error)?.stack ?? e).slice(0, 1000) }))
        .finally(() => {
          this.work = null;
          if (this.queue.length) wake();
        });
    }
    const w = this.work;
    if (w) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([w, new Promise<void>((res) => (timer = setTimeout(res, this.budgetMs)))]);
      clearTimeout(timer);
    }
    return this.queue.splice(0);
  }
  get busy(): boolean {
    return this.work !== null;
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await this.work;
  }
}
