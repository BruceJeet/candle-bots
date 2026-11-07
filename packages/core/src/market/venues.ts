/**
 * (batch 6) One coin's price on every venue the core can decode, read together: the coin's own venue as the core's
 * wide market read finds it (Candle curve or its DAMM v2 pool, pump.fun curve or the canonical PumpSwap pool), plus
 * any other PumpSwap or Meteora DAMM v2 pool named by address. Each price is SOL per whole token from the pool's own
 * state, with the SOL in the pool (`depthSol`) so a thin pool can be told apart. Reads only: two batched account reads
 * for the listed pools (the pools and mints, then their vaults) and the core's market read.
 *
 * A pool is refused (priced null, `problem` says why) when it does not pair the coin with SOL, or is a PumpSwap pool
 * in mayhem mode, or its accounts do not match.
 */
import { decodeDamm, dammPrice } from "./curve.ts";
import { decodeMint } from "./mint.ts";
import { decodePumpPool, decodeTokenAccount, pumpPoolPrice, pumpPoolState, pumpPoolUnsupported } from "./pump.ts";
import { readMarkets } from "./reader.ts";
import { b58encode } from "../solana/base58.ts";
import { dammPool, pumpSwapPool, WSOL } from "../solana/pda.ts";
import { getAccounts, type Rpc } from "../solana/rpc.ts";

export type PoolVenue = "pumpswap" | "damm";

export interface PoolRef {
  venue: PoolVenue;
  address: string;
}

export interface VenuePrice {
  /** "pump-curve", "pumpswap", "curve", "damm" (the coin's own venue), or the listed pool's venue, or "perp". */
  venue: string;
  source: "own" | "pool" | "perp";
  /** The pool's address (null for the coin's own curve read and a perp). */
  address: string | null;
  priceSol: number | null;
  /** SOL in the pool, null when unknown (a perp has none). */
  depthSol: number | null;
  problem?: string;
}

export interface CoinVenueRead {
  mint: string;
  decimals: number | null;
  prices: VenuePrice[];
}

/** The SOL vault of a DAMM v2 pool (token A's vault at byte 232, token B's at 264). */
function dammSolVault(v: any, pool: { tokenA: string; tokenB: string }): string | null {
  try {
    const b = Buffer.from(v.data[0], "base64");
    const at = pool.tokenA === WSOL ? 232 : pool.tokenB === WSOL ? 264 : -1;
    return at < 0 ? null : b58encode(b.subarray(at, at + 32));
  } catch {
    return null;
  }
}

