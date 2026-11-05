/** Market reads for a set of coins in one RPC round trip: the Candle curve, and the DAMM v2 pool once migrated. */
import { candleCurve, dammPool, pumpCurve, pumpFeeConfig, pumpSwapPool, PUMP_AMM_PROGRAM, PUMP_PROGRAM, WSOL } from "../solana/pda.ts";
import { getAccounts, type Rpc } from "../solana/rpc.ts";
import { b58encode } from "../solana/base58.ts";
import { buyImpact, curveProgress, dammBuy, dammPrice, dammRoomAboveFloor, decodeCandleCurve, decodeDamm, priceFromSqrt, type CandleCurve, type DammPool } from "./curve.ts";
import type { MarketView } from "../strategies/types.ts";
import { decodeFeeConfig, decodePumpCurve, decodePumpPool, decodeTokenAccount, pumpCurvePrice, pumpCurveProgress, pumpCurveSell, pumpCurveUnsupported, pumpPoolPrice, pumpPoolSell, pumpPoolState, pumpPoolUnsupported, type FeeConfig, type PumpCurve, type PumpPoolState } from "./pump.ts";
import { decodeMint } from "./mint.ts";
import type { DryPricer } from "../exec/executor.ts";

export interface MarketRead extends MarketView {
  mint: string;
  curve: CandleCurve | null;
  /** (0.4.0) The graduated coin's DAMM v2 pool as read (its creator checked against the curve's authority). */
  pool?: DammPool | null;
  roomAboveFloor: number | null;
  problem?: string;
  /** (0.5.0, venues.pump) The pump.fun curve as read (venue pump-curve, or complete while its pool is read). */
  pumpCurve?: PumpCurve | null;
  /** (0.5.0, venues.pump) The canonical PumpSwap pool with its vaults (venue pumpswap). */
  pumpPool?: PumpPoolState | null;
  /** (0.5.0, venues.pump) Pump's fee tiers for the venue (null: unreadable, so no expected out). */
  pumpFees?: FeeConfig | null;
  /** (0.5.0, venues.pump) The coin's supply from its mint (the PumpSwap fee tier needs it). */
  supply?: bigint | null;
  /**
   * (0.5.0, venues.reserves or .pump) Real SOL in the venue, lamports: the Candle curve's quote reserve, the DAMM v2
   * pool's SOL vault, the pump curve's real quote reserve, the PumpSwap SOL vault. Null when unread.
   */
  quoteLiquidityLamports?: bigint | null;
}

/** (0.5.0) What readMarkets reads beyond the Candle curve and the DAMM v2 pool. Omitted: exactly the 0.4.0 read. */
export interface ReadOptions {
  /** pump.fun bonding curves and canonical PumpSwap pools, found per mint from chain (which accounts exist). */
  pump?: boolean;
  /** Real SOL in each venue (one more read per DAMM v2 pool: its SOL vault). */
  reserves?: boolean;
}

export interface CoinRef {
  mint: string;
  decimals: number;
}

const pdaCache = new Map<string, { curve: string; pool: string }>();
function pdas(mint: string) {
  let p = pdaCache.get(mint);
  if (!p) {
    p = { curve: candleCurve(mint), pool: dammPool(mint) };
    pdaCache.set(mint, p);
  }
  return p;
}

export async function readMarkets(rpc: Rpc, coins: CoinRef[], nowMs: number, opts?: ReadOptions): Promise<Map<string, MarketRead>> {
  if (opts && (opts.pump || opts.reserves)) return readMarketsWide(rpc, coins, nowMs, opts);
  const out = new Map<string, MarketRead>();
  if (!coins.length) return out;
  const keys: string[] = [];
  for (const c of coins) keys.push(pdas(c.mint).curve, pdas(c.mint).pool);
  const vals = await getAccounts(rpc, keys);
  coins.forEach((c, i) => {
    const cv = vals[2 * i];
    const pv = vals[2 * i + 1];
    const base: MarketRead = { mint: c.mint, priceSol: null, progress: null, migrated: false, venue: "unknown", nowMs, curve: null, roomAboveFloor: null };
    try {
      const curve = decodeCandleCurve(cv);
      if (curve.baseMint !== c.mint) throw new Error("curve_mismatch");
      base.curve = curve;
      base.progress = curveProgress(curve);
      base.migrated = curve.migrated;
      if (!curve.migrated && base.progress >= 1) {
        // Full but not flagged migrated yet: the graduating swap is done and the pool is not there. Hold.
        base.problem = "migrating";
      } else if (!curve.migrated) {
        base.venue = "curve";
        base.priceSol = curve.sqrtPrice ? priceFromSqrt(curve.sqrtPrice, c.decimals) : null;
      } else if (pv) {
        const pool = decodeDamm(pv);
        if (pool.creator !== curve.authority) throw new Error("pool_mismatch");
        base.venue = "damm";
        base.pool = pool;
        base.priceSol = dammPrice(pool, c.mint, c.decimals);
        base.roomAboveFloor = dammRoomAboveFloor(pool);
      } else {
        base.problem = "migrating";
      }
    } catch (e) {
      base.problem = (e as Error).message;
    }
    out.set(c.mint, base);
  });
  return out;
}

