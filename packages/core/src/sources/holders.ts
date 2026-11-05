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
  /** The slot the largest-accounts answer was read at (its context), when the RPC said. */
  slot?: number | null;
}

/** A wallet's holding with the slot it was read at (null when the RPC did not say). */
export interface BalanceAt {
  amount: bigint;
  slot: number | null;
}

export interface HolderSource {
  snapshot(mint: string): Promise<HolderSnapshot>;
  balanceOf(owner: string, mint: string): Promise<bigint | null>;
  /** The holding and the slot it was read at (a source that cannot say the slot may leave this out). */
  balanceAt?(owner: string, mint: string): Promise<BalanceAt | null>;
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
    // Bounded: a long run over many coins does not grow the cache forever (owners are read again after a clear).
    if (this.owners.size > 50_000) this.owners.clear();
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
    const slot = typeof largest?.context?.slot === "number" ? largest.context.slot : null;
    return { mint, atMs: this.now(), holders, supply: BigInt(supplyRaw), slot };
  }

  balanceOf(owner: string, mint: string): Promise<bigint | null> {
    return tokenBalance(this.rpc, owner, mint);
  }

  /** Every token account the owner holds for the mint, summed, with the answer's slot. Null when the read fails. */
  async balanceAt(owner: string, mint: string): Promise<BalanceAt | null> {
    try {
      const r = await this.rpc.call<any>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      if (!r || !Array.isArray(r.value)) return null;
      let sum = 0n;
      for (const a of r.value) {
        const amt = a?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (typeof amt !== "string" || !/^\d+$/.test(amt)) return null;
        sum += BigInt(amt);
      }
      return { amount: sum, slot: typeof r.context?.slot === "number" ? r.context.slot : null };
    } catch {
      return null;
    }
  }
}

/** A read on the way to a coin's creator failed: try again later (not the same as "no creator"). */
export class CreatorReadError extends Error {}

/**
 * A coin's creator from chain: a pump.fun coin's curve names it (`creator`). Otherwise the fee payer of the mint's
 * oldest successful transaction (its launch), paged back through the mint's history (at most `pages` pages of 1000).
 * Null when there is none to find (no history, or one longer than the cap). A read that fails throws CreatorReadError:
 * a failed curve read never falls through to the fee-payer path.
 */
export async function creatorOf(rpc: Rpc, mint: string, pages = 10): Promise<{ creator: string; source: "pump-curve" | "first-tx" } | null> {
  let v: any;
  try {
    v = (await rpc.call<any>("getAccountInfo", [pumpCurve(mint), { encoding: "base64", commitment: "confirmed" }]))?.value;
  } catch (e) {
    throw new CreatorReadError(`pump curve read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
  if (v) {
    let c: ReturnType<typeof decodePumpCurve> | null = null;
    try {
      c = decodePumpCurve(v);
    } catch {
      c = null; // an account at that address that is not a pump curve: the launch transaction below
    }
    if (c && c.creator && c.creator !== "11111111111111111111111111111111") return { creator: c.creator, source: "pump-curve" };
  }
  let before: string | undefined;
  let lastPage: any[] = [];
  let reachedStart = false;
  for (let i = 0; i < pages; i++) {
    let list: any[];
    try {
      list = (await rpc.call<any[]>("getSignaturesForAddress", [mint, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }])) ?? [];
    } catch (e) {
      throw new CreatorReadError(`history read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
    if (!Array.isArray(list)) throw new CreatorReadError("history read: bad response");
    if (!list.length) {
      reachedStart = true; // an exact multiple of 1000: the empty page after the last full one
      break;
    }
    lastPage = list;
    before = list[list.length - 1].signature;
    if (list.length < 1000) {
      reachedStart = true;
      break;
    }
  }
  if (!reachedStart) return null; // never reached the start of the history within the cap
  // The oldest transaction that succeeded (a failed one touching the address may come first).
  const oldest = [...lastPage].reverse().find((x) => x && x.err == null)?.signature as string | undefined;
  if (!oldest) return null;
  let tx: any;
  try {
    tx = await rpc.call<any>("getTransaction", [oldest, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  } catch (e) {
    throw new CreatorReadError(`launch transaction read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
  if (!tx) throw new CreatorReadError("launch transaction not served yet");
  const k = tx?.transaction?.message?.accountKeys?.[0];
  const key = typeof k === "string" ? k : k?.pubkey;
  return typeof key === "string" ? { creator: key, source: "first-tx" } : null;
}
