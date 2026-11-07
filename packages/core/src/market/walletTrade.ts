/**
 * (batch 4) One wallet's trade in one transaction, from the transaction's own balance changes for that wallet.
 *
 * A trade is: exactly one token (wrapped SOL aside) whose balance in the wallet's token accounts changed, and SOL moving
 * the other way. The venue comes from the programs the transaction invoked: the pump.fun curve, PumpSwap, the Candle
 * curve, Meteora DAMM v2, or a Jupiter route (which may split over several venues; the event lists the known ones).
 * Anything else is not classified: `{ ok: false, reason }`, never a guess.
 *
 * SOL (`solRaw`, lamports) is what the swap cost or paid the wallet, all-in: venue fees, tips and platform fees that the
 * wallet itself paid in the transaction are part of it. Two things are not:
 *   - the network fee (`feeRaw`), when the wallet is the fee payer;
 *   - rent (`rentRaw`): lamports the wallet put into accounts it created in the transaction and that are still funded
 *     at the end (its token account, a venue's one-time per-user account), less the rent of the wallet's token accounts
 *     closed back to it. Positive: the wallet parked rent; negative: it got rent back.
 * So for the wallet:  native change + persistent wrapped-SOL change = -feeRaw - rentRaw -/+ solRaw  (buy -, sell +).
 *
 * `heldBeforeRaw` / `heldAfterRaw` are the wallet's balance of the token before and after, summed over its token accounts
 * for that mint that the transaction lists (a second account of the same mint that the transaction does not touch is not
 * seen).
 */
import { b58decode } from "../solana/base58.ts";
import { CANDLE_CURVE_PROGRAM, DAMM_V2_PROGRAM, PUMP_AMM_PROGRAM, PUMP_PROGRAM, WSOL } from "../solana/pda.ts";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAMS: ReadonlySet<string> = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/** The venues the decoder names, by program id. */
export const VENUE_PROGRAMS: Readonly<Record<string, TradeVenue>> = Object.freeze({
  [PUMP_PROGRAM]: "pump-curve",
  [PUMP_AMM_PROGRAM]: "pumpswap",
  [CANDLE_CURVE_PROGRAM]: "candle-curve",
  [DAMM_V2_PROGRAM]: "damm-v2",
});
/** Routers: a trade through one is named after the router. */
export const ROUTER_PROGRAMS: Readonly<Record<string, TradeRoute>> = Object.freeze({ [JUPITER_PROGRAM]: "jupiter" });

export type TradeVenue = "pump-curve" | "pumpswap" | "candle-curve" | "damm-v2";
export type TradeRoute = "jupiter";
export const TRADE_VENUES: readonly (TradeVenue | TradeRoute)[] = Object.freeze(["pump-curve", "pumpswap", "candle-curve", "damm-v2", "jupiter"]);

export interface WalletTrade {
  wallet: string;
  mint: string;
  side: "buy" | "sell";
  /** SOL the swap cost (buy) or paid (sell), lamports, all-in less the network fee and rent. Always > 0. */
  solRaw: bigint;
  /** Tokens bought or sold, raw units. Always > 0. */
  tokenRaw: bigint;
  /** The venue, or the router for a routed trade. */
  venue: TradeVenue | TradeRoute;
  /** Every known venue the transaction invoked (one for a direct trade; any number for a route). */
  venues: TradeVenue[];
  signature: string;
  slot: number;
  /** Block time in seconds, or null when the node has none. */
  blockTime: number | null;
  /** Network fee the wallet paid (0 when another account paid it), lamports. */
  feeRaw: bigint;
  /** Rent the wallet parked (+) or got back (-) in this transaction, lamports. */
  rentRaw: bigint;
  heldBeforeRaw: bigint;
  heldAfterRaw: bigint;
  decimals: number;
}

export type DecodedTrade = { ok: true; trade: WalletTrade } | { ok: false; reason: string };

/** Every account key of a json-encoded transaction, in index order (static keys, then loaded writable, then readonly). */
export function accountKeysOf(tx: any): string[] {
  const msg = tx?.transaction?.message;
  const keys = (msg?.accountKeys ?? []).map((k: any) => (typeof k === "string" ? k : k?.pubkey));
  return [...keys, ...(tx?.meta?.loadedAddresses?.writable ?? []), ...(tx?.meta?.loadedAddresses?.readonly ?? [])];
}