const pumpPdas = new Map<string, { curve: string; pool: string }>();
function pumpKeys(mint: string) {
  let p = pumpPdas.get(mint);
  if (!p) {
    p = { curve: pumpCurve(mint), pool: pumpSwapPool(mint) };
    pumpPdas.set(mint, p);
  }
  return p;
}
const FEES_CURVE = pumpFeeConfig(PUMP_PROGRAM);
const FEES_AMM = pumpFeeConfig(PUMP_AMM_PROGRAM);

/**
 * (0.5.0) The wide read: per coin the Candle curve, the DAMM v2 pool, the pump curve, the canonical PumpSwap pool and
 * the mint (one batched read, with pump's two fee configs), then the vaults the venues found need (a second batched
 * read). The venue is decided from which accounts exist, in this order: a Candle curve (as readMarkets: curve, then
 * its DAMM v2 pool once migrated); a pump curve not complete (pump-curve); a complete pump curve or no curve with the
 * canonical PumpSwap pool (pumpswap); a complete pump curve without its pool (problem "migrating"); nothing
 * (problem "no_venue").
 */
async function readMarketsWide(rpc: Rpc, coins: CoinRef[], nowMs: number, opts: ReadOptions): Promise<Map<string, MarketRead>> {
  const out = new Map<string, MarketRead>();
  if (!coins.length) return out;
  const pump = !!opts.pump;
  const per = pump ? 5 : 2;
  const keys: string[] = [];
  for (const c of coins) {
    keys.push(pdas(c.mint).curve, pdas(c.mint).pool);
    if (pump) keys.push(pumpKeys(c.mint).curve, pumpKeys(c.mint).pool, c.mint);
  }
  if (pump) keys.push(FEES_CURVE, FEES_AMM);
  const vals = await getAccounts(rpc, keys);
  let feesCurve: FeeConfig | null = null;
  let feesAmm: FeeConfig | null = null;
  if (pump) {
    try {
      feesCurve = decodeFeeConfig(vals[vals.length - 2]);
    } catch {
      feesCurve = null;
    }
    try {
      feesAmm = decodeFeeConfig(vals[vals.length - 1]);
    } catch {
      feesAmm = null;
    }
  }
  // Second round: vaults (PumpSwap base and quote, DAMM v2 SOL vault), by key.
  const second: string[] = [];
  const later: Array<() => void> = [];
  const vaultVals = new Map<string, any>();
  coins.forEach((c, i) => {
    const v = (j: number) => vals[per * i + j];
    const base: MarketRead = { mint: c.mint, priceSol: null, progress: null, migrated: false, venue: "unknown", nowMs, curve: null, roomAboveFloor: null };
    out.set(c.mint, base);
    if (pump) {
      try {
        base.supply = decodeMint(v(4)).supply;
      } catch {
        base.supply = null;
      }
    }
    try {
      if (v(0)) {
        const curve = decodeCandleCurve(v(0));
        if (curve.baseMint !== c.mint) throw new Error("curve_mismatch");
        base.curve = curve;
        base.progress = curveProgress(curve);
        base.migrated = curve.migrated;
        if (!curve.migrated && base.progress >= 1) base.problem = "migrating";
        else if (!curve.migrated) {
          base.venue = "curve";
          base.priceSol = curve.sqrtPrice ? priceFromSqrt(curve.sqrtPrice, c.decimals) : null;
          if (opts.reserves || pump) base.quoteLiquidityLamports = curve.quoteReserve;
        } else if (v(1)) {
          const pool = decodeDamm(v(1));
          if (pool.creator !== curve.authority) throw new Error("pool_mismatch");
          base.venue = "damm";
          base.pool = pool;
          base.priceSol = dammPrice(pool, c.mint, c.decimals);
          base.roomAboveFloor = dammRoomAboveFloor(pool);
          if (opts.reserves) {
            const quoteVault = pool.tokenA === WSOL ? dammVaultA(v(1)) : pool.tokenB === WSOL ? dammVaultB(v(1)) : null;
            if (quoteVault) {
              second.push(quoteVault);
              later.push(() => {
                try {
                  base.quoteLiquidityLamports = decodeTokenAccount(vaultVals.get(quoteVault)).amount;
                } catch {
                  base.quoteLiquidityLamports = null;
                }
              });
            }
          }
        } else base.problem = "migrating";
        return;
      }
      if (!pump) {
        base.problem = "curve_missing";
        return;
      }
      let pc: PumpCurve | null = null;
      if (v(2)) {
        pc = decodePumpCurve(v(2));
        base.pumpCurve = pc;
        base.pumpFees = feesCurve;
        base.progress = pumpCurveProgress(pc);
        base.migrated = pc.complete;
        if (!pc.complete) {
          const why = pumpCurveUnsupported(pc);
          if (why) throw new Error(why);
          base.venue = "pump-curve";
          base.priceSol = pumpCurvePrice(pc, c.decimals);
          base.quoteLiquidityLamports = pc.realQuote;
          return;
        }
      }
      if (!v(3)) {
        base.problem = pc ? "migrating" : "no_venue";
        return;
      }
      const pool = decodePumpPool(v(3));
      const why = pumpPoolUnsupported(pool, c.mint);
      if (why) throw new Error(why);
      base.migrated = true;
      base.progress = 1;
      base.pumpFees = feesAmm;
      second.push(pool.baseVault, pool.quoteVault);
      later.push(() => {
        try {
          const s = pumpPoolState(pool, decodeTokenAccount(vaultVals.get(pool.baseVault)), decodeTokenAccount(vaultVals.get(pool.quoteVault)));
          base.pumpPool = s;
          base.venue = "pumpswap";
          base.priceSol = pumpPoolPrice(s, c.decimals);
          base.quoteLiquidityLamports = s.quoteVault;
        } catch (e) {
          base.problem = (e as Error).message;
        }
      });
    } catch (e) {
      base.problem = (e as Error).message;
    }
  });
  if (second.length) {
    try {
      const got = await getAccounts(rpc, [...new Set(second)]);
      [...new Set(second)].forEach((k, i) => vaultVals.set(k, got[i]));
    } catch {
      /* every vault unread: each coin below records why */
    }
    for (const f of later) f();
  }
  return out;
}

