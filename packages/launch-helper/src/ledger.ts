/**
 * The launch helper's ledger: the core ledger plus `launches`, one row per launch, written before anything is sent.
 * The row's `client_launch_id` is the launch's identity for its whole life: it is never replaced, and a state dir
 * holds one launch.
 */
import { Ledger as CoreLedger } from "candle-bot-core/ledger";

export type LaunchState = "new" | "building" | "built" | "submitting" | "unresolved" | "landed" | "open" | "failed" | "refused";

export interface LaunchRow {
  id: number;
  client_launch_id: string;
  spec_hash: string;
  spec_json: string;
  state: LaunchState;
  attempts: number;
  bundle_id: string | null;
  built_at: number | null;
  legs_json: string | null;
  expected_out_raw: string | null;
  mint: string | null;
  signatures_json: string | null;
  dev_buy_signature: string | null;
  position_id: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const LAUNCHES = `
create table if not exists launches (
  id integer primary key, client_launch_id text not null unique, spec_hash text not null, spec_json text not null,
  state text not null, attempts integer not null default 0, bundle_id text, built_at integer, legs_json text,
  expected_out_raw text, mint text, signatures_json text, dev_buy_signature text, position_id integer, error text,
  created_at integer not null, updated_at integer not null
);
`;

export class Ledger extends CoreLedger {
  constructor(path: string) {
    super(path);
    this.db.exec(LAUNCHES);
  }

  /** The state dir's launch (one per state dir), if any. */
  launchRow(): LaunchRow | undefined {
    return this.db.prepare("select * from launches order by id limit 1").get() as LaunchRow | undefined;
  }

  createLaunch(r: { clientLaunchId: string; specHash: string; specJson: string; now: number }): LaunchRow {
    this.db.prepare("insert into launches (client_launch_id, spec_hash, spec_json, state, created_at, updated_at) values (?, ?, ?, 'new', ?, ?)").run(r.clientLaunchId, r.specHash, r.specJson, r.now, r.now);
    return this.launchRow()!;
  }

  updateLaunch(id: number, u: Partial<Omit<LaunchRow, "id" | "client_launch_id" | "spec_hash" | "spec_json" | "created_at">>): void {
    const keys = Object.keys(u);
    if (!keys.length) return;
    this.db.prepare(`update launches set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`).run(...keys.map((k) => (u as any)[k] ?? null), id);
  }
}
