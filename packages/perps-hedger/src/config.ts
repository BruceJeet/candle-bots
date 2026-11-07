/**
 * The one config file. Unknown keys are refused at every level. Secrets never live here: the file names the
 * environment variables that hold them.
 *
 *   mode      "dry" (paper perps, real reads, no key) or "live" (orders through the Candle SDK)
 *   network   "mainnet" or "testnet" (Hyperliquid's; the SDK refuses a build for the other)
 *   spot      the Solana wallet whose bags are hedged (all of it, or listed mints)
 *   perps     the EVM TEE wallet that holds the hedge, its signer, order settings, the paper account
 *   hedge     the proxy, ratios or beta, per-coin perps, the band and the caps
 *   alerts    the core's alert sinks
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConfigError, ENV_NAME, deepFreeze, isObj, num, only, parseAlerts, str, strList, type AlertsConfig, type SignerConfig } from "candle-bot-core/config";
import { asAddress } from "candle-bot-core/solana/base58";
import { DEFAULT_SPOT_EXCLUDE } from "candle-bot-core/perps/spot";
import type { HedgeConfig } from "candle-bot-core/perps/planner";

export { ConfigError } from "candle-bot-core/config";

export interface SpotSection {
  wallet: string;
  mode: "wallet" | "list";
  mints: string[];
  exclude: string[];
  maxBags: number;
  /** A bag whose venue holds less SOL than this is not hedged (an airdropped coin on a thin pool). */
  minLiquiditySol: number;
}

export interface PerpsSection {
  /** The EVM TEE wallet's address (the Hyperliquid account). Optional in dry mode. */
  wallet: string | null;
  walletId?: string;
  privyWalletId?: string;
  privyAppId?: string;
  signer?: SignerConfig;
  marginMode: "isolated" | "cross";
  slippageBps: number;
  /** An order the venue has no record of is written off as not placed after this long. */
  settleSec: number;
  /** How often fills and funding are read and booked. */
  fillsEverySec: number;
  /** A position that differs from the book this long (two reads at least) freezes the coin. */
  mismatchSec: number;
  paper: { startUsd: number; feeBps: number; slippageBps: number };
}

export interface BetaSection {
  windowMin: number;
  minSamples: number;
  min: number;
  max: number;
  everySec: number;
}

export interface Config {
  mode: "dry" | "live";
  network: "mainnet" | "testnet";
  apiUrl: string;
  apiKeyEnv?: string;
  rpcUrlEnv?: string;
  stateDir: string;
  loopMs: number;
  spot: SpotSection;
  perps: PerpsSection;
  hedge: HedgeConfig & { beta: BetaSection | null };
  alerts: AlertsConfig;
  configDir: string;
}

const PERP_COIN = /^[A-Za-z0-9]{1,20}$/;