/** DAMM v2 vault addresses (token A @232, token B @264) from the pool account's bytes. */
function dammVaultA(v: any): string | null {
  return dammKey(v, 232);
}
function dammVaultB(v: any): string | null {
  return dammKey(v, 264);
}
function dammKey(v: any, at: number): string | null {
  try {
    const b = Buffer.from(v.data[0], "base64");
    return b58encode(b.subarray(at, at + 32));
  } catch {
    return null;
  }
}

/**
 * (0.5.0) Lamports a sell of `raw` tokens should bring on the venue this read found, from the venue's own math and
 * fees: pump-curve and pumpswap only (null for Candle's curve, DAMM v2, a missing fee config or a sell the math
 * refuses).
 */
export function expectedSellOut(m: MarketRead, raw: bigint): bigint | null {
  try {
    if (!m.pumpFees) return null;
    if (m.venue === "pump-curve" && m.pumpCurve) return pumpCurveSell(m.pumpCurve, raw, m.pumpFees).outLamports;
    if (m.venue === "pumpswap" && m.pumpPool && m.supply) return pumpPoolSell(m.pumpPool, m.mint, raw, m.supply, m.pumpFees).outLamports;
  } catch {
    return null;
  }
  return null;
}

export function impactBps(curve: CandleCurve, lamports: bigint): { bps: number; expectedOutRaw: bigint } | { error: string } {
  try {
    const r = buyImpact(curve, lamports);
    return { bps: r.impactBps, expectedOutRaw: r.expectedOutRaw };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export interface QuoteSource {
  getQuote(chain: "solana", mint: string, q: { side: "buy" | "sell"; amountIn: string; slippageBps?: number }): Promise<{ quote: { amountOut: string } }>;
}

/**
 * Dry-run fills: Candle's public curve quote (exact integers) while the coin is on the curve; the on-chain
 * curve math as a fallback; for a migrated coin, the pool price less 2 % (labelled dry in the ledger).
 */
export function dryPricer(rpc: Rpc, quotes: QuoteSource | null, decimalsOf: (mint: string) => number, opts?: ReadOptions): DryPricer {
  return {
    async buyOut(mint, lamports) {
      if (quotes) {
        try {
          const q = await quotes.getQuote("solana", mint, { side: "buy", amountIn: lamports.toString() });
          return BigInt(q.quote.amountOut);
        } catch {
          /* fall back to the curve */
        }
      }
      const m = (await readMarkets(rpc, [{ mint, decimals: decimalsOf(mint) }], Date.now())).get(mint)!;
      if (!m.curve) throw Object.assign(new Error("no curve"), { code: "NO_MARKET" });
      // (0.4.0) A graduated coin: the pool's own buy math.
      if (m.curve.migrated && m.pool) return dammBuy(m.pool, mint, lamports).expectedOutRaw;
      return buyImpact(m.curve, lamports).expectedOutRaw;
    },
    async sellOut(mint, raw, decimals) {
      if (quotes) {
        try {
          const q = await quotes.getQuote("solana", mint, { side: "sell", amountIn: raw.toString() });
          return BigInt(q.quote.amountOut);
        } catch {
          /* graduated or unavailable: mark to market */
        }
      }
      const m = (await readMarkets(rpc, [{ mint, decimals }], Date.now(), opts)).get(mint)!;
      // (0.5.0) A pump.fun venue: the venue's own sell math.
      const exp = opts?.pump ? expectedSellOut(m, raw) : null;
      if (exp !== null) return exp;
      if (m.priceSol === null) throw Object.assign(new Error("no price"), { code: "NO_MARKET" });
      return BigInt(Math.floor((Number(raw) / 10 ** decimals) * m.priceSol * 1e9 * 0.98));
    },
  };
}
