/**
 * The one config file: the core's shared sections (candle-bot-core) plus `dca` (the schedules and the limits every run
 * shares). Unknown keys are refused at every level.
 *
 * A schedule buys, or sells, a fixed amount of one coin on a timer:
 *   { "id", "mint", "side": "buy" | "sell", "sol" | "fraction", "everySec", "atUtc"?, "jitterSec"?, "missed"?,
 *     "maxRuns"?, "until"?, "maxPriceSol"? (buy), "minPriceSol"? (sell), "maxImpactBps"?, "budgetSol"? (buy) }
 * A buy spends `sol` per run (at most buy.sol). A sell sells `sol` worth at the price then, or `fraction` of what the
 * bot holds of the coin. The timing keys are the core scheduler's (candle-bot-core/scheduler).
 *
 * `buy` is the core's section: buy.sol is the largest ticket, buy.lifetimeSol the cap on all buys ever, buy.maxOpen
 * the cap on lots held at once. It is required when a schedule buys, and left out when none does. `buy.maxPerCoin` is
 * not a key here: every run's buy is its own lot, any number per coin. `exit` (optional, default hold) is the exit
 * for the lots the bot bought.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseConfig as parseCore, ConfigError, isObj, only, num, bool, str, strList, asAddress, type Config as CoreConfig, type SectionParser } from "candle-bot-core";
import { parseSchedule, SCHEDULE_KEYS, type ScheduleSpec } from "candle-bot-core/scheduler";
import { withLots } from "candle-bot-core/lots";

export { ConfigError } from "candle-bot-core/config";

export interface DcaSchedule extends ScheduleSpec {
  mint: string;
  side: "buy" | "sell";
  /** Buy: SOL spent per run. Sell: SOL worth sold per run (at the price then). */
  sol: number | null;
  /** Sell: the share of what the bot holds of the coin, per run. */
  fraction: number | null;
  /** Buy: no buy above this price (SOL per whole token). */
  maxPriceSol: number | null;
  /** Sell: no sell under this price (SOL per whole token). */
  minPriceSol: number | null;
  /** The run's price impact cap (bps, the fee apart). Buy: at most dca.maxImpactBps. Sell: pump.fun venues only. */
  maxImpactBps: number | null;
  /** Buy: the most this schedule commits over all its runs (SOL). */
  budgetSol: number | null;
}

export interface Dca {
  schedules: DcaSchedule[];
  /** The buy's price impact cap (bps, the fee apart), at the decision and on every retry. */
  maxImpactBps: number;
  /** No attempt of a buy is built more than this many seconds after its run started. */
  buyWithinSec: number;
  /** Linked payer: sign only builds whose programs are known (the core's list plus extraPrograms). */
  checkPrograms: boolean;
  extraPrograms: string[];
  /** Linked payer: a sell is never signed below the venue's own expected out less sell.maxSlippageBps and this (pump.fun venues). */
  sellFloorMarginBps: number;
  /** Linked payer: a buy is never signed with a floor under the decision fill less buy.maxSlippageBps and this. */
  buyFloorMarginBps: number;
  /** A wallet bag worth less than this (SOL) is not booked as a lot. */
  minValueSol: number;
  /** Mints with a transfer fee up to this many bps may be booked and sold (default 0: none). */
  maxTransferFeeBps: number;
}

export type Config = CoreConfig & { dca: Dca };

/** The core's buy section when no schedule buys: every cap zero (the engine refuses any buy). */
export const NO_BUYS = Object.freeze({ sol: 0.000001, maxSlippageBps: 0, maxOpen: 0, lifetimeSol: 0, maxPerCoin: 1 });

const KEYS = [...SCHEDULE_KEYS, "mint", "side", "sol", "fraction", "maxPriceSol", "minPriceSol", "maxImpactBps", "budgetSol"];

