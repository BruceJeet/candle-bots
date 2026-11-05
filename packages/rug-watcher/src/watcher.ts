/**
 * The rug watcher: no entries (its trigger never offers a candidate), the core's Adopter for the coins it watches,
 * pump.fun venues and pool SOL read on every exit tick, the rules (watch.ts) on those reads and on polled holders, and
 * an exit strategy (RugExit) that sells what a firing owes before it asks the configured `exit` (default hold).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Engine, Executor, loadStrategy, type AdoptionHook, type Alerter, type Candidate, type ExitStrategy, type PendingInfo, type Trigger } from "candle-bot-core";
import { Adopter } from "candle-bot-core/adopt/adopter";
import { KNOWN_PROGRAMS } from "candle-bot-core/exec/trader";
import { dryPricer, sellFloor, type MarketRead, type ReadOptions } from "candle-bot-core/market/reader";
import { HolderPoller, creatorOf, type HolderSource } from "candle-bot-core/sources/holders";
import { parts, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import type { Ledger } from "candle-bot-core/ledger";
import { ConfigError, type Config } from "./config.ts";
import { RugWatch } from "./watch.ts";

type Ctx = CoreCtx<Config>;

/** Pump.fun curves and PumpSwap pools, and the SOL in every venue (the liquidity rule reads it). */
export const VENUES: ReadOptions = Object.freeze({ pump: true, reserves: true });

/** Sells a firing still owes first; otherwise the configured exit decides. The tick's read is sampled here too. */
export class RugExit implements ExitStrategy {
  readonly name: string;
  readonly trailMark: boolean;
  readonly needsBasis: boolean;
  readonly fallback: ExitStrategy;
  private watch: RugWatch;
  private positionOf: (mint: string) => ReturnType<Ledger["position"]>;
  constructor(fallback: ExitStrategy, watch: RugWatch, positionOf: (mint: string) => ReturnType<Ledger["position"]>) {
    this.fallback = fallback;
    this.watch = watch;
    this.positionOf = positionOf;
    this.name = `rug+${fallback.name}`;
    this.trailMark = fallback.trailMark === true;
    this.needsBasis = fallback.needsBasis !== false;
  }
  onTick(p: Parameters<ExitStrategy["onTick"]>[0], m: Parameters<ExitStrategy["onTick"]>[1]) {
    const row = this.positionOf(p.mint);
    if (row) {
      this.watch.observeOne(row, m as MarketRead);
      const owed = this.watch.pendingSell(row.id);
      if (owed) return { action: "sell" as const, fraction: owed.fraction, reason: owed.reason };
    }
    return this.fallback.onTick(p, m);
  }
}

export class WatcherTrigger implements Trigger {
  readonly name = "rug-watcher";
  readonly candidateLabel = "candidates";
  readonly buyIdPrefix = "crwb";
  readonly sellIdPrefix = "crws";
  private cfg: Config;
  adopter: Adopter | null = null;
  watch: RugWatch | null = null;
  engine: Engine | null = null;
  constructor(cfg: Config) {
    this.cfg = cfg;
  }
  poll(): Candidate[] {
    return [];
  }
  decide() {
    return { verdict: "skip" as const, reason: "this bot never buys" };
  }
  status(_pending: Array<{ candidate: Candidate } & PendingInfo>): Record<string, unknown> {
    const a = this.adopter;
    const w = this.watch;
    if (!a || !w) return {};
    const watched = a.managed().map((r) => {
      const p = r.position;
      const m = this.engine?.market(p.mint);
      const c = w.creatorRow(p.mint);
      return {
        position: p.id, mint: p.mint, status: p.status, venue: m?.venue ?? null, lastPriceSol: p.last_price,
        poolSol: typeof m?.quoteLiquidityLamports === "bigint" ? Number(m.quoteLiquidityLamports) / 1e9 : null,
        creator: c ? { wallet: c.creator, source: c.source, maxHeldRaw: c.max_raw } : null,
        remainingRaw: p.remaining_raw, basis: r.basis_source,
        fired: w.events(p.id).map((e) => ({ event: e.id, rule: e.rule, key: e.key, at: new Date(e.fired_at).toISOString(), alertOnly: !!e.alert_only, sell: e.sell, sold: e.done_at !== null, numbers: JSON.parse(e.numbers) })),
      };
    });
    return { watched, rules: Object.keys(this.cfg.rules), adoption: { mode: this.cfg.adoption.mode, skipped: a.skips }, sellsPaused: this.engine?.sellsPaused() ?? false };
  }
}

