/**
 * The scanner: a watch-only Watcher. Each step: the watchlist (list, feed bucket), the series poll (prices; trades come
 * on the trade-log socket), then each rule on each watched coin. A firing alerts once per coin and rule per cooldown;
 * the last firing is kept in the ledger (table `scan_fired`, created on first use), so a restart does not repeat it.
 * By default a rule acts only on complete numbers (no gap in the bars it reads).
 */
import type { Alerter, Logger, Ledger, Watcher } from "candle-bot-core";
import type { SeriesSource } from "candle-bot-core/sources/series";
import type { CandleFeed } from "candle-bot-core/sources/candleFeed";
import type { Watchlist } from "candle-bot-core/sources/watchlist";
import { fallFromHigh, riseFromLow, volumeVsBaseline } from "candle-bot-core/market/indicators";
import type { Config } from "./config.ts";

export type RuleName = "volumeSpike" | "dip" | "breakout" | "feedVolume";

export interface Firing {
  mint: string;
  rule: RuleName;
  text: string;
  numbers: Record<string, number | string | boolean>;
}

const TABLE = "create table if not exists scan_fired (mint text not null, rule text not null, at integer not null, primary key (mint, rule))";

const r2 = (x: number) => Math.round(x * 100) / 100;
const sig = (x: number) => Number(x.toPrecision(4));

/** Every rule on one coin (pure; reads the series and the feed). */
export function evaluate(cfg: Config, mint: string, series: SeriesSource, feed: CandleFeed | null): Firing[] {
  const r = cfg.rules;
  const out: Firing[] = [];
  const v = series.series(mint);
  const ok = (complete: boolean) => complete || r.allowIncomplete;
  if (v) {
    if (r.volumeSpike) {
      const x = volumeVsBaseline(v.bars, r.volumeSpike.recentBars, r.volumeSpike.baselineBars);
      if (x && ok(x.complete) && x.value >= r.volumeSpike.minRatio && x.recentMean * r.volumeSpike.recentBars >= r.volumeSpike.minVolumeSol) out.push({ mint, rule: "volumeSpike", text: `volume ${r2(x.value)}x its baseline (${sig(x.recentMean * r.volumeSpike.recentBars)} SOL in the last ${r.volumeSpike.recentBars} min vs ${sig(x.baselineMean)} SOL/min before)${x.complete ? "" : " [incomplete: a gap in the bars]"}`, numbers: { ratio: r2(x.value), recentSol: sig(x.recentMean * r.volumeSpike.recentBars), baselineSolPerMin: sig(x.baselineMean), z: x.z === null ? "n/a" : r2(x.z), complete: x.complete, source: v.source } });
    }
    if (r.dip) {
      const x = fallFromHigh(v.bars, r.dip.windowBars);
      if (x && ok(x.complete) && x.value >= r.dip.minFallPct) out.push({ mint, rule: "dip", text: `down ${r2(x.value)} % from its ${r.dip.windowBars}-min high (${sig(x.high)} to ${sig(x.last)} SOL)${x.complete ? "" : " [incomplete]"}`, numbers: { fallPct: r2(x.value), high: sig(x.high), last: sig(x.last), complete: x.complete } });
    }
    if (r.breakout) {
      const x = riseFromLow(v.bars, r.breakout.windowBars);
      if (x && ok(x.complete) && x.value >= r.breakout.minRisePct) out.push({ mint, rule: "breakout", text: `up ${r2(x.value)} % from its ${r.breakout.windowBars}-min low (${sig(x.low)} to ${sig(x.last)} SOL)${x.complete ? "" : " [incomplete]"}`, numbers: { risePct: r2(x.value), low: sig(x.low), last: sig(x.last), complete: x.complete } });
    }
  }
  if (r.feedVolume && feed) {
    const c = feed.coin(mint);
    const vol = c?.volume5m ?? null;
    if (c && vol && !feed.isStale(vol) && vol.value >= r.feedVolume.minVolume5mUsd) out.push({ mint, rule: "feedVolume", text: `Candle feed: ${Math.round(vol.value).toLocaleString("en-US")} USD traded in its rolling 5 min (feed value, observed ${new Date(vol.observedAt!).toISOString()})`, numbers: { volume5mUsd: Math.round(vol.value), observedAt: new Date(vol.observedAt!).toISOString(), source: "candle-feed", complete: false } });
  }
  return out;
}

export interface ScannerDeps {
  cfg: Config;
  ledger: Ledger;
  alerter: Alerter;
  log: Logger;
  series: SeriesSource & { tick?(force?: boolean): Promise<void>; status?(): Record<string, unknown>; stop?(): void };
  watchlist: Watchlist;
  feed: CandleFeed | null;
  now?: () => number;
}

export class Scanner implements Watcher {
  private d: ScannerDeps;
  private now: () => number;
  private last = new Map<string, Firing[]>();
  fired = 0;

  constructor(d: ScannerDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    d.ledger.db.exec(TABLE);
  }

  private cooldownMs(rule: RuleName): number {
    return (this.d.cfg.rules[rule]?.cooldownMin ?? 30) * 60_000;
  }

  async step(shouldStop: () => boolean = () => false): Promise<void> {
    await this.d.watchlist.step();
    if (shouldStop()) return;
    await this.d.series.tick?.();
    for (const mint of this.d.watchlist.watched()) {
      if (shouldStop()) return;
      const hits = evaluate(this.d.cfg, mint, this.d.series, this.d.feed);
      this.last.set(mint, hits);
      for (const h of hits) this.fire(h);
    }
  }

  /** Alert once per coin and rule per cooldown (kept in the ledger across restarts). */
  fire(h: Firing): boolean {
    const now = this.now();
    const row = this.d.ledger.db.prepare("select at from scan_fired where mint = ? and rule = ?").get(h.mint, h.rule) as { at: number } | undefined;
    if (row && now - row.at < this.cooldownMs(h.rule)) return false;
    this.d.ledger.db.prepare("insert into scan_fired (mint, rule, at) values (?, ?, ?) on conflict(mint, rule) do update set at = excluded.at").run(h.mint, h.rule, now);
    const link = this.d.cfg.rules.link ? ` ${this.d.cfg.rules.link.replace("{mint}", h.mint)}` : "";
    const sym = this.d.feed?.coin(h.mint)?.symbol;
    this.d.alerter.raise(`scan:${h.rule}:${h.mint}:${now}`, `${sym ? `$${sym} ` : ""}${h.mint}: ${h.text}.${link}`, { mint: h.mint, rule: h.rule, ...h.numbers });
    this.d.log.info("scan_fired", { mint: h.mint, rule: h.rule, ...h.numbers });
    this.fired++;
    return true;
  }

  status(): Record<string, unknown> {
    return {
      fired: this.fired,
      rules: Object.keys(this.d.cfg.rules).filter((k) => !["allowIncomplete", "link"].includes(k)),
      watchlist: this.d.watchlist.status(),
      series: this.d.series.status?.() ?? null,
      feed: this.d.feed?.status() ?? null,
      hits: Object.fromEntries([...this.last].filter(([, h]) => h.length).map(([m, h]) => [m, h.map((x) => x.rule)])),
    };
  }

  stop(): void {
    this.d.series.stop?.();
  }
}
