/**
 * (0.5.0) pump.fun bonding curves and PumpSwap (pump-amm) pools: decoding and sell math. Pure, no I/O.
 *
 * Layouts are the programs' own on-chain Anchor IDLs (read Nov 5 2026), checked on mainnet accounts:
 *
 * BondingCurve (program 6EF8rr…F6P, discriminator sha256("account:BondingCurve")[:8]): virtual_token_reserves u64 @8,
 * virtual_quote_reserves u64 @16, real_token_reserves u64 @24, real_quote_reserves u64 @32, token_total_supply u64 @40,
 * complete bool @48, creator @49, is_mayhem_mode bool @81, is_cashback_coin bool @82, quote_mint @83 (all zero = SOL),
 * creator_fee_bps u64 @115, can_edit_creator_fee bool @123, is_holder_reward bool @124. Older curves are shorter: a
 * field past the end reads as its default.
 *
 * Pool (pump-amm pAMMBay…EA, discriminator sha256("account:Pool")[:8], shared with Candle's curve account name):
 * pool_bump u8 @8, index u16 @9, creator @11, base_mint @43, quote_mint @75, lp_mint @107, pool_base_token_account @139,
 * pool_quote_token_account @171, lp_supply u64 @203, coin_creator @211, is_mayhem_mode bool @243, is_cashback_coin bool
 * @244, virtual_quote_reserves i128 @245 (not in the on-chain IDL; in pump's public docs, and the swap math needs it: a
 * pool shorter than 261 bytes reads it as 0).
 *
 * FeeConfig (pump's fee program pfeeUx…ZjVZ, one per program, PDA("fee_config", program)): bump u8 @8, admin @9, flat
 * fees (lp, protocol, creator: u64 bps each) @41, fee_tiers vec<{market_cap_lamports_threshold u128, fees}> @65, then
 * stable_fee_tiers (not read).
 *
 * Sell math, reproduced to the lamport on real sells (fixtures in the tests):
 *  - curve: out = floor(n * vq / (vt + n)); fees on that out, each ceil(out * bps / 10_000): protocol and creator
 *    (the buyback fee is part of the protocol fee). The wallet gets out - fees.
 *  - PumpSwap: quote_out = floor(n * Q / (B + n)) with B the base vault and Q = quote vault + virtual_quote_reserves;
 *    fees ceil(quote_out * bps / 10_000) each for lp, protocol and coin creator. The wallet gets quote_out - fees.
 *  - fee tier: the last tier whose threshold <= market cap (lamports): curve vq * supply / vt; pool Q * supply / B.
 * Not modelled (refused, never guessed): a quote other than SOL, a mayhem-mode PumpSwap pool, a pool whose base is not
 * the coin (the canonical pool always has the coin as base). A mayhem-mode curve's ordinary sell follows the same math.
 * Cashback coins: the price is the same; the expected out leaves the cashback fee out (it overstates by its bps).
 */
import { b58encode } from "../solana/base58.ts";
import { PUMP_AMM_PROGRAM, PUMP_FEE_PROGRAM, PUMP_PROGRAM, WSOL } from "../solana/pda.ts";
import { DecodeError, type AccountValue } from "./curve.ts";

const CURVE_DISC = Uint8Array.from([23, 183, 248, 55, 96, 216, 172, 96]);
const POOL_DISC = Uint8Array.from([241, 154, 109, 4, 17, 177, 109, 188]);
const FEE_DISC = Uint8Array.from([143, 52, 146, 187, 219, 123, 76, 155]);
const SYSTEM = "11111111111111111111111111111111";
/** Token-program token account: mint @0, owner @32, amount u64 @64 (165 bytes; token-2022 accounts are longer). */
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function bytes(v: AccountValue | null | undefined, owner: string, minLen: number, disc: Uint8Array | null, what: string): Uint8Array {
  if (!v) throw new DecodeError(`${what}_missing`);
  if (v.owner !== owner) throw new DecodeError(`${what}_owner`);
  const d = v.data;
  if (!Array.isArray(d) || d[1] !== "base64" || typeof d[0] !== "string") throw new DecodeError(`${what}_layout`);
  const b = new Uint8Array(Buffer.from(d[0], "base64"));
  if (b.length < minLen) throw new DecodeError(`${what}_layout`);
  if (disc) for (let i = 0; i < 8; i++) if (b[i] !== disc[i]) throw new DecodeError(`${what}_layout`);
  return b;
}

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u64 = (b: Uint8Array, at: number) => dv(b).getBigUint64(at, true);
const key = (b: Uint8Array, at: number) => b58encode(b.subarray(at, at + 32));
function i128(b: Uint8Array, at: number): bigint {
  const lo = dv(b).getBigUint64(at, true);
  const hi = dv(b).getBigInt64(at + 8, true);
  return lo | (hi << 64n);
}

export interface PumpCurve {
  virtualToken: bigint;
  virtualQuote: bigint;
  realToken: bigint;
  realQuote: bigint;
  supply: bigint;
  complete: boolean;
  creator: string | null;
  mayhem: boolean;
  cashback: boolean;
  /** The curve's quote mint; WSOL for SOL (the field all zero, or absent on older curves). */
  quoteMint: string;
}

