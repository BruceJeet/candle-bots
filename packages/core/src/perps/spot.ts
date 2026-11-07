/**
 * (batch 6) The spot side a hedge covers: the coins a Solana wallet holds (every SPL and Token-2022 account, or only
 * listed mints), each priced in SOL on the venue the core reads for it (Candle curve, DAMM v2, pump.fun curve,
 * PumpSwap). Reads only: one call per token program for the balances and the core's batched market read.
 */
import { readMarkets, type MarketRead } from "../market/reader.ts";
import { TOKEN_2022, TOKEN_PROGRAM } from "../market/pump.ts";
import { WSOL } from "../solana/pda.ts";
import type { Rpc } from "../solana/rpc.ts";

/** Stablecoins never need a hedge: excluded by default along with wrapped SOL. */
export const DEFAULT_SPOT_EXCLUDE: readonly string[] = Object.freeze([
  WSOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export interface SpotBag {
  mint: string;
  qtyRaw: bigint;
  decimals: number;
  /** SOL per whole token on the venue read, null when it could not be priced (`problem` says why). */
  priceSol: number | null;
  venue: string;
  /** SOL in the coin's venue (curve reserve or pool vault), null when unread. */
  liquiditySol: number | null;
  problem?: string;
}

export interface SpotReadOptions {
  wallet: string;
  /** "list": only `mints` (a listed mint the wallet no longer holds comes back with qty 0). "wallet": everything held. */
  mode: "list" | "wallet";
  mints: string[];
  exclude: ReadonlySet<string>;
  /** At most this many coins are priced per read (a wallet full of airdrops must not flood the RPC). */
  maxBags: number;
  now?: () => number;
  /** Called with the number of candidate coins when there are more than maxBags (the rest are not read). */
  onTruncated?: (candidates: number) => void;
}

/** The wallet's balances per mint (both token programs). Throws when either read fails. */
export async function walletBalances(rpc: Rpc, wallet: string): Promise<Map<string, { amount: bigint; decimals: number }>> {
  const out = new Map<string, { amount: bigint; decimals: number }>();
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
    const r = await rpc.call<any>("getTokenAccountsByOwner", [wallet, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    if (!r || !Array.isArray(r.value)) throw new Error("getTokenAccountsByOwner: unexpected answer");
    for (const a of r.value) {
      const info = a?.account?.data?.parsed?.info;
      const amt = info?.tokenAmount?.amount;
      if (typeof info?.mint !== "string" || typeof amt !== "string" || !/^\d+$/.test(amt)) throw new Error("getTokenAccountsByOwner: unreadable token account");
      const prev = out.get(info.mint) ?? { amount: 0n, decimals: Number(info.tokenAmount.decimals ?? 0) };
      prev.amount += BigInt(amt);
      out.set(info.mint, prev);
    }
  }
  return out;
}

/**
 * The bags and their SOL prices. Throws when the balances cannot be read (the caller keeps its last read). A coin
 * whose market read fails comes back with priceSol null and a problem.
 */
export async function readSpotBags(rpc: Rpc, o: SpotReadOptions): Promise<SpotBag[]> {
  const bal = await walletBalances(rpc, o.wallet);
  const wanted = o.mode === "list" ? o.mints : [...bal.keys()].filter((m) => (bal.get(m)?.amount ?? 0n) > 0n);
  const all = [...new Set(wanted)].filter((m) => !o.exclude.has(m)).sort();
  // Listed mints first, then the rest (a wallet full of dust must not push a listed bag out of the read).
  const listed = new Set(o.mints);
  const mints = [...all.filter((m) => listed.has(m)), ...all.filter((m) => !listed.has(m))].slice(0, o.maxBags);
  if (all.length > o.maxBags) o.onTruncated?.(all.length);
  const coins = mints.map((mint) => ({ mint, decimals: bal.get(mint)?.decimals ?? 6 }));
  let reads = new Map<string, MarketRead>();
  let readError: string | null = null;
  try {
    reads = await readMarkets(rpc, coins.filter((c) => (bal.get(c.mint)?.amount ?? 0n) > 0n), (o.now ?? Date.now)(), { pump: true, reserves: true });
  } catch (e) {
    readError = String((e as Error)?.message ?? e).slice(0, 200);
  }
  return coins.map((c) => {
    const qtyRaw = bal.get(c.mint)?.amount ?? 0n;
    if (qtyRaw === 0n) return { mint: c.mint, qtyRaw, decimals: c.decimals, priceSol: null, venue: "none", liquiditySol: null, problem: "not held" };
    const m = reads.get(c.mint);
    if (!m) return { mint: c.mint, qtyRaw, decimals: c.decimals, priceSol: null, venue: "unknown", liquiditySol: null, problem: readError ?? "unread" };
    const ok = m.priceSol !== null && Number.isFinite(m.priceSol) && m.priceSol > 0;
    const liquiditySol = m.quoteLiquidityLamports !== undefined && m.quoteLiquidityLamports !== null ? Number(m.quoteLiquidityLamports) / 1e9 : null;
    return { mint: c.mint, qtyRaw, decimals: c.decimals, priceSol: ok ? m.priceSol : null, venue: m.venue, liquiditySol, ...(ok ? {} : { problem: m.problem ?? "no price" }) };
  });
}

/** A bag's value in USD at a SOL price in USD. */
export function bagUsd(b: Pick<SpotBag, "qtyRaw" | "decimals" | "priceSol">, solUsd: number): number | null {
  if (b.priceSol === null || !(solUsd > 0)) return null;
  return (Number(b.qtyRaw) / 10 ** b.decimals) * b.priceSol * solUsd;
}
