/**
 * Sweep requests: the bot never moves funds. When realized profit (above a SOL reserve the wallet keeps) reaches
 * `minSweepSol`, it records ONE sweep request in the ledger (table `sweep_requests`, created on first use), writes it
 * to `sweeps/<requestId>.json` for whoever sends it, and alerts. While a request is pending no new one is made, and the
 * alert repeats on the alerter's renotify schedule. The request closes when it is marked done (`swept`, with the
 * transfer's signature checked on chain, or `--unverified`) or cancelled (`cancel`); the next one counts only profit
 * not yet swept.
 *
 * Realized profit = over this bot's positions with a cost basis (basis `none` is left out): proceeds less the cost of
 * the tokens that left the position (sold or written off) and less network fees. Losses count against it. Profit already swept (the amount
 * the chain showed, or the amount requested when marked unverified) is subtracted.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Alerter, Logger, Rpc } from "candle-bot-core";
import { b58decode } from "candle-bot-core/solana/base58";
import type { Ledger, PositionRow } from "candle-bot-core/ledger";
import type { Config } from "./config.ts";

const TABLE = `
create table if not exists sweep_requests (
  id integer primary key, request_id text not null unique, dry integer not null, wallet text not null, home text not null,
  amount_lamports text not null, realized_lamports text not null, reason text not null, status text not null,
  created_at integer not null, done_at integer, done_signature text, done_amount_lamports text, verified integer, note text,
  stale_at integer
);
create table if not exists sweep_transfers (
  signature text primary key, request_id text not null, amount_lamports text not null, block_time integer, at integer not null
);
`;
/** Columns added after the table first shipped in a dev build (a ledger left from an earlier run is migrated). */
const LATER_COLUMNS: Array<[string, string]> = [["stale_at", "integer"]];
/** A kept `swept` request (its transaction not on chain yet) is tried this many times, then dropped and alerted. */
export const SWEPT_MAX_TRIES = 20;
/** A transfer may be this much older than its request (clock skew between this host and the chain), seconds. */
export const BLOCK_TIME_SKEW_SEC = 120;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export interface SweepRow {
  id: number;
  request_id: string;
  dry: number;
  wallet: string;
  home: string;
  amount_lamports: string;
  realized_lamports: string;
  reason: string;
  status: "pending" | "done" | "cancelled";
  created_at: number;
  done_at: number | null;
  done_signature: string | null;
  done_amount_lamports: string | null;
  verified: number | null;
  note: string | null;
  stale_at: number | null;
}

/**
 * What one position has realized: proceeds, less the cost of the tokens that left it (sold or written off), less the
 * network fees its orders paid. Conservative: it never counts a fee or a write-off as profit.
 */
export function realizedOf(p: Pick<PositionRow, "qty_raw" | "remaining_raw" | "cost_lamports" | "proceeds_lamports" | "network_fees_lamports">): bigint {
  const qty = BigInt(p.qty_raw);
  const proceeds = BigInt(p.proceeds_lamports ?? "0") - BigInt(p.network_fees_lamports ?? "0");
  if (qty <= 0n) return proceeds;
  const gone = qty - BigInt(p.remaining_raw);
  const costGone = gone > 0n ? (BigInt(p.cost_lamports) * gone + qty - 1n) / qty : 0n; // rounded up
  return proceeds - costGone;
}

export const sol = (l: bigint) => `${(Number(l) / 1e9).toFixed(9).replace(/0+$/, "").replace(/\.$/, "")} SOL`;

export interface SweeperDeps {
  cfg: Config;
  ledger: Ledger;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  /** Basis source per position (the adopter's `adoptions` row); positions with `none` are left out. */
  basisOf: (positionId: number) => string | undefined;
  now?: () => number;
}

export class Sweeper {
  private d: SweeperDeps;
  private now: () => number;
  private nextAt = 0;
  private dry: boolean;
  constructor(d: SweeperDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.dry = d.cfg.mode === "dry";
    d.ledger.db.exec(TABLE);
    const cols = new Set((d.ledger.db.prepare("pragma table_info(sweep_requests)").all() as Array<{ name: string }>).map((c) => c.name));
    for (const [c, ddl] of LATER_COLUMNS) if (!cols.has(c)) d.ledger.db.exec(`alter table sweep_requests add column ${c} ${ddl}`);
  }