const parseDca: SectionParser<Dca> = (raw, core) => {
  const w = "config.dca";
  if (!isObj(raw)) throw new ConfigError(`${w}: required, with "schedules"`);
  only(raw, ["schedules", "maxImpactBps", "buyWithinSec", "checkPrograms", "extraPrograms", "sellFloorMarginBps", "buyFloorMarginBps", "minValueSol", "maxTransferFeeBps"], w);
  const maxImpactBps = num(raw, "maxImpactBps", w, { min: 0, max: 10_000, int: true, def: 300 });
  const list = raw.schedules;
  if (!Array.isArray(list) || !list.length) throw new ConfigError(`${w}.schedules: a list of at least one schedule`);
  const schedules: DcaSchedule[] = [];
  const buyMints = new Set<string>();
  for (const [i, e] of list.entries()) {
    const at = `${w}.schedules[${i}]`;
    if (!isObj(e)) throw new ConfigError(`${at}: an object`);
    only(e, KEYS, at);
    const mint = str(e, "mint", at)!;
    if (asAddress(mint) !== mint) throw new ConfigError(`${at}.mint: set the coin's mint address (base58), not "${mint}"`);
    const side = str(e, "side", at) as "buy" | "sell";
    if (side !== "buy" && side !== "sell") throw new ConfigError(`${at}.side: "buy" or "sell"`);
    const spec = parseSchedule(e, at);
    if (schedules.some((s) => s.id === spec.id)) throw new ConfigError(`${at}.id: "${spec.id}" is used twice`);
    const sol = e.sol === undefined ? null : num(e, "sol", at, { min: 0.000001, max: 1000 });
    const fraction = e.fraction === undefined ? null : num(e, "fraction", at, { min: 0.000001, max: 1 });
    const maxPriceSol = e.maxPriceSol === undefined ? null : num(e, "maxPriceSol", at, { min: 0 });
    const minPriceSol = e.minPriceSol === undefined ? null : num(e, "minPriceSol", at, { min: 0 });
    const cap = e.maxImpactBps === undefined ? null : num(e, "maxImpactBps", at, { min: 0, max: 10_000, int: true });
    const budgetSol = e.budgetSol === undefined ? null : num(e, "budgetSol", at, { min: 0.000001 });
    if (side === "buy") {
      if (sol === null) throw new ConfigError(`${at}.sol: required for a buy (SOL per run)`);
      if (fraction !== null) throw new ConfigError(`${at}.fraction: only for a sell (a buy spends "sol")`);
      if (minPriceSol !== null) throw new ConfigError(`${at}.minPriceSol: only for a sell (a buy has maxPriceSol)`);
      if (sol > core.buy.sol) throw new ConfigError(`${at}.sol: ${sol} is over buy.sol ${core.buy.sol} (the largest ticket)`);
      if (cap !== null && cap > maxImpactBps) throw new ConfigError(`${at}.maxImpactBps: at most dca.maxImpactBps ${maxImpactBps} (the retry limit)`);
      if (budgetSol !== null && budgetSol < sol) throw new ConfigError(`${at}.budgetSol: under one run's sol`);
      // The engine keeps one candidate per coin: a second buy schedule on the coin would replace the first's.
      if (buyMints.has(mint)) throw new ConfigError(`${at}.mint: one buy schedule per coin (merge them, or give the second its own bot)`);
      buyMints.add(mint);
    } else {
      if ((sol === null) === (fraction === null)) throw new ConfigError(`${at}: a sell takes one of "sol" (SOL worth per run) or "fraction" (of what the bot holds)`);
      if (maxPriceSol !== null) throw new ConfigError(`${at}.maxPriceSol: only for a buy (a sell has minPriceSol)`);
      if (budgetSol !== null) throw new ConfigError(`${at}.budgetSol: only for a buy (a sell is bounded by what the bot holds, maxRuns and until)`);
    }
    schedules.push({ ...spec, mint, side, sol, fraction, maxPriceSol, minPriceSol, maxImpactBps: cap, budgetSol });
  }
  return {
    schedules,
    maxImpactBps,
    buyWithinSec: num(raw, "buyWithinSec", w, { min: 5, max: 3600, int: true, def: 60 }),
    checkPrograms: bool(raw, "checkPrograms", w, true),
    extraPrograms: strList(raw, "extraPrograms", w, { def: [], address: true })!,
    sellFloorMarginBps: num(raw, "sellFloorMarginBps", w, { min: 0, max: 10_000, int: true, def: 200 }),
    buyFloorMarginBps: num(raw, "buyFloorMarginBps", w, { min: 0, max: 10_000, int: true, def: 200 }),
    minValueSol: num(raw, "minValueSol", w, { min: 0, def: 0.001 }),
    maxTransferFeeBps: num(raw, "maxTransferFeeBps", w, { min: 0, max: 10_000, int: true, def: 0 }),
  };
};

export const SECTIONS = { dca: parseDca };

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  if (!isObj(raw)) throw new ConfigError("config: must be a JSON object");
  if (isObj(raw.buy) && raw.buy.maxPerCoin !== undefined) throw new ConfigError("config.buy.maxPerCoin: not used here (every run's buy is its own lot)");
  const d = raw.dca;
  const buys = isObj(d) && Array.isArray(d.schedules) && d.schedules.some((s) => isObj(s) && s.side === "buy");
  if (raw.buy === undefined && buys) throw new ConfigError("config.buy: required when a schedule buys ({ sol: the largest ticket, maxSlippageBps, maxOpen: lots held at once, lifetimeSol: all buys ever })");
  const withDefaults = { ...raw, ...(raw.buy === undefined ? { buy: NO_BUYS } : {}), ...(raw.exit === undefined ? { exit: { strategy: "hold" } } : {}) };
  return withLots(parseCore(withDefaults, baseDir, SECTIONS) as Config);
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
