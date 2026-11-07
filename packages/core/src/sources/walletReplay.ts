/**
 * (batch 4) Record a wallet source's fetched transactions and replay them: for tests, and to see what a bot would have
 * done on a past stretch of a wallet's trades before running it live.
 *
 *   new WalletSource({ ..., record: walletRecorder("wallets.jsonl") })   one JSON line per fetched transaction
 *   const rp = new ReplayWallets(text);  rp.seek(t)                      a WalletFeed: what the source had decoded by t
 *   replayWallets(text)                                                  every event, in order (decoded again)
 *
 * The replay decodes the recorded transactions with today's decoder (market/walletTrade), so a decoder change shows up
 * in a replay of an old recording. Gaps are not recorded: a replay is complete by construction (`complete: true`).
 */
import { appendFileSync } from "node:fs";
import { decodeWalletTrade } from "../market/walletTrade.ts";
import type { Anchor, RecordedTx, WalletEvent, WalletFeed, WalletGap, WalletSkip } from "./wallets.ts";

/** A recorder that appends one JSON line per fetched transaction to `path`. */
export function walletRecorder(path: string): (r: RecordedTx) => void {
  return (r) => appendFileSync(path, JSON.stringify(r) + "\n");
}

export function parseRecorded(text: string): RecordedTx[] {
  const out: RecordedTx[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as RecordedTx;
    if (typeof r.at !== "number" || typeof r.wallet !== "string" || typeof r.signature !== "string" || !r.tx) throw new Error("replay: a line is not a recorded transaction");
    out.push(r);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Every recorded transaction decoded again, in order: the trades and the skipped. */
export function replayWallets(text: string | RecordedTx[]): { events: WalletEvent[]; skipped: WalletSkip[] } {
  const recs = typeof text === "string" ? parseRecorded(text) : [...text].sort((a, b) => a.at - b.at);
  const events: WalletEvent[] = [];
  const skipped: WalletSkip[] = [];
  const seen = new Set<string>();
  for (const r of recs) {
    const k = `${r.wallet}:${r.signature}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const d = decodeWalletTrade(r.tx, r.wallet, r.signature);
    if (d.ok) events.push({ ...d.trade, complete: true, seenAtMs: r.at, via: "replay" });
    else skipped.push({ wallet: r.wallet, signature: r.signature, reason: d.reason });
  }
  return { events, skipped };
}

/** A WalletFeed over a recording: seek(t) releases every event recorded at or before t (once each). */
export class ReplayWallets implements WalletFeed {
  readonly events: WalletEvent[];
  readonly skipped: WalletSkip[];
  private i = 0;
  private out: WalletEvent[] = [];
  private gaps: WalletGap[] = [];
  private follow = new Set<string>();
  private heads = new Map<string, Anchor>();
  onNew: (() => void) | null = null;
  readonly stats = { replayed: 0 };

  constructor(text: string | RecordedTx[] | { events: WalletEvent[]; gaps?: WalletGap[] }) {
    if (typeof text === "object" && !Array.isArray(text)) {
      this.events = [...text.events].sort((a, b) => a.seenAtMs - b.seenAtMs);
      this.skipped = [];
      this.gaps = [...(text.gaps ?? [])];
    } else {
      const r = replayWallets(text);
      this.events = r.events;
      this.skipped = r.skipped;
    }
  }
  subscribe(wallets: string[]): void {
    for (const w of wallets) this.follow.add(w);
  }
  watched(): string[] {
    return [...this.follow];
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  /** Release every event seen at or before t (only followed wallets). */
  seek(t: number): void {
    let n = 0;
    while (this.i < this.events.length && this.events[this.i].seenAtMs <= t) {
      const e = this.events[this.i++];
      if (!this.follow.has(e.wallet)) continue;
      this.out.push(e);
      this.heads.set(e.wallet, { signature: e.signature, blockTime: e.blockTime });
      this.stats.replayed++;
      n++;
    }
    if (n) this.onNew?.();
  }
  /** Add an event or a gap by hand (tests). */
  push(e: WalletEvent | WalletGap): void {
    if ("signature" in e) {
      this.out.push(e);
      this.heads.set(e.wallet, { signature: e.signature, blockTime: e.blockTime });
    } else this.gaps.push(e);
    this.onNew?.();
  }
  drain(): WalletEvent[] {
    const o = this.out;
    this.out = [];
    return o;
  }
  drainGaps(): WalletGap[] {
    const g = this.gaps;
    this.gaps = [];
    return g;
  }
  head(wallet: string): Anchor | null {
    return this.heads.get(wallet) ?? null;
  }
  /** A recording has no queue: everything released is handled. */
  checkpoint(wallet: string): Anchor | null {
    return this.heads.get(wallet) ?? null;
  }
  openGaps(): Array<{ wallet: string; fromMs: number; reason: string }> {
    return [];
  }
  done(): boolean {
    return this.i >= this.events.length;
  }
}