  /** Realized profit over this run mode's positions with a basis, and how many positions it covers. */
  realized(): { lamports: bigint; positions: number } {
    let sum = 0n;
    let n = 0;
    for (const p of this.d.ledger.allPositions()) {
      if (!!p.dry !== this.dry) continue;
      const b = this.d.basisOf(p.id);
      // `mark` (the price at adoption) is not what was paid: a sale above it may be principal coming back. Left out
      // unless sweep.countMarkBasis.
      if (b === undefined || b === "none" || (b === "mark" && !this.d.cfg.sweep.countMarkBasis)) continue;
      sum += realizedOf(p);
      n++;
    }
    return { lamports: sum, positions: n };
  }

  rows(): SweepRow[] {
    return this.d.ledger.db.prepare("select * from sweep_requests where dry = ? order by id").all(this.dry ? 1 : 0) as unknown as SweepRow[];
  }

  pending(): SweepRow | undefined {
    return this.rows().find((r) => r.status === "pending");
  }

  /** Profit already swept: the amount the chain showed, else the amount requested (marked done unverified). */
  swept(): bigint {
    return this.rows().filter((r) => r.status === "done").reduce((s, r) => s + BigInt(r.done_amount_lamports ?? r.amount_lamports), 0n);
  }

  private file(r: SweepRow): string {
    return join(this.d.cfg.stateDir, "sweeps", `${r.request_id}.json`);
  }

  /** The request as the sender needs it (also the file's content). */
  body(r: SweepRow): Record<string, unknown> {
    return {
      requestId: r.request_id, dry: !!r.dry, wallet: r.wallet, home: r.home, amountSol: Number(r.amount_lamports) / 1e9, amountLamports: r.amount_lamports, reason: r.reason, createdAt: new Date(r.created_at).toISOString(), status: r.status,
      send: "send exactly amountLamports; read this file again just before sending (it turns stale if the amount no longer holds)",
      ...(r.status === "pending" && r.stale_at !== null ? { stale: true, doNotSend: "this request no longer holds (profit or balance fell, or home changed); cancel it and a new one is made" } : {}),
      ...(r.status === "done" ? { sentLamports: r.done_amount_lamports, signatures: this.transfers(r.request_id).map((t) => t.signature) } : {}),
    };
  }

  private writeFile(r: SweepRow): void {
    const f = this.file(r);
    mkdirSync(join(this.d.cfg.stateDir, "sweeps"), { recursive: true });
    writeFileSync(f + ".tmp", JSON.stringify(this.body(r), null, 2) + "\n");
    renameSync(f + ".tmp", f);
  }

  transfers(requestId: string): Array<{ signature: string; amount_lamports: string }> {
    return this.d.ledger.db.prepare("select signature, amount_lamports from sweep_transfers where request_id = ? order by at").all(requestId) as any;
  }

  /** Each request's file follows its ledger row (the ledger is the authority; a file left by a crash is corrected). */
  private syncFiles(): void {
    for (const r of this.rows()) {
      const f = this.file(r);
      let ok = false;
      try {
        const cur = JSON.parse(readFileSync(f, "utf8"));
        ok = JSON.stringify(cur) === JSON.stringify(this.body(r));
      } catch {
        ok = false;
      }
      if (!ok) this.writeFile(r);
    }
  }

  private remind(r: SweepRow): void {
    this.d.alerter.raise(
      `sweep:${r.request_id}`,
      `${r.dry ? "DRY " : ""}sweep request ${r.request_id}: send ${sol(BigInt(r.amount_lamports))} from ${r.wallet} to ${r.home} (${r.reason}). Then mark it: swept ${r.request_id} --signature <sig>`,
      { requestId: r.request_id, wallet: r.wallet, home: r.home, amountLamports: r.amount_lamports },
    );
  }