interface Ix {
  program: string;
  accounts: number[];
  data: Uint8Array;
}

function instructionsOf(tx: any, keys: string[]): Ix[] {
  const raw = [...(tx.transaction.message.instructions ?? []), ...(tx.meta.innerInstructions ?? []).flatMap((g: any) => g?.instructions ?? [])];
  return raw.map((ix: any) => {
    if (typeof ix?.programIdIndex !== "number" || !Array.isArray(ix.accounts) || typeof ix.data !== "string") throw new Error("instruction shape");
    return { program: keys[ix.programIdIndex], accounts: ix.accounts, data: b58decode(ix.data) };
  });
}

function u32(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] * 0x1000000);
}
function u64(d: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
  return v;
}

/** Lamports funded by createAccount (0) or createAccountWithSeed (3), with the funder and the new account; else null. */
export function systemCreate(ix: Ix): { from: number; to: number; lamports: bigint } | null {
  if (ix.program !== SYSTEM_PROGRAM || ix.data.length < 4) return null;
  const kind = u32(ix.data, 0);
  if (kind === 0 && ix.data.length >= 12) return { from: ix.accounts[0], to: ix.accounts[1], lamports: u64(ix.data, 4) };
  if (kind === 3) {
    // base (32), seed (u64 length + bytes), lamports, space, owner
    const o = 4 + 32;
    if (ix.data.length < o + 8) return null;
    const n = Number(u64(ix.data, o));
    const at = o + 8 + n;
    if (ix.data.length < at + 8) return null;
    return { from: ix.accounts[0], to: ix.accounts[1], lamports: u64(ix.data, at) };
  }
  return null;
}

interface TokenRow {
  index: number;
  mint: string;
  owner: string | undefined;
  amount: bigint;
  decimals: number;
}

function tokenRows(list: any[] | undefined): TokenRow[] {
  return (list ?? []).map((b: any) => {
    const amount = b?.uiTokenAmount?.amount;
    if (typeof b?.accountIndex !== "number" || typeof b?.mint !== "string" || typeof amount !== "string" || !/^\d+$/.test(amount)) throw new Error("token balance shape");
    return { index: b.accountIndex, mint: b.mint, owner: b.owner, amount: BigInt(amount), decimals: Number(b.uiTokenAmount.decimals ?? 0) };
  });
}

