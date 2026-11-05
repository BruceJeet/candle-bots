/**
 * (0.5.0) Adoption: a bot takes over bags already in its wallet that it did not buy (bought by hand or by another tool)
 * and runs the core's exits on them. Opt-in; a bot without an Adopter keeps the 0.4.0 rule (a surplus is alerted,
 * never adopted).
 *
 * Two modes:
 *  - `list`: only the mints named in the config (or added with the `adopt` request);
 *  - `wallet`: every token the wallet holds, less `exclude`, less any mint another bot holds an open position in
 *    (`excludeStateDirs`: their ledgers read read-only every step), less dust (`minValueSol`).
 *
 * A coin this bot managed before (its position closed or released) is adopted again only on an `adopt` request.
 *
 * Before a mint is adopted: its token account must not be frozen; its mint account must pass the junk check
 * (market/mint.ts: no transfer hook, permanent delegate, non-transferable, frozen default, pause, confidential
 * transfers, transfer fee over `maxTransferFeeBps`, unknown extension); it must have a venue the core can price (a
 * Candle curve or its DAMM v2 pool, a pump.fun curve, the canonical PumpSwap pool). Anything unreadable or unpriceable
 * is skipped and logged, never adopted blind.
 *
 * Quantity: always the wallet's balance on chain (qty_source "wallet"). Cost basis, in order:
 *  1. the buy signatures given for the mint (each read from chain: tokens in, SOL out; transfers refused);
 *  2. a cost entered by hand (`costSol`);
 *  3. the wallet's own buys of the coin found in its token accounts' history (paged, at most `historyPages` pages of
 *     100 signatures per account; only transactions where the wallet gained the coin and paid SOL; transfers and
 *     airdrops are not buys): their average cost per token times the tokens held;
 *  4. none. A strategy that needs a basis (ladder, tpsl, trail with `activate`, preGrad with a stop-loss) then gets
 *     `noBasis`: "skip" (default: not adopted, logged) or "mark" (the bag's value at the mark when adopted, chosen
 *     explicitly). A strategy that needs no basis adopts it with no basis (cost 0, recorded as "none").
 * The source is recorded on the adoption row and the position's entry (positions.launch_json).
 *
 * Later changes to an adopted bag (no order of the coin in flight, nothing attempted on it during the read, the same
 * difference seen on two reads at least RECONCILE_CONFIRM_MS apart, so a lagging balance after one of our own sells
 * is not a change):
 *  - more tokens than booked: the position grows by the difference. Tokens that came with a buy of the wallet's own
 *    since adoption (found in the history, not booked by any order) add that buy's cost, pro rata; tokens that came any
 *    other way (a transfer) add at the position's average entry price, so they never lower it. Alerted.
 *  - fewer tokens than booked (sold or sent outside the bot): the position shrinks to the wallet's balance, the
 *    difference is written down (never booked as a sell, never "sold" again); at zero the position closes. Alerted.
 * A dry run compares the wallet with the balance it last saw instead (its own dry sells never touch the wallet).
 *
 * Other bots' ledgers: opened read-only (`readOnly`, a 250 ms busy timeout), one short query, closed at once, every
 * step. SQLite in WAL mode never blocks a writer for a reader, and a reader holding no transaction keeps no lock, so the
 * other bot is never slowed. A ledger that cannot be read (missing, busy, locked, another layout) stops all new
 * adoptions and growth that step (fail closed) and is alerted. A mint that appears in another bot's open positions
 * after it was adopted here is released (managed no more, nothing sold) and alerted.
 *
 * Batch 4's wallet mirror reuses this path: its "copy" of a followed wallet's buy is a list-mode adoption with the
 * buy's signature as basis, run against the mirror's own wallet after its own buy lands, so `adopt()` is public.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Alerter } from "../alerts.ts";
import { ConfigError, isObj, num, only, str, strList, type Config, type Obj } from "../config.ts";
import { fillFromTx } from "../exec/fills.ts";
import type { Ledger, PositionRow } from "../ledger.ts";
import type { Logger } from "../log.ts";
import { decodeMint, junkReason } from "../market/mint.ts";
import { TOKEN_2022, TOKEN_PROGRAM } from "../market/pump.ts";
import { expectedSellOut, readMarkets, type MarketRead, type ReadOptions } from "../market/reader.ts";
import { asAddress } from "../solana/base58.ts";
import { getTransaction, tokenAccounts, type Rpc } from "../solana/rpc.ts";
import { WSOL } from "../solana/pda.ts";
import { readControl } from "../engine.ts";

/** A change in an adopted bag must be seen on two reads at least this far apart before the position follows it. */
export const RECONCILE_CONFIRM_MS = 60_000;
/** A skipped mint (junk, unpriceable, dust, no basis) is looked at again after this long. */
export const SKIP_RETRY_MS = 600_000;
/** Mints adopted in one step at most (each costs a few reads; the rest wait for the next step). */
export const ADOPT_PER_STEP = 10;
/**
 * Candidate mints looked at in one step at most, adopted or not (each look costs reads; a wallet full of airdropped
 * junk must not stall the cycle or flood the RPC). The rest are looked at in the next steps, oldest look first.
 */