export function decodePumpCurve(v: AccountValue | null | undefined): PumpCurve {
  const b = bytes(v, PUMP_PROGRAM, 49, CURVE_DISC, "pump_curve");
  const q = b.length >= 115 ? key(b, 83) : SYSTEM;
  return {
    virtualToken: u64(b, 8),
    virtualQuote: u64(b, 16),
    realToken: u64(b, 24),
    realQuote: u64(b, 32),
    supply: u64(b, 40),
    complete: b[48] !== 0,
    creator: b.length >= 81 ? key(b, 49) : null,
    mayhem: b.length >= 82 ? b[81] !== 0 : false,
    cashback: b.length >= 83 ? b[82] !== 0 : false,
    quoteMint: q === SYSTEM ? WSOL : q,
  };
}

export interface PumpPool {
  index: number;
  creator: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  coinCreator: string;
  mayhem: boolean;
  cashback: boolean;
  /** Signed: added to the quote vault for the swap's quote reserve (0 on a pool too short to carry it). */
  virtualQuote: bigint;
}

export function decodePumpPool(v: AccountValue | null | undefined): PumpPool {
  const b = bytes(v, PUMP_AMM_PROGRAM, 243, POOL_DISC, "pump_pool");
  return {
    index: dv(b).getUint16(9, true),
    creator: key(b, 11),
    baseMint: key(b, 43),
    quoteMint: key(b, 75),
    baseVault: key(b, 139),
    quoteVault: key(b, 171),
    coinCreator: key(b, 211),
    mayhem: b.length >= 244 ? b[243] !== 0 : false,
    cashback: b.length >= 245 ? b[244] !== 0 : false,
    virtualQuote: b.length >= 261 ? i128(b, 245) : 0n,
  };
}

/** A token account's mint and raw amount (either token program). */
export function decodeTokenAccount(v: AccountValue | null | undefined): { mint: string; owner: string; amount: bigint } {
  if (!v) throw new DecodeError("vault_missing");
  if (v.owner !== TOKEN_PROGRAM && v.owner !== TOKEN_2022) throw new DecodeError("vault_owner");
  const d = v.data;
  if (!Array.isArray(d) || d[1] !== "base64" || typeof d[0] !== "string") throw new DecodeError("vault_layout");
  const b = new Uint8Array(Buffer.from(d[0], "base64"));
  if (b.length < 165) throw new DecodeError("vault_layout");
  return { mint: key(b, 0), owner: key(b, 32), amount: u64(b, 64) };
}

export interface PumpFees {
  lpBps: bigint;
  protocolBps: bigint;
  creatorBps: bigint;
}

export interface FeeConfig {
  flat: PumpFees;
  /** Ascending thresholds (market cap in lamports). */
  tiers: Array<{ minMcapLamports: bigint; fees: PumpFees }>;
}

export function decodeFeeConfig(v: AccountValue | null | undefined): FeeConfig {
  const b = bytes(v, PUMP_FEE_PROGRAM, 69, FEE_DISC, "fee_config");
  const fees = (at: number): PumpFees => ({ lpBps: u64(b, at), protocolBps: u64(b, at + 8), creatorBps: u64(b, at + 16) });
  const flat = fees(41);
  const n = dv(b).getUint32(65, true);
  if (n > 256 || 69 + n * 40 > b.length) throw new DecodeError("fee_config_layout");
  const tiers: FeeConfig["tiers"] = [];
  for (let i = 0; i < n; i++) {
    const at = 69 + i * 40;
    tiers.push({ minMcapLamports: u64(b, at) | (u64(b, at + 8) << 64n), fees: fees(at + 16) });
  }
  for (let i = 1; i < tiers.length; i++) if (tiers[i].minMcapLamports < tiers[i - 1].minMcapLamports) throw new DecodeError("fee_config_layout");
  return { flat, tiers };
}

/** The fees at a market cap: the last tier at or under it; the flat fees when the config has no tiers. */
export function feesAt(cfg: FeeConfig, mcapLamports: bigint): PumpFees {
  let f: PumpFees | null = null;
  for (const t of cfg.tiers) if (t.minMcapLamports <= mcapLamports) f = t.fees;
  return f ?? cfg.tiers[0]?.fees ?? cfg.flat;
}

const ceilBps = (x: bigint, bps: bigint) => (x * bps + 9_999n) / 10_000n;

/** Why this curve's sell cannot be modelled, or null. */
export function pumpCurveUnsupported(c: PumpCurve): string | null {
  // Mayhem-mode curves: an ordinary sell follows the same math and fees (checked on two real sells, to the lamport).
  if (c.quoteMint !== WSOL) return "pump_quote_not_sol";
  if (c.virtualToken === 0n || c.virtualQuote === 0n) return "pump_reserves";
  return null;
}

