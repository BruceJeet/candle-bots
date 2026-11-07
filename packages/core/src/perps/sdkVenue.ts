/**
 * (batch 6) Hyperliquid through the Candle SDK. Orders: `perpsOpen` / `perpsClose` / `perpsLeverage` only (Candle
 * builds, the SDK checks the build against its own read of Hyperliquid, Candle's relay signs, the SDK submits): this
 * file never calls Hyperliquid's /exchange itself. Reads: Hyperliquid's public /info (fills and funding through the
 * SDK's `readPerpsHistoryPage`; markets, the account and an order's status by its client id as plain /info reads).
 * Reads need no key.
 */
import { HYPERLIQUID_EXCHANGE_URLS, readPerpsHistoryPage, type CandleClient, type PerpsActionResult, type PerpsReplayResult } from "@candledottv/agent-sdk";
import { dec, type PerpAccount, type PerpFill, type PerpFunding, type PerpMarket, type PerpNetwork, type PerpOrderRequest, type PerpOrderResult, type PerpOrderStatus, type PerpsVenue } from "./venue.ts";

export type InfoFetch = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

/** The perps calls the venue makes on a CandleClient (so a test can hand in its own). */
export type PerpsClient = Pick<CandleClient, "perpsOpen" | "perpsClose" | "perpsLeverage">;

export interface SdkVenueOptions {
  network: PerpNetwork;
  /** The EVM TEE wallet: its address (the Hyperliquid account), Candle's row id and its Privy wallet id. */
  address: string;
  walletId: string;
  privyWalletId: string;
  /** A CandleClient made with the key, the signer store, privyAppId and `hyperliquidNetwork: network`. */
  client: PerpsClient;
  /** For /info reads (a timed fetch). */
  fetch: InfoFetch;
  now?: () => number;
}

/** Hyperliquid's public /info per network (the SDK's own exchange URL with /info, as the SDK derives it). */
export const INFO_URLS: Readonly<Record<PerpNetwork, string>> = Object.freeze({
  mainnet: HYPERLIQUID_EXCHANGE_URLS.mainnet.replace(/\/exchange$/, "/info"),
  testnet: HYPERLIQUID_EXCHANGE_URLS.testnet.replace(/\/exchange$/, "/info"),
});