export interface Built {
  engine: Engine;
  trigger: WatcherTrigger;
  adopter: Adopter;
  watch: RugWatch;
  exit: RugExit;
}

/** Linked wallet with checkPrograms on: the programs it may sign for (core KNOWN_PROGRAMS plus extraPrograms). */
export function knownProgramsFor(cfg: Config): Set<string> | undefined {
  return cfg.payer === "linked" && cfg.watch.checkPrograms ? new Set([...KNOWN_PROGRAMS, ...cfg.watch.extraPrograms]) : undefined;
}

/** Every excludeStateDirs entry must hold a ledger at start (a missing one would hold every sell of an adopted bag). */
export function checkExcludeDirs(cfg: Config): void {
  for (const d of cfg.adoption.excludeStateDirs) if (!existsSync(join(d, "ledger.sqlite"))) throw new ConfigError(`config.adoption.excludeStateDirs: no ledger.sqlite in ${d}`);
}

/** The engine for this config: executor (pump dry pricing; the signing checks for a linked wallet), adopter, watcher. */
export async function makeWatcher(ctx: Ctx, ledger: Ledger): Promise<Built> {
  const cfg = ctx.cfg;
  checkExcludeDirs(cfg);
  const fallback = await loadStrategy(cfg.exit, cfg.configDir);
  const known = knownProgramsFor(cfg);
  const decimalsOf = (m: string) => ledger.allPositions().find((p) => p.mint === m)?.decimals ?? 6;
  const { alerter, executor } = await parts(ctx, ledger, {
    maxBuyImpactBps: 0,
    executor: (d) => new Executor({ ...d, dry: dryPricer(ctx.rpc, ctx.client, decimalsOf, { pump: true }), ...(known ? { knownPrograms: known } : {}), ...(cfg.payer === "linked" ? { sellFloor: sellFloor(ctx.rpc, cfg.sell.maxSlippageBps, cfg.watch.sellFloorMarginBps) } : {}) }),
  });
  return assemble({ cfg, ledger, rpc: ctx.rpc, log: ctx.log, alerter, executor, fallback });
}

/** The adopter, watcher, trigger and engine around an executor (a library user, or a test, brings its own parts). */
export function assemble(d: { cfg: Config; ledger: Ledger; rpc: Ctx["rpc"]; log: Ctx["log"]; alerter: Alerter; executor: Executor; fallback: ExitStrategy; holders?: HolderSource; now?: () => number }): Built {
  const { cfg, ledger } = d;
  const adopter = new Adopter({
    cfg, adoption: cfg.adoption, ledger, rpc: d.rpc, log: d.log, alerter: d.alerter, holds: d.executor, venues: VENUES, now: d.now,
    needsBasis: () => d.fallback.needsBasis !== false,
    strategyName: () => d.fallback.name,
  });
  let engine: Engine | null = null;
  const watch = new RugWatch({
    cfg, ledger, log: d.log, alerter: d.alerter, now: d.now,
    holders: d.holders ?? new HolderPoller(d.rpc, d.now),
    creatorOf: (mint) => creatorOf(d.rpc, mint),
    managed: () => adopter.managed().map((r) => r.position),
    market: (mint) => engine?.market(mint),
    sellsPaused: () => engine?.sellsPaused() ?? false,
  });
  const positionOf = (mint: string) => adopter.managed().find((r) => r.mint === mint)?.position;
  const exit = new RugExit(d.fallback, watch, positionOf);
  // The watcher runs in the adoption step of each full cycle, after the adopter, whatever the adopter did.
  const hook: AdoptionHook = {
    async step(shouldStop) {
      try {
        await adopter.step(shouldStop);
      } finally {
        watch.observe();
        await watch.poll(shouldStop);
      }
    },
    sellCheck: (p) => adopter.sellCheck(p),
  };
  const trigger = new WatcherTrigger(cfg);
  engine = new Engine({ cfg, ledger, trigger, executor: d.executor, strategy: exit, rpc: d.rpc, log: d.log, alerter: d.alerter, venues: VENUES, adopter: hook, pauseSells: true, now: d.now });
  trigger.adopter = adopter;
  trigger.watch = watch;
  trigger.engine = engine;
  return { engine, trigger, adopter, watch, exit };
}

export const ledgerPath = (cfg: Config) => join(cfg.stateDir, "ledger.sqlite");
