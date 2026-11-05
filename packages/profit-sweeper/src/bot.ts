/**
 * The profit sweeper: the exit manager's engine (no entries, a strategy per coin, the core's Adopter, pump.fun venues,
 * PAUSE_SELLS, the linked-wallet signing checks) plus the Sweeper (sweep.ts), which asks for realized profit to be sent
 * home and never moves funds itself.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Engine, Executor, loadStrategy, type Alerter, type Candidate, type ExitStrategy, type PendingInfo, type Trigger } from "candle-bot-core";
import { Adopter } from "candle-bot-core/adopt/adopter";
import { KNOWN_PROGRAMS } from "candle-bot-core/exec/trader";
import { dryPricer, sellFloor } from "candle-bot-core/market/reader";
import { parts, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import type { Ledger, PositionRow } from "candle-bot-core/ledger";
import { ConfigError, type Config } from "./config.ts";
import { Sweeper } from "./sweep.ts";
import type { AdoptionHook } from "candle-bot-core";

type Ctx = CoreCtx<Config>;

/** One strategy per coin: `targets.exits[mint]`, else `exit`. */
export class ByMint implements ExitStrategy {
  readonly name: string;
  readonly trailMark: boolean;
  readonly needsBasis: boolean;
  readonly fallback: ExitStrategy;
  readonly perMint: Map<string, ExitStrategy>;
  constructor(fallback: ExitStrategy, perMint: Map<string, ExitStrategy>) {
    this.fallback = fallback;
    this.perMint = perMint;
    this.name = fallback.name;
    this.trailMark = fallback.trailMark === true || [...perMint.values()].some((s) => s.trailMark === true);
    this.needsBasis = this.of("").needsBasis !== false;
  }
  of(mint: string): ExitStrategy {
    return this.perMint.get(mint) ?? this.fallback;
  }
  onTick(p: Parameters<ExitStrategy["onTick"]>[0], m: Parameters<ExitStrategy["onTick"]>[1]) {
    return this.of(p.mint).onTick(p, m);
  }
}

export async function loadExits(cfg: Config): Promise<ByMint> {
  const fallback = await loadStrategy(cfg.exit, cfg.configDir);
  const per = new Map<string, ExitStrategy>();
  for (const [mint, spec] of Object.entries(cfg.targets.exits)) per.set(mint, await loadStrategy(spec, cfg.configDir));
  return new ByMint(fallback, per);
}

/** What the strategy would do next for a bag, in words (status.json). */
export function nextExit(spec: Record<string, unknown>, p: PositionRow, trailMark: number | undefined): string {
  const qty = BigInt(p.qty_raw);
  const entry = qty > 0n && BigInt(p.cost_lamports) > 0n ? Number(BigInt(p.cost_lamports)) / 1e9 / (Number(qty) / 10 ** p.decimals) : null;
  const sol = (x: number) => `${x.toPrecision(4)} SOL`;
  switch (spec.strategy) {
    case "trail": {
      const mark = trailMark ?? p.peak_price;
      const at = mark * (1 - Number(spec.trailBps) / 10_000);
      const act = spec.activate === undefined ? "" : entry === null ? " (not armed: no basis)" : p.peak_price < entry * Number(spec.activate) ? `, armed at ${sol(entry * Number(spec.activate))}` : "";
      return `trail: sells ${Number(spec.sell ?? 1) < 1 ? `${Number(spec.sell) * 100} % ` : ""}at <= ${sol(at)} (mark ${sol(mark)})${act}`;
    }
    case "tpsl":
      if (entry === null) return "tpsl: no basis (holds)";
      return `tpsl:${spec.takeProfit !== undefined ? ` take profit at >= ${sol(entry * Number(spec.takeProfit))}` : ""}${spec.stopLoss !== undefined ? ` stop at <= ${sol(entry * Number(spec.stopLoss))}` : ""}${spec.trailing !== undefined ? ` trailing ${Number(spec.trailing) * 100} %` : ""}`;
    case "ladder": {
      if (entry === null) return "ladder: no basis (holds)";
      const rungs = (spec.rungs as Array<{ at: number; sell: number }>) ?? [];
      const base = Number(BigInt(p.qty_raw) - BigInt(p.written_down_raw ?? "0"));
      const sold = base > 0 ? (base - Number(p.remaining_raw)) / base : 0;
      let cum = 0;
      for (const r of rungs) {
        cum += r.sell;
        if (cum - sold > 1e-6) return `ladder: next rung ${r.at}x at ${sol(entry * r.at)}${spec.stopLoss ? `, stop at ${sol(entry * Number(spec.stopLoss))}` : ""}`;
      }
      return `ladder: all rungs sold${spec.stopLoss ? `, stop at ${sol(entry * Number(spec.stopLoss))}` : ""}`;
    }
    case "time":
      return `time: at ${new Date(p.opened_at + Number(spec.afterSec) * 1000).toISOString()}`;
    case "hold":
      return "hold: only a manual sell";
    case "preGrad":
      return `preGrad: at ${Number(spec.progress) * 100} % progress or on migration`;
    default:
      return `custom (${String(spec.strategy)})`;
  }
}

