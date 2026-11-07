/**
 * The one config file: the core's shared sections (candle-bot-core) plus `rebalance` (the targets, the bands, the caps
 * and the schedule). Unknown keys are refused at every level.
 *
 * `buy` is the core's section: buy.sol is the largest single buy, buy.lifetimeSol the cap on all buys ever,
 * buy.maxOpen the cap on lots held at once (each buy is its own lot). `buy.maxPerCoin` is not a key here. There is no
 * `exit`: the rebalancer sells only to rebalance (its lots hold between runs).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseConfig as parseCore, ConfigError, isObj, only, num, bool, strList, asAddress, type Config as CoreConfig, type SectionParser } from "candle-bot-core";
import { parseSchedule, SCHEDULE_KEYS, type ScheduleSpec } from "candle-bot-core/scheduler";
import { withLots } from "candle-bot-core/lots";
import { WSOL } from "candle-bot-core/solana/pda";

export { ConfigError } from "candle-bot-core/config";

/** The schedule's id in the ledger (one schedule per bot). */
export const SCHEDULE_ID = "rebalance";
export const MAX_TARGETS = 20;

export interface Rebalance {
  /** Target weight per coin; with solWeight they sum to 1. */
  targets: Record<string, number>;
  solWeight: number;
  /** A coin trades only when its weight is off its target by more than this (percentage points). */
  bandPct: number;
  /** Orders under this (SOL at the price then) are dropped. */
  minTradeSol: number;
  /** SOL moved per run at most (sells and buys together, at the decision prices). */
  maxSolPerRun: number;
  /** SOL never counted or spent (fees, rent). */
  reserveSol: number;
  schedule: ScheduleSpec;
  /** A buy's price impact cap (bps, the fee apart), at the decision and on every retry. */
  maxImpactBps: number;
  /** No attempt of a buy is built more than this many seconds after its decision. */
  buyWithinSec: number;
  checkPrograms: boolean;
  extraPrograms: string[];
  sellFloorMarginBps: number;
  buyFloorMarginBps: number;
  /** A wallet bag worth less than this (SOL) is not booked as a lot. */
  minValueSol: number;
  maxTransferFeeBps: number;
}

export type Config = CoreConfig & { rebalance: Rebalance };

const parseRebalance: SectionParser<Rebalance> = (raw, core) => {
  const w = "config.rebalance";
  if (!isObj(raw)) throw new ConfigError(`${w}: required, with "targets", "solWeight", "maxSolPerRun" and "schedule"`);
  only(raw, ["targets", "solWeight", "bandPct", "minTradeSol", "maxSolPerRun", "reserveSol", "schedule", "maxImpactBps", "buyWithinSec", "checkPrograms", "extraPrograms", "sellFloorMarginBps", "buyFloorMarginBps", "minValueSol", "maxTransferFeeBps"], w);
  const t = raw.targets;
  if (!isObj(t) || !Object.keys(t).length) throw new ConfigError(`${w}.targets: an object { "<mint>": weight, ... } with at least one coin`);
  if (Object.keys(t).length > MAX_TARGETS) throw new ConfigError(`${w}.targets: at most ${MAX_TARGETS} coins`);
  const targets: Record<string, number> = {};
  for (const [mint, v] of Object.entries(t)) {
    if (asAddress(mint) !== mint) throw new ConfigError(`${w}.targets: "${mint}" is not a mint address (set the coin's mint)`);
    if (mint === WSOL) throw new ConfigError(`${w}.targets: wrapped SOL is SOL; give its weight as solWeight`);
    targets[mint] = num(t, mint, `${w}.targets`, { min: 0, max: 1 });
  }
  const solWeight = num(raw, "solWeight", w, { min: 0, max: 1 });
  const sum = Object.values(targets).reduce((s, x) => s + x, solWeight);
  if (Math.abs(sum - 1) > 1e-6) throw new ConfigError(`${w}: the targets and solWeight must sum to 1 (they sum to ${+sum.toFixed(9)})`);
  const maxSolPerRun = num(raw, "maxSolPerRun", w, { min: 0.000001, max: 1_000_000 });
  const minTradeSol = num(raw, "minTradeSol", w, { min: 0, def: 0.01 });
  if (minTradeSol > maxSolPerRun) throw new ConfigError(`${w}.minTradeSol: over maxSolPerRun`);
  if (minTradeSol > core.buy.sol) throw new ConfigError(`${w}.minTradeSol: over buy.sol ${core.buy.sol} (the largest buy): no buy could pass it`);
  const s = raw.schedule;
  if (!isObj(s)) throw new ConfigError(`${w}.schedule: required, e.g. { "everySec": 3600 } (optional atUtc, jitterSec, missed, maxRuns, until)`);
  const keys = SCHEDULE_KEYS.filter((k) => k !== "id");
  only(s, keys, `${w}.schedule`);
  const schedule = parseSchedule({ ...s, id: SCHEDULE_ID }, `${w}.schedule`);
  return {
    targets, solWeight,
    bandPct: num(raw, "bandPct", w, { min: 0, max: 100, def: 5 }),
    minTradeSol, maxSolPerRun,
    reserveSol: num(raw, "reserveSol", w, { min: 0, max: 1000, def: 0.05 }),
    schedule,
    maxImpactBps: num(raw, "maxImpactBps", w, { min: 0, max: 10_000, int: true, def: 300 }),
    buyWithinSec: num(raw, "buyWithinSec", w, { min: 5, max: 3600, int: true, def: 60 }),
    checkPrograms: bool(raw, "checkPrograms", w, true),
    extraPrograms: strList(raw, "extraPrograms", w, { def: [], address: true })!,
    sellFloorMarginBps: num(raw, "sellFloorMarginBps", w, { min: 0, max: 10_000, int: true, def: 200 }),
    buyFloorMarginBps: num(raw, "buyFloorMarginBps", w, { min: 0, max: 10_000, int: true, def: 200 }),
    minValueSol: num(raw, "minValueSol", w, { min: 0, def: 0.001 }),
    maxTransferFeeBps: num(raw, "maxTransferFeeBps", w, { min: 0, max: 10_000, int: true, def: 0 }),
  };
};

export const SECTIONS = { rebalance: parseRebalance };

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  if (!isObj(raw)) throw new ConfigError("config: must be a JSON object");
  if (raw.exit !== undefined) throw new ConfigError("config.exit: the rebalancer sells only to rebalance; remove the exit section");
  if (isObj(raw.buy) && raw.buy.maxPerCoin !== undefined) throw new ConfigError("config.buy.maxPerCoin: not used here (every buy is its own lot)");
  return withLots(parseCore({ ...raw, exit: { strategy: "hold" } }, baseDir, SECTIONS) as Config);
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`cannot read config ${path}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`config ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw, dirname(resolve(path)));
}
