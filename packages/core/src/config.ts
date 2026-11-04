/**
 * The one config file. Validated at start; unknown keys are refused at every level so a typo can never be
 * silently ignored. Secrets never live here: the file names the environment variables that hold them.
 *
 * The core parses the sections every bot shares (mode, payer, wallet, signer, buy, sell, exit, retry, alerts). A bot
 * adds its own top-level sections (`sections`): each is parsed by the bot's function, with the helpers below, after
 * `sell` and before `exit`, and lands on the result under its own key.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { asAddress } from "./solana/base58.ts";

export type Mode = "dry" | "live";
export type SignerConfig =
  | { store: "keychain" }
  | { store: "file"; path: string; passphraseEnv: string }
  | { store: "env"; pemEnv: string };

export type Payer = "linked" | "embedded";

export interface Config {
  mode: Mode;
  /** linked: a TEE wallet signed locally with the key signer; embedded: the account's embedded wallet, signed by Candle. */
  payer: Payer;
  apiUrl: string;
  apiKeyEnv: string;
  rpcUrlEnv?: string;
  rpcWsUrlEnv?: string;
  wallet: string;
  linkedWalletId?: string;
  privyWalletId?: string;
  privyAppId?: string;
  signer?: SignerConfig;
  stateDir: string;
  loopMs: number;
  buy: {
    sol: number;
    maxSlippageBps: number;
    maxOpen: number;
    lifetimeSol: number;
    maxPerCoin: number;
    maxPriorityFeeLamports?: number;
  };
  sell: { maxSlippageBps: number; maxPriorityFeeLamports?: number };
  exit: { strategy: string; [param: string]: unknown };
  retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; maxExitOrders: number; stuckRetryMs: number; builtProbeMs: number; builtHoldMs: number };
  alerts: { command?: string[]; commandEnv?: string[]; webhookEnv?: string; renotifyMs: number; holdAlertMs: number };
  /** The folder of the config file: relative paths in it (stateDir, signer.path, exit.module) resolve here. */
  configDir: string;
}

export class ConfigError extends Error {}

/** Freeze an object and everything it holds (plain objects and arrays). Returns it. */
export function deepFreeze<T>(o: T, seen = new WeakSet<object>()): T {
  // Into already-frozen objects too: a config frozen only at the top still gets its sections frozen.
  if (o && typeof o === "object" && !seen.has(o)) {
    seen.add(o);
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v, seen);
  }
  return o;
}

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function only(o: Obj, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ConfigError(`${where}: unknown key "${k}"`);
}