export async function infoPost(fetchFn: InfoFetch, network: PerpNetwork, body: Record<string, unknown>): Promise<any> {
  const r = await fetchFn(INFO_URLS[network], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`hyperliquid info ${String(body.type)}: HTTP ${r.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`hyperliquid info ${String(body.type)}: not JSON`);
  }
}

/** metaAndAssetCtxs -> markets by coin name (asset = the index in the universe). Throws on a shape it cannot read. */
export function parseMarkets(body: any): Map<string, PerpMarket> {
  if (!Array.isArray(body) || body.length < 2 || !Array.isArray(body[0]?.universe) || !Array.isArray(body[1])) throw new Error("hyperliquid metaAndAssetCtxs: unexpected shape");
  const [meta, ctxs] = body;
  const out = new Map<string, PerpMarket>();
  meta.universe.forEach((u: any, asset: number) => {
    if (typeof u?.name !== "string" || !Number.isInteger(u.szDecimals) || !(Number(u.maxLeverage) > 0)) throw new Error("hyperliquid metaAndAssetCtxs: unreadable market");
    const c = ctxs[asset] ?? {};
    out.set(u.name, {
      coin: u.name,
      asset,
      szDecimals: u.szDecimals,
      maxLeverage: Number(u.maxLeverage),
      onlyIsolated: u.onlyIsolated === true,
      delisted: u.isDelisted === true,
      markPx: dec(c.markPx),
      midPx: dec(c.midPx),
      fundingRate: dec(c.funding),
    });
  });
  return out;
}

/** Markets by coin name, read now. */
export async function readPerpMarkets(fetchFn: InfoFetch, network: PerpNetwork): Promise<Map<string, PerpMarket>> {
  return parseMarkets(await infoPost(fetchFn, network, { type: "metaAndAssetCtxs" }));
}

/** clearinghouseState -> the account (main perps only). Throws on a shape it cannot read. */
export function parseClearinghouse(body: any, readAt: number): PerpAccount {
  if (!body || typeof body !== "object" || !Array.isArray(body.assetPositions)) throw new Error("hyperliquid clearinghouseState: unexpected shape");
  const positions = body.assetPositions.map((a: any) => {
    const p = a?.position;
    const szi = dec(p?.szi);
    if (!p || typeof p.coin !== "string" || szi === null) throw new Error("hyperliquid clearinghouseState: unreadable position");
    const lev = p.leverage && (p.leverage.type === "cross" || p.leverage.type === "isolated") && Number.isFinite(Number(p.leverage.value)) ? { type: p.leverage.type, value: Number(p.leverage.value) } : null;
    return { coin: p.coin, szi, entryPx: dec(p.entryPx), unrealizedPnl: dec(p.unrealizedPnl), leverage: lev };
  });
  return { readAt, accountValueUsd: dec(body.marginSummary?.accountValue), marginUsedUsd: dec(body.marginSummary?.totalMarginUsed), positions };
}

/** One order leg of an SDK action result -> what the order came to. */
export function resultOf(r: PerpsActionResult | PerpsReplayResult): PerpOrderResult {
  if ((r as PerpsReplayResult).replayed === true) {
    // Never expected (each order gets a new client id); the replay names Candle's record, not a fill: reconcile.
    const rep = (r as PerpsReplayResult).replay;
    return { status: "unknown", error: `replayed: Candle already holds this client id (status ${rep.status}, venue ${rep.venueStatus ?? "unread"})`, raw: rep };
  }
  const a = r as PerpsActionResult;
  if (!a.submitted) return { status: "unknown", error: `not submitted${a.submitError ? `: ${a.submitError}` : ""}`, ...(a.signature ? { signed: true } : {}) };
  const o = a.outcome;
  if (!o || o.status === "unknown") return { status: "unknown", error: o && "error" in o ? o.error : "no outcome", raw: a.exchange };
  if (o.status === "rejected") return { status: "rejected", error: o.error, raw: a.exchange };
  const leg: any = o.legs[0];
  if (leg && typeof leg === "object" && leg.filled) {
    const sz = dec(leg.filled.totalSz);
    if (sz === null) return { status: "unknown", error: "filled leg without a size", raw: a.exchange };
    return { status: "filled", oid: Number.isSafeInteger(leg.filled.oid) ? leg.filled.oid : null, filledSz: String(leg.filled.totalSz), avgPx: dec(leg.filled.avgPx), raw: a.exchange };
  }
  // A market (IOC) order that rests is not expected; anything else is reconciled by its client id.
  return { status: "unknown", error: `order leg ${JSON.stringify(leg ?? null).slice(0, 200)}`, raw: a.exchange };
}

/** Hyperliquid's orderStatus answer -> the order's record (filled size = original less what is left). */
export function parseOrderStatus(body: any): PerpOrderStatus {
  if (body?.status === "unknownOid") return { found: false };
  const rec = body?.order;
  const o = rec?.order;
  if (body?.status !== "order" || !o) throw new Error("hyperliquid orderStatus: unexpected shape");
  const orig = dec(o.origSz);
  const left = dec(o.sz);
  if (orig === null || left === null || !Number.isSafeInteger(o.oid)) throw new Error("hyperliquid orderStatus: unreadable order");
  const filled = Math.max(0, orig - left);
  return { found: true, oid: o.oid, status: String(rec.status), filledSz: String(+filled.toPrecision(12)), avgPx: null, side: o.side === "B" ? "long" : "short", coin: String(o.coin) };
}

export class SdkPerpsVenue implements PerpsVenue {
  readonly kind = "live" as const;
  readonly network: PerpNetwork;
  private o: SdkVenueOptions;
  private now: () => number;

  constructor(o: SdkVenueOptions) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(o.address)) throw new Error("perps wallet: not an EVM address");
    this.o = { ...o, address: o.address.toLowerCase() };
    this.network = o.network;
    this.now = o.now ?? Date.now;
  }

  markets() {
    return readPerpMarkets(this.o.fetch, this.network);
  }

  async account(): Promise<PerpAccount> {
    return parseClearinghouse(await infoPost(this.o.fetch, this.network, { type: "clearinghouseState", user: this.o.address }), this.now());
  }

  private ref() {
    return { walletId: this.o.walletId, privyWalletId: this.o.privyWalletId };
  }

  async open(req: PerpOrderRequest): Promise<PerpOrderResult> {
    if (req.reduceOnly || req.size === null) throw new Error("open: an open has a size and is never reduce-only");
    try {
      return resultOf(await this.o.client.perpsOpen({ ...this.ref(), coin: req.coin, side: req.side, size: req.size, type: "market", slippageBps: req.slippageBps, clientId: req.clientId }));
    } catch (e) {
      return { status: "unknown", error: String((e as Error)?.message ?? e).slice(0, 500) };
    }
  }

  async close(req: PerpOrderRequest): Promise<PerpOrderResult> {
    if (!req.reduceOnly) throw new Error("close: a close is reduce-only");
    try {
      return resultOf(await this.o.client.perpsClose({ ...this.ref(), coin: req.coin, ...(req.size !== null ? { size: req.size } : {}), slippageBps: req.slippageBps, clientId: req.clientId }));
    } catch (e) {
      return { status: "unknown", error: String((e as Error)?.message ?? e).slice(0, 500) };
    }
  }

  async setLeverage(coin: string, leverage: number, mode: "cross" | "isolated"): Promise<void> {
    const r = await this.o.client.perpsLeverage({ ...this.ref(), coin, leverage, mode });
    const res = resultOf(r);
    if (r.outcome?.status !== "confirmed") throw new Error(`leverage ${coin} ${leverage}x ${mode}: ${"error" in res ? res.error : r.outcome?.status ?? "not submitted"}`);
  }

  async orderStatus(clientId: string): Promise<PerpOrderStatus> {
    return parseOrderStatus(await infoPost(this.o.fetch, this.network, { type: "orderStatus", user: this.o.address, oid: clientId }));
  }

  private async pages(kind: "fills" | "funding", sinceMs: number): Promise<any[]> {
    const rows: any[] = [];
    const endTime = this.now();
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page: any = await readPerpsHistoryPage({ kind, network: this.network, walletId: this.o.walletId, address: this.o.address, options: cursor ? { cursor } : { startTime: Math.min(sinceMs, endTime), endTime, limit: kind === "fills" ? 2000 : 500 }, fetch: this.o.fetch as any, now: this.now });
      rows.push(...(kind === "fills" ? page.fills : page.funding));
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return rows;
  }

  async fills(sinceMs: number): Promise<PerpFill[]> {
    return (await this.pages("fills", sinceMs)).map(parseFill).sort((a, b) => a.time - b.time || a.tid - b.tid);
  }

  async funding(sinceMs: number): Promise<PerpFunding[]> {
    return (await this.pages("funding", sinceMs)).map(parseFunding).sort((a, b) => a.time - b.time);
  }
}

export function parseFill(f: any): PerpFill {
  const px = dec(f.px), sz = dec(f.sz), fee = dec(f.fee);
  if (px === null || sz === null || fee === null || !Number.isSafeInteger(f.tid) || !Number.isSafeInteger(f.oid)) throw new Error("hyperliquid fill: unreadable row");
  return { tid: f.tid, oid: f.oid, coin: String(f.coin), px, sz, side: f.side === "B" ? "long" : "short", time: Number(f.time), fee, builderFee: dec(f.builderFee) ?? 0, closedPnl: dec(f.closedPnl) ?? 0 };
}

export function parseFunding(r: any): PerpFunding {
  const d = r?.delta;
  const usdc = dec(d?.usdc);
  if (!d || usdc === null || typeof d.coin !== "string") throw new Error("hyperliquid funding: unreadable row");
  return { time: Number(r.time), coin: d.coin, usdc, szi: dec(d.szi) ?? 0, rate: dec(d.fundingRate) ?? 0 };
}