export async function readVenuePrices(rpc: Rpc, coins: Array<{ mint: string; pools: PoolRef[]; own: boolean }>, nowMs: number): Promise<Map<string, CoinVenueRead>> {
  const out = new Map<string, CoinVenueRead>();
  if (!coins.length) return out;
  // 1: mints and listed pools.
  const keys: string[] = [];
  for (const c of coins) keys.push(c.mint, ...c.pools.map((p) => p.address));
  const first = await getAccounts(rpc, keys);
  const byKey = new Map<string, any>();
  keys.forEach((k, i) => byKey.set(k, first[i]));
  for (const c of coins) {
    let decimals: number | null = null;
    try {
      decimals = decodeMint(byKey.get(c.mint)).decimals;
    } catch {
      decimals = null;
    }
    out.set(c.mint, { mint: c.mint, decimals, prices: [] });
  }
  // 2: the coin's own venue, by the core's wide read.
  const own = coins.filter((c) => c.own && out.get(c.mint)!.decimals !== null);
  if (own.length) {
    const reads = await readMarkets(rpc, own.map((c) => ({ mint: c.mint, decimals: out.get(c.mint)!.decimals! })), nowMs, { pump: true, reserves: true });
    for (const c of own) {
      const m = reads.get(c.mint);
      const ok = !!m && m.priceSol !== null && Number.isFinite(m.priceSol) && m.priceSol > 0;
      const depth = m?.quoteLiquidityLamports !== undefined && m?.quoteLiquidityLamports !== null ? Number(m.quoteLiquidityLamports) / 1e9 : null;
      const address = m?.venue === "pumpswap" ? pumpSwapPool(c.mint) : m?.venue === "damm" ? dammPool(c.mint) : null;
      out.get(c.mint)!.prices.push({ venue: m?.venue ?? "unknown", source: "own", address, priceSol: ok ? m!.priceSol : null, depthSol: depth, ...(ok ? {} : { problem: m?.problem ?? "no price" }) });
    }
  }
  // 3: listed pools, then their vaults.
  const later: Array<() => void> = [];
  const vaults: string[] = [];
  const vaultVals = new Map<string, any>();
  for (const c of coins) {
    const read = out.get(c.mint)!;
    const ownAddr = new Set(read.prices.map((p) => p.address).filter(Boolean));
    for (const p of c.pools) {
      if (ownAddr.has(p.address)) continue; // the coin's own pool, already read
      const row: VenuePrice = { venue: p.venue, source: "pool", address: p.address, priceSol: null, depthSol: null };
      read.prices.push(row);
      if (read.decimals === null) {
        row.problem = "mint_unread";
        continue;
      }
      const dec = read.decimals;
      const acct = byKey.get(p.address);
      try {
        if (p.venue === "pumpswap") {
          const pool = decodePumpPool(acct);
          const why = pumpPoolUnsupported(pool, c.mint);
          if (why) throw new Error(why);
          vaults.push(pool.baseVault, pool.quoteVault);
          later.push(() => {
            try {
              const s = pumpPoolState(pool, decodeTokenAccount(vaultVals.get(pool.baseVault)), decodeTokenAccount(vaultVals.get(pool.quoteVault)));
              row.priceSol = pumpPoolPrice(s, dec);
              row.depthSol = Number(s.quoteVault) / 1e9;
            } catch (e) {
              row.problem = (e as Error).message;
            }
          });
        } else {
          const pool = decodeDamm(acct);
          const pairs = (pool.tokenA === c.mint && pool.tokenB === WSOL) || (pool.tokenB === c.mint && pool.tokenA === WSOL);
          if (!pairs) throw new Error("damm_pair_not_coin_sol");
          if (pool.status !== 0) throw new Error("damm_disabled");
          row.priceSol = dammPrice(pool, c.mint, dec);
          const sv = dammSolVault(acct, pool);
          if (sv) {
            vaults.push(sv);
            later.push(() => {
              try {
                const t = decodeTokenAccount(vaultVals.get(sv));
                row.depthSol = t.mint === WSOL ? Number(t.amount) / 1e9 : null;
              } catch {
                row.depthSol = null;
              }
            });
          }
        }
      } catch (e) {
        row.problem = (e as Error).message;
      }
    }
  }
  if (vaults.length) {
    const uniq = [...new Set(vaults)];
    try {
      const got = await getAccounts(rpc, uniq);
      uniq.forEach((k, i) => vaultVals.set(k, got[i]));
    } catch {
      /* each pool below records why */
    }
    for (const f of later) f();
  }
  return out;
}

export interface Spread {
  bps: number;
  hi: VenuePrice;
  lo: VenuePrice;
  /** Prices compared (priced, deep enough). */
  n: number;
}

/**
 * The widest gap between two venues of a coin, in bps of the lower price: (hi / lo - 1) x 10,000. Only priced venues
 * with at least `minDepthSol` SOL count (a perp, which has no depth, counts when `perps` is true). Null with fewer than
 * two.
 */
export function spreadOf(prices: VenuePrice[], minDepthSol: number, perps = true): Spread | null {
  const ok = prices.filter((p) => p.priceSol !== null && p.priceSol > 0 && (p.source === "perp" ? perps : p.depthSol !== null && p.depthSol >= minDepthSol));
  if (ok.length < 2) return null;
  let hi = ok[0];
  let lo = ok[0];
  for (const p of ok) {
    if (p.priceSol! > hi.priceSol!) hi = p;
    if (p.priceSol! < lo.priceSol!) lo = p;
  }
  return { bps: Math.round((hi.priceSol! / lo.priceSol! - 1) * 10_000), hi, lo, n: ok.length };
}

/** Units of the coin per perp contract: Hyperliquid's `k` prefix is 1,000 (kBONK, kPEPE). */
export function perpUnits(coin: string): number {
  return /^k[A-Z0-9]/.test(coin) ? 1000 : 1;
}
