/**
 * Watch-only mode: the same wallet source and leader book, no wallet, no key, no executor. Each leader trade is an
 * alert (config.notify picks which); a gap the source could not read back is an alert too. The newest signature handled
 * per leader is kept in the state dir's ledger, so a restart reads back what happened while it was down.
 */
import type { Alerter, Ledger, Watcher } from "candle-bot-core";
import type { Logger } from "candle-bot-core/log";
import { LeaderBook } from "candle-bot-core/sources/walletPositions";
import type { Anchor, WalletEvent, WalletFeed, WalletGap } from "candle-bot-core/sources/wallets";
import type { WatchModeConfig } from "./config.ts";

const CURSORS = "create table if not exists watch_cursor (leader text primary key, signature text not null, block_time integer, slot integer not null, updated_at integer not null)";

export function watchCursors(ledger: Ledger): Record<string, Anchor> {
  ledger.db.exec(CURSORS);
  const out: Record<string, Anchor> = {};
  for (const r of ledger.db.prepare("select leader, signature, block_time from watch_cursor").all() as Array<{ leader: string; signature: string; block_time: number | null }>) out[r.leader] = { signature: r.signature, blockTime: r.block_time };
  return out;
}

const sol = (x: bigint) => Number(x) / 1e9;
const fmt = (x: number) => (x >= 1 ? x.toFixed(3) : x.toPrecision(3));

export class LeaderWatcher implements Watcher {
  private d: { cfg: WatchModeConfig; ledger: Ledger; alerter: Alerter; log: Logger; source: WalletFeed; now?: () => number };
  private book: LeaderBook;
  private labels: Map<string, string>;
  private started = false;
  readonly stats = { trades: 0, alerts: 0, gapsRecovered: 0, gapsUnrecovered: 0 };
  private recent: Array<Record<string, unknown>> = [];

  constructor(d: LeaderWatcher["d"]) {
    this.d = d;
    this.book = new LeaderBook();
    this.labels = new Map(d.cfg.leaders.map((l) => [l.address, l.label ?? `${l.address.slice(0, 4)}…${l.address.slice(-4)}`]));
    d.ledger.db.exec(CURSORS);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.d.source.subscribe(this.d.cfg.leaders.map((l) => l.address));
    await this.d.source.start();
  }

  async step(): Promise<void> {
    await this.start();
    for (const g of this.d.source.drainGaps()) this.gap(g);
    for (const e of this.d.source.drain()) this.trade(e);
    // The restart point: what the source has read and handled (never past a queued transaction).
    for (const l of this.d.cfg.leaders) {
      const cp = this.d.source.checkpoint?.(l.address);
      if (cp) this.d.ledger.db.prepare("insert into watch_cursor (leader, signature, block_time, slot, updated_at) values (?, ?, ?, 0, ?) on conflict(leader) do update set signature = excluded.signature, block_time = excluded.block_time, updated_at = excluded.updated_at").run(l.address, cp.signature, cp.blockTime ?? null, (this.d.now ?? Date.now)());
    }
  }

  /** One leader trade: book it, alert it (by config.notify), move the cursor. */
  trade(e: WalletEvent): void {
    const n = this.d.cfg.notify;
    const move = this.book.apply(e);
    if (move.repeat) return;
    this.stats.trades++;
    const who = this.labels.get(e.wallet) ?? e.wallet;
    const link = n.link ? ` ${n.link.replace("{mint}", e.mint)}` : "";
    const ago = e.blockTime !== null ? ` ${Math.max(0, Math.round(((this.d.now ?? Date.now)() - e.blockTime * 1000) / 1000))} s ago` : "";
    const route = e.venue === "jupiter" ? `jupiter (${e.venues.join(", ") || "other venues"})` : e.venue;
    const row = { leader: e.wallet, mint: e.mint, side: e.side, kind: move.kind, sol: sol(e.solRaw), fraction: move.fraction, venue: e.venue, signature: e.signature, complete: e.complete };
    this.recent = [...this.recent.slice(-19), { ...row, at: new Date(e.seenAtMs).toISOString() }];
    this.d.log.info("leader_trade", row);
    if (sol(e.solRaw) < n.minSol) return;
    let text: string | null = null;
    if (e.side === "buy" && n.buys && (!n.opensOnly || move.kind === "open")) text = `${who} ${move.kind === "open" ? "opened" : "added to"} ${e.mint}: ${fmt(sol(e.solRaw))} SOL on ${route}${ago}`;
    if (e.side === "sell" && n.sells) text = `${who} ${move.kind === "close" ? "sold out of" : `sold ${Math.round((move.fraction ?? 1) * 1000) / 10} % of`} ${e.mint}: ${fmt(sol(e.solRaw))} SOL on ${route}${ago}`;
    if (!text) return;
    if (!e.complete) text += " (trades before this one may be missing)";
    if (this.d.alerter.raise(`leader:${e.wallet}:${e.signature}`, text + link, { ...row, sol: row.sol })) this.stats.alerts++;
  }

  gap(g: WalletGap): void {
    if (g.recovered) {
      this.stats.gapsRecovered++;
      this.d.log.info("leader_gap_recovered", { leader: g.wallet, reason: g.reason });
      return;
    }
    this.stats.gapsUnrecovered++;
    if (!this.d.cfg.notify.gaps) return;
    const who = this.labels.get(g.wallet) ?? g.wallet;
    this.d.alerter.raise(`leader:${g.wallet}:gap:${g.fromMs}`, `${who}: trades from ${new Date(g.fromMs).toISOString()} to ${new Date(g.toMs).toISOString()} may be missing (${g.reason}; ${g.missing ?? "not read"})`);
  }

  status(): Record<string, unknown> {
    const s = this.d.source;
    return { leaders: this.d.cfg.leaders.map((l) => ({ address: l.address, label: l.label ?? null, head: s.head(l.address)?.signature ?? null })), watch: this.stats, source: { stats: s.stats ?? null, openGaps: s.openGaps() }, recent: this.recent };
  }

  async stop(): Promise<void> {
    await this.d.source.stop();
  }
}