export const LOOKS_PER_STEP = 20;
/** A mint whose read failed (RPC error, rate limit) is looked at again after this long, not SKIP_RETRY_MS. */
export const READ_RETRY_MS = 60_000;
/** Another bot's open mints as last read stay good for a sell check this long when a fresh read fails. */
export const OTHERS_GRACE_MS = 300_000;
/** A mint's junk check is re-read before a sell when it is older than this. */
export const SELL_CHECK_MS = 60_000;

export interface AdoptMint {
  mint: string;
  /** Buy signatures of this bag (each read from chain). */
  signatures?: string[];
  /** The bag's cost, entered by hand (SOL). */
  costSol?: number;
  /** "mark": no basis search, the mark at adoption. */
  basis?: "mark";
}

export interface AdoptionConfig {
  mode: "list" | "wallet";
  mints: AdoptMint[];
  exclude: string[];
  excludeStateDirs: string[];
  minValueSol: number;
  maxTransferFeeBps: number;
  noBasis: "skip" | "mark";
  historyPages: number;
  /** How often the wallet is read for new bags and changes, ms. */
  everyMs: number;
}

/** The `adoption` config section (a bot names it in its sections). */
export function parseAdoption(raw: unknown, baseDir: string, ownStateDir?: string): AdoptionConfig {
  const w = "config.adoption";
  if (!isObj(raw)) throw new ConfigError(`${w}: required object with "mode": "list" or "wallet"`);
  only(raw, ["mode", "mints", "exclude", "excludeStateDirs", "minValueSol", "maxTransferFeeBps", "noBasis", "historyPages", "everyMs"], w);
  const mode = str(raw, "mode", w) as AdoptionConfig["mode"];
  if (mode !== "list" && mode !== "wallet") throw new ConfigError(`${w}.mode: "list" or "wallet"`);
  const mints: AdoptMint[] = [];
  const list = raw.mints === undefined ? [] : raw.mints;
  if (!Array.isArray(list)) throw new ConfigError(`${w}.mints: a list of mints or { mint, signatures?, costSol?, basis? }`);
  for (const [i, m] of list.entries()) {
    const at = `${w}.mints[${i}]`;
    const e: Obj = typeof m === "string" ? { mint: m } : isObj(m) ? m : (() => { throw new ConfigError(`${at}: a mint or an object`); })();
    only(e, ["mint", "signatures", "costSol", "basis"], at);
    const mint = str(e, "mint", at)!;
    if (asAddress(mint) !== mint) throw new ConfigError(`${at}.mint: not a Solana address`);
    if (mints.some((x) => x.mint === mint)) throw new ConfigError(`${at}.mint: listed twice`);
    const sigs = strList(e, "signatures", at);
    if (sigs) for (const s of sigs) if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s)) throw new ConfigError(`${at}.signatures: "${s.slice(0, 20)}…" is not a signature`);
    const costSol = e.costSol === undefined ? undefined : num(e, "costSol", at, { min: 0 });
    const basis = e.basis === undefined ? undefined : (str(e, "basis", at) as "mark");
    if (basis !== undefined && basis !== "mark") throw new ConfigError(`${at}.basis: "mark" (or leave it out)`);
    if ([sigs?.length ? 1 : 0, costSol !== undefined ? 1 : 0, basis ? 1 : 0].reduce((a, b) => a + b, 0) > 1) throw new ConfigError(`${at}: give one of signatures, costSol, basis`);
    mints.push({ mint, ...(sigs?.length ? { signatures: sigs } : {}), ...(costSol !== undefined ? { costSol } : {}), ...(basis ? { basis } : {}) });
  }
  if (mode === "list" && !mints.length) throw new ConfigError(`${w}.mints: list mode needs at least one mint`);
  const exclude = strList(raw, "exclude", w, { def: [], address: true })!;
  const dirs = (strList(raw, "excludeStateDirs", w, { def: [] }) ?? []).map((d) => resolve(baseDir, d));
  if (ownStateDir) for (const d of dirs) if (d === resolve(ownStateDir)) throw new ConfigError(`${w}.excludeStateDirs: "${d}" is this bot's own state dir`);
  const noBasis = str(raw, "noBasis", w, { def: "skip" }) as AdoptionConfig["noBasis"];
  if (noBasis !== "skip" && noBasis !== "mark") throw new ConfigError(`${w}.noBasis: "skip" (default) or "mark"`);
  return {
    mode, mints, exclude: [...new Set([...exclude, WSOL])], excludeStateDirs: dirs,
    minValueSol: num(raw, "minValueSol", w, { min: 0, def: 0.001 }),
    maxTransferFeeBps: num(raw, "maxTransferFeeBps", w, { min: 0, max: 10_000, int: true, def: 0 }),
    noBasis,
    historyPages: num(raw, "historyPages", w, { min: 0, max: 50, int: true, def: 3 }),
    everyMs: num(raw, "everyMs", w, { min: 1_000, int: true, def: 15_000 }),
  };
}

