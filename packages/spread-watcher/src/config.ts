/**
 * The spread watcher's config: the core's watch-only keys (no wallet, no key, nothing that trades) plus `coins`,
 * `perps` and `rules`. Unknown keys are refused at every level.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseWatchConfig, ConfigError, isObj, only, num, bool, str, asAddress, type SectionParser, type WatchConfig } from "candle-bot-core";
import type { PoolRef } from "candle-bot-core/market/venues";

export { ConfigError } from "candle-bot-core/config";

export interface CoinSpec {
  mint: string;
  label: string;
  /** Read the coin's own venue (its curve, or the pool it graduated to), as the core finds it. Default true. */
  own: boolean;
  /** Other pools of the coin, by address. */
  pools: PoolRef[];
  /** The coin's Hyperliquid perp (e.g. "WIF", "kBONK"), and the coin units per contract (default: 1,000 for a k prefix). */
  perp: string | null;
  perpUnits: number | null;
}

export interface PerpsSection {
  network: "mainnet" | "testnet";
  /** Read the perp marks every this many seconds (one public read for every coin). */
  everySec: number;
}

export interface Rules {
  /** Alert when the widest gap between two venues is at least this (bps of the lower price). */
  minSpreadBps: number;
  /** ... on this many reads in a row. */
  minReads: number;
  /** A pool counts only with at least this much SOL in it. */
  minDepthSol: number;
  /** Compare perps too (they have no depth). Default true. */
  perps: boolean;
  /** One alert per coin per this long. */
  cooldownMin: number;
  link: string;
}

const PERP = /^[A-Za-z0-9]{1,20}$/;

const parseCoins: SectionParser<CoinSpec[]> = (raw) => {
  const w = "config.coins";
  if (!Array.isArray(raw) || !raw.length) throw new ConfigError(`${w}: required, a list of { mint, pools?, perp? }`);
  const seen = new Set<string>();
  return raw.map((c, i) => {
    const at = `${w}[${i}]`;
    if (!isObj(c)) throw new ConfigError(`${at}: an object { mint, pools?, perp? }`);
    only(c, ["mint", "label", "own", "pools", "perp", "perpUnits"], at);
    const mint = str(c, "mint", at)!;
    if (asAddress(mint) !== mint) throw new ConfigError(`${at}.mint: not a Solana address`);
    if (seen.has(mint)) throw new ConfigError(`${at}.mint: listed twice`);
    seen.add(mint);
    const poolsRaw = c.pools === undefined ? [] : c.pools;
    if (!Array.isArray(poolsRaw)) throw new ConfigError(`${at}.pools: a list of { venue: "pumpswap" | "damm", address }`);
    const pools: PoolRef[] = poolsRaw.map((p, j) => {
      const pa = `${at}.pools[${j}]`;
      if (!isObj(p)) throw new ConfigError(`${pa}: { venue, address }`);
      only(p, ["venue", "address"], pa);
      const venue = str(p, "venue", pa) as PoolRef["venue"];
      if (venue !== "pumpswap" && venue !== "damm") throw new ConfigError(`${pa}.venue: "pumpswap" or "damm"`);
      const address = str(p, "address", pa)!;
      if (asAddress(address) !== address) throw new ConfigError(`${pa}.address: not a Solana address`);
      return { venue, address };
    });
    if (new Set(pools.map((p) => p.address)).size !== pools.length) throw new ConfigError(`${at}.pools: a pool is listed twice`);
    const perp = c.perp === undefined || c.perp === null ? null : str(c, "perp", at, { re: PERP })!;
    const own = bool(c, "own", at, true);
    if ((own ? 1 : 0) + pools.length + (perp ? 1 : 0) < 2) throw new ConfigError(`${at}: a spread needs two venues (own, pools, perp)`);
    return { mint, label: str(c, "label", at, { def: mint.slice(0, 6) })!, own, pools, perp, perpUnits: c.perpUnits === undefined ? null : num(c, "perpUnits", at, { min: 1e-9, max: 1e12 }) };
  });
};

const parsePerps: SectionParser<PerpsSection> = (raw) => {
  const w = "config.perps";
  const r = raw === undefined ? {} : raw;
  if (!isObj(r)) throw new ConfigError(`${w}: an object`);
  only(r, ["network", "everySec"], w);
  const network = str(r, "network", w, { def: "mainnet" }) as PerpsSection["network"];
  if (network !== "mainnet" && network !== "testnet") throw new ConfigError(`${w}.network: "mainnet" or "testnet"`);
  return { network, everySec: num(r, "everySec", w, { min: 5, max: 3_600, int: true, def: 30 }) };
};

const parseRules: SectionParser<Rules> = (raw) => {
  const w = "config.rules";
  const r = raw === undefined ? {} : raw;
  if (!isObj(r)) throw new ConfigError(`${w}: an object`);
  only(r, ["minSpreadBps", "minReads", "minDepthSol", "perps", "cooldownMin", "link"], w);
  return {
    minSpreadBps: num(r, "minSpreadBps", w, { min: 1, max: 1_000_000, int: true, def: 300 }),
    minReads: num(r, "minReads", w, { min: 1, max: 100, int: true, def: 3 }),
    minDepthSol: num(r, "minDepthSol", w, { min: 0, def: 5 }),
    perps: bool(r, "perps", w, true),
    cooldownMin: num(r, "cooldownMin", w, { min: 1, max: 10_080, int: true, def: 30 }),
    link: str(r, "link", w, { def: "https://alpha.candle.tv/token/{mint}" })!,
  };
};

export const SECTIONS = { coins: parseCoins, perps: parsePerps, rules: parseRules };
export type Config = WatchConfig<typeof SECTIONS>;

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  return parseWatchConfig(raw, baseDir, SECTIONS);
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
