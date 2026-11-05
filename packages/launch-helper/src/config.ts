/**
 * The one config file: the core's shared sections (candle-bot-core) plus `launch`, the launch spec. Unknown keys are
 * refused at every level. The launch goes through Candle's atomic route from the account's main (embedded) wallet:
 * `payer` must be "embedded".
 */
import { parseConfig as parseCore, loadConfig as loadCore, ConfigError, isObj, only, num, str, type Config as CoreConfig, type SectionParser } from "candle-bot-core";

export { ConfigError } from "candle-bot-core/config";

export const LAUNCH_MODES = ["open", "exclusive", "test-open", "test-exclusive", "exp-a", "exp-b", "exp-c", "exp-custom"] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

export interface LaunchSpec {
  name: string;
  symbol: string;
  imageUrl: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  mode: LaunchMode;
  /** The dev buy, SOL: the bundle's first buy, from the same wallet, in the launch's block. At most buy.sol. */
  devBuySol: number;
  /** Refuse to submit unless Candle's expected fill for the dev buy is at least this (raw token units). */
  minDevBuyOutRaw?: bigint;
  /** Alert when a sent launch is still unresolved after this many minutes. */
  unresolvedAlertMin: number;
  /** Launch even when the account already launched a token with this name and symbol (default false: refused). */
  newLaunch: boolean;
}

export type Config = CoreConfig & { launch: LaunchSpec };

const parseLaunch: SectionParser<LaunchSpec> = (raw, core) => {
  if (!isObj(raw)) throw new ConfigError("config.launch: required object (name, symbol, imageUrl, devBuySol, ...)");
  only(raw, ["name", "symbol", "imageUrl", "description", "website", "twitter", "telegram", "mode", "devBuySol", "minDevBuyOutRaw", "unresolvedAlertMin", "newLaunch"], "config.launch");
  const name = str(raw, "name", "config.launch")!;
  const symbol = str(raw, "symbol", "config.launch")!;
  const imageUrl = str(raw, "imageUrl", "config.launch")!;
  if (!/^https:\/\//.test(imageUrl)) throw new ConfigError("config.launch.imageUrl: must be an https:// URL");
  const mode = (str(raw, "mode", "config.launch", { def: "open" }) as LaunchMode);
  if (!LAUNCH_MODES.includes(mode)) throw new ConfigError(`config.launch.mode: "${mode}" is not a Candle launch mode (${LAUNCH_MODES.join(", ")})`);
  const devBuySol = num(raw, "devBuySol", "config.launch", { min: 0.000001 });
  if (devBuySol > core.buy.sol) throw new ConfigError(`config.launch.devBuySol: ${devBuySol} is above buy.sol (${core.buy.sol})`);
  let minDevBuyOutRaw: bigint | undefined;
  if (raw.minDevBuyOutRaw !== undefined) {
    const v = String(raw.minDevBuyOutRaw);
    if (!/^\d+$/.test(v)) throw new ConfigError("config.launch.minDevBuyOutRaw: a whole number of raw token units (a string)");
    minDevBuyOutRaw = BigInt(v);
  }
  return {
    name, symbol, imageUrl, mode, devBuySol, minDevBuyOutRaw,
    description: str(raw, "description", "config.launch", { optional: true }),
    website: str(raw, "website", "config.launch", { optional: true }),
    twitter: str(raw, "twitter", "config.launch", { optional: true }),
    telegram: str(raw, "telegram", "config.launch", { optional: true }),
    unresolvedAlertMin: num(raw, "unresolvedAlertMin", "config.launch", { min: 1, def: 10 }),
    newLaunch: bool(raw, "newLaunch"),
  };
};

function bool(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new ConfigError(`config.launch.${k}: true or false`);
  return v;
}

export const SECTIONS = { launch: parseLaunch };

function check(cfg: Config): Config {
  if (cfg.payer !== "embedded")
    throw new ConfigError('config.payer: the launch helper launches from the account\'s main wallet through Candle\'s atomic route; set "payer": "embedded" (Candle refuses a TEE wallet on that route)');
  // The live run's pre-flight refuses too (a --mode live override is checked there).
  if (cfg.mode === "live" && cfg.launch.minDevBuyOutRaw === undefined)
    throw new ConfigError("config.launch.minDevBuyOutRaw: required in live mode (the dev buy's on-chain minimum is 0 inside the bundle; `plan` previews Candle's fill to set it from)");
  return cfg;
}

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  return check(parseCore(raw, baseDir, SECTIONS) as Config);
}

export function loadConfig(path: string): Config {
  return check(loadCore(path, SECTIONS) as Config);
}