export function num(o: Obj, k: string, where: string, opts: { min?: number; max?: number; int?: boolean; def?: number } = {}): number {
  const v = o[k];
  if (v === undefined) {
    if (opts.def !== undefined) return opts.def;
    throw new ConfigError(`${where}.${k}: required`);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ConfigError(`${where}.${k}: must be a number`);
  if (opts.int && !Number.isInteger(v)) throw new ConfigError(`${where}.${k}: must be an integer`);
  if (opts.min !== undefined && v < opts.min) throw new ConfigError(`${where}.${k}: must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new ConfigError(`${where}.${k}: must be <= ${opts.max}`);
  return v;
}

export function str(o: Obj, k: string, where: string, opts: { def?: string; optional?: boolean; re?: RegExp } = {}): string | undefined {
  const v = o[k];
  if (v === undefined) {
    if (opts.def !== undefined) return opts.def;
    if (opts.optional) return undefined;
    throw new ConfigError(`${where}.${k}: required`);
  }
  if (typeof v !== "string" || !v) throw new ConfigError(`${where}.${k}: must be a non-empty string`);
  if (opts.re && !opts.re.test(v)) throw new ConfigError(`${where}.${k}: invalid value`);
  return v;
}

export function bool(o: Obj, k: string, where: string, def: boolean): boolean {
  const v = o[k];
  if (v === undefined) return def;
  if (typeof v !== "boolean") throw new ConfigError(`${where}.${k}: must be true or false`);
  return v;
}

export function strList(o: Obj, k: string, where: string, opts: { def?: string[]; address?: boolean } = {}): string[] | undefined {
  const v = o[k];
  if (v === undefined) return opts.def;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) throw new ConfigError(`${where}.${k}: must be a list of strings`);
  if (opts.address) for (const a of v) if (!asAddress(a)) throw new ConfigError(`${where}.${k}: "${a}" is not an address`);
  return v as string[];
}

export function regex(o: Obj, k: string, where: string): string | undefined {
  const v = str(o, k, where, { optional: true });
  if (v === undefined) return v;
  try {
    new RegExp(v, "i");
  } catch {
    throw new ConfigError(`${where}.${k}: not a valid regular expression`);
  }
  return v;
}

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A bot's own config section: gets the raw value (undefined when absent) and the core sections parsed so far. */
export type SectionParser<T> = (raw: unknown, core: { mode: Mode; wallet: string; buy: Config["buy"]; baseDir: string }) => T;
export type Sections = Record<string, SectionParser<unknown>>;
export type BotConfig<S extends Sections> = Config & { [K in keyof S]: ReturnType<S[K]> };

const CORE_KEYS = ["mode", "apiUrl", "apiKeyEnv", "rpcUrlEnv", "rpcWsUrlEnv", "wallet", "linkedWalletId", "privyWalletId", "privyAppId",
  "signer", "payer", "stateDir", "loopMs", "buy", "sell", "exit", "retry", "alerts", "$schema", "comment"];

export function parseConfig<S extends Sections = {}>(raw: unknown, baseDir = process.cwd(), sections: S = {} as S): BotConfig<S> {
  if (!isObj(raw)) throw new ConfigError("config: must be a JSON object");
  for (const k of Object.keys(sections)) if (CORE_KEYS.includes(k)) throw new ConfigError(`bot config section "${k}" collides with a core key`);
  const keys = [...CORE_KEYS];
  keys.splice(keys.indexOf("exit"), 0, ...Object.keys(sections));
  only(raw, keys, "config");

  const mode = str(raw, "mode", "config") as Mode;
  if (mode !== "dry" && mode !== "live") throw new ConfigError('config.mode: must be "dry" or "live"');
  const apiUrl = str(raw, "apiUrl", "config", { def: "https://api.alpha.candle.tv" })!;
  if (!/^https:\/\//.test(apiUrl)) throw new ConfigError("config.apiUrl: must be https://");
  const apiKeyEnv = str(raw, "apiKeyEnv", "config", { re: ENV_NAME })!;
  const rpcUrlEnv = str(raw, "rpcUrlEnv", "config", { optional: true, re: ENV_NAME });
  const rpcWsUrlEnv = str(raw, "rpcWsUrlEnv", "config", { optional: true, re: ENV_NAME });
  const wallet = str(raw, "wallet", "config")!;
  if (!asAddress(wallet)) throw new ConfigError("config.wallet: not a Solana address");
  const linkedWalletId = str(raw, "linkedWalletId", "config", { optional: true, re: /^[A-Za-z0-9_-]{4,128}$/ });
  const privyWalletId = str(raw, "privyWalletId", "config", { optional: true, re: /^[A-Za-z0-9_-]{4,128}$/ });
  const privyAppId = str(raw, "privyAppId", "config", { optional: true, re: /^[A-Za-z0-9]{8,64}$/ });

  let signer: SignerConfig | undefined;
  if (raw.signer !== undefined) {
    const s = raw.signer;
    if (!isObj(s)) throw new ConfigError("config.signer: must be an object");
    const store = str(s, "store", "config.signer");
    if (store === "keychain") {
      only(s, ["store"], "config.signer");
      signer = { store };
    } else if (store === "file") {
      only(s, ["store", "path", "passphraseEnv"], "config.signer");
      signer = { store, path: resolve(baseDir, str(s, "path", "config.signer")!), passphraseEnv: str(s, "passphraseEnv", "config.signer", { re: ENV_NAME })! };
    } else if (store === "env") {
      only(s, ["store", "pemEnv"], "config.signer");
      signer = { store, pemEnv: str(s, "pemEnv", "config.signer", { re: ENV_NAME })! };
    } else throw new ConfigError('config.signer.store: "keychain", "file" or "env"');
  }
  const payer = str(raw, "payer", "config", { def: "linked" }) as Payer;
  if (payer !== "linked" && payer !== "embedded") throw new ConfigError('config.payer: "linked" (TEE wallet, local signer) or "embedded" (Candle signs)');
  if (payer === "embedded" && (signer || privyAppId || linkedWalletId || privyWalletId))
    throw new ConfigError("config: payer \"embedded\" signs on Candle's side; remove signer / privyAppId / linkedWalletId / privyWalletId");
  if (mode === "live" && payer === "linked" && !signer) throw new ConfigError("config.signer: required in live mode with payer \"linked\" (where the wallet's P-256 signer key lives)");

  const stateDir = resolve(baseDir, str(raw, "stateDir", "config", { def: "./state" })!);
  const loopMs = num(raw, "loopMs", "config", { min: 200, max: 60_000, int: true, def: 2000 });

  if (!isObj(raw.buy)) throw new ConfigError("config.buy: required object");
  const b = raw.buy;
  only(b, ["sol", "maxSlippageBps", "maxOpen", "lifetimeSol", "maxPerCoin", "maxPriorityFeeLamports"], "config.buy");
  const buy = {
    sol: num(b, "sol", "config.buy", { min: 0.000001, max: 1000 }),
    maxSlippageBps: num(b, "maxSlippageBps", "config.buy", { min: 0, max: 10_000, int: true }),
    maxOpen: num(b, "maxOpen", "config.buy", { min: 0, int: true }),
    lifetimeSol: num(b, "lifetimeSol", "config.buy", { min: 0 }),
    // One entry per coin: re-entry is not supported (a second position in a coin would share its wallet balance).
    maxPerCoin: num(b, "maxPerCoin", "config.buy", { min: 1, max: 1, int: true, def: 1 }),
    maxPriorityFeeLamports: b.maxPriorityFeeLamports === undefined ? undefined : num(b, "maxPriorityFeeLamports", "config.buy", { min: 0, max: 10_000_000, int: true }),
  };

  const sl = raw.sell === undefined ? {} : raw.sell;
  if (!isObj(sl)) throw new ConfigError("config.sell: must be an object");
  only(sl, ["maxSlippageBps", "maxPriorityFeeLamports"], "config.sell");
  const sell = {
    maxSlippageBps: num(sl, "maxSlippageBps", "config.sell", { min: 0, max: 10_000, int: true, def: Math.max(buy.maxSlippageBps, 1000) }),
    maxPriorityFeeLamports: sl.maxPriorityFeeLamports === undefined ? undefined : num(sl, "maxPriorityFeeLamports", "config.sell", { min: 0, max: 10_000_000, int: true }),
  };

  const own: Record<string, unknown> = {};
  // Sections see a frozen copy of the core sections: they cannot change the caps.
  const seen = deepFreeze({ mode, wallet, buy: { ...buy }, baseDir });
  for (const [k, parse] of Object.entries(sections)) own[k] = parse(raw[k], seen);

  if (!isObj(raw.exit)) throw new ConfigError("config.exit: required object with a strategy name");
  const strategy = str(raw.exit, "strategy", "config.exit", { re: /^[A-Za-z][A-Za-z0-9_-]{0,40}$/ })!;
  const exit = { ...raw.exit, strategy };

  const r = raw.retry === undefined ? {} : raw.retry;
  if (!isObj(r)) throw new ConfigError("config.retry: must be an object");
  only(r, ["maxAttempts", "baseDelayMs", "maxDelayMs", "maxExitOrders", "stuckRetryMs", "builtProbeMs", "builtHoldMs"], "config.retry");
  const retry = {
    maxAttempts: num(r, "maxAttempts", "config.retry", { min: 1, max: 50, int: true, def: 6 }),
    baseDelayMs: num(r, "baseDelayMs", "config.retry", { min: 100, int: true, def: 2000 }),
    maxDelayMs: num(r, "maxDelayMs", "config.retry", { min: 100, int: true, def: 120_000 }),
    maxExitOrders: num(r, "maxExitOrders", "config.retry", { min: 1, max: 20, int: true, def: 3 }),
    stuckRetryMs: num(r, "stuckRetryMs", "config.retry", { min: 60_000, int: true, def: 600_000 }),
    builtProbeMs: num(r, "builtProbeMs", "config.retry", { min: 60_000, int: true, def: 600_000 }),
    builtHoldMs: num(r, "builtHoldMs", "config.retry", { min: 600_000, int: true, def: 21_600_000 }),
  };

  const al = raw.alerts === undefined ? {} : raw.alerts;
  if (!isObj(al)) throw new ConfigError("config.alerts: must be an object");
  only(al, ["command", "commandEnv", "webhookEnv", "renotifyMs", "holdAlertMs"], "config.alerts");
  const command = strList(al, "command", "config.alerts");
  if (command && !command.length) throw new ConfigError("config.alerts.command: an argv list, e.g. [\"/usr/local/bin/notify\", \"bot\"]");
  const alerts = {
    command,
    commandEnv: strList(al, "commandEnv", "config.alerts"),
    webhookEnv: str(al, "webhookEnv", "config.alerts", { optional: true, re: ENV_NAME }),
    renotifyMs: num(al, "renotifyMs", "config.alerts", { min: 60_000, int: true, def: 3_600_000 }),
    holdAlertMs: num(al, "holdAlertMs", "config.alerts", { min: 0, int: true, def: 300_000 }),
  };

  // Frozen through: the engine, the executor and every trigger read this one object, and none may change it.
  return deepFreeze({ mode, payer, apiUrl, apiKeyEnv, rpcUrlEnv, rpcWsUrlEnv, wallet, linkedWalletId, privyWalletId, privyAppId, signer, stateDir, loopMs, buy, sell, ...own, exit, retry, alerts, configDir: resolve(baseDir) }) as BotConfig<S>;
}

export function loadConfig<S extends Sections = {}>(path: string, sections: S = {} as S): BotConfig<S> {
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
  return parseConfig(raw, dirname(resolve(path)), sections);
}
