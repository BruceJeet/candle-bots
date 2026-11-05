/**
 * (0.6.0) pump.fun curve and PumpSwap trade events, decoded from a transaction's `Program data:` log lines (Anchor
 * `emit!`; the same bytes also ride a self-CPI inner instruction). Pure: no I/O.
 *
 * Layouts from the programs' on-chain Anchor IDLs (read Nov 5 2026, version 0.1.0):
 *  - pump `TradeEvent` (discriminator bdbc7fd34ee661ee): mint, sol_amount, token_amount, is_buy, user, timestamp, the
 *    four reserves after the trade, fees, creator, …, then variable-length fields (ix_name: string, shareholders: vec)
 *    and, on newer coins, quote_mint / quote_amount. The fixed prefix is decoded always; the tail only when present
 *    (an older, shorter event has no quote fields and is a SOL coin).
 *  - PumpSwap `BuyEvent` (67f4521f2cf57777) / `SellEvent` (3e2f370aa503dc2a): timestamp, base amount, the limit, user and
 *    pool reserves, quote amount, fees, pool, user, … The event names the POOL, not the coin: the caller maps the pool
 *    to its base mint from the pool account (never from the event).
 *
 * Trust: a `Program data:` line is accepted only while the innermost running program (from the log's `Program X invoke
 * [n]` / `Program X success|failed` lines) is the program that owns that event: pump for TradeEvent, PumpSwap for
 * Buy/SellEvent. Any program can log bytes that look like an event; only these programs' own frames count. A stack the
 * log cannot account for (an invoke depth that does not match, a return that is not the running program, `Log
 * truncated`) stops reading for the rest of that transaction. Pump also emits each event through a self-CPI (an inner
 * instruction); this reader uses the log copy only (a logs subscription carries no inner instructions), and the
 * self-CPI copy is ignored, so an event is never counted twice.
 *
 * Volume convention: the SOL (quote) that traded against the venue, fees excluded: the curve's `sol_amount`; the
 * pool's `quote_amount_in` (buy) or `quote_amount_out` (sell).
 */
import { b58encode } from "../solana/base58.ts";
import { PUMP_PROGRAM, PUMP_AMM_PROGRAM } from "../solana/pda.ts";

export const PUMP_TRADE_EVENT = Uint8Array.from([189, 219, 127, 211, 78, 230, 97, 238]);
export const PUMPSWAP_BUY_EVENT = Uint8Array.from([103, 244, 82, 31, 44, 245, 119, 119]);
export const PUMPSWAP_SELL_EVENT = Uint8Array.from([62, 47, 55, 10, 165, 3, 220, 42]);
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface CurveTrade {
  kind: "pump-curve";
  mint: string;
  side: "buy" | "sell";
  /** SOL (lamports) to or from the curve, fees excluded. */
  quoteAmount: bigint;
  /** The quote mint: WSOL for SOL coins (and every event too old to say); "" when the tail cannot be read (unknown). */
  quoteMint: string;
  tokenAmount: bigint;
  user: string;
  timestampSec: number;
  /** The curve after the trade. */
  virtualQuote: bigint;
  virtualToken: bigint;
  realQuote: bigint;
  realToken: bigint;
}

export interface PoolTrade {
  kind: "pumpswap";
  pool: string;
  side: "buy" | "sell";
  /** Coin (base) raw amount out (buy) or in (sell). */
  baseAmount: bigint;
  /** Quote (lamports for a SOL pool) in (buy) or out (sell), before the LP fee as the event states it. */
  quoteAmount: bigint;
  user: string;
  timestampSec: number;
  /** The pool's reserves the event reports (before the trade, as the program records them). */
  poolBase: bigint;
  poolQuote: bigint;
}

export type PumpTrade = CurveTrade | PoolTrade;

class Reader {
  b: Uint8Array;
  o: number;
  constructor(b: Uint8Array, o = 8) {
    this.b = b;
    this.o = o;
  }
  need(n: number): boolean {
    return this.o + n <= this.b.length;
  }
  u64(): bigint {
    if (!this.need(8)) throw new RangeError("short");
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.o, 8).getBigUint64(0, true);
    this.o += 8;
    return v;
  }
  i64(): bigint {
    if (!this.need(8)) throw new RangeError("short");
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.o, 8).getBigInt64(0, true);
    this.o += 8;
    return v;
  }
  u32(): number {
    if (!this.need(4)) throw new RangeError("short");
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.o, 4).getUint32(0, true);
    this.o += 4;
    return v;
  }
  bool(): boolean {
    if (!this.need(1)) throw new RangeError("short");
    return this.b[this.o++] !== 0;
  }
  key(): string {
    if (!this.need(32)) throw new RangeError("short");
    const v = b58encode(this.b.subarray(this.o, this.o + 32));
    this.o += 32;
    return v;
  }
  skip(n: number): void {
    if (!this.need(n)) throw new RangeError("short");
    this.o += n;
  }
}

const eq8 = (a: Uint8Array, d: Uint8Array) => a.length >= 8 && d.every((x, i) => a[i] === x);

