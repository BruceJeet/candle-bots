/**
 * (batch 4) A followed wallet's position in each coin, from its trades as the wallet source saw them, and what each
 * trade means for a copy:
 *
 *   open    a buy while the wallet held at most `openDustPct` % of what it holds after (its first buy, or a buy from
 *           flat). Only opens are copied by default: a buy into a bag the wallet already held is an `add`.
 *   add     a buy into a bag it held.
 *   reduce  a sell that leaves tokens: `fraction` = sold / held before.
 *   close   a sell that leaves nothing (fraction 1).
 *
 * Held before comes from the transaction itself (the wallet's token accounts it lists, before the trade) whenever it
 * has one, and from the trades seen otherwise. The two are compared: a difference means the wallet moved tokens in a
 * way the source did not see as a trade (a transfer, a trade the source missed, a second token account); the move says
 * `tracked: false` and the chain figure is used. A sell whose transaction shows nothing left is always a close.
 *
 * State is plain data (toJSON / fromJSON) so a bot can keep it in its ledger.
 */
import type { WalletTrade } from "../market/walletTrade.ts";

export interface LeaderHolding {
  /** Raw tokens the wallet holds by the last trade seen. */
  heldRaw: bigint;
  /** Bought and sold since its last open (raw tokens, lamports). */
  boughtRaw: bigint;
  soldRaw: bigint;
  solInRaw: bigint;
  solOutRaw: bigint;
  /** Signature and time (ms) of the last open; null before one. */
  openSignature: string | null;
  openedAtMs: number | null;
  /** Signature of the last trade applied (a trade is applied once). */
  lastSignature: string;
  lastSlot: number;
}

export interface LeaderMove {
  kind: "open" | "add" | "reduce" | "close";
  wallet: string;
  mint: string;
  /** For reduce and close: share of the wallet's holding sold (0 < f <= 1). */
  fraction: number | null;
  heldBeforeRaw: bigint;
  heldAfterRaw: bigint;
  /** False when the seen trades did not add up to the transaction's own before-balance (the chain figure was used). */
  tracked: boolean;
  /** The trade was applied before (same signature): nothing changed. */
  repeat: boolean;
}

export interface LeaderBookOptions {
  /** A buy is an open when the wallet held at most this share (%) of its holding after the buy (default 1). */
  openDustPct?: number;
}

const key = (wallet: string, mint: string) => `${wallet}:${mint}`;

export class LeaderBook {
  private book = new Map<string, LeaderHolding>();
  private openDustPct: number;

  constructor(o: LeaderBookOptions = {}) {
    this.openDustPct = o.openDustPct ?? 1;
    if (!(this.openDustPct >= 0 && this.openDustPct < 100)) throw new Error("openDustPct must be in [0, 100)");
  }

  holding(wallet: string, mint: string): Readonly<LeaderHolding> | undefined {
    return this.book.get(key(wallet, mint));
  }

  /** Apply one trade (in any order; a repeat is a no-op). */
  apply(t: Pick<WalletTrade, "wallet" | "mint" | "side" | "tokenRaw" | "solRaw" | "heldBeforeRaw" | "heldAfterRaw" | "signature" | "slot" | "blockTime">): LeaderMove {
    const k = key(t.wallet, t.mint);
    const h = this.book.get(k);
    if (h && h.lastSignature === t.signature) {
      return { kind: t.side === "buy" ? "add" : t.heldAfterRaw === 0n ? "close" : "reduce", wallet: t.wallet, mint: t.mint, fraction: null, heldBeforeRaw: t.heldBeforeRaw, heldAfterRaw: t.heldAfterRaw, tracked: true, repeat: true };
    }
    const tracked = h ? h.heldRaw : 0n;
    // The transaction's own figures: before = after -/+ the trade.
    const before = t.heldBeforeRaw;
    const after = t.heldAfterRaw;
    const consistent = tracked === before;
    const cur: LeaderHolding = h ?? { heldRaw: 0n, boughtRaw: 0n, soldRaw: 0n, solInRaw: 0n, solOutRaw: 0n, openSignature: null, openedAtMs: null, lastSignature: "", lastSlot: 0 };
    let kind: LeaderMove["kind"];
    let fraction: number | null = null;
    if (t.side === "buy") {
      // An open: what it held before is dust against what it holds after.
      const isOpen = before * 10_000n <= after * BigInt(Math.round(this.openDustPct * 100));
      kind = isOpen ? "open" : "add";
      if (isOpen) {
        cur.boughtRaw = 0n;
        cur.soldRaw = 0n;
        cur.solInRaw = 0n;
        cur.solOutRaw = 0n;
        cur.openSignature = t.signature;
        cur.openedAtMs = t.blockTime !== null ? t.blockTime * 1000 : null;
      }
      cur.boughtRaw += t.tokenRaw;
      cur.solInRaw += t.solRaw;
    } else {
      cur.soldRaw += t.tokenRaw;
      cur.solOutRaw += t.solRaw;
      if (after === 0n) {
        kind = "close";
        fraction = 1;
      } else {
        kind = "reduce";
        const base = before > 0n ? before : tracked;
        fraction = base > 0n ? Math.min(1, Number((t.tokenRaw * 1_000_000n) / base) / 1_000_000) : 1;
        if (!(fraction > 0)) fraction = 1e-6;
      }
    }
    cur.heldRaw = after;
    cur.lastSignature = t.signature;
    cur.lastSlot = Math.max(cur.lastSlot, t.slot);
    this.book.set(k, cur);
    return { kind, wallet: t.wallet, mint: t.mint, fraction, heldBeforeRaw: before, heldAfterRaw: after, tracked: consistent, repeat: false };
  }

  toJSON(): Record<string, Record<string, string | number | null>> {
    const out: Record<string, Record<string, string | number | null>> = {};
    for (const [k, h] of this.book) out[k] = { heldRaw: h.heldRaw.toString(), boughtRaw: h.boughtRaw.toString(), soldRaw: h.soldRaw.toString(), solInRaw: h.solInRaw.toString(), solOutRaw: h.solOutRaw.toString(), openSignature: h.openSignature, openedAtMs: h.openedAtMs, lastSignature: h.lastSignature, lastSlot: h.lastSlot };
    return out;
  }

  static fromJSON(j: unknown, o: LeaderBookOptions = {}): LeaderBook {
    const b = new LeaderBook(o);
    if (!j || typeof j !== "object") return b;
    for (const [k, v] of Object.entries(j as Record<string, any>)) {
      if (!v || typeof v !== "object") continue;
      b.book.set(k, { heldRaw: BigInt(v.heldRaw ?? 0), boughtRaw: BigInt(v.boughtRaw ?? 0), soldRaw: BigInt(v.soldRaw ?? 0), solInRaw: BigInt(v.solInRaw ?? 0), solOutRaw: BigInt(v.solOutRaw ?? 0), openSignature: v.openSignature ?? null, openedAtMs: v.openedAtMs ?? null, lastSignature: String(v.lastSignature ?? ""), lastSlot: Number(v.lastSlot ?? 0) });
    }
    return b;
  }
}