export class SweeperTrigger implements Trigger {
  readonly name = "profit-sweeper";
  readonly candidateLabel = "candidates";
  readonly buyIdPrefix = "cpsb";
  readonly sellIdPrefix = "cpss";
  private cfg: Config;
  private ledger: Ledger;
  adopter: Adopter | null = null;
  engine: Engine | null = null;
  sweeper: Sweeper | null = null;
  constructor(cfg: Config, ledger: Ledger) {
    this.cfg = cfg;
    this.ledger = ledger;
  }
  poll(): Candidate[] {
    return [];
  }
  decide() {
    return { verdict: "skip" as const, reason: "this bot never buys" };
  }
  status(_pending: Array<{ candidate: Candidate } & PendingInfo>): Record<string, unknown> {
    const a = this.adopter;
    if (!a) return {};
    const managed = a.managed().map((r) => {
      const p = r.position;
      const spec = this.cfg.targets.exits[p.mint] ?? this.cfg.exit;
      let mark: number | undefined;
      try {
        mark = this.ledger.trailMark(p.id);
      } catch {
        mark = undefined;
      }
      return { position: p.id, mint: p.mint, status: p.status, venue: this.engine?.market(p.mint)?.venue ?? null, basis: r.basis_source, costSol: Number(BigInt(p.cost_lamports)) / 1e9, remainingRaw: p.remaining_raw, lastPriceSol: p.last_price, strategy: spec.strategy, nextExit: nextExit(spec, p, mark) };
    });
    return { managed, sweep: this.sweeper?.status() ?? null, adoption: { mode: this.cfg.adoption.mode, skipped: a.skips }, sellsPaused: this.engine?.sellsPaused() ?? false };
  }
}

export interface Built {
  engine: Engine;
  trigger: SweeperTrigger;
  adopter: Adopter;
  exits: ByMint;
  sweeper: Sweeper;
}

/** Linked wallet with checkPrograms on: the programs it may sign for (core KNOWN_PROGRAMS plus extraPrograms). */
export function knownProgramsFor(cfg: Config): Set<string> | undefined {
  return cfg.payer === "linked" && cfg.targets.checkPrograms ? new Set([...KNOWN_PROGRAMS, ...cfg.targets.extraPrograms]) : undefined;
}

/** Every excludeStateDirs entry must hold a ledger at start (a missing one would hold every sell of an adopted bag). */
export function checkExcludeDirs(cfg: Config): void {
  for (const d of cfg.adoption.excludeStateDirs) if (!existsSync(join(d, "ledger.sqlite"))) throw new ConfigError(`config.adoption.excludeStateDirs: no ledger.sqlite in ${d}`);
}

export async function makeSweeper(ctx: Ctx, ledger: Ledger): Promise<Built> {
  const cfg = ctx.cfg;
  checkExcludeDirs(cfg);
  const exits = await loadExits(cfg);
  const known = knownProgramsFor(cfg);
  const decimalsOf = (m: string) => ledger.allPositions().find((p) => p.mint === m)?.decimals ?? 6;
  const { alerter, executor } = await parts(ctx, ledger, {
    maxBuyImpactBps: 0,
    executor: (d) => new Executor({ ...d, dry: dryPricer(ctx.rpc, ctx.client, decimalsOf, { pump: true }), ...(known ? { knownPrograms: known } : {}), ...(cfg.payer === "linked" ? { sellFloor: sellFloor(ctx.rpc, cfg.sell.maxSlippageBps, cfg.targets.sellFloorMarginBps) } : {}) }),
  });
  return assemble({ cfg, ledger, rpc: ctx.rpc, log: ctx.log, alerter, executor, exits });
}

/** The adopter, the trigger and the engine around an executor (a library user, or a test, brings its own executor). */
export function assemble(d: { cfg: Config; ledger: Ledger; rpc: Ctx["rpc"]; log: Ctx["log"]; alerter: Alerter; executor: Executor; exits: ByMint; now?: () => number }): Built {
  const { cfg, ledger, exits } = d;
  const adopter = new Adopter({
    cfg, adoption: cfg.adoption, ledger, rpc: d.rpc, log: d.log, alerter: d.alerter, holds: d.executor, venues: { pump: true }, now: d.now,
    needsBasis: (mint) => exits.of(mint).needsBasis !== false,
    strategyName: (mint) => exits.of(mint).name,
  });
  const sweeper = new Sweeper({ cfg, ledger, rpc: d.rpc, log: d.log, alerter: d.alerter, now: d.now, basisOf: (id) => adopter.adoption(id)?.basis_source });
  // The sweeper runs in the adoption step of each full cycle, after the adopter, whatever the adopter did.
  const hook: AdoptionHook = {
    async step(shouldStop) {
      try {
        await adopter.step(shouldStop);
      } finally {
        if (!shouldStop()) await sweeper.step();
      }
    },
    sellCheck: (p) => adopter.sellCheck(p),
  };
  const trigger = new SweeperTrigger(cfg, ledger);
  const engine = new Engine({ cfg, ledger, trigger, executor: d.executor, strategy: exits, rpc: d.rpc, log: d.log, alerter: d.alerter, venues: { pump: true }, adopter: hook, pauseSells: true, now: d.now });
  trigger.adopter = adopter;
  trigger.engine = engine;
  trigger.sweeper = sweeper;
  return { engine, trigger, adopter, exits, sweeper };
}

export const ledgerPath = (cfg: Config) => join(cfg.stateDir, "ledger.sqlite");
