/**
 * The one config file: the core's shared sections (candle-bot-core) plus `adoption` (which bags to manage) and
 * `manager` (per-coin exits, extra programs a linked wallet may sign for). This bot never buys: a `buy` section is
 * refused, and the core's buy caps are set to zero inside. Unknown keys are refused at every level.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseConfig as parseCore, ConfigError, isObj, only, bool, num, strList, asAddress, type Config as CoreConfig, type SectionParser } from "candle-bot-core";
import { parseAdoption, type AdoptionConfig } from "candle-bot-core/adopt/adopter";

export { ConfigError } from "candle-bot-core/config";

export interface Manager {
  /** Per-coin exits: a mint's own `{ strategy, ...params }`, instead of `exit`. */
  exits: Record<string, { strategy: string; [k: string]: unknown }>;
  /** Linked wallet: refuse to sign a build that calls a program outside the known set (default true). */
  checkPrograms: boolean;
  /** Programs to add to the known set. */
  extraPrograms: string[];
  /** Linked wallet, pump.fun venues: Candle's sell floor may sit at most sell.maxSlippageBps plus this under the venue's own price (default 200). */
  sellFloorMarginBps: number;
}

export type Config = CoreConfig & { adoption: AdoptionConfig; manager: Manager };

/** The core's buy section, all zero: the engine's caps refuse any buy. */
export const NO_BUYS = Object.freeze({ sol: 0.000001, maxSlippageBps: 0, maxOpen: 0, lifetimeSol: 0, maxPerCoin: 1 });

const parseManager: SectionParser<Manager> = (raw) => {
  const r = raw === undefined ? {} : raw;
  if (!isObj(r)) throw new ConfigError("config.manager: must be an object");
  only(r, ["exits", "checkPrograms", "extraPrograms", "sellFloorMarginBps"], "config.manager");
  const exits: Manager["exits"] = {};
  const ex = r.exits === undefined ? {} : r.exits;
  if (!isObj(ex)) throw new ConfigError("config.manager.exits: an object { \"<mint>\": { \"strategy\": ..., ... } }");
  for (const [mint, spec] of Object.entries(ex)) {
    if (asAddress(mint) !== mint) throw new ConfigError(`config.manager.exits: "${mint}" is not a mint address`);
    if (!isObj(spec) || typeof spec.strategy !== "string" || !spec.strategy) throw new ConfigError(`config.manager.exits.${mint}: { "strategy": ..., params }`);
    exits[mint] = { ...(spec as Record<string, unknown>), strategy: spec.strategy };
  }
  return {
    exits,
    checkPrograms: bool(r, "checkPrograms", "config.manager", true),
    extraPrograms: strList(r, "extraPrograms", "config.manager", { def: [], address: true })!,
    sellFloorMarginBps: num(r, "sellFloorMarginBps", "config.manager", { min: 0, max: 10_000, int: true, def: 200 }),
  };
};

const adoptionSection: SectionParser<AdoptionConfig> = (raw, core) => parseAdoption(raw, core.baseDir);

export const SECTIONS = { adoption: adoptionSection, manager: parseManager };

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  if (!isObj(raw)) throw new ConfigError("config: must be a JSON object");
  if (raw.buy !== undefined) throw new ConfigError("config.buy: this bot never buys; remove the buy section");
  const cfg = parseCore({ ...raw, buy: NO_BUYS }, baseDir, SECTIONS) as Config;
  for (const d of cfg.adoption.excludeStateDirs) if (resolve(d) === resolve(cfg.stateDir)) throw new ConfigError(`config.adoption.excludeStateDirs: "${d}" is this bot's own stateDir`);
  return cfg;
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
