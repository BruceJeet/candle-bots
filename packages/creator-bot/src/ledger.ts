/**
 * The creator follower's ledger: the core ledger (candle-bot-core) plus `follows`, one row per launch of a listed
 * creator with the decision. A creator's usage (entries and SOL) is read from the core's own positions and orders,
 * by the `followed` address the bot writes into each position's entry context: the same counting rules as the core's
 * maxPerCoin and lifetimeSol (a buy Candle refused before anything was signed, or one that reverted, spent nothing and
 * does not count), and nothing a booking could miss or a restart could lose.
 */
import { Ledger as CoreLedger } from "candle-bot-core/ledger";

export type { PositionRow, OrderRow, PositionStatus, OrderStatus, Side, QtySource } from "candle-bot-core/ledger";

export interface FollowRow {
  mint: string;
  creator: string;
  label: string | null;
  launched_at: number | null;
  first_seen_at: number;
  symbol: string | null;
  launch_mode: string | null;
  decision: string;
  reason: string;
}

const FOLLOWS = `
create table if not exists follows (
  mint text primary key, creator text not null, label text, launched_at integer, first_seen_at integer not null,
  symbol text, launch_mode text, decision text not null, reason text not null
);
`;

export class Ledger extends CoreLedger {
  constructor(path: string) {
    super(path);
    this.db.exec(FOLLOWS);
  }

  recordFollow(r: FollowRow): void {
    this.db
      .prepare(
        `insert into follows (mint, creator, label, launched_at, first_seen_at, symbol, launch_mode, decision, reason)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(mint) do update set decision = excluded.decision, reason = excluded.reason,
           symbol = coalesce(excluded.symbol, follows.symbol), launch_mode = coalesce(excluded.launch_mode, follows.launch_mode)`,
      )
      .run(r.mint, r.creator, r.label, r.launched_at, r.first_seen_at, r.symbol, r.launch_mode, r.decision, r.reason);
  }

  follow(mint: string): FollowRow | undefined {
    return this.db.prepare("select * from follows where mint = ?").get(mint) as FollowRow | undefined;
  }

  recentFollows(limit = 20): FollowRow[] {
    return this.db.prepare("select * from follows order by first_seen_at desc limit ?").all(limit) as unknown as FollowRow[];
  }

  /**
   * What this mode has committed to a followed creator: entries (positions that may have spent) and lamports (their
   * buy tickets, one per transaction on a double execution), from the positions whose entry context names it.
   */
  creatorUsage(creator: string, dry: boolean): { entries: number; lamports: bigint } {
    const rows = this.db
      .prepare(
        `select p.id pid, o.amount_raw a, o.extra_signatures x from positions p join orders o on o.position_id = p.id
          where o.side = 'buy' and p.dry = ? and json_extract(p.launch_json, '$.followed') = ?
            and o.status != 'reverted' and not (o.status = 'rejected' and o.ever_signed = 0)`,
      )
      .all(dry ? 1 : 0, creator) as Array<{ pid: number; a: string; x: string | null }>;
    const lamports = rows.reduce((s, r) => s + BigInt(r.a) * BigInt(1 + (r.x ? (JSON.parse(r.x) as unknown[]).length : 0)), 0n);
    return { entries: new Set(rows.map((r) => r.pid)).size, lamports };
  }
}