/** The coin holds and reads the adopter needs from the executor (Executor matches it). */
export interface CoinHolds {
  reserveMint(mint: string): boolean;
  releaseMint(mint: string): void;
  mintBusy(mint: string): boolean;
  mintEpoch(mint: string): number;
}

export interface AdopterDeps {
  cfg: Config;
  adoption: AdoptionConfig;
  ledger: Ledger;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  holds: CoinHolds;
  /** Whether the exit that will manage this mint reads a cost basis. */
  needsBasis: (mint: string) => boolean;
  /** The strategy name recorded on the position. */
  strategyName: (mint: string) => string;
  now?: () => number;
  venues?: ReadOptions;
}

interface WalletToken {
  mint: string;
  amount: bigint;
  decimals: number;
  frozen: boolean;
}

export interface AdoptionRow {
  position_id: number;
  mint: string;
  basis_source: string;
  wallet_seen_raw: string;
  since: number;
  adopted_at: number;
  updated_at: number;
}

/** `signatures`: buys counted in the basis (recorded so a later growth never counts them again). */
export type Basis = { source: "signatures" | "manual" | "chain" | "mark" | "none"; costLamports: bigint; detail?: Record<string, unknown>; signatures?: string[] };

const TABLES = `
create table if not exists adoptions (
  position_id integer primary key, mint text not null, basis_source text not null, wallet_seen_raw text not null,
  since integer not null, adopted_at integer not null, updated_at integer not null
);
create table if not exists adoption_sigs (signature text primary key, position_id integer not null);
`;

export class Adopter {
  private d: AdopterDeps;
  private now: () => number;
  private dry: boolean;
  private nextAt = 0;
  private skipped = new Map<string, { until: number; why: string }>();
  /** A difference seen once (mint -> first seen, balance then), waiting for the confirming read. */
  private pendingDiff = new Map<string, { at: number; bal: bigint }>();
  private mintChecks = new Map<string, { at: number; why: string | null }>();
  /** Other bots' open mints as of the last read (null: not read yet, or a ledger could not be read). */
  private others: Set<string> | null = null;
  /** The last good read of other bots' mints, and when. */
  private othersOk: Set<string> | null = null;
  private othersOkAt = 0;
  /** Mints the `adopt` request added this run (list mode). */
  private added = new Map<string, AdoptMint>();

  constructor(d: AdopterDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.dry = d.cfg.mode === "dry";
    d.ledger.db.exec(TABLES);
    // The engine's own expected out of each sell (pump venues) is kept in orders.decision_out_raw: set once at booking,
    // never overwritten by a build's quote (expected_out_raw follows those).
    d.ledger.ensureDecisionColumn();
  }

  /** Adoption rows of positions still managed (open or exit_stuck), this run's mode only. */
  managed(): Array<AdoptionRow & { position: PositionRow }> {
    const rows = this.d.ledger.db.prepare("select * from adoptions order by position_id").all() as unknown as AdoptionRow[];
    const out: Array<AdoptionRow & { position: PositionRow }> = [];
    for (const r of rows) {
      const p = this.d.ledger.position(r.position_id);
      if (p && !!p.dry === this.dry && (p.status === "open" || p.status === "exit_stuck")) out.push({ ...r, position: p });
    }
    return out;
  }

  adoption(positionId: number): AdoptionRow | undefined {
    return this.d.ledger.db.prepare("select * from adoptions where position_id = ?").get(positionId) as AdoptionRow | undefined;
  }

  private everAdopted(mint: string): boolean {
    return !!this.d.ledger.db.prepare("select 1 from adoptions a join positions p on p.id = a.position_id where a.mint = ? and p.dry = ? limit 1").get(mint, this.dry ? 1 : 0);
  }

  private positionsOf(mint: string): PositionRow[] {
    return this.d.ledger.positionsByStatus("opening", "open", "exit_stuck", "released").filter((p) => p.mint === mint && !!p.dry === this.dry);
  }

