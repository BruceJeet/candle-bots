/**
 * The mirror's ledger: the core ledger (candle-bot-core) plus its own tables, created on first use:
 *   leader_trades   every leader trade the bot handled, once per (leader, signature): a restart or a backfill that
 *                   delivers it again changes nothing
 *   mirror_copies   one row per (leader, coin) the bot decided on; a `buy` row means that coin was copied from that
 *                   leader and is never copied from it again
 *   mirror_sells    the sells the bot owes for a leader's sells, per position, until a sell with that reason filled
 *   mirror_cursor   the newest signature handled per leader (the source backfills from it after a restart)
 *   mirror_kv       the leader book (sources/walletPositions) as JSON
 * Positions name their leader in the entry context (positions.launch_json.leader), so a leader's usage (entries and
 * SOL) is counted with the core's own rules.
 */
import { Ledger as CoreLedger } from "candle-bot-core/ledger";
import type { WalletEvent } from "candle-bot-core/sources/wallets";
import type { LeaderMove } from "candle-bot-core/sources/walletPositions";

export type { PositionRow, OrderRow, PositionStatus, OrderStatus, Side, QtySource } from "candle-bot-core/ledger";

const TABLES = `
create table if not exists leader_trades (
  leader text not null, signature text not null, mint text not null, side text not null, sol_raw text not null,
  token_raw text not null, venue text not null, slot integer not null, block_time integer, seen_at integer not null,
  via text not null, complete integer not null, kind text not null, fraction real, held_before text not null,
  held_after text not null, tracked integer not null, primary key (leader, signature)
);
create table if not exists mirror_copies (
  leader text not null, mint text not null, signature text not null, decided_at integer not null, decision text not null,
  reason text not null, primary key (leader, mint)
);
create table if not exists mirror_sells (
  id integer primary key, position_id integer not null, leader text not null, signature text not null, mint text not null,
  fraction real not null, kind text not null, created_at integer not null, done_at integer, outcome text,
  unique (position_id, signature)
);
create table if not exists mirror_cursor (
  leader text primary key, signature text not null, block_time integer, updated_at integer not null
);
create table if not exists mirror_kv (k text primary key, v text not null);
`;

export interface LeaderTradeRow {
  leader: string;
  signature: string;
  mint: string;
  side: string;
  sol_raw: string;
  token_raw: string;
  venue: string;
  slot: number;
  block_time: number | null;
  seen_at: number;
  via: string;
  complete: number;
  kind: string;
  fraction: number | null;
  held_before: string;
  held_after: string;
  tracked: number;
}

export interface MirrorSellRow {
  id: number;
  position_id: number;
  leader: string;
  signature: string;
  mint: string;
  fraction: number;
  kind: string;
  created_at: number;
  done_at: number | null;
  outcome: string | null;
}

export class Ledger extends CoreLedger {
  constructor(path: string) {
    super(path);
    this.db.exec(TABLES);
  }

  hasLeaderTrade(leader: string, signature: string): boolean {
    return !!this.db.prepare("select 1 from leader_trades where leader = ? and signature = ?").get(leader, signature);
  }

