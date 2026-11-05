/** The graduation sniper's ledger: the core ledger (candle-bot-core) plus `graduations`, one row per graduation decided. */
import { Ledger as CoreLedger } from "candle-bot-core/ledger";

export type { PositionRow, OrderRow, PositionStatus, OrderStatus, Side, QtySource } from "candle-bot-core/ledger";

export interface GraduationRow {
  mint: string;
  graduated_at: number | null;
  graduated_at_source: string | null;
  detected_at: number;
  launched_at: number | null;
  symbol: string | null;
  creator: string | null;
  decision: string;
  reason: string;
}

const GRADUATIONS = `
create table if not exists graduations (
  mint text primary key, graduated_at integer, graduated_at_source text, detected_at integer not null, launched_at integer,
  symbol text, creator text, decision text not null, reason text not null
);
`;

export class Ledger extends CoreLedger {
  constructor(path: string) {
    super(path);
    this.db.exec(GRADUATIONS);
  }

  recordGraduation(r: GraduationRow): void {
    this.db
      .prepare(
        `insert into graduations (mint, graduated_at, graduated_at_source, detected_at, launched_at, symbol, creator, decision, reason)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(mint) do update set decision = excluded.decision, reason = excluded.reason`,
      )
      .run(r.mint, r.graduated_at, r.graduated_at_source, r.detected_at, r.launched_at, r.symbol, r.creator, r.decision, r.reason);
  }

  graduation(mint: string): GraduationRow | undefined {
    return this.db.prepare("select * from graduations where mint = ?").get(mint) as GraduationRow | undefined;
  }

  recentGraduations(limit = 20): GraduationRow[] {
    return this.db.prepare("select * from graduations order by detected_at desc limit ?").all(limit) as unknown as GraduationRow[];
  }
}