/** SOL per whole token on the curve now (spot). */
export function pumpCurvePrice(c: PumpCurve, decimals: number): number {
  if (c.virtualToken === 0n) throw new DecodeError("pump_reserves");
  return (Number(c.virtualQuote) / Number(c.virtualToken)) * 10 ** (decimals - 9);
}

export function pumpCurveMcap(c: PumpCurve): bigint {
  return c.virtualToken === 0n ? 0n : (c.virtualQuote * c.supply) / c.virtualToken;
}

/**
 * Graduation progress 0..1: the share of the curve's sellable tokens already bought, from the standard launch's
 * 793,100,000,000,000 real tokens. Null for a supply other than the standard 10^15 (a progress the curve cannot say).
 */
export function pumpCurveProgress(c: PumpCurve): number | null {
  if (c.complete) return 1;
  if (c.supply !== 1_000_000_000_000_000n) return null;
  const initial = 793_100_000_000_000n;
  if (c.realToken > initial) return 0;
  return Number(initial - c.realToken) / Number(initial);
}

export interface SellOut {
  /** Lamports the wallet receives (after every fee modelled). */
  outLamports: bigint;
  grossLamports: bigint;
  feeLamports: bigint;
  fees: PumpFees;
}

/** Selling `raw` tokens on the curve now (pure). Throws curve_complete, pump_* (unsupported), pump_reserves. */
export function pumpCurveSell(c: PumpCurve, raw: bigint, cfg: FeeConfig): SellOut {
  if (c.complete) throw new DecodeError("curve_complete");
  const why = pumpCurveUnsupported(c);
  if (why) throw new DecodeError(why);
  if (raw <= 0n) throw new DecodeError("pump_amount");
  const gross = (raw * c.virtualQuote) / (c.virtualToken + raw);
  if (gross > c.realQuote) throw new DecodeError("pump_reserves");
  const fees = feesAt(cfg, pumpCurveMcap(c));
  const fee = ceilBps(gross, fees.protocolBps) + ceilBps(gross, fees.creatorBps) + ceilBps(gross, fees.lpBps);
  return { outLamports: gross > fee ? gross - fee : 0n, grossLamports: gross, feeLamports: fee, fees };
}

export interface PumpPoolState {
  pool: PumpPool;
  /** The base vault's raw amount (the coin). */
  baseReserve: bigint;
  /** The quote vault's raw amount (real SOL in the pool). */
  quoteVault: bigint;
  /** The swap's quote reserve: quote vault + virtual_quote_reserves. */
  quoteReserve: bigint;
}

/** Why this pool's sell of `mint` cannot be modelled, or null. */
export function pumpPoolUnsupported(p: PumpPool, mint: string): string | null {
  if (p.baseMint !== mint) return "pump_pool_mismatch";
  if (p.quoteMint !== WSOL) return "pump_quote_not_sol";
  if (p.mayhem) return "pump_mayhem";
  return null;
}

/** The pool with its vault balances read (checks the vaults are the pool's and hold the right mints). */
export function pumpPoolState(p: PumpPool, base: { mint: string; amount: bigint }, quote: { mint: string; amount: bigint }): PumpPoolState {
  if (base.mint !== p.baseMint || quote.mint !== p.quoteMint) throw new DecodeError("vault_mismatch");
  const q = quote.amount + p.virtualQuote;
  if (base.amount === 0n || q <= 0n) throw new DecodeError("pump_reserves");
  return { pool: p, baseReserve: base.amount, quoteVault: quote.amount, quoteReserve: q };
}

export function pumpPoolPrice(s: PumpPoolState, decimals: number): number {
  return (Number(s.quoteReserve) / Number(s.baseReserve)) * 10 ** (decimals - 9);
}

export function pumpPoolMcap(s: PumpPoolState, supply: bigint): bigint {
  return (s.quoteReserve * supply) / s.baseReserve;
}

/** Selling `raw` of the pool's base coin now (pure). `supply` is the coin's supply (for the fee tier). */
export function pumpPoolSell(s: PumpPoolState, mint: string, raw: bigint, supply: bigint, cfg: FeeConfig): SellOut {
  const why = pumpPoolUnsupported(s.pool, mint);
  if (why) throw new DecodeError(why);
  if (raw <= 0n) throw new DecodeError("pump_amount");
  const gross = (raw * s.quoteReserve) / (s.baseReserve + raw);
  if (gross > s.quoteVault) throw new DecodeError("pump_reserves");
  const tier = feesAt(cfg, pumpPoolMcap(s, supply));
  // A pool with no coin creator set pays no creator fee (not checked on a real sell: every fixture pool has one).
  const fees = s.pool.coinCreator === SYSTEM ? { ...tier, creatorBps: 0n } : tier;
  const fee = ceilBps(gross, fees.lpBps) + ceilBps(gross, fees.protocolBps) + ceilBps(gross, fees.creatorBps);
  return { outLamports: gross > fee ? gross - fee : 0n, grossLamports: gross, feeLamports: fee, fees };
}

export { TOKEN_PROGRAM, TOKEN_2022 };
