/**
 * The one config file: the core's shared sections (candle-bot-core) plus this bot's `filters` and `detect`.
 * Validated at start; unknown keys are refused at every level so a typo can never be silently ignored. Secrets never
 * live here: the file names the environment variables that hold them.
 */
import { parseConfig as parseCore, loadConfig as loadCore, ConfigError, isObj, only, num, bool, strList, regex, type Config as CoreConfig } from "candle-bot-core/config";

export { ConfigError } from "candle-bot-core/config";
export type { Mode, Payer, SignerConfig } from "candle-bot-core/config";

export interface Filters {
  chains: string[];
  launchModes: string[];
  maxAgeSec: number;
  maxImpactBps: number;
  creatorAllow?: string[];
  creatorDeny?: string[];
  nameMatch?: string;
  symbolMatch?: string;
  /** Classify a chain-first launch from its curve account (open / exclusive / exp-*) instead of waiting on Candle's list. */
  inferModeFromCurve: boolean;
}

export interface Detect {
  api: boolean;
  chain: boolean;
  apiPollMs: number;
  chainPollMs: number;
  apiLimit: number;
}

export type Config = CoreConfig & { filters: Filters; detect: Detect };

/** Candle's launch modes (agent-sdk 0.6.14 launch-definition `curve.values`). */
export const LAUNCH_MODES = ["open", "exclusive", "test-open", "test-exclusive", "exp-a", "exp-b", "exp-c", "exp-custom"];
export const KNOWN_CHAINS = ["solana"];

function parseFilters(f: unknown): Filters {
  if (!isObj(f)) throw new ConfigError("config.filters: required object");
  only(f, ["chains", "launchModes", "maxAgeSec", "maxImpactBps", "creatorAllow", "creatorDeny", "nameMatch", "symbolMatch", "inferModeFromCurve"], "config.filters");
  const chains = strList(f, "chains", "config.filters", { def: ["solana"] })!;
  for (const c of chains) if (!KNOWN_CHAINS.includes(c)) throw new ConfigError(`config.filters.chains: "${c}" is not supported yet (${KNOWN_CHAINS.join(", ")})`);
  const launchModes = strList(f, "launchModes", "config.filters");
  if (!launchModes || !launchModes.length) throw new ConfigError("config.filters.launchModes: required, e.g. [\"open\", \"exp-custom\"]");
  for (const m of launchModes) if (!LAUNCH_MODES.includes(m)) throw new ConfigError(`config.filters.launchModes: "${m}" is not a Candle launch mode (${LAUNCH_MODES.join(", ")})`);
  return {
    chains,
    launchModes,
    maxAgeSec: num(f, "maxAgeSec", "config.filters", { min: 1 }),
    maxImpactBps: num(f, "maxImpactBps", "config.filters", { min: 0, max: 10_000 }),
    creatorAllow: strList(f, "creatorAllow", "config.filters", { address: true }),
    creatorDeny: strList(f, "creatorDeny", "config.filters", { address: true }),
    nameMatch: regex(f, "nameMatch", "config.filters"),
    symbolMatch: regex(f, "symbolMatch", "config.filters"),
    inferModeFromCurve: bool(f, "inferModeFromCurve", "config.filters", true),
  };
}

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

/** This bot's sections, in the order they are parsed (after `sell`, before `exit`, as in 0.1.3). */
export const SECTIONS = { filters: parseFilters, detect: parseDetect };

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  return parseCore(raw, baseDir, SECTIONS);
}

export function loadConfig(path: string): Config {
  return loadCore(path, SECTIONS);
}
