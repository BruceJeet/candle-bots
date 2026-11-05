/**
 * The one config file: the core's shared sections (candle-bot-core) plus `adoption` (which coins to watch: the core's
 * adoption, as the exit manager), `rules` (what counts as a rug, what to do) and `watch` (holder polling, signing
 * checks). This bot never buys: a `buy` section is refused. Unknown keys are refused at every level.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseConfig as parseCore, ConfigError, isObj, only, bool, num, strList, asAddress, type Config as CoreConfig, type Obj, type SectionParser } from "candle-bot-core";
import { parseAdoption, type AdoptionConfig } from "candle-bot-core/adopt/adopter";

export { ConfigError } from "candle-bot-core/config";

/** What a rule does when it fires: sell this share of what remains, or only alert. */
export interface Action {
  sell: number;
  alertOnly: boolean;
}
export type WindowRule = Action & { dropPct: number; windowSec: number };
/** creators: a coin's creator wallet by hand, for coins whose launch transaction does not name it (see the README). */
export type DevRule = Action & { soldPct?: number; floorPct?: number; creators: Record<string, string> };
/** exclude: wallets never counted as large holders (an exchange, a locker that is a plain wallet). */
export type HolderRule = Action & { topN: number; soldPctOfSupply: number; windowSec: number; exclude: string[] };

export interface Rules {
  liquidityPull?: WindowRule;
  priceCrash?: WindowRule;
  devDump?: DevRule;
  holderExit?: HolderRule;
}

export interface Watch {
  /** How often each watched coin's holders (and its creator's balance) are read. */
  holdersPollMs: number;
  /** Coins whose holders are read in one poll at most (the rest in the next). */
  maxCoinsPerPoll: number;
  checkPrograms: boolean;
  extraPrograms: string[];
  sellFloorMarginBps: number;
}

export type Config = CoreConfig & { adoption: AdoptionConfig; rules: Rules; watch: Watch };

export const NO_BUYS = Object.freeze({ sol: 0.000001, maxSlippageBps: 0, maxOpen: 0, lifetimeSol: 0, maxPerCoin: 1 });

function action(o: Obj, w: string): Action {
  return { sell: num(o, "sell", w, { min: 0, max: 1, def: 1 }), alertOnly: bool(o, "alertOnly", w, false) };
}

function checkAction(a: Action, w: string): void {
  if (!a.alertOnly && !(a.sell > 0)) throw new ConfigError(`${w}: sell must be > 0 unless alertOnly is true`);
}

const parseRules: SectionParser<Rules> = (raw) => {
  const w = "config.rules";
  if (!isObj(raw)) throw new ConfigError(`${w}: required object with at least one of liquidityPull, priceCrash, devDump, holderExit`);
  only(raw, ["liquidityPull", "priceCrash", "devDump", "holderExit"], w);
  const out: Rules = {};
  for (const k of ["liquidityPull", "priceCrash"] as const) {
    const r = raw[k];
    if (r === undefined) continue;
    if (!isObj(r)) throw new ConfigError(`${w}.${k}: an object`);
    only(r, ["dropPct", "windowSec", "sell", "alertOnly"], `${w}.${k}`);
    out[k] = { dropPct: num(r, "dropPct", `${w}.${k}`, { min: 1, max: 99 }), windowSec: num(r, "windowSec", `${w}.${k}`, { min: 5, max: 86_400, int: true }), ...action(r, `${w}.${k}`) };
    checkAction(out[k]!, `${w}.${k}`);
  }
  if (raw.devDump !== undefined) {
    const r = raw.devDump;
    if (!isObj(r)) throw new ConfigError(`${w}.devDump: an object`);
    only(r, ["soldPct", "floorPct", "creators", "sell", "alertOnly"], `${w}.devDump`);
    const creators: Record<string, string> = {};
    const cr = r.creators === undefined ? {} : r.creators;
    if (!isObj(cr)) throw new ConfigError(`${w}.devDump.creators: an object { "<mint>": "<creator wallet>" }`);
    for (const [mint, who] of Object.entries(cr)) {
      if (asAddress(mint) !== mint) throw new ConfigError(`${w}.devDump.creators: "${mint}" is not a mint address`);
      if (typeof who !== "string" || asAddress(who) !== who) throw new ConfigError(`${w}.devDump.creators.${mint}: a wallet address`);
      creators[mint] = who;
    }
    const soldPct = r.soldPct === undefined ? undefined : num(r, "soldPct", `${w}.devDump`, { min: 1, max: 100 });
    const floorPct = r.floorPct === undefined ? undefined : num(r, "floorPct", `${w}.devDump`, { min: 0.0001, max: 100 });
    if (soldPct === undefined && floorPct === undefined) throw new ConfigError(`${w}.devDump: set soldPct, floorPct or both`);
    out.devDump = { ...(soldPct !== undefined ? { soldPct } : {}), ...(floorPct !== undefined ? { floorPct } : {}), creators, ...action(r, `${w}.devDump`) };
    checkAction(out.devDump, `${w}.devDump`);
  }
  if (raw.holderExit !== undefined) {
    const r = raw.holderExit;
    if (!isObj(r)) throw new ConfigError(`${w}.holderExit: an object`);
    only(r, ["topN", "soldPctOfSupply", "windowSec", "exclude", "sell", "alertOnly"], `${w}.holderExit`);
    out.holderExit = {
      topN: num(r, "topN", `${w}.holderExit`, { min: 1, max: 20, int: true, def: 10 }),
      soldPctOfSupply: num(r, "soldPctOfSupply", `${w}.holderExit`, { min: 0.01, max: 100 }),
      windowSec: num(r, "windowSec", `${w}.holderExit`, { min: 10, max: 86_400, int: true, def: 600 }),
      exclude: strList(r, "exclude", `${w}.holderExit`, { def: [], address: true })!,
      ...action(r, `${w}.holderExit`),
    };
    checkAction(out.holderExit, `${w}.holderExit`);
  }
  if (!Object.keys(out).length) throw new ConfigError(`${w}: at least one rule`);
  return out;
};

const parseWatch: SectionParser<Watch> = (raw) => {
  const r = raw === undefined ? {} : raw;
  if (!isObj(r)) throw new ConfigError("config.watch: must be an object");
  only(r, ["holdersPollMs", "maxCoinsPerPoll", "checkPrograms", "extraPrograms", "sellFloorMarginBps"], "config.watch");
  return {
    holdersPollMs: num(r, "holdersPollMs", "config.watch", { min: 2_000, int: true, def: 15_000 }),
    maxCoinsPerPoll: num(r, "maxCoinsPerPoll", "config.watch", { min: 1, max: 100, int: true, def: 10 }),
    checkPrograms: bool(r, "checkPrograms", "config.watch", true),
    extraPrograms: strList(r, "extraPrograms", "config.watch", { def: [], address: true })!,
    sellFloorMarginBps: num(r, "sellFloorMarginBps", "config.watch", { min: 0, max: 10_000, int: true, def: 200 }),
  };
};

const adoptionSection: SectionParser<AdoptionConfig> = (raw, core) => parseAdoption(raw, core.baseDir);

export const SECTIONS = { adoption: adoptionSection, rules: parseRules, watch: parseWatch };

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  if (!isObj(raw)) throw new ConfigError("config: must be a JSON object");
  if (raw.buy !== undefined) throw new ConfigError("config.buy: this bot never buys; remove the buy section");
  // `exit` is optional here (the rules are the point): default hold.
  const cfg = parseCore({ ...raw, buy: NO_BUYS, exit: raw.exit ?? { strategy: "hold" } }, baseDir, SECTIONS) as Config;
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
