/**
 * (0.5.0) A minimal holder poller: who holds a coin, polled (not streamed).
 *
 * One snapshot of a coin = `getTokenLargestAccounts(mint)` (the 20 largest token accounts) plus their owners
 * (`getMultipleAccounts`, jsonParsed, only for accounts not seen before: an account's owner is cached). Accounts whose
 * owner is off the ed25519 curve (a program-derived address: a bonding curve, a pool, a vault, a locker) are left out,
 * so the list is wallets. A wallet's several accounts are summed. `diff(prev, cur)` gives each owner's change.
 *
 * Lag: the poll interval plus the RPC's confirmed commitment (about a second). Cost per coin per poll: one
 * getTokenLargestAccounts, plus one getMultipleAccounts only when a new account shows up among the largest; a
 * creator's balance read is one getTokenAccountsByOwner. Wallets outside the 20 largest accounts are not seen.
 *
 * Batch 4's wallet watcher can replace this with a stream: the interface a rule needs is `HolderSource.snapshot(mint)`
 * and `balanceOf(owner, mint)`; a streamed source keeps its own state and answers the same two calls.
 */
import { b58decode } from "../solana/base58.ts";
import { onCurve, pumpCurve } from "../solana/pda.ts";
import { decodePumpCurve } from "../market/pump.ts";
import { tokenBalance, type Rpc } from "../solana/rpc.ts";

export interface Holder {
  owner: string;
  amount: bigint;
}

export interface HolderSnapshot {
  mint: string;
  atMs: number;
  /** Wallets among the largest accounts, largest first (program-owned accounts left out). */
  holders: Holder[];
  /** The mint's supply in raw units, as getTokenLargestAccounts' context could not say: from getTokenSupply. */
  supply: bigint;
}

export interface HolderSource {
  snapshot(mint: string): Promise<HolderSnapshot>;
  balanceOf(owner: string, mint: string): Promise<bigint | null>;
}

/** Each owner's change from `prev` to `cur` (owners in either; an owner gone from the list counts as 0 now). */
export function holderDiff(prev: HolderSnapshot, cur: HolderSnapshot): Map<string, { before: bigint; after: bigint; delta: bigint }> {
  const out = new Map<string, { before: bigint; after: bigint; delta: bigint }>();
  const b = new Map(prev.holders.map((h) => [h.owner, h.amount]));
  const a = new Map(cur.holders.map((h) => [h.owner, h.amount]));
  for (const o of new Set([...b.keys(), ...a.keys()])) {
    const before = b.get(o) ?? 0n;
    // An owner that dropped out of the largest list: its balance is unknown, not zero. Left out of the diff.
    if (!a.has(o)) continue;
    const after = a.get(o)!;
    out.set(o, { before, after, delta: after - before });
  }
  return out;
}

export class HolderPoller implements HolderSource {
  private rpc: Rpc;
  private now: () => number;
  private owners = new Map<string, string>();

  constructor(rpc: Rpc, now: () => number = Date.now) {
    this.rpc = rpc;
    this.now = now;
  }

  async snapshot(mint: string): Promise<HolderSnapshot> {
    const largest = await this.rpc.call<any>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
    // A malformed answer is a failed read (unknown), never "nobody holds it": the rules would read every holder as gone.
    if (!Array.isArray(largest?.value)) throw new Error("holder largest accounts: bad response");
    const rows: Array<{ address: string; amount: string }> = largest.value;
    const unknown = rows.map((r) => r.address).filter((a) => typeof a === "string" && !this.owners.has(a));
    if (unknown.length) {
      const r = await this.rpc.call<any>("getMultipleAccounts", [unknown, { encoding: "jsonParsed", commitment: "confirmed" }]);
      const vals = r?.value;
      if (!Array.isArray(vals) || vals.length !== unknown.length) throw new Error("holder owners: bad response");
      unknown.forEach((a, i) => {
        const owner = vals[i]?.data?.parsed?.info?.owner;
        if (typeof owner === "string") this.owners.set(a, owner);
      });
    }
    const sup = await this.rpc.call<any>("getTokenSupply", [mint, { commitment: "confirmed" }]);
    const supplyRaw = sup?.value?.amount;
    if (typeof supplyRaw !== "string" || !/^\d+$/.test(supplyRaw)) throw new Error("holder supply: bad response");
    const by = new Map<string, bigint>();
    for (const r of rows) {
      const owner = this.owners.get(r.address);
      if (!owner || typeof r.amount !== "string" || !/^\d+$/.test(r.amount)) continue;
      let wallet: boolean;
      try {
        wallet = onCurve(b58decode(owner));
      } catch {
        wallet = false;
      }
      if (!wallet) continue;
      by.set(owner, (by.get(owner) ?? 0n) + BigInt(r.amount));
    }
    const holders = [...by].map(([owner, amount]) => ({ owner, amount })).sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));
    return { mint, atMs: this.now(), holders, supply: BigInt(supplyRaw) };
  }

  balanceOf(owner: string, mint: string): Promise<bigint | null> {
    return tokenBalance(this.rpc, owner, mint);
  }
}

/**
 * A coin's creator from chain: a pump.fun coin's curve names it (`creator`). Otherwise the fee payer of the mint's
 * oldest transaction (its launch), paged back through the mint's history (at most `pages` pages of 1000). Null when it
 * cannot be found (a history longer than the cap, a read that fails).
 */
export async function creatorOf(rpc: Rpc, mint: string, pages = 10): Promise<{ creator: string; source: "pump-curve" | "first-tx" } | null> {
  try {
    const v = (await rpc.call<any>("getAccountInfo", [pumpCurve(mint), { encoding: "base64", commitment: "confirmed" }]))?.value;
    if (v) {
      const c = decodePumpCurve(v);
      if (c.creator && c.creator !== "11111111111111111111111111111111") return { creator: c.creator, source: "pump-curve" };
    }
  } catch {
    /* not a pump coin, or unreadable: the launch transaction below */
  }
  let before: string | undefined;
  let oldest: string | null = null;
  for (let i = 0; i < pages; i++) {
    let list: any[];
    try {
      list = (await rpc.call<any[]>("getSignaturesForAddress", [mint, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }])) ?? [];
    } catch {
      return null;
    }
    if (!list.length) break;
    oldest = list[list.length - 1].signature;
    before = oldest ?? undefined;
    if (list.length < 1000) {
      before = undefined;
      break;
    }
  }
  if (!oldest || before) return null; // never reached the start of the history
  try {
    const tx = await rpc.call<any>("getTransaction", [oldest, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    const k = tx?.transaction?.message?.accountKeys?.[0];
    const key = typeof k === "string" ? k : k?.pubkey;
    return typeof key === "string" ? { creator: key, source: "first-tx" } : null;
  } catch {
    return null;
  }
}
