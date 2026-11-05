/**
 * The one config file: the core's shared sections (candle-bot-core) plus this bot's `graduation` (the filters) and
 * `detect` (where launches are seen, and how often their curves are read). Unknown keys are refused at every level.
 */
import { parseConfig as parseCore, loadConfig as loadCore, ConfigError, isObj, only, num, bool, strList, type Config as CoreConfig } from "candle-bot-core/config";

export { ConfigError } from "candle-bot-core/config";

export interface Graduation {
  /** Buy only within this many seconds of the pool opening (the block time of its activation slot). */
  maxSecondsSinceGraduation: number;
  /** Time from launch to graduation, seconds (each optional). */
  minLaunchToGraduationSec?: number;
  maxLaunchToGraduationSec?: number;
  /** Price impact of the ticket on the pool, bps (the fee apart). Also the buy-retry limit. */
  maxImpactBps: number;
  /** The pool's price over its floor, minus 1 (0.5 = 50 % above the floor). */
  minRoomAboveFloor?: number;
  creatorAllow?: string[];
  creatorDeny?: string[];
}

export interface Detect {
  api: boolean;
  chain: boolean;
  apiPollMs: number;
  chainPollMs: number;
  apiLimit: number;
  /** How often the watched coins' curves are read (one batched call). */
  curvePollMs: number;
  /** How long a coin's curve is watched after its launch. */
  watchHours: number;
  /** Most coins watched at once (the oldest are dropped first). */
  maxWatched: number;
}

export type Config = CoreConfig & { graduation: Graduation; detect: Detect };

function parseGraduation(raw: unknown): Graduation {
  const g = raw === undefined ? {} : raw;
  if (!isObj(g)) throw new ConfigError("config.graduation: must be an object");
  only(g, ["maxSecondsSinceGraduation", "minLaunchToGraduationSec", "maxLaunchToGraduationSec", "maxImpactBps", "minRoomAboveFloor", "creatorAllow", "creatorDeny"], "config.graduation");
  const out: Graduation = {
    maxSecondsSinceGraduation: num(g, "maxSecondsSinceGraduation", "config.graduation", { min: 1, def: 300 }),
    minLaunchToGraduationSec: g.minLaunchToGraduationSec === undefined ? undefined : num(g, "minLaunchToGraduationSec", "config.graduation", { min: 0 }),
    maxLaunchToGraduationSec: g.maxLaunchToGraduationSec === undefined ? undefined : num(g, "maxLaunchToGraduationSec", "config.graduation", { min: 1 }),
    maxImpactBps: num(g, "maxImpactBps", "config.graduation", { min: 0, max: 10_000, def: 300 }),
    minRoomAboveFloor: g.minRoomAboveFloor === undefined ? undefined : num(g, "minRoomAboveFloor", "config.graduation", { min: 0 }),
    creatorAllow: strList(g, "creatorAllow", "config.graduation", { address: true }),
    creatorDeny: strList(g, "creatorDeny", "config.graduation", { address: true }),
  };
  if (out.minLaunchToGraduationSec !== undefined && out.maxLaunchToGraduationSec !== undefined && out.minLaunchToGraduationSec > out.maxLaunchToGraduationSec)
    throw new ConfigError("config.graduation: minLaunchToGraduationSec is above maxLaunchToGraduationSec");
  return out;
}

function parseDetect(raw: unknown): Detect {
  const d = raw === undefined ? {} : raw;
  if (!isObj(d)) throw new ConfigError("config.detect: must be an object");
  only(d, ["api", "chain", "apiPollMs", "chainPollMs", "apiLimit", "curvePollMs", "watchHours", "maxWatched"], "config.detect");
  const detect: Detect = {
    api: bool(d, "api", "config.detect", true),
    chain: bool(d, "chain", "config.detect", true),
    apiPollMs: num(d, "apiPollMs", "config.detect", { min: 500, int: true, def: 10_000 }),
    chainPollMs: num(d, "chainPollMs", "config.detect", { min: 1000, int: true, def: 15_000 }),
    // Candle's list holds every coin still on its curve at start: read it whole.
    apiLimit: num(d, "apiLimit", "config.detect", { min: 1, max: 200, int: true, def: 200 }),
    curvePollMs: num(d, "curvePollMs", "config.detect", { min: 500, int: true, def: 2000 }),
    watchHours: num(d, "watchHours", "config.detect", { min: 0.1, def: 72 }),
    maxWatched: num(d, "maxWatched", "config.detect", { min: 1, max: 5000, int: true, def: 1000 }),
  };
  if (!detect.api && !detect.chain) throw new ConfigError("config.detect: at least one of api and chain must be on");
  return detect;
}

/** This bot's sections, in the order they are parsed (after `sell`, before `exit`). */
export const SECTIONS = { graduation: parseGraduation, detect: parseDetect };

/** `preGrad` sells before graduation: this bot only holds graduated coins, so it is refused. */
function refusePreGrad(cfg: Config): Config {
  if (cfg.exit.strategy === "preGrad")
    throw new ConfigError("config.exit.strategy: preGrad sells before graduation, and this bot only buys coins that have graduated; pick tpsl, time, ladder or hold");
  return cfg;
}

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  return refusePreGrad(parseCore(raw, baseDir, SECTIONS));
}

export function loadConfig(path: string): Config {
  return refusePreGrad(loadCore(path, SECTIONS));
}