  /** Every mint another bot holds an open position in, or null when one of those ledgers cannot be read. */
  otherBotsMints(): Set<string> | null {
    const out = new Set<string>();
    for (const dir of this.d.adoption.excludeStateDirs) {
      const path = join(dir, "ledger.sqlite");
      if (!existsSync(path)) {
        this.ledgerAlert(dir, "no ledger.sqlite there");
        return null;
      }
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(path, { readOnly: true });
        db.exec("pragma busy_timeout = 250");
        // Open positions, and failed buys that may have landed (signed, or a possible execution): that bot's `sell` can
        // still reopen those tokens, so they are its own.
        const rows = db.prepare(
          `select distinct p.mint mint from positions p where p.status in ('opening','open','exit_stuck')
             or (p.status = 'failed' and exists (select 1 from orders o where o.position_id = p.id and o.side = 'buy'
                   and (o.signature is not null or o.ever_signed = 1) and o.status in ('failed','rejected')))`,
        ).all() as Array<{ mint: string }>;
        for (const r of rows) out.add(String(r.mint));
      } catch (e) {
        this.ledgerAlert(dir, String((e as Error)?.message ?? e).slice(0, 160));
        return null;
      } finally {
        try {
          db?.close();
        } catch {
          /* closed */
        }
      }
    }
    this.othersOk = out;
    this.othersOkAt = this.now();
    return out;
  }

  private ledgerAlert(dir: string, why: string): void {
    this.d.log.warn("adoption_exclude_unreadable", { stateDir: dir, why });
    this.d.alerter.raise(`adoption:exclude:${dir}`, `cannot read the ledger in ${dir} (${why}): no new adoptions and no growth until it can be read`);
  }

  /** The wallet's tokens (both token programs), or null when either read fails. */
  async walletTokens(): Promise<Map<string, WalletToken> | null> {
    const out = new Map<string, WalletToken>();
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
      let r: any;
      try {
        r = await this.d.rpc.call<any>("getTokenAccountsByOwner", [this.d.cfg.wallet, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      } catch {
        return null;
      }
      if (!r || !Array.isArray(r.value)) return null;
      for (const a of r.value) {
        const info = a?.account?.data?.parsed?.info;
        const amt = info?.tokenAmount?.amount;
        const mint = info?.mint;
        if (typeof mint !== "string" || typeof amt !== "string" || !/^\d+$/.test(amt)) return null;
        const prev = out.get(mint);
        const t: WalletToken = prev ?? { mint, amount: 0n, decimals: Number(info.tokenAmount.decimals ?? 0), frozen: false };
        t.amount += BigInt(amt);
        if (info.state === "frozen" && BigInt(amt) > 0n) t.frozen = true;
        out.set(mint, t);
      }
    }
    return out;
  }

  private configured(mint: string): AdoptMint | undefined {
    return this.d.adoption.mints.find((m) => m.mint === mint) ?? this.added.get(mint);
  }

  /**
   * One adoption step (the engine runs it in its full cycle, every adoption.everyMs): requests, other bots' ledgers,
   * the wallet, releases, changes to adopted bags, new bags. Never throws (each part is guarded and logged).
   */
  async step(shouldStop: () => boolean = () => false, force = false): Promise<void> {
    this.requests();
    if (!force && this.now() < this.nextAt) return;
    this.nextAt = this.now() + this.d.adoption.everyMs;
    this.others = this.otherBotsMints();
    if (this.others) for (const a of this.managed()) if (this.others.has(a.mint)) this.release(a.position_id, "another bot holds an open position in this coin");
    const epochs = new Map<string, number>();
    for (const a of this.managed()) epochs.set(a.mint, this.d.holds.mintEpoch(a.mint));
    const wallet = await this.walletTokens();
    if (!wallet) {
      this.d.log.warn("adoption_wallet_unreadable", {});
      return;
    }
    if (shouldStop()) return;
    try {
      await this.reconcile(wallet, epochs);
    } catch (e) {
      this.d.log.error("adoption_reconcile_failed", { error: String((e as Error)?.stack ?? e) });
    }
    if (shouldStop() || this.others === null) return;
    let n = 0;
    let looks = 0;
    // Least recently looked at first, so a long wallet is worked through over several steps.
    const cands = this.candidates(wallet).sort((x, y) => (this.lookedAt.get(x.mint) ?? 0) - (this.lookedAt.get(y.mint) ?? 0));
    for (const t of cands) {
      if (shouldStop() || n >= ADOPT_PER_STEP || looks >= LOOKS_PER_STEP) break;
      looks++;
      this.lookedAt.set(t.mint, this.now());
      try {
        const r = await this.adopt(t.mint, t);
        if (r.ok) n++;
      } catch (e) {
        // A read that threw (RPC error, rate limit): looked at again soon, never counted as a verdict on the coin.
        this.skip(t.mint, `read failed (${String((e as Error)?.message ?? e).slice(0, 80)})`, {}, READ_RETRY_MS);
      }
    }
  }

  /** When each candidate mint was last looked at (round robin across steps). */
  private lookedAt = new Map<string, number>();

  /** Wallet tokens that may be adopted now (mode, exclusions, not managed or released, not skipped recently). */
  private candidates(wallet: Map<string, WalletToken>): WalletToken[] {
    const out: WalletToken[] = [];
    for (const t of wallet.values()) {
      if (t.amount <= 0n) continue;
      if (this.d.adoption.mode === "list" && !this.configured(t.mint)) continue;
      if (this.d.adoption.exclude.includes(t.mint)) continue;
      if (this.others?.has(t.mint)) continue;
      if (this.positionsOf(t.mint).length) continue;
      // A coin this bot already managed and closed is adopted again only on an `adopt` request (a dry run's own dry
      // sells leave the tokens in the wallet; a live run's exit leaves dust or nothing).
      if (!this.added.has(t.mint) && this.everAdopted(t.mint)) continue;
      const s = this.skipped.get(t.mint);
      if (s && s.until > this.now()) continue;
      out.push(t);
    }
    return out;
  }

  private skip(mint: string, why: string, fields: Record<string, unknown> = {}, retryMs = SKIP_RETRY_MS): { ok: false; reason: string } {
    const prev = this.skipped.get(mint);
    this.skipped.set(mint, { until: this.now() + retryMs, why });
    if (prev?.why !== why) this.d.log.info("adoption_skip", { mint, why, ...fields });
    return { ok: false, reason: why };
  }

  /** The junk check for one mint (read now), or why it cannot be judged. */
  async mintCheck(mint: string): Promise<{ why: string | null; decimals?: number; transient?: boolean }> {
    let v: any;
    try {
      v = (await this.d.rpc.call<any>("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }]))?.value;
    } catch (e) {
      return { why: `mint unreadable (${String((e as Error)?.message ?? e).slice(0, 80)})`, transient: true };
    }
    try {
      const m = decodeMint(v);
      const why = junkReason(m, { maxTransferFeeBps: this.d.adoption.maxTransferFeeBps });
      this.mintChecks.set(mint, { at: this.now(), why });
      return { why, decimals: m.decimals };
    } catch (e) {
      return { why: `mint ${(e as Error).message}` };
    }
  }

  /**
   * (Before each sell of an adopted bag) the mint's junk check again (cached SELL_CHECK_MS), and no other bot holding
   * the coin. Returns why the sell must not be signed, or null.
   */
  async sellCheck(p: PositionRow): Promise<string | null> {
    if (!this.adoption(p.id)) return null;
    // Read the other bots' ledgers now (a `sell` run with the bot stopped has had no adoption step yet). A read that
    // fails falls back to the last good one for OTHERS_GRACE_MS (a busy moment never holds a stop-loss); past that
    // the sell is refused and alerted.
    const fresh = this.otherBotsMints();
    this.others = fresh;
    const known = fresh ?? (this.now() - this.othersOkAt <= OTHERS_GRACE_MS ? this.othersOk : null);
    if (known === null) {
      this.d.alerter.raise(`adoption:exits_blocked`, `exits of adopted bags are held: another bot's ledger has not been readable for over ${Math.round(OTHERS_GRACE_MS / 60_000)} min (see adoption_exclude_unreadable)`);
      return "another bot's ledger could not be read";
    }
    if (known.has(p.mint)) return "another bot holds an open position in this coin";
    const c = this.mintChecks.get(p.mint);
    if (c && this.now() - c.at < SELL_CHECK_MS) return c.why;
    return (await this.mintCheck(p.mint)).why;
  }

  /**
   * Adopt one mint now (the adoption step, the `adopt` request, batch 4's mirror). `t` is the wallet's holding when the
   * caller has read it. Holds the coin (no attempt on it) while it reads and books.
   */
  async adopt(mint: string, t?: WalletToken): Promise<{ ok: true; positionId: number } | { ok: false; reason: string }> {
    if (asAddress(mint) !== mint) return { ok: false, reason: "bad_mint" };
    if (this.d.adoption.exclude.includes(mint)) return this.skip(mint, "excluded");
    // Read now, whoever calls (the step, an `adopt` command with the bot stopped, a mirror): never a stale answer.
    this.others = this.otherBotsMints();
    if (this.others === null) return { ok: false, reason: "another bot's ledger could not be read" };
    if (this.others.has(mint)) return this.skip(mint, "another bot holds an open position in this coin");
    if (this.positionsOf(mint).length) return { ok: false, reason: "already managed or released" };
    if (!this.d.holds.reserveMint(mint)) return { ok: false, reason: "mint_busy" };
    try {
      if (!t) {
        const w = await this.walletTokens();
        if (!w) return { ok: false, reason: "wallet unreadable" };
        t = w.get(mint);
        if (!t || t.amount <= 0n) return this.skip(mint, "not in the wallet");
      }
      if (t.frozen) return this.skip(mint, "token account frozen");
      const mc = await this.mintCheck(mint);
      if (mc.why) return mc.transient ? this.skip(mint, mc.why, {}, READ_RETRY_MS) : this.skip(mint, `junk: ${mc.why}`);
      const decimals = mc.decimals ?? t.decimals;
      const m = (await readMarkets(this.d.rpc, [{ mint, decimals }], this.now(), this.d.venues ?? { pump: true })).get(mint);
      if (!m || m.priceSol === null || m.problem) return this.skip(mint, `unpriceable: ${m?.problem ?? "no price"}`);
      const valueLamports = expectedSellOut(m, t.amount) ?? BigInt(Math.floor((Number(t.amount) / 10 ** decimals) * m.priceSol * 1e9));
      if (Number(valueLamports) / 1e9 < this.d.adoption.minValueSol) return this.skip(mint, "dust", { valueSol: Number(valueLamports) / 1e9 });
      let basis: Basis | null;
      try {
        basis = await this.basisFor(mint, t.amount, decimals, m);
      } catch (e) {
        return this.skip(mint, `basis: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
      if (basis === null) return this.skip(mint, "no cost basis (the exit needs one; noBasis \"skip\")");
      // The other bots' ledgers once more right before booking (the reads above can take a while).
      this.others = this.otherBotsMints();
      if (this.others === null) return { ok: false, reason: "another bot's ledger could not be read" };
      if (this.others.has(mint)) return this.skip(mint, "another bot holds an open position in this coin");
      return this.book(mint, t.amount, decimals, m, basis);
    } finally {
      this.d.holds.releaseMint(mint);
    }
  }

  /** The cost basis per the order in the header, or null when the exit needs one and none may be used. */
  private async basisFor(mint: string, qty: bigint, decimals: number, m: MarketRead): Promise<Basis | null> {
    const c = this.configured(mint);
    const markCost = BigInt(Math.floor((Number(qty) / 10 ** decimals) * (m.priceSol ?? 0) * 1e9));
    if (c?.signatures?.length) {
      let tokens = 0n;
      let cost = 0n;
      for (const sig of c.signatures) {
        const tx = await getTransaction(this.d.rpc, sig).catch(() => null);
        if (!tx) throw new Error(`basis signature ${sig} unreadable`);
        const f = fillFromTx(tx, this.d.cfg.wallet, mint);
        if (f.err || f.tokenDeltaRaw <= 0n || f.swapLamports >= 0n) throw new Error(`basis signature ${sig} is not a buy of ${mint} by this wallet`);
        tokens += f.tokenDeltaRaw;
        cost += -f.swapLamports;
      }
      // The signatures' cost, scaled to the tokens held (fewer held than bought: the held share's cost).
      // The signatures' average cost per token, for the tokens held (more held than they bought: the rest at the same
      // average, never at zero).
      return { source: "signatures", costLamports: (cost * qty) / tokens, detail: { signatures: c.signatures, tokensBought: tokens.toString() } };
    }
    if (c?.costSol !== undefined) return { source: "manual", costLamports: BigInt(Math.round(c.costSol * 1e9)) };
    if (c?.basis !== "mark") {
      const h = await this.historyBuys(mint);
      if (h && h.tokens > 0n) {
        // The average cost of the buys found, for the tokens held.
        return { source: "chain", costLamports: (h.cost * qty) / h.tokens, detail: { buys: h.signatures.length, tokensBought: h.tokens.toString(), complete: h.complete }, signatures: h.signatures };
      }
    }
    if (c?.basis === "mark") return { source: "mark", costLamports: markCost };
    if (!this.d.needsBasis(mint)) return { source: "none", costLamports: 0n };
    if (this.d.adoption.noBasis === "mark") return { source: "mark", costLamports: markCost };
    return null;
  }

  /** The wallet's buys of the coin in its token accounts' history (newest first, capped), skipping booked signatures. */
  async historyBuys(mint: string, sinceSec = 0): Promise<{ tokens: bigint; cost: bigint; signatures: string[]; complete: boolean } | null> {
    const pages = this.d.adoption.historyPages;
    if (pages <= 0) return null;
    const accts = await tokenAccounts(this.d.rpc, this.d.cfg.wallet, mint);
    if (accts === null) return null;
    const booked = new Set([...this.d.ledger.bookedSignatures(), ...(this.d.ledger.db.prepare("select signature from adoption_sigs").all() as Array<{ signature: string }>).map((r) => r.signature)]);
    let tokens = 0n, cost = 0n, complete = true;
    const sigs: string[] = [];
    const seen = new Set<string>();
    for (const a of accts) {
      let before: string | undefined;
      let done = false;
      for (let page = 0; page < pages && !done; page++) {
        let list: any[];
        try {
          list = (await this.d.rpc.call<any[]>("getSignaturesForAddress", [a, { limit: 100, commitment: "confirmed", ...(before ? { before } : {}) }])) ?? [];
        } catch {
          return null;
        }
        if (list.length < 100) done = true;
        for (const s of list) {
          if (!s?.signature) continue;
          before = s.signature;
          if (sinceSec && typeof s.blockTime === "number" && s.blockTime < sinceSec) {
            done = true;
            break;
          }
          if (s.err || booked.has(s.signature) || seen.has(s.signature)) continue;
          seen.add(s.signature);
          const tx = await getTransaction(this.d.rpc, s.signature).catch(() => null);
          if (!tx) {
            complete = false;
            continue;
          }
          let f;
          try {
            f = fillFromTx(tx, this.d.cfg.wallet, mint);
          } catch {
            complete = false;
            continue;
          }
          // A buy: tokens in and SOL paid. Transfers in (no SOL paid) and sells are not.
          if (f.err || f.tokenDeltaRaw <= 0n || f.swapLamports >= 0n) continue;
          tokens += f.tokenDeltaRaw;
          cost += -f.swapLamports;
          sigs.push(s.signature);
        }
      }
      if (!done) complete = false;
    }
    return { tokens, cost, signatures: sigs, complete };
  }

  private book(mint: string, qty: bigint, decimals: number, m: MarketRead, basis: Basis): { ok: true; positionId: number } | { ok: false; reason: string } {
    const now = this.now();
    let pid: number;
    try {
      pid = this.d.ledger.tx(() => {
        if (this.positionsOf(mint).length) throw new Error("already managed");
        const entry = { from: "adoption", mode: this.d.adoption.mode, basis: basis.source, ...(basis.detail ?? {}), markSol: m.priceSol, venue: m.venue };
        const id = this.d.ledger.createPosition({ mint, chain: "solana", dry: this.dry, now, decimals, strategy: this.d.strategyName(mint), entry });
        this.d.ledger.updatePosition(id, { status: "open", qty_raw: qty.toString(), qty_source: "wallet", remaining_raw: qty.toString(), cost_lamports: basis.costLamports.toString(), peak_price: m.priceSol ?? 0, last_price: m.priceSol ?? null, note: `adopted (basis ${basis.source})` });
        this.d.ledger.db.prepare("insert into adoptions (position_id, mint, basis_source, wallet_seen_raw, since, adopted_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)").run(id, mint, basis.source, qty.toString(), Math.floor(now / 1000), now, now);
        const sigs = [...((basis.detail?.signatures as string[] | undefined) ?? []), ...(basis.signatures ?? [])];
        for (const s of sigs) this.d.ledger.db.prepare("insert or ignore into adoption_sigs (signature, position_id) values (?, ?)").run(s, id);
        return id;
      });
    } catch (e) {
      return { ok: false, reason: String((e as Error)?.message ?? e).slice(0, 120) };
    }
    this.skipped.delete(mint);
    this.d.log.info(this.dry ? "dry_adopted" : "adopted", { position: pid, mint, qtyRaw: qty, basis: basis.source, costLamports: basis.costLamports, venue: m.venue, priceSol: m.priceSol });
    this.d.alerter.raise(`position:${pid}:adopted`, `adopted ${mint}: ${qty} raw on ${m.venue}, basis ${basis.source}${basis.source === "none" ? "" : ` ${Number(basis.costLamports) / 1e9} SOL`}`);
    return { ok: true, positionId: pid };
  }

  /** Stop managing an adopted bag: nothing is sold. Refused while an order of it is in flight. */
  release(positionId: number, why: string): string {
    const p = this.d.ledger.position(positionId);
    if (!p || !this.adoption(positionId)) return "not an adopted position";
    if (p.status !== "open" && p.status !== "exit_stuck") return `position ${positionId} is ${p.status}`;
    if (this.d.ledger.openOrderFor(positionId) || this.d.holds.mintBusy(p.mint)) return "an order of this coin is in flight; try again";
    this.d.ledger.updatePosition(positionId, { status: "released", closed_at: this.now(), note: `released: ${why}` });
    this.d.log.info("released", { position: positionId, mint: p.mint, why });
    this.d.alerter.raise(`position:${positionId}:released`, `released ${p.mint} (position ${positionId}): ${why}; nothing sold`);
    return `released position ${positionId}`;
  }

  /** `adopt` / `release` request files (written by the CLI while the bot runs). */
  private requests(): void {
    const dir = join(this.d.cfg.stateDir, "requests");
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => /^(adopt|release)-[A-Za-z0-9-]+\.json$/.test(n));
    } catch {
      return;
    }
    for (const n of names) {
      const text = readControl(join(dir, n));
      try {
        unlinkSync(join(dir, n));
      } catch {
        /* gone */
      }
      if (!text) continue;
      try {
        const req = JSON.parse(text) as { mint: string; signatures?: string[]; costSol?: number; basis?: "mark" };
        if (asAddress(req.mint) !== req.mint) throw new Error("bad mint");
        if (n.startsWith("release-")) {
          const p = this.managed().find((a) => a.mint === req.mint);
          const r = p ? this.release(p.position_id, "release request") : "no adopted position for that mint";
          this.d.log.info("release_request", { mint: req.mint, result: r });
        } else {
          const e: AdoptMint = { mint: req.mint, ...(req.signatures?.length ? { signatures: req.signatures } : {}), ...(req.costSol !== undefined ? { costSol: Number(req.costSol) } : {}), ...(req.basis === "mark" ? { basis: "mark" as const } : {}) };
          this.added.set(req.mint, e);
          this.skipped.delete(req.mint);
          // A released mint may be adopted again by an explicit request: its released row stays as history.
          this.d.ledger.db.prepare("update positions set status = 'closed', note = coalesce(note, '') || ' (re-adopted)' where mint = ? and status = 'released' and dry = ?").run(req.mint, this.dry ? 1 : 0);
          this.nextAt = 0;
          this.d.log.info("adopt_request", { mint: req.mint });
        }
      } catch (e) {
        this.d.log.warn("adoption_request_bad", { file: n, error: String((e as Error)?.message ?? e) });
      }
    }
  }

  /** Follow adopted bags' wallet balance (header: later changes). */
  private async reconcile(wallet: Map<string, WalletToken>, epochs: Map<string, number>): Promise<void> {
    const byMint = new Map<string, Array<AdoptionRow & { position: PositionRow }>>();
    for (const a of this.managed()) byMint.set(a.mint, [...(byMint.get(a.mint) ?? []), a]);
    for (const [mint, rows] of byMint) {
      // One adopted position per coin (adopt() refuses a second); anything else waits for a human.
      if (rows.length !== 1) continue;
      const a = rows[0];
      const p = this.d.ledger.position(a.position_id)!;
      if (this.d.ledger.openOrderFor(p.id) || this.d.holds.mintBusy(mint) || this.d.holds.mintEpoch(mint) !== epochs.get(mint)) {
        this.pendingDiff.delete(mint);
        continue;
      }
      const bal = wallet.get(mint)?.amount ?? 0n;
      const ref = this.dry ? BigInt(a.wallet_seen_raw) : BigInt(p.remaining_raw);
      if (bal === ref) {
        this.pendingDiff.delete(mint);
        continue;
      }
      const seen = this.pendingDiff.get(mint);
      if (!seen || seen.bal !== bal) {
        this.pendingDiff.set(mint, { at: this.now(), bal });
        continue;
      }
      if (this.now() - seen.at < RECONCILE_CONFIRM_MS) continue;
      this.pendingDiff.delete(mint);
      if (bal > ref) await this.grow(a, p, bal - ref, bal);
      else this.shrink(a, p, ref - bal, bal);
    }
  }

  private shrink(a: AdoptionRow, p: PositionRow, delta: bigint, bal: bigint): void {
    const now = this.now();
    const rem = BigInt(p.remaining_raw);
    const newRem = rem > delta ? rem - delta : 0n;
    this.d.ledger.tx(() => {
      this.d.ledger.updatePosition(p.id, {
        remaining_raw: newRem.toString(),
        written_down_raw: (BigInt(p.written_down_raw ?? "0") + (rem - newRem)).toString(),
        note: `shrunk outside the bot: -${delta}`,
        ...(newRem === 0n ? { status: "closed", closed_at: now } : {}),
      });
      this.d.ledger.db.prepare("update adoptions set wallet_seen_raw = ?, updated_at = ? where position_id = ?").run(bal.toString(), now, p.id);
    });
    this.d.log.warn("adopted_shrunk", { position: p.id, mint: p.mint, deltaRaw: delta, remainingRaw: newRem, closed: newRem === 0n });
    this.d.alerter.raise(`position:${p.id}:shrunk:${bal}`, `${p.mint} (position ${p.id}): ${delta} raw left the wallet outside this bot; position now ${newRem}${newRem === 0n ? " (closed)" : ""}`);
  }

  private async grow(a: AdoptionRow, p: PositionRow, delta: bigint, bal: bigint): Promise<void> {
    if (this.others === null) return; // fail closed: another bot's ledger unread
    // The history scan runs without holding the coin (a sell of this bag never waits for it); the booking holds it and
    // goes ahead only on the row the scan began from.
    const h = this.dry ? null : await this.historyBuys(p.mint, a.since - 60);
    if (!this.d.holds.reserveMint(p.mint)) return;
    try {
      const fresh = this.d.ledger.position(p.id);
      if (!fresh || fresh.remaining_raw !== p.remaining_raw || (fresh.status !== "open" && fresh.status !== "exit_stuck") || this.d.ledger.openOrderFor(p.id)) return;
      const qty = BigInt(p.qty_raw);
      const avgCost = qty > 0n ? (BigInt(p.cost_lamports) * delta) / qty : 0n;
      let add = avgCost;
      let how = "transfer (at the average entry)";
      let sigs: string[] = [];
      if (h && h.tokens > 0n) {
        // Bought since adoption: that buy's cost for the tokens it brought (pro rata), the rest at the average entry.
        const bought = h.tokens < delta ? h.tokens : delta;
        add = (h.cost * bought) / h.tokens + (qty > 0n ? (BigInt(p.cost_lamports) * (delta - bought)) / qty : 0n);
        how = `buy${h.signatures.length > 1 ? "s" : ""} ${h.signatures.join(", ")}`;
        sigs = h.signatures;
      }
      const now = this.now();
      this.d.ledger.tx(() => {
        this.d.ledger.updatePosition(p.id, { qty_raw: (qty + delta).toString(), remaining_raw: (BigInt(p.remaining_raw) + delta).toString(), cost_lamports: (BigInt(p.cost_lamports) + add).toString(), note: `grown outside the bot: +${delta} (${how.slice(0, 120)})` });
        this.d.ledger.db.prepare("update adoptions set wallet_seen_raw = ?, updated_at = ? where position_id = ?").run(bal.toString(), now, p.id);
        for (const s of sigs) this.d.ledger.db.prepare("insert or ignore into adoption_sigs (signature, position_id) values (?, ?)").run(s, p.id);
      });
      this.d.log.warn("adopted_grown", { position: p.id, mint: p.mint, deltaRaw: delta, addedCostLamports: add, how });
      this.d.alerter.raise(`position:${p.id}:grown:${bal}`, `${p.mint} (position ${p.id}): +${delta} raw arrived outside this bot (${how.slice(0, 100)}); position grown`);
    } finally {
      this.d.holds.releaseMint(p.mint);
    }
  }

  /** For status.json: each managed bag's adoption facts. */
  statusRows(): Array<Record<string, unknown>> {
    return this.managed().map((a) => ({ position: a.position_id, mint: a.mint, basis: a.basis_source, adoptedAt: new Date(a.adopted_at).toISOString() }));
  }

  get skips(): Array<{ mint: string; why: string; until: string }> {
    return [...this.skipped].map(([mint, s]) => ({ mint, why: s.why, until: new Date(s.until).toISOString() }));
  }
}
