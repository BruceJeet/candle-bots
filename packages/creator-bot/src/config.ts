/**
 * The one config file: the core's shared sections (candle-bot-core) plus `follow` (the creators and the global filters)
 * and `detect` (where launches are seen). Unknown keys are refused at every level.
 */
import { parseConfig as parseCore, loadConfig as loadCore, ConfigError, isObj, only, num, bool, str, strList, asAddress, type Config as CoreConfig, type SectionParser } from "candle-bot-core";

export { ConfigError } from "candle-bot-core/config";

export interface Creator {
  address: string;
  label?: string;
  /** This creator's ticket, SOL; at most buy.sol (default buy.sol). */
  sol: number;
  /** Most buys of this creator's launches over the bot's lifetime (optional). */
  maxEntries?: number;
  /** Most SOL spent on this creator's launches over the bot's lifetime (optional). */
  maxSol?: number;
}

export interface Follow {
  creators: Creator[];
  launchModes: string[];
  maxAgeSec: number;
  maxImpactBps: number;
  inferModeFromCurve: boolean;
  /** Buy only once the creator's wallet holds the coin (its own dev buy). */
  requireDevBuy: boolean;
}

export interface Detect {
  api: boolean;
  chain: boolean;
  apiPollMs: number;
  chainPollMs: number;
  apiLimit: number;
}

export type Config = CoreConfig & { follow: Follow; detect: Detect };

/** Candle's launch modes (agent-sdk 0.6.14 launch-definition `curve.values`). */
export const LAUNCH_MODES = ["open", "exclusive", "test-open", "test-exclusive", "exp-a", "exp-b", "exp-c", "exp-custom"];
/** Every production mode: the default, since the list of creators is the main filter. */
export const DEFAULT_MODES = ["open", "exclusive", "exp-a", "exp-b", "exp-c", "exp-custom"];

const parseFollow: SectionParser<Follow> = (raw, core) => {
  if (!isObj(raw)) throw new ConfigError("config.follow: required object with a `creators` list");
  only(raw, ["creators", "launchModes", "maxAgeSec", "maxImpactBps", "inferModeFromCurve", "requireDevBuy"], "config.follow");
  const list = raw.creators;
  if (!Array.isArray(list) || !list.length) throw new ConfigError("config.follow.creators: required, a list of { address, label?, sol?, maxEntries?, maxSol? }");
  const seen = new Set<string>();
  const creators = list.map((c, i): Creator => {
    const where = `config.follow.creators[${i}]`;
    if (!isObj(c)) throw new ConfigError(`${where}: must be an object`);
    only(c, ["address", "label", "sol", "maxEntries", "maxSol"], where);
    const address = str(c, "address", where)!;
    if (!asAddress(address)) throw new ConfigError(`${where}.address: "${address}" is not an address`);
    if (seen.has(address)) throw new ConfigError(`${where}.address: listed twice`);
    seen.add(address);
    const sol = num(c, "sol", where, { min: 0.000001, def: core.buy.sol });
    if (sol > core.buy.sol) throw new ConfigError(`${where}.sol: ${sol} is above buy.sol (${core.buy.sol}); a creator's ticket can only be smaller`);
    return {
      address,
      label: str(c, "label", where, { optional: true }),
      sol,
      maxEntries: c.maxEntries === undefined ? undefined : num(c, "maxEntries", where, { min: 1, int: true }),
      maxSol: c.maxSol === undefined ? undefined : num(c, "maxSol", where, { min: 0.000001 }),
    };
  });
  const launchModes = strList(raw, "launchModes", "config.follow", { def: DEFAULT_MODES })!;
  if (!launchModes.length) throw new ConfigError("config.follow.launchModes: at least one mode");
  for (const m of launchModes) if (!LAUNCH_MODES.includes(m)) throw new ConfigError(`config.follow.launchModes: "${m}" is not a Candle launch mode (${LAUNCH_MODES.join(", ")})`);
  return {
    creators,
    launchModes,
    maxAgeSec: num(raw, "maxAgeSec", "config.follow", { min: 1, def: 60 }),
    maxImpactBps: num(raw, "maxImpactBps", "config.follow", { min: 0, max: 10_000, def: 300 }),
    inferModeFromCurve: bool(raw, "inferModeFromCurve", "config.follow", true),
    requireDevBuy: bool(raw, "requireDevBuy", "config.follow", false),
  };
};

function parseDetect(raw: unknown): Detect {
  const d = raw === undefined ? {} : raw;
  if (!isObj(d)) throw new ConfigError("config.detect: must be an object");
  only(d, ["api", "chain", "apiPollMs", "chainPollMs", "apiLimit"], "config.detect");
  const detect = {
    api: bool(d, "api", "config.detect", true),
    chain: bool(d, "chain", "config.detect", true),
    apiPollMs: num(d, "apiPollMs", "config.detect", { min: 500, int: true, def: 3000 }),
    chainPollMs: num(d, "chainPollMs", "config.detect", { min: 1000, int: true, def: 15_000 }),
    apiLimit: num(d, "apiLimit", "config.detect", { min: 1, max: 200, int: true, def: 20 }),
  };
  if (!detect.api && !detect.chain) throw new ConfigError("config.detect: at least one of api and chain must be on");
  return detect;
}

/** This bot's sections, in the order they are parsed (after `sell`, before `exit`). */
export const SECTIONS = { follow: parseFollow, detect: parseDetect };

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  return parseCore(raw, baseDir, SECTIONS) as Config;
}

export function loadConfig(path: string): Config {
  return loadCore(path, SECTIONS) as Config;
}
