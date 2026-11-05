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
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Alerter, Logger, Rpc } from "candle-bot-core";
import type { Ledger, PositionRow } from "candle-bot-core/ledger";
import type { Config } from "./config.ts";

const TABLE = `
create table if not exists sweep_requests (
  id integer primary key, request_id text not null unique, dry integer not null, wallet text not null, home text not null,
  amount_lamports text not null, realized_lamports text not null, reason text not null, status text not null,
  created_at integer not null, done_at integer, done_signature text, done_amount_lamports text, verified integer, note text
);
`;

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
  }

  /** Realized profit over this run mode's positions with a basis, and how many positions it covers. */
  realized(): { lamports: bigint; positions: number } {
    let sum = 0n;
    let n = 0;
    for (const p of this.d.ledger.allPositions()) {
      if (!!p.dry !== this.dry) continue;
      const b = this.d.basisOf(p.id);
      if (b === undefined || b === "none") continue;
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
    return { requestId: r.request_id, dry: !!r.dry, wallet: r.wallet, home: r.home, amountSol: Number(r.amount_lamports) / 1e9, amountLamports: r.amount_lamports, reason: r.reason, createdAt: new Date(r.created_at).toISOString(), status: r.status };
  }

  private writeFile(r: SweepRow): void {
    const f = this.file(r);
    mkdirSync(join(this.d.cfg.stateDir, "sweeps"), { recursive: true });
    writeFileSync(f + ".tmp", JSON.stringify(this.body(r), null, 2) + "\n");
    renameSync(f + ".tmp", f);
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
    await this.requests();
    const now = this.now();
    if (now < this.nextAt) return;
    this.nextAt = now + this.d.cfg.sweep.everyMs;
    const open = this.pending();
    if (open) {
      // One sweep at a time: the pending one is re-announced on the alerter's schedule, its file rewritten if lost.
      if (!existsSync(this.file(open))) this.writeFile(open);
      this.remind(open);
      return;
    }
    const s = this.d.cfg.sweep;
    const realized = this.realized();
    const unswept = realized.lamports - this.swept();
    const min = BigInt(Math.round(s.minSweepSol * 1e9));
    if (unswept < min) return;
    let bal: bigint;
    try {
      const v = (await this.d.rpc.call<any>("getBalance", [this.d.cfg.wallet, { commitment: "confirmed" }]))?.value;
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("bad response");
      bal = BigInt(v);
    } catch (e) {
      this.d.log.warn("sweep_balance_unreadable", { error: String((e as Error)?.message ?? e).slice(0, 160) });
      return;
    }
    const reserve = BigInt(Math.round(s.reserveSol * 1e9));
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
      const out = n.startsWith("swept") ? await this.markDone(String(req.requestId), req.signature ?? null, req.unverified === true) : this.cancel(String(req.requestId));
      this.d.log.info(n.startsWith("swept") ? "swept_request" : "sweep_cancel_request", { file: n, result: out });
      // A transfer not yet visible on chain stays for the next step; anything else is answered once.
      if (!out.startsWith("not on chain yet")) {
        try {
          unlinkSync(f);
        } catch {
          /* gone */
        }
      }
    }
  }

  /**
   * Mark a pending request done. With a signature, the transaction is read from chain: it must have succeeded, the wallet
   * must have paid and the home address received; the amount recorded is what the home address received. `unverified`
   * marks it done at the requested amount without a chain check.
   */
  async markDone(requestId: string, signature: string | null, unverified: boolean): Promise<string> {
    const r = this.rows().find((x) => x.request_id === requestId);
    if (!r) return `no sweep request ${requestId}`;
    if (r.status !== "pending") return `sweep request ${requestId} is ${r.status}`;
    if (!signature) {
      if (!unverified) return "give --signature <sig> (checked on chain) or --unverified";
      this.close(r, "done", null, r.amount_lamports, false, "marked done without a signature");
      return `done (unverified): ${sol(BigInt(r.amount_lamports))}`;
    }
    if (this.rows().some((x) => x.done_signature === signature)) return `signature ${signature} already closed another sweep`;
    let tx: any;
    try {
      tx = await this.d.rpc.call<any>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    } catch (e) {
      return `not on chain yet (read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}); kept`;
    }
    if (!tx) return "not on chain yet; kept";
    if (tx.meta?.err) return `that transaction failed on chain (${JSON.stringify(tx.meta.err).slice(0, 80)}); not marked`;
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
    if (fromWallet === null || fromWallet >= 0n) return `that transaction is not paid from ${r.wallet}; not marked`;
    const note = toHome < BigInt(r.amount_lamports) ? `home received ${sol(toHome)} of ${sol(BigInt(r.amount_lamports))} requested` : null;
    this.close(r, "done", signature, toHome.toString(), true, note);
    return `done: ${sol(toHome)} to ${r.home}${note ? ` (${note})` : ""}`;
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