  /** One step: requests from the command line, then at most one new sweep request. Never throws on a failed read. */
  async step(): Promise<void> {
    const now = this.now();
    if (now < this.nextAt) return;
    this.nextAt = now + this.d.cfg.sweep.everyMs;
    // Command-line requests, the files, then the sweep itself: all on the everyMs clock (a kept `swept` request costs
    // one transaction read per look, never one per cycle).
    await this.requests();
    this.syncFiles();
    const s = this.d.cfg.sweep;
    const min = BigInt(Math.round(s.minSweepSol * 1e9));
    const reserve = BigInt(Math.round(s.reserveSol * 1e9));
    const open = this.pending();
    const realized = this.realized();
    const unswept = realized.lamports - this.swept();
    if (open) {
      // One sweep at a time. The pending one is checked again on every look: if the profit or the balance has fallen
      // under what it asks, or home has changed, it is stale (do not send; cancel it), else it is re-announced.
      const why = open.home !== s.home ? `home is now ${s.home} in the config, not ${open.home}` : open.wallet !== this.d.cfg.wallet ? `the bot's wallet is now ${this.d.cfg.wallet}, not ${open.wallet}` : null;
      let stale = why;
      if (!stale) {
        if (unswept < BigInt(open.amount_lamports)) stale = `unswept profit is now ${sol(unswept)}, under the ${sol(BigInt(open.amount_lamports))} asked`;
        else {
          const bal = await this.balance();
          if (bal !== null && bal - reserve < BigInt(open.amount_lamports)) stale = `the wallet now holds ${sol(bal)}; less the ${sol(reserve)} reserve that is under the ${sol(BigInt(open.amount_lamports))} asked`;
        }
      }
      if (stale) {
        if (open.stale_at === null) {
          this.d.ledger.db.prepare("update sweep_requests set stale_at = ?, note = ? where id = ? and status = 'pending'").run(now, `stale: ${stale}`, open.id);
          this.writeFile(this.pending()!);
          this.d.log.warn("sweep_stale", { requestId: open.request_id, why: stale });
        }
        this.d.alerter.raise(`sweep:${open.request_id}:stale`, `${open.dry ? "DRY " : ""}sweep request ${open.request_id} is STALE, do not send it: ${stale}. Cancel it (cancel ${open.request_id}); a new request follows. If you already sent it, mark it swept with the signature.`);
      } else {
        if (open.stale_at !== null) {
          // Back within bounds (a balance read that recovered): announced again as it stands.
          this.d.ledger.db.prepare("update sweep_requests set stale_at = null, note = null where id = ? and status = 'pending'").run(open.id);
          this.writeFile(this.pending()!);
        }
        this.remind(open);
      }
      return;
    }
    if (unswept < min) return;
    // After a sweep closed short (sent in part), the remainder is not asked for again on its own: the next request
    // waits for new realized profit since that request (then it covers the remainder too).
    const lastDone = this.rows().filter((x) => x.status === "done").pop();
    if (lastDone && realized.lamports <= BigInt(lastDone.realized_lamports)) {
      if (this.d.ledger.alert("sweep:remainder_waits", lastDone.request_id, now, 86_400_000)) this.d.log.info("sweep_remainder_waits", { unsweptLamports: unswept, afterRequest: lastDone.request_id });
      return;
    }
    const bal = await this.balance();
    if (bal === null) return;
    const room = bal - reserve;
    const amount = unswept < room ? unswept : room;
    if (amount < min) {
      if (this.d.ledger.alert("sweep:held", "reserve", now, 3_600_000)) this.d.log.info("sweep_held", { unsweptLamports: unswept, balanceLamports: bal, reserveLamports: reserve });
      this.d.alerter.raise("sweep:held_by_reserve", `${this.dry ? "DRY " : ""}profit of ${sol(unswept)} is waiting to be swept, but the wallet holds ${sol(bal)} with ${sol(reserve)} kept as reserve; no sweep request until there is room for at least ${sol(min)}`);
      return;
    }
    const requestId = `sweep-${now.toString(36)}-${randomBytes(3).toString("hex")}`;
    const reason = `realized profit ${sol(realized.lamports)} over ${realized.positions} position(s), ${sol(this.swept())} swept before${amount < unswept ? `; capped at the balance less the ${sol(reserve)} reserve` : ""}`;
    // Recorded before the file and the alert: a crash after this line re-announces the same request, never a new one.
    this.d.ledger.db.prepare("insert into sweep_requests (request_id, dry, wallet, home, amount_lamports, realized_lamports, reason, status, created_at) values (?, ?, ?, ?, ?, ?, ?, 'pending', ?)").run(requestId, this.dry ? 1 : 0, this.d.cfg.wallet, s.home, amount.toString(), realized.lamports.toString(), reason, now);
    const r = this.pending()!;
    this.writeFile(r);
    this.d.log.info("sweep_request", this.body(r));
    this.remind(r);
  }

  /** The wallet's SOL balance (null: unreadable, logged). */
  private async balance(): Promise<bigint | null> {
    try {
      const v = (await this.d.rpc.call<any>("getBalance", [this.d.cfg.wallet, { commitment: "confirmed" }]))?.value;
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("bad response");
      return BigInt(v);
    } catch (e) {
      this.d.log.warn("sweep_balance_unreadable", { error: String((e as Error)?.message ?? e).slice(0, 160) });
      return null;
    }
  }