/** One pump curve TradeEvent (null when the bytes are not one, or too short for its fixed prefix). */
export function decodeCurveTrade(b: Uint8Array): CurveTrade | null {
  if (!eq8(b, PUMP_TRADE_EVENT)) return null;
  const r = new Reader(b);
  try {
    const mint = r.key();
    const sol = r.u64();
    const tok = r.u64();
    const isBuy = r.bool();
    const user = r.key();
    const ts = r.i64();
    const vq = r.u64();
    const vt = r.u64();
    const rq = r.u64();
    const rt = r.u64();
    const t: CurveTrade = { kind: "pump-curve", mint, side: isBuy ? "buy" : "sell", quoteAmount: sol, quoteMint: WSOL_MINT, tokenAmount: tok, user, timestampSec: Number(ts), virtualQuote: vq, virtualToken: vt, realQuote: rq, realToken: rt };
    // The tail (newer events): fee_recipient, fee_bps, fee, creator, creator_fee_bps, creator_fee, track_volume,
    // total_unclaimed, total_claimed, current_sol_volume, last_update_ts, ix_name, mayhem_mode, cashback_bps, cashback,
    // buyback_bps, buyback_fee, shareholders, quote_mint, quote_amount, virtual_quote, real_quote.
    try {
      r.skip(32 + 8 + 8 + 32 + 8 + 8 + 1 + 8 + 8 + 8 + 8);
      const nameLen = r.u32();
      if (nameLen > 64) return { ...t, quoteMint: "" }; // a layout this reader does not know: the quote is unknown
      r.skip(nameLen);
      r.skip(1 + 8 + 8 + 8 + 8);
      const holders = r.u32();
      if (holders > 64) return { ...t, quoteMint: "" };
      r.skip(holders * 34);
      const quoteMint = r.key();
      const quoteAmount = r.u64();
      const vqq = r.u64();
      const rqq = r.u64();
      if (quoteMint !== WSOL_MINT && quoteMint !== "11111111111111111111111111111111") {
        // A coin quoted in another token: its own quote amount and reserves.
        return { ...t, quoteMint, quoteAmount, virtualQuote: vqq, realQuote: rqq };
      }
    } catch {
      /* an older, shorter event: no quote fields, a SOL coin */
    }
    return t;
  } catch {
    return null;
  }
}

/** One PumpSwap BuyEvent / SellEvent (null when the bytes are not one, or too short). */
export function decodePoolTrade(b: Uint8Array): PoolTrade | null {
  const buy = eq8(b, PUMPSWAP_BUY_EVENT);
  if (!buy && !eq8(b, PUMPSWAP_SELL_EVENT)) return null;
  const r = new Reader(b);
  try {
    const ts = r.i64();
    const base = r.u64();
    r.u64(); // max_quote_amount_in / min_quote_amount_out
    r.u64(); // user_base_token_reserves
    r.u64(); // user_quote_token_reserves
    const poolBase = r.u64();
    const poolQuote = r.u64();
    const quote = r.u64(); // quote_amount_in / quote_amount_out
    // buy: lp_fee_bps, lp_fee, protocol_fee_bps, protocol_fee, quote_amount_in_with_lp_fee, user_quote_amount_in
    // sell: lp_fee_bps, lp_fee, protocol_fee_bps, protocol_fee, quote_amount_out_without_lp_fee, user_quote_amount_out
    r.skip(6 * 8);
    const pool = r.key();
    const user = r.key();
    return { kind: "pumpswap", pool, side: buy ? "buy" : "sell", baseAmount: base, quoteAmount: quote, user, timestampSec: Number(ts), poolBase, poolQuote };
  } catch {
    return null;
  }
}

const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const RETURN = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed)/;

/**
 * Every pump curve and PumpSwap trade event in a transaction's logs, each from its own program's frame (a failed
 * transaction gives none; a forged line from any other frame is ignored).
 */
export function tradesFromLogs(logs: string[], err: unknown = null): PumpTrade[] {
  return readTrades(logs, err).trades;
}

/**
 * tradesFromLogs, and whether the log could be read to its end. `partial`: a `Log truncated`, or a stack the log cannot
 * account for, stopped the reading; trades after that point (a pump trade inside a long aggregator route) may be
 * missing, so the caller must treat that moment as unknown.
 */
export function readTrades(logs: string[], err: unknown = null): { trades: PumpTrade[]; partial: boolean } {
  if (err) return { trades: [], partial: false };
  const out: PumpTrade[] = [];
  const stack: string[] = [];
  const stop = () => ({ trades: out, partial: true });
  for (const l of logs) {
    const inv = INVOKE.exec(l);
    if (inv) {
      stack.push(inv[1]);
      if (stack.length !== Number(inv[2])) return stop(); // the depth the log claims is not the depth it shows
      continue;
    }
    const ret = RETURN.exec(l);
    if (ret) {
      if (stack[stack.length - 1] !== ret[1]) return stop(); // a return from a program that is not running
      stack.pop();
      continue;
    }
    if (l.startsWith("Log truncated")) return stop();
    if (!l.startsWith("Program data: ")) continue;
    const top = stack[stack.length - 1];
    if (top !== PUMP_PROGRAM && top !== PUMP_AMM_PROGRAM) continue;
    let b: Uint8Array;
    try {
      b = new Uint8Array(Buffer.from(l.slice(14), "base64"));
    } catch {
      continue;
    }
    const t = top === PUMP_PROGRAM ? decodeCurveTrade(b) : decodePoolTrade(b);
    if (t) out.push(t);
  }
  return { trades: out, partial: false };
}

/** SOL per whole token after a curve trade (virtual reserves), for a coin with `decimals`. */
export function curveTradePrice(t: CurveTrade, decimals = 6): number | null {
  if (t.virtualToken <= 0n) return null;
  return Number(t.virtualQuote) / 1e9 / (Number(t.virtualToken) / 10 ** decimals);
}
