/**
 * The one config file: the core's shared sections (candle-bot-core) plus `adoption` (which bags to manage), `targets`
 * (per-coin exits, extra programs a linked wallet may sign for) and `sweep` (the home address profit is asked to go to,
 * the reserve kept). This bot never buys: a `buy` section is refused, and the core's buy caps are set to zero inside.
 * It never moves funds: a sweep is a request (sweep.ts). Unknown keys are refused at every level.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseConfig as parseCore, ConfigError, isObj, only, bool, num, strList, asAddress, type Config as CoreConfig, type SectionParser } from "candle-bot-core";
import { parseAdoption, type AdoptionConfig } from "candle-bot-core/adopt/adopter";
import { onCurve } from "candle-bot-core/solana/pda";
import { b58decode } from "candle-bot-core/solana/base58";

export { ConfigError } from "candle-bot-core/config";

export interface Targets {
  /** Per-coin exits: a mint's own `{ strategy, ...params }`, instead of `exit`. */
  exits: Record<string, { strategy: string; [k: string]: unknown }>;
  /** Linked wallet: refuse to sign a build that calls a program outside the known set (default true). */
  checkPrograms: boolean;
  /** Programs to add to the known set. */
  extraPrograms: string[];
  /** Linked wallet, pump.fun venues: Candle's sell floor may sit at most sell.maxSlippageBps plus this under the venue's own price (default 200). */
  sellFloorMarginBps: number;
}

export interface Sweep {
  /** The one address profit is asked to go to: full base58, from this config only. No default. */
  home: string;
  /** SOL the wallet keeps for fees and rent: a request never asks for more than the balance less this. */
  reserveSol: number;
  /** The smallest sweep asked for (SOL). */
  minSweepSol: number;
  /** How often profit is looked at (ms). */
  everyMs: number;
  /** Count bags adopted at the market price (`basis: "mark"`) as profit (default false: their cost is not known). */
  countMarkBasis: boolean;
  /** Addresses never accepted as home (look-alikes you know of, an old address). */
  denyHomes: string[];
}

export type Config = CoreConfig & { adoption: AdoptionConfig; targets: Targets; sweep: Sweep };

/** The core's buy section, all zero: the engine's caps refuse any buy. */
export const NO_BUYS = Object.freeze({ sol: 0.000001, maxSlippageBps: 0, maxOpen: 0, lifetimeSol: 0, maxPerCoin: 1 });

const parseTargets: SectionParser<Targets> = (raw) => {
  const r = raw === undefined ? {} : raw;
  if (!isObj(r)) throw new ConfigError("config.targets: must be an object");
  only(r, ["exits", "checkPrograms", "extraPrograms", "sellFloorMarginBps"], "config.targets");
  const exits: Targets["exits"] = {};
  const ex = r.exits === undefined ? {} : r.exits;
  if (!isObj(ex)) throw new ConfigError("config.targets.exits: an object { \"<mint>\": { \"strategy\": ..., ... } }");
  for (const [mint, spec] of Object.entries(ex)) {
    if (asAddress(mint) !== mint) throw new ConfigError(`config.targets.exits: "${mint}" is not a mint address`);
    if (!isObj(spec) || typeof spec.strategy !== "string" || !spec.strategy) throw new ConfigError(`config.targets.exits.${mint}: { "strategy": ..., params }`);
    exits[mint] = { ...(spec as Record<string, unknown>), strategy: spec.strategy };
  }
  return {
    exits,
    checkPrograms: bool(r, "checkPrograms", "config.targets", true),
    extraPrograms: strList(r, "extraPrograms", "config.targets", { def: [], address: true })!,
    sellFloorMarginBps: num(r, "sellFloorMarginBps", "config.targets", { min: 0, max: 10_000, int: true, def: 200 }),
  };
};

const adoptionSection: SectionParser<AdoptionConfig> = (raw, core) => parseAdoption(raw, core.baseDir);

/** Never a home: the system program, wrapped SOL, the token programs (a transfer there is lost or refused). */
const NEVER_HOME = new Set([
  "11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

const parseSweep: SectionParser<Sweep> = (raw, core) => {
  const w = "config.sweep";
  if (!isObj(raw)) throw new ConfigError(`${w}: required, with "home" (the full address profit is asked to go to)`);
  only(raw, ["home", "reserveSol", "minSweepSol", "everyMs", "countMarkBasis", "denyHomes"], w);
  const home = raw.home;
  if (typeof home !== "string" || asAddress(home) !== home) throw new ConfigError(`${w}.home: a full Solana address (base58, 32 bytes), written out in full`);
  if (home === core.wallet) throw new ConfigError(`${w}.home: is the bot's own wallet`);
  if (NEVER_HOME.has(home)) throw new ConfigError(`${w}.home: ${home} is a program or token address, not a wallet`);
  // A program-derived address (off the ed25519 curve) has no private key: SOL sent there is held by a program.
  if (!onCurve(b58decode(home))) throw new ConfigError(`${w}.home: ${home} is off the ed25519 curve (a program-derived address, not a wallet)`);
  const denyHomes = strList(raw, "denyHomes", w, { def: [], address: true })!;
  if (denyHomes.includes(home)) throw new ConfigError(`${w}.home: ${home} is in sweep.denyHomes`);
  return {
    home,
    reserveSol: num(raw, "reserveSol", w, { min: 0, max: 1_000, def: 0.05 }),
    minSweepSol: num(raw, "minSweepSol", w, { min: 0.000001, max: 1_000_000, def: 0.05 }),
    everyMs: num(raw, "everyMs", w, { min: 1_000, max: 86_400_000, int: true, def: 60_000 }),
    countMarkBasis: bool(raw, "countMarkBasis", w, false),
    denyHomes,
  };
};

export const SECTIONS = { adoption: adoptionSection, targets: parseTargets, sweep: parseSweep };

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