  /** `swept` / `cancel` request files (written by the command line while the bot runs). */
  private async requests(): Promise<void> {
    const dir = join(this.d.cfg.stateDir, "requests");
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => /^(swept|cancel)-.*\.json$/.test(n)).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const f = join(dir, n);
      let req: any;
      try {
        req = JSON.parse(readFileSync(f, "utf8"));
      } catch (e) {
        this.d.log.warn("sweep_request_unreadable", { file: n, error: String((e as Error)?.message ?? e) });
        try {
          unlinkSync(f);
        } catch {
          /* gone */
        }
        continue;
      }
      let out: string;
      try {
        out = n.startsWith("swept") ? await this.markDone(String(req.requestId), req.signature ?? null, req.unverified === true) : this.cancel(String(req.requestId));
      } catch (e) {
        // One file that fails never stops the others.
        out = `failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
      }
      this.d.log.info(n.startsWith("swept") ? "swept_request" : "sweep_cancel_request", { file: n, result: out });
      // A transfer not yet visible on chain stays for the next look, at most SWEPT_MAX_TRIES times; anything else is
      // answered once.
      let keep = out.startsWith("not on chain yet");
      if (keep) {
        const tries = (Number(req.tries) || 0) + 1;
        if (tries >= SWEPT_MAX_TRIES) {
          keep = false;
          this.d.alerter.raise(`sweep:swept_gave_up:${n}`, `swept ${req.requestId} --signature ${req.signature}: not found on chain after ${tries} looks; dropped. Check the signature and run swept again`);
        } else {
          try {
            writeFileSync(f + ".tmp", JSON.stringify({ ...req, tries }));
            renameSync(f + ".tmp", f);
          } catch {
            /* tried again as it was */
          }
        }
      }
      if (!keep) {
        try {
          unlinkSync(f);
        } catch {
          /* gone */
        }
      }
    }
  }

  /**
   * Record a transfer for a request. With a signature, the transaction is read from chain (finalized): it must have
   * succeeded, be no older than the request, be paid by the wallet (at least what home received) and pay home; what home
   * received is recorded. The first transfer closes a pending request; more transfers (a sweep sent in parts) add to a
   * request already done. A signature counts once, in any request. `unverified` closes a pending request at the amount
   * asked, without a chain check.
   */
  async markDone(requestId: string, signature: string | null, unverified: boolean): Promise<string> {
    const r = this.d.ledger.db.prepare("select * from sweep_requests where request_id = ?").get(requestId) as unknown as SweepRow | undefined;
    if (!r) return `no sweep request ${requestId}`;
    if (!!r.dry !== this.dry) return `sweep request ${requestId} is a ${r.dry ? "dry" : "live"} request; this run is ${this.dry ? "dry" : "live"}`;
    if (!signature) {
      if (r.status !== "pending") return `sweep request ${requestId} is ${r.status}`;
      if (!unverified) return "give --signature <sig> (checked on chain) or --unverified";
      this.close(r, "done", null, r.amount_lamports, false, "marked done without a signature");
      return `done (unverified): ${sol(BigInt(r.amount_lamports))}`;
    }
    if (r.status === "cancelled") return `sweep request ${requestId} is cancelled`;
    if (r.status === "done" && r.verified !== 1) return `sweep request ${requestId} was marked done unverified; it takes no transfers`;
    if (!validSignature(signature)) return `${signature} is not a transaction signature; not marked`;
    if (this.d.ledger.db.prepare("select 1 from sweep_transfers where signature = ?").get(signature)) return `signature ${signature} already counted for a sweep`;
    let tx: any;
    try {
      tx = await this.d.rpc.call<any>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "finalized" }]);
    } catch (e) {
      const code = (e as any)?.code;
      if (code === -32602 || code === "-32602") return `the RPC refused that signature (${String((e as Error)?.message ?? e).slice(0, 80)}); not marked`;
      return `not on chain yet (read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}); kept`;
    }
    if (!tx) return "not on chain yet (or not finalized); kept";
    if (tx.meta?.err) return `that transaction failed on chain (${JSON.stringify(tx.meta.err).slice(0, 80)}); not marked`;
    // No block time from the RPC: its age cannot be checked. Kept and looked at again (capped), never accepted blind.
    if (typeof tx.blockTime !== "number") return "not on chain yet (the RPC gave no block time, so its age cannot be checked); kept";
    if (tx.blockTime < Math.floor(r.created_at / 1000) - BLOCK_TIME_SKEW_SEC) return `that transaction is older than the request (${new Date(tx.blockTime * 1000).toISOString()}); not marked`;
    const keys: string[] = (tx.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === "string" ? k : k?.pubkey));
    const loaded = tx.meta?.loadedAddresses ? [...(tx.meta.loadedAddresses.writable ?? []), ...(tx.meta.loadedAddresses.readonly ?? [])] : [];
    const all = [...keys, ...loaded];
    const pre: number[] = tx.meta?.preBalances ?? [];
    const post: number[] = tx.meta?.postBalances ?? [];
    const delta = (who: string) => {
      const i = all.indexOf(who);
      return i < 0 || pre[i] === undefined || post[i] === undefined ? null : BigInt(post[i]) - BigInt(pre[i]);
    };
    const toHome = delta(r.home);
    const fromWallet = delta(r.wallet);
    if (toHome === null || toHome <= 0n) return `that transaction pays nothing to ${r.home}; not marked`;
    if (fromWallet === null || -fromWallet < toHome) return `that transaction is not paid from ${r.wallet} (it paid ${fromWallet === null ? "nothing" : sol(-fromWallet)}, home received ${sol(toHome)}); not marked`;
    this.d.ledger.db.prepare("insert into sweep_transfers (signature, request_id, amount_lamports, block_time, at) values (?, ?, ?, ?, ?)").run(signature, r.request_id, toHome.toString(), typeof tx.blockTime === "number" ? tx.blockTime : null, this.now());
    const total = this.transfers(r.request_id).reduce((x, t) => x + BigInt(t.amount_lamports), 0n);
    const note = total < BigInt(r.amount_lamports) ? `home received ${sol(total)} of ${sol(BigInt(r.amount_lamports))} asked` : null;
    if (r.status === "pending") {
      this.close(r, "done", signature, total.toString(), true, note);
      return `done: ${sol(toHome)} to ${r.home}${note ? ` (${note})` : ""}`;
    }
    this.d.ledger.db.prepare("update sweep_requests set done_amount_lamports = ?, note = ? where id = ?").run(total.toString(), note, r.id);
    this.writeFile(this.d.ledger.db.prepare("select * from sweep_requests where id = ?").get(r.id) as unknown as SweepRow);
    this.d.log.info("sweep_transfer_added", { requestId: r.request_id, signature, amountLamports: toHome.toString(), totalLamports: total.toString() });
    return `added: ${sol(toHome)} more to ${r.home}, ${sol(total)} in all for ${r.request_id}`;
  }

  cancel(requestId: string): string {
    const r = this.rows().find((x) => x.request_id === requestId);
    if (!r) return `no sweep request ${requestId}`;
    if (r.status !== "pending") return `sweep request ${requestId} is ${r.status}`;
    this.close(r, "cancelled", null, null, null, "cancelled");
    return "cancelled";
  }

  private close(r: SweepRow, status: "done" | "cancelled", sig: string | null, amount: string | null, verified: boolean | null, note: string | null): void {
    this.d.ledger.db.prepare("update sweep_requests set status = ?, done_at = ?, done_signature = ?, done_amount_lamports = ?, verified = ?, note = ? where id = ? and status = 'pending'").run(status, this.now(), sig, amount, verified === null ? null : verified ? 1 : 0, note, r.id);
    const done = this.rows().find((x) => x.id === r.id)!;
    this.writeFile(done);
    this.d.log.info(status === "done" ? "sweep_done" : "sweep_cancelled", { requestId: r.request_id, signature: sig, amountLamports: amount, verified, note });
  }

  status(): Record<string, unknown> {
    const realized = this.realized();
    const p = this.pending();
    return {
      home: this.d.cfg.sweep.home,
      realizedSol: Number(realized.lamports) / 1e9,
      sweptSol: Number(this.swept()) / 1e9,
      pending: p ? this.body(p) : null,
      requests: this.rows().slice(-10).map((r) => ({ ...this.body(r), doneSignature: r.done_signature, doneAmountLamports: r.done_amount_lamports, verified: r.verified === null ? null : !!r.verified, note: r.note })),
    };
  }
}

/** A base58 transaction signature (64 bytes). */
export function validSignature(sig: string): boolean {
  if (!SIG_RE.test(sig)) return false;
  try {
    return b58decode(sig).length === 64;
  } catch {
    return false;
  }
}
