/**
 * (batch 6) The EVM TEE wallet a key trades perps from: its row in Candle's list of the key's trading wallets
 * (GET /api/v1/agent/wallets/trading, every page), with the key's prefix and Candle's Privy app id from the same
 * answer. Config pins (walletId, privyWalletId, privyAppId) must match.
 */
import { CandleClient, type SecretStore } from "@candledottv/agent-sdk";
import type { ResolvedWallet } from "../exec/trader.ts";

export async function resolvePerpsWallet(o: { apiUrl: string; address: string; walletId?: string; privyWalletId?: string; privyAppId?: string }, apiKey: string, f: typeof fetch = fetch): Promise<ResolvedWallet & { address: string }> {
  const get = async (path: string) => {
    const r = await f(o.apiUrl + path, { headers: { "x-api-key": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`GET ${path.split("?")[0]}: HTTP ${r.status}`);
    return (await r.json()) as any;
  };
  const want = o.address.toLowerCase();
  const rows: any[] = [];
  let head: any = null;
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const body = await get(`/api/v1/agent/wallets/trading${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    head ??= body;
    rows.push(...(body.page ?? []));
    if (body.isDone !== false || !body.continueCursor) break;
    cursor = body.continueCursor;
  }
  const row = rows.find((r) => r.chain === "evm" && typeof r.address === "string" && r.address.toLowerCase() === want && r.active !== false);
  if (!row) throw new Error(`perps wallet ${o.address} is not an EVM TEE wallet this API key can trade from (GET /api/v1/agent/wallets/trading)`);
  const id = row.id ?? row._id;
  if (!id || !row.privyWalletId) throw new Error(`perps wallet ${o.address}: Candle returned no wallet id or Privy wallet id`);
  const appId = head?.privyAppId ?? o.privyAppId;
  if (!appId) throw new Error("Candle returned no privyAppId for this key; set perps.privyAppId");
  if (o.privyAppId && o.privyAppId !== appId) throw new Error("perps.privyAppId does not match the one Candle returns for this key");
  if (o.walletId && o.walletId !== id) throw new Error("perps.walletId does not match the wallet's row");
  if (o.privyWalletId && o.privyWalletId !== row.privyWalletId) throw new Error("perps.privyWalletId does not match the wallet's row");
  return { linkedWalletId: id, privyWalletId: row.privyWalletId, keyPrefix: String(head?.keyPrefix ?? ""), privyAppId: appId, signerQuorumId: row.signerQuorumId ?? null, address: want };
}

/** A Candle client for perps orders: the key, the signer store, Candle's Privy app id and the Hyperliquid network. */
export function perpsClient(o: { apiUrl: string; apiKey: string; privyAppId: string; secretStore: SecretStore; network: "mainnet" | "testnet"; fetch: typeof fetch }): CandleClient {
  return new CandleClient({ apiUrl: o.apiUrl, apiKey: o.apiKey, privyAppId: o.privyAppId, secretStore: o.secretStore, fetch: o.fetch, hyperliquidNetwork: o.network });
}
