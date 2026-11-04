/**
 * The launch bot's ledger: the core ledger (candle-bot-core) plus the `launches` table, one row per launch seen,
 * with both sources' sightings and the filter's decision. Same file and schema as 0.1.3.
 */
import { Ledger as CoreLedger } from "candle-bot-core/ledger";

export type { PositionRow, OrderRow, PositionStatus, OrderStatus, Side, QtySource } from "candle-bot-core/ledger";

export interface LaunchRow {
  mint: string;
  chain: string;
  first_source: string;
  first_seen_at: number;
  launched_at: number | null;
  api_seen_at: number | null;
  chain_seen_at: number | null;
  api_latency_ms: number | null;
  chain_latency_ms: number | null;
  symbol: string | null;
  name: string | null;
  creator: string | null;
  launch_mode: string | null;
  decision: string | null;
  reason: string | null;
}

const LAUNCHES = `
create table if not exists launches (
  mint text primary key, chain text not null, first_source text not null, first_seen_at integer not null,
  launched_at integer, api_seen_at integer, chain_seen_at integer, api_latency_ms integer, chain_latency_ms integer,
  symbol text, name text, creator text, launch_mode text, decision text, reason text
);
`;

export class Ledger extends CoreLedger {
  constructor(path: string) {
    super(path);
    this.db.exec(LAUNCHES);
  }

  /** As the core's, with the launch as the entry context (`launch`, the 0.1.3 name, still accepted). */
  override createPosition(p: Parameters<CoreLedger["createPosition"]>[0] & { launch?: unknown }): number {
    const { launch, ...rest } = p;
    return super.createPosition({ ...rest, entry: rest.entry !== undefined ? rest.entry : launch });
  }

  recordLaunch(l: LaunchRow): void {
    this.db
      .prepare(
        `insert into launches (mint, chain, first_source, first_seen_at, launched_at, api_seen_at, chain_seen_at, api_latency_ms, chain_latency_ms, symbol, name, creator, launch_mode, decision, reason)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(mint) do update set
           launched_at = coalesce(excluded.launched_at, launches.launched_at),
           api_seen_at = coalesce(launches.api_seen_at, excluded.api_seen_at),
           chain_seen_at = coalesce(launches.chain_seen_at, excluded.chain_seen_at),
           api_latency_ms = coalesce(excluded.api_latency_ms, launches.api_latency_ms),
           chain_latency_ms = coalesce(excluded.chain_latency_ms, launches.chain_latency_ms),
           symbol = coalesce(excluded.symbol, launches.symbol), name = coalesce(excluded.name, launches.name),
           creator = coalesce(excluded.creator, launches.creator), launch_mode = coalesce(excluded.launch_mode, launches.launch_mode),
           decision = coalesce(excluded.decision, launches.decision), reason = coalesce(excluded.reason, launches.reason)`,
      )
      .run(l.mint, l.chain, l.first_source, l.first_seen_at, l.launched_at, l.api_seen_at, l.chain_seen_at, l.api_latency_ms, l.chain_latency_ms, l.symbol, l.name, l.creator, l.launch_mode, l.decision, l.reason);
  }

  launch(mint: string): LaunchRow | undefined {
    return this.db.prepare("select * from launches where mint = ?").get(mint) as LaunchRow | undefined;
  }

  recentLaunches(limit = 20): LaunchRow[] {
    return this.db.prepare("select * from launches order by first_seen_at desc limit ?").all(limit) as unknown as LaunchRow[];
  }
}