  /** Record a handled leader trade and move the leader's cursor, in one transaction. False: it was already recorded. */
  recordLeaderTrade(e: WalletEvent, move: LeaderMove, book: unknown): boolean {
    let added = false;
    this.tx(() => {
      const r = this.db
        .prepare(
          `insert or ignore into leader_trades (leader, signature, mint, side, sol_raw, token_raw, venue, slot, block_time, seen_at, via, complete, kind, fraction, held_before, held_after, tracked)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(e.wallet, e.signature, e.mint, e.side, e.solRaw.toString(), e.tokenRaw.toString(), e.venue, e.slot, e.blockTime, e.seenAtMs, e.via, e.complete ? 1 : 0, move.kind, move.fraction, move.heldBeforeRaw.toString(), move.heldAfterRaw.toString(), move.tracked ? 1 : 0);
      added = Number(r.changes) > 0;
      if (!added) return;
      this.db.prepare("insert into mirror_kv (k, v) values ('leader_book', ?) on conflict(k) do update set v = excluded.v").run(JSON.stringify(book));
    });
    return added;
  }

  /** Set a leader's restart point (the source's checkpoint: everything up to it read and handled). */
  putCursor(leader: string, signature: string, blockTime: number | null, now: number): void {
    const cur = this.db.prepare("select signature from mirror_cursor where leader = ?").get(leader) as { signature: string } | undefined;
    if (cur?.signature === signature) return;
    this.db.prepare("insert into mirror_cursor (leader, signature, block_time, updated_at) values (?, ?, ?, ?) on conflict(leader) do update set signature = excluded.signature, block_time = excluded.block_time, updated_at = excluded.updated_at").run(leader, signature, blockTime, now);
  }

  cursors(): Record<string, { signature: string; blockTime: number | null }> {
    const out: Record<string, { signature: string; blockTime: number | null }> = {};
    for (const r of this.db.prepare("select leader, signature, block_time from mirror_cursor").all() as Array<{ leader: string; signature: string; block_time: number | null }>) out[r.leader] = { signature: r.signature, blockTime: r.block_time };
    return out;
  }

  leaderBook(): unknown {
    const r = this.db.prepare("select v from mirror_kv where k = 'leader_book'").get() as { v: string } | undefined;
    return r ? JSON.parse(r.v) : null;
  }

  /** Leader sells of a coin after a slot, by any of `leaders`, oldest first. */
  leaderSellsAfter(mint: string, leaders: string[], slot: number): LeaderTradeRow[] {
    if (!leaders.length) return [];
    return this.db
      .prepare(`select * from leader_trades where mint = ? and side = 'sell' and slot > ? and leader in (${leaders.map(() => "?").join(",")}) order by slot, seen_at`)
      .all(mint, slot, ...leaders) as unknown as LeaderTradeRow[];
  }

  copied(leader: string, mint: string): boolean {
    return !!this.db.prepare("select 1 from mirror_copies where leader = ? and mint = ? and decision = 'buy'").get(leader, mint);
  }

  /** Record a decision on a (leader, coin). A `buy` is final; a skip is replaced by a later decision. */
  recordCopy(leader: string, mint: string, signature: string, decision: string, reason: string, now: number): void {
    this.db
      .prepare(
        `insert into mirror_copies (leader, mint, signature, decided_at, decision, reason) values (?, ?, ?, ?, ?, ?)
         on conflict(leader, mint) do update set signature = excluded.signature, decided_at = excluded.decided_at, decision = excluded.decision, reason = excluded.reason
         where mirror_copies.decision != 'buy'`,
      )
      .run(leader, mint, signature, now, decision, reason);
  }

  recentCopies(limit = 20): Array<{ leader: string; mint: string; signature: string; decided_at: number; decision: string; reason: string }> {
    return this.db.prepare("select * from mirror_copies order by decided_at desc limit ?").all(limit) as never;
  }

  recentLeaderTrades(limit = 20): LeaderTradeRow[] {
    return this.db.prepare("select * from leader_trades order by seen_at desc limit ?").all(limit) as unknown as LeaderTradeRow[];
  }

  /** Owe a sell on a position for a leader's sell (once per position and leader signature). */
  addMirrorSell(s: { positionId: number; leader: string; signature: string; mint: string; fraction: number; kind: string; now: number }): boolean {
    const r = this.db.prepare("insert or ignore into mirror_sells (position_id, leader, signature, mint, fraction, kind, created_at) values (?, ?, ?, ?, ?, ?, ?)").run(s.positionId, s.leader, s.signature, s.mint, s.fraction, s.kind, s.now);
    return Number(r.changes) > 0;
  }

  pendingMirrorSells(positionId: number): MirrorSellRow[] {
    return this.db.prepare("select * from mirror_sells where position_id = ? and done_at is null order by id").all(positionId) as unknown as MirrorSellRow[];
  }

  allPendingMirrorSells(): MirrorSellRow[] {
    return this.db.prepare("select * from mirror_sells where done_at is null order by id").all() as unknown as MirrorSellRow[];
  }

  finishMirrorSell(id: number, outcome: string, now: number): void {
    this.db.prepare("update mirror_sells set done_at = ?, outcome = ? where id = ? and done_at is null").run(now, outcome, id);
  }

  /**
   * What this mode has committed to a leader: entries (positions that may have spent) and lamports (their buy tickets,
   * one per transaction on a double execution), from the positions whose entry context names it. The same counting
   * rules as the core's maxPerCoin and lifetimeSol.
   */
  leaderUsage(leader: string, dry: boolean): { entries: number; lamports: bigint } {
    const rows = this.db
      .prepare(
        `select p.id pid, o.amount_raw a, o.extra_signatures x from positions p join orders o on o.position_id = p.id
          where o.side = 'buy' and p.dry = ? and json_extract(p.launch_json, '$.leader') = ?
            and o.status != 'reverted' and not (o.status = 'rejected' and o.ever_signed = 0)`,
      )
      .all(dry ? 1 : 0, leader) as Array<{ pid: number; a: string; x: string | null }>;
    const lamports = rows.reduce((s, r) => s + BigInt(r.a) * BigInt(1 + (r.x ? (JSON.parse(r.x) as unknown[]).length : 0)), 0n);
    return { entries: new Set(rows.map((r) => r.pid)).size, lamports };
  }
}
