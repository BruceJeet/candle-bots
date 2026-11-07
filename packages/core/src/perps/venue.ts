/**
 * (batch 6) A perps venue as a bot sees it: market reads, the account's positions, orders by client id, and the
 * fills and funding the account was charged. Two implementations ship: `SdkPerpsVenue` (Hyperliquid through the
 * Candle SDK: every order is built, checked, signed and submitted by the SDK) and `PaperPerpsVenue` (dry runs: real
 * public market reads, paper positions). Tests use a scripted fake with the same interface.
 *
 * Sizes are decimal strings in the coin (Hyperliquid's wire form); positions are signed numbers (negative: short).
 */

export type PerpNetwork = "mainnet" | "testnet";

export interface PerpMarket {
  coin: string;
  /** The market's index in the venue's perp universe (differs by network: never pinned). */
  asset: number;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  delisted: boolean;
  /** Mark price in USD, null when the venue gave none. */
  markPx: number | null;
  midPx: number | null;
  /** The hourly funding rate (positive: longs pay shorts). */
  fundingRate: number | null;
}

export interface PerpPosition {
  coin: string;
  /** Signed size in the coin: negative is short. */
  szi: number;
  entryPx: number | null;
  unrealizedPnl: number | null;
  leverage: { type: "cross" | "isolated"; value: number } | null;
}

export interface PerpAccount {
  readAt: number;
  accountValueUsd: number | null;
  marginUsedUsd: number | null;
  positions: PerpPosition[];
}

export interface PerpOrderRequest {
  coin: string;
  /** short sells, long buys. A close names the side that reduces the position (long closes a short). */
  side: "long" | "short";
  /** null on a close: the whole position. */
  size: string | null;
  /** Every close is reduce-only (the venue's close); opens never are. */
  reduceOnly: boolean;
  /** 0x + 32 hex: the order's cloid, and the SDK's idempotency id. */
  clientId: string;
  slippageBps: number;
}

/**
 * What a submitted order came to:
 *  - filled: the venue filled `filledSz` (maybe less than asked: an IOC's remainder is cancelled) at `avgPx`;
 *  - rejected: the venue or Candle refused it, nothing filled;
 *  - unknown: no clear answer (a timeout, a submit that failed after signing, a leg the SDK could not judge). The
 *    caller must reconcile by client id (`orderStatus`) before it acts on that coin again.
 */
export type PerpOrderResult =
  | { status: "filled"; oid: number | null; filledSz: string; avgPx: number | null; raw?: unknown }
  | { status: "rejected"; error: string; raw?: unknown }
  | { status: "unknown"; error: string; raw?: unknown };

/** The venue's record of an order by client id. `unknownOid`: the venue never saw it. */
export type PerpOrderStatus =
  | { found: true; oid: number; status: string; filledSz: string; avgPx: number | null; side: "long" | "short"; coin: string }
  | { found: false };

export interface PerpFill {
  tid: number;
  oid: number;
  coin: string;
  px: number;
  /** Unsigned size; `side` says which way. */
  sz: number;
  side: "long" | "short";
  time: number;
  /** USD, the builder fee included (Hyperliquid's own `fee`). */
  fee: number;
  builderFee: number;
  closedPnl: number;
}

export interface PerpFunding {
  time: number;
  coin: string;
  /** Signed USD: negative was paid, positive received. */
  usdc: number;
  szi: number;
  rate: number;
}

export interface PerpsVenue {
  readonly network: PerpNetwork;
  readonly kind: "live" | "paper" | "fake";
  markets(): Promise<Map<string, PerpMarket>>;
  account(): Promise<PerpAccount>;
  open(req: PerpOrderRequest): Promise<PerpOrderResult>;
  close(req: PerpOrderRequest): Promise<PerpOrderResult>;
  /** Set the coin's leverage and margin mode. Throws when refused. */
  setLeverage(coin: string, leverage: number, mode: "cross" | "isolated"): Promise<void>;
  orderStatus(clientId: string): Promise<PerpOrderStatus>;
  /** Fills and funding from `sinceMs` to now, oldest first. */
  fills(sinceMs: number): Promise<PerpFill[]>;
  funding(sinceMs: number): Promise<PerpFunding[]>;
}

/** A fresh client id: 0x + 32 lowercase hex. */
export function newClientId(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return "0x" + Buffer.from(rand(16)).toString("hex");
}

export const CLIENT_ID_RE = /^0x[0-9a-f]{32}$/;

/** `x` rounded toward zero at `decimals`, as a wire decimal ("0" when it rounds to nothing). */
export function floorSize(x: number, decimals: number): string {
  if (!Number.isFinite(x) || x <= 0) return "0";
  const f = 10 ** decimals;
  // A hair over the float error so 0.29999999 at 2 decimals stays 0.29, and 0.3 (stored 0.29999...) stays 0.3.
  const n = Math.floor(x * f * (1 + 1e-12));
  if (n <= 0) return "0";
  const s = (n / f).toFixed(decimals);
  return decimals ? s.replace(/\.?0+$/, "") : s;
}

/** One size step of a market (its smallest size). */
export function sizeStep(szDecimals: number): number {
  return 10 ** -szDecimals;
}

/** Parse a decimal string or number the venue sent; null when it is not a finite number. */
export function dec(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