/** The trade `wallet` made in the json-encoded transaction `tx` (getTransaction, encoding json), or why there is none. */
export function decodeWalletTrade(tx: any, wallet: string, signature?: string): DecodedTrade {
  if (!tx || !tx.meta || !tx.transaction?.message) return { ok: false, reason: "no transaction" };
  if (tx.meta.err !== null && tx.meta.err !== undefined) return { ok: false, reason: "failed transaction" };
  const sig = signature ?? tx.transaction.signatures?.[0];
  if (typeof sig !== "string") return { ok: false, reason: "no signature" };
  let keys: string[];
  let ixs: Ix[];
  let pre: TokenRow[];
  let post: TokenRow[];
  try {
    keys = accountKeysOf(tx);
    ixs = instructionsOf(tx, keys);
    pre = tokenRows(tx.meta.preTokenBalances);
    post = tokenRows(tx.meta.postTokenBalances);
  } catch (e) {
    return { ok: false, reason: `unreadable transaction (${(e as Error).message})` };
  }
  const preB: unknown[] = tx.meta.preBalances ?? [];
  const postB: unknown[] = tx.meta.postBalances ?? [];
  if (preB.length !== keys.length || postB.length !== keys.length) return { ok: false, reason: "balances do not match the account keys" };
  const lam = (list: unknown[], i: number) => BigInt(list[i] as number);
  const wi = keys.indexOf(wallet);
  if (wi < 0) return { ok: false, reason: "wallet not in the transaction" };

  // Token balances of the wallet, per mint (an account absent on one side holds 0 there).
  const mine = (rows: TokenRow[]) => rows.filter((r) => r.owner === wallet);
  const sumBy = (rows: TokenRow[]) => {
    const m = new Map<string, bigint>();
    for (const r of rows) m.set(r.mint, (m.get(r.mint) ?? 0n) + r.amount);
    return m;
  };
  const preMine = sumBy(mine(pre));
  const postMine = sumBy(mine(post));
  const decimalsOf = new Map<string, number>();
  for (const r of [...pre, ...post]) decimalsOf.set(r.mint, r.decimals);
  const changed = [...new Set([...preMine.keys(), ...postMine.keys()])]
    .filter((m) => m !== WSOL)
    .map((m) => ({ mint: m, before: preMine.get(m) ?? 0n, after: postMine.get(m) ?? 0n }))
    .filter((x) => x.before !== x.after);
  if (!changed.length) return { ok: false, reason: "no token balance of the wallet changed" };
  if (changed.length > 1) return { ok: false, reason: `${changed.length} tokens changed (${changed.map((c) => c.mint).join(", ")})` };
  const tok = changed[0];

  // SOL: native change, plus the change in wrapped SOL held in the wallet's token accounts that exist before or after.
  const fee = keys[0] === wallet ? BigInt(tx.meta.fee ?? 0) : 0n;
  const native = lam(postB, wi) - lam(preB, wi);
  const wsol = (postMine.get(WSOL) ?? 0n) - (preMine.get(WSOL) ?? 0n);
  // Rent the wallet funded into accounts still alive at the end.
  let rentIn = 0n;
  for (const ix of ixs) {
    const c = systemCreate(ix);
    if (c && keys[c.from] === wallet && c.to !== wi && lam(postB, c.to) > 0n) rentIn += c.lamports;
  }
  // Rent of the wallet's token accounts closed to it: the account's lamports before, less any wrapped SOL it held then.
  let rentBack = 0n;
  const preByIndex = new Map(pre.map((r) => [r.index, r]));
  const closed = new Set<number>();
  for (const ix of ixs) {
    if (!TOKEN_PROGRAMS.has(ix.program) || ix.data.length < 1 || ix.data[0] !== 9) continue;
    const [acct, dest] = ix.accounts;
    if (keys[dest] !== wallet || closed.has(acct)) continue;
    closed.add(acct);
    const row = preByIndex.get(acct);
    if (!row || row.owner !== wallet) continue; // created in this transaction (pre 0 lamports), or not the wallet's
    rentBack += lam(preB, acct) - (row.mint === WSOL ? row.amount : 0n);
  }
  const rent = rentIn - rentBack;
  const swap = native + wsol + fee + rent; // < 0: SOL went into the trade
  const side = tok.after > tok.before ? "buy" : "sell";
  if (swap === 0n) return { ok: false, reason: "no SOL leg (a transfer, or a swap against another token)" };
  if ((side === "buy" && swap > 0n) || (side === "sell" && swap < 0n)) return { ok: false, reason: `SOL and tokens moved the same way (tokens ${side === "buy" ? "in" : "out"}, SOL ${swap > 0n ? "in" : "out"})` };

  const invoked = new Set(ixs.map((i) => i.program));
  const venues = [...new Set([...invoked].map((p) => VENUE_PROGRAMS[p]).filter((v): v is TradeVenue => !!v))];
  const routers = [...new Set([...invoked].map((p) => ROUTER_PROGRAMS[p]).filter((v): v is TradeRoute => !!v))];
  let venue: TradeVenue | TradeRoute;
  if (routers.length === 1) venue = routers[0];
  else if (routers.length > 1) return { ok: false, reason: "several routers" };
  else if (venues.length === 1) venue = venues[0];
  else if (!venues.length) return { ok: false, reason: "no known venue" };
  else return { ok: false, reason: `several venues without a router (${venues.join(", ")})` };

  return {
    ok: true,
    trade: {
      wallet,
      mint: tok.mint,
      side,
      solRaw: swap < 0n ? -swap : swap,
      tokenRaw: side === "buy" ? tok.after - tok.before : tok.before - tok.after,
      venue,
      venues,
      signature: sig,
      slot: Number(tx.slot ?? 0),
      blockTime: typeof tx.blockTime === "number" ? tx.blockTime : null,
      feeRaw: fee,
      rentRaw: rent,
      heldBeforeRaw: tok.before,
      heldAfterRaw: tok.after,
      decimals: decimalsOf.get(tok.mint) ?? 6,
    },
  };
}

/** Whether a transaction's logs show a known venue or router being invoked (cheap pre-filter before fetching it). */
export function logsInvokeVenue(logs: readonly string[]): boolean {
  for (const l of logs) {
    const m = /^Program (\w{32,44}) invoke/.exec(l);
    if (m && (VENUE_PROGRAMS[m[1]] || ROUTER_PROGRAMS[m[1]])) return true;
  }
  return false;
}