function parseSigner(s: unknown, baseDir: string): SignerConfig {
  if (!isObj(s)) throw new ConfigError("config.perps.signer: must be an object");
  const store = str(s, "store", "config.perps.signer");
  if (store === "keychain") {
    only(s, ["store"], "config.perps.signer");
    return { store };
  }
  if (store === "file") {
    only(s, ["store", "path", "passphraseEnv"], "config.perps.signer");
    return { store, path: resolve(baseDir, str(s, "path", "config.perps.signer")!), passphraseEnv: str(s, "passphraseEnv", "config.perps.signer", { re: ENV_NAME })! };
  }
  if (store === "env") {
    only(s, ["store", "pemEnv"], "config.perps.signer");
    return { store, pemEnv: str(s, "pemEnv", "config.perps.signer", { re: ENV_NAME })! };
  }
  if (store === "candle-cli") {
    only(s, ["store", "passphraseEnv", "configDir", "fingerprint"], "config.perps.signer");
    const configDir = str(s, "configDir", "config.perps.signer", { optional: true });
    if (configDir !== undefined && configDir.startsWith("~")) throw new ConfigError("config.perps.signer.configDir: an absolute or config-relative path (a leading ~ is not expanded)");
    const fingerprint = str(s, "fingerprint", "config.perps.signer", { optional: true, re: /^CNDL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/ });
    return { store, passphraseEnv: str(s, "passphraseEnv", "config.perps.signer", { re: ENV_NAME })!, ...(configDir !== undefined ? { configDir: resolve(baseDir, configDir) } : {}), ...(fingerprint ? { fingerprint } : {}) };
  }
  throw new ConfigError('config.perps.signer.store: "keychain", "file", "env" or "candle-cli"');
}

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  const w = "config";
  if (!isObj(raw)) throw new ConfigError("config: must be a JSON object");
  only(raw, ["mode", "network", "apiUrl", "apiKeyEnv", "rpcUrlEnv", "stateDir", "loopMs", "spot", "perps", "hedge", "alerts", "$schema", "comment"], w);
  const mode = str(raw, "mode", w) as Config["mode"];
  if (mode !== "dry" && mode !== "live") throw new ConfigError('config.mode: "dry" or "live"');
  // A live run names its network: a live config never trades mainnet by default.
  if (mode === "live" && raw.network === undefined) throw new ConfigError('config.network: required in live mode ("mainnet" or "testnet")');
  const network = str(raw, "network", w, { def: "mainnet" }) as Config["network"];
  if (network !== "mainnet" && network !== "testnet") throw new ConfigError('config.network: "mainnet" or "testnet"');
  const apiUrl = str(raw, "apiUrl", w, { def: "https://api.alpha.candle.tv" })!;
  if (!/^https:\/\//.test(apiUrl)) throw new ConfigError("config.apiUrl: must be https://");
  const apiKeyEnv = str(raw, "apiKeyEnv", w, { optional: true, re: ENV_NAME });
  if (mode === "live" && !apiKeyEnv) throw new ConfigError("config.apiKeyEnv: required in live mode (the env var with the Candle API key, scope perps:write)");
  const rpcUrlEnv = str(raw, "rpcUrlEnv", w, { optional: true, re: ENV_NAME });
  const stateDir = resolve(baseDir, str(raw, "stateDir", w, { def: "./state-hedge" })!);
  const loopMs = num(raw, "loopMs", w, { min: 2_000, max: 600_000, int: true, def: 15_000 });

  // spot
  const sp = raw.spot;
  if (!isObj(sp)) throw new ConfigError("config.spot: required object { wallet, mode }");
  only(sp, ["wallet", "mode", "mints", "exclude", "maxBags", "minLiquiditySol"], "config.spot");
  const spotWallet = str(sp, "wallet", "config.spot")!;
  if (asAddress(spotWallet) !== spotWallet) throw new ConfigError("config.spot.wallet: not a Solana address");
  const spotMode = str(sp, "mode", "config.spot", { def: "wallet" }) as SpotSection["mode"];
  if (spotMode !== "wallet" && spotMode !== "list") throw new ConfigError('config.spot.mode: "wallet" or "list"');
  const mints = strList(sp, "mints", "config.spot", { def: [], address: true })!;
  if (spotMode === "list" && !mints.length) throw new ConfigError("config.spot.mints: list mode needs at least one mint");
  if (new Set(mints).size !== mints.length) throw new ConfigError("config.spot.mints: a mint is listed twice");
  const exclude = [...new Set([...DEFAULT_SPOT_EXCLUDE, ...strList(sp, "exclude", "config.spot", { def: [], address: true })!])];
  const spot: SpotSection = { wallet: spotWallet, mode: spotMode, mints, exclude, maxBags: num(sp, "maxBags", "config.spot", { min: 1, max: 200, int: true, def: 50 }), minLiquiditySol: num(sp, "minLiquiditySol", "config.spot", { min: 0, def: 5 }) };

  // perps
  const pp = raw.perps === undefined ? {} : raw.perps;
  if (!isObj(pp)) throw new ConfigError("config.perps: must be an object");
  only(pp, ["wallet", "walletId", "privyWalletId", "privyAppId", "signer", "marginMode", "slippageBps", "settleSec", "fillsEverySec", "mismatchSec", "paper"], "config.perps");
  const evm = str(pp, "wallet", "config.perps", { optional: true, re: /^0x[0-9a-fA-F]{40}$/ });
  if (mode === "live" && !evm) throw new ConfigError("config.perps.wallet: required in live mode (the EVM TEE wallet's 0x address)");
  const signer = pp.signer === undefined ? undefined : parseSigner(pp.signer, baseDir);
  if (mode === "live" && !signer) throw new ConfigError("config.perps.signer: required in live mode (where the wallet's P-256 signer key lives)");
  const marginMode = str(pp, "marginMode", "config.perps", { def: "isolated" }) as PerpsSection["marginMode"];
  if (marginMode !== "isolated" && marginMode !== "cross") throw new ConfigError('config.perps.marginMode: "isolated" or "cross"');
  const pa = pp.paper === undefined ? {} : pp.paper;
  if (!isObj(pa)) throw new ConfigError("config.perps.paper: must be an object");
  only(pa, ["startUsd", "feeBps", "slippageBps"], "config.perps.paper");
  const perps: PerpsSection = {
    wallet: evm ? evm.toLowerCase() : null,
    ...(pp.walletId !== undefined ? { walletId: str(pp, "walletId", "config.perps", { re: /^[A-Za-z0-9_-]{4,128}$/ })! } : {}),
    ...(pp.privyWalletId !== undefined ? { privyWalletId: str(pp, "privyWalletId", "config.perps", { re: /^[A-Za-z0-9_-]{4,128}$/ })! } : {}),
    ...(pp.privyAppId !== undefined ? { privyAppId: str(pp, "privyAppId", "config.perps", { re: /^[A-Za-z0-9]{8,64}$/ })! } : {}),
    ...(signer ? { signer } : {}),
    marginMode,
    slippageBps: num(pp, "slippageBps", "config.perps", { min: 1, max: 1_000, int: true, def: 100 }),
    settleSec: num(pp, "settleSec", "config.perps", { min: 30, max: 3_600, int: true, def: 120 }),
    fillsEverySec: num(pp, "fillsEverySec", "config.perps", { min: 10, max: 3_600, int: true, def: 60 }),
    mismatchSec: num(pp, "mismatchSec", "config.perps", { min: 5, max: 3_600, int: true, def: 30 }),
    paper: {
      startUsd: num(pa, "startUsd", "config.perps.paper", { min: 1, def: 1_000 }),
      feeBps: num(pa, "feeBps", "config.perps.paper", { min: 0, max: 1_000, def: 14.5 }),
      slippageBps: num(pa, "slippageBps", "config.perps.paper", { min: 0, max: 1_000, def: 5 }),
    },
  };

  // hedge
  const h = raw.hedge;
  if (!isObj(h)) throw new ConfigError("config.hedge: required object (at least maxMarginUsd)");
  only(h, ["proxy", "ratio", "coins", "bandPct", "minOrderUsd", "maxLeverage", "maxMarginUsd", "maxNotionalUsd", "minBagUsd", "unpricedCloseSec", "beta"], "config.hedge");
  const proxy = str(h, "proxy", "config.hedge", { def: "SOL", re: PERP_COIN })!;
  const coinsRaw = h.coins === undefined ? {} : h.coins;
  if (!isObj(coinsRaw)) throw new ConfigError('config.hedge.coins: { "<mint>": { "perp": "WIF" | null, "ratio": 1 } }');
  const coins: HedgeConfig["coins"] = {};
  for (const [mint, spec] of Object.entries(coinsRaw)) {
    const at = `config.hedge.coins.${mint}`;
    if (asAddress(mint) !== mint) throw new ConfigError(`config.hedge.coins: "${mint}" is not a mint address`);
    if (!isObj(spec)) throw new ConfigError(`${at}: { "perp": ..., "ratio": ... }`);
    only(spec, ["perp", "ratio"], at);
    if (spec.perp !== undefined && spec.perp !== null && (typeof spec.perp !== "string" || !PERP_COIN.test(spec.perp))) throw new ConfigError(`${at}.perp: a Hyperliquid coin name (e.g. "WIF", "kBONK") or null`);
    coins[mint] = { ...(spec.perp !== undefined ? { perp: spec.perp as string | null } : {}), ...(spec.ratio !== undefined ? { ratio: num(spec, "ratio", at, { min: 0, max: 5 }) } : {}) };
  }
  let beta: BetaSection | null = null;
  if (h.beta !== undefined) {
    const b = h.beta;
    if (!isObj(b)) throw new ConfigError("config.hedge.beta: an object { windowMin, minSamples, min, max, everySec }");
    only(b, ["windowMin", "minSamples", "min", "max", "everySec"], "config.hedge.beta");
    beta = {
      windowMin: num(b, "windowMin", "config.hedge.beta", { min: 10, max: 10_080, int: true, def: 240 }),
      minSamples: num(b, "minSamples", "config.hedge.beta", { min: 10, max: 10_000, int: true, def: 60 }),
      min: num(b, "min", "config.hedge.beta", { min: 0, max: 5, def: 0 }),
      max: num(b, "max", "config.hedge.beta", { min: 0, max: 5, def: 3 }),
      everySec: num(b, "everySec", "config.hedge.beta", { min: 10, max: 3_600, int: true, def: 60 }),
    };
    if (beta.min > beta.max) throw new ConfigError("config.hedge.beta: min is above max");
  }
  const maxNotionalUsd = h.maxNotionalUsd === undefined ? undefined : num(h, "maxNotionalUsd", "config.hedge", { min: 0 });
  const hedge = {
    proxy,
    ratio: num(h, "ratio", "config.hedge", { min: 0, max: 5, def: 1 }),
    coins,
    bandPct: num(h, "bandPct", "config.hedge", { min: 0, max: 100, def: 20 }),
    minOrderUsd: num(h, "minOrderUsd", "config.hedge", { min: 10, def: 11 }),
    maxLeverage: num(h, "maxLeverage", "config.hedge", { min: 1, max: 50, int: true, def: 3 }),
    maxMarginUsd: num(h, "maxMarginUsd", "config.hedge", { min: 0 }),
    ...(maxNotionalUsd !== undefined ? { maxNotionalUsd } : {}),
    minBagUsd: num(h, "minBagUsd", "config.hedge", { min: 0, def: 20 }),
    unpricedCloseSec: num(h, "unpricedCloseSec", "config.hedge", { min: 10, max: 86_400, int: true, def: 300 }),
    beta,
  };
  if (hedge.unpricedCloseSec * 1000 < loopMs) throw new ConfigError("config.hedge.unpricedCloseSec: shorter than one loop (loopMs): every bag would count as unpriced");

  return deepFreeze({ mode, network, apiUrl, ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(rpcUrlEnv ? { rpcUrlEnv } : {}), stateDir, loopMs, spot, perps, hedge, alerts: parseAlerts(raw.alerts), configDir: resolve(baseDir) });
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

