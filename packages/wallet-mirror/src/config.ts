/**
 * The mirror's config: the core's shared sections (candle-bot-core) plus `leaders` (the wallets to copy), `mirror` (the
 * copy rules) and `source` (how the wallets are watched). A watch-only config (`watch` command) takes the core's
 * watch-only keys (nothing that trades) plus `leaders`, `source` and `notify`. Unknown keys are refused at every level.
 */
import { parseConfig as parseCore, loadConfig as loadCore, parseWatchConfig, ConfigError, isObj, only, num, bool, str, strList, asAddress, ENV_NAME, type Config as CoreConfig, type SectionParser, type WatchConfig } from "candle-bot-core";
import { TRADE_VENUES } from "candle-bot-core/market/walletTrade";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export { ConfigError } from "candle-bot-core/config";

export interface Leader {
  address: string;
  label?: string;
  /** This leader's fixed ticket, SOL (ticket.mode fixed); at most buy.sol. */
  sol?: number;
  /** This leader's share of its own SOL (ticket.mode fraction). */
  fraction?: number;
  /** Most copies of this leader over the bot's lifetime. */
  maxEntries?: number;
  /** Most SOL spent copying this leader over the bot's lifetime. */
  maxSol?: number;
}

export interface Mirror {
  ticket: { mode: "fixed" | "fraction"; fraction: number; minSol: number };
  /** Which leader buys are copied: "opens" (a buy from flat: the leader held at most openDustPct % before) or every "buys". */
  copy: "opens" | "buys";
  openDustPct: number;
  /** A leader trade older than this at detection is not copied (seconds, from its block time). */
  maxAgeSec: number;
  /** A leader buy smaller than this is not copied (SOL). */
  minLeaderSol: number;
  /** The venues (or the Jupiter route) whose trades are copied. */
  venues: string[];
  /** Mirror the leader's sells (same share of what the leader held). */
  sells: boolean;
  /** Whose sells: only the leader we copied in that coin, or any listed leader. */
  sellsFrom: "copied" | "any";
  /** A leader sell below this share of its holding is not mirrored (0: every sell). */
  minSellFraction: number;
  /** Most price impact of our ticket at the buy (bps). */
  maxImpactBps: number;
  /** A leader that has sold below this share of its peak holding since its buy is not copied (0..1). */
  minLeaderHeldFraction: number;
  /** Most our price may be above the leader's fill price (bps). */
  maxOverLeaderBps: number;
  /** TEE wallet (payer linked) only: the programs a build may call (as the other bots). */
  checkPrograms: boolean;
  extraPrograms: string[];
  sellFloorMarginBps: number;
  buyFloorMarginBps: number;
}

export interface Source {
  /** A separate RPC for the watcher (its reads are many; a rate limit there must not reach the trading RPC). */
  rpcUrlEnv?: string;
  wsUrlEnv?: string;
  /** No websocket: poll only. */
  poll: boolean;
  fetchPerSec: number;
  fetchBurst: number;
  pollSec: number;
  reconcileSec: number;
  backfillLimit: number;
  /** Append every fetched transaction to this file (JSON lines), for `replay`. */
  record?: string;
}

export interface Notify {
  buys: boolean;
  sells: boolean;
  /** Only opens (a buy from flat), not adds. */
  opensOnly: boolean;
  minSol: number;
  gaps: boolean;
  link: string;
}

export type Config = CoreConfig & { leaders: Leader[]; mirror: Mirror; source: Source };

function parseLeaders(raw: unknown, core: { buy: CoreConfig["buy"] } | null): Leader[] {
  const where = "config.leaders";
  if (!Array.isArray(raw) || !raw.length) throw new ConfigError(`${where}: required, a list of { address, label? }`);
  const seen = new Set<string>();
  return raw.map((l, i): Leader => {
    const w = `${where}[${i}]`;
    if (!isObj(l)) throw new ConfigError(`${w}: must be an object`);
    only(l, core ? ["address", "label", "sol", "fraction", "maxEntries", "maxSol"] : ["address", "label"], w);
    const address = str(l, "address", w)!;
    if (!asAddress(address)) throw new ConfigError(`${w}.address: "${address}" is not an address`);
    if (seen.has(address)) throw new ConfigError(`${w}.address: listed twice`);
    seen.add(address);
    const out: Leader = { address, label: str(l, "label", w, { optional: true }) };
    if (!core) return out;
    if (l.sol !== undefined) {
      out.sol = num(l, "sol", w, { min: 0.000001 });
      if (out.sol > core.buy.sol) throw new ConfigError(`${w}.sol: ${out.sol} is above buy.sol (${core.buy.sol}); a leader's ticket can only be smaller`);
    }
    if (l.fraction !== undefined) out.fraction = num(l, "fraction", w, { min: 0.000001, max: 100 });
    if (l.maxEntries !== undefined) out.maxEntries = num(l, "maxEntries", w, { min: 1, int: true });
    if (l.maxSol !== undefined) out.maxSol = num(l, "maxSol", w, { min: 0.000001 });
    return out;
  });
}

const parseMirror: SectionParser<Mirror> = (raw, core) => {
  const w = "config.mirror";
  const m = raw === undefined ? {} : raw;
  if (!isObj(m)) throw new ConfigError(`${w}: must be an object`);
  only(m, ["ticket", "copy", "openDustPct", "maxAgeSec", "minLeaderSol", "venues", "sells", "sellsFrom", "minSellFraction", "maxImpactBps", "minLeaderHeldFraction", "maxOverLeaderBps", "checkPrograms", "extraPrograms", "sellFloorMarginBps", "buyFloorMarginBps"], w);
  const t = m.ticket === undefined ? {} : m.ticket;
  if (!isObj(t)) throw new ConfigError(`${w}.ticket: must be an object`);
  only(t, ["mode", "fraction", "minSol"], `${w}.ticket`);
  const mode = str(t, "mode", `${w}.ticket`, { def: "fixed" });
  if (mode !== "fixed" && mode !== "fraction") throw new ConfigError(`${w}.ticket.mode: "fixed" (buy.sol, or a leader's sol) or "fraction" (a share of the leader's SOL, capped at buy.sol)`);
  const ticket = {
    mode: mode as "fixed" | "fraction",
    fraction: num(t, "fraction", `${w}.ticket`, { min: 0.000001, max: 100, def: 0.1 }),
    minSol: num(t, "minSol", `${w}.ticket`, { min: 0.000001, def: Math.min(0.001, core.buy.sol) }),
  };
  if (ticket.minSol > core.buy.sol) throw new ConfigError(`${w}.ticket.minSol: ${ticket.minSol} is above buy.sol (${core.buy.sol}); nothing could be bought`);
  const copy = str(m, "copy", w, { def: "opens" });
  if (copy !== "opens" && copy !== "buys") throw new ConfigError(`${w}.copy: "opens" (a buy from flat) or "buys" (any buy; still once per coin)`);
  const venues = strList(m, "venues", w, { def: [...TRADE_VENUES] })!;
  if (!venues.length) throw new ConfigError(`${w}.venues: at least one`);
  for (const v of venues) if (!TRADE_VENUES.includes(v as never)) throw new ConfigError(`${w}.venues: "${v}" is not one of ${TRADE_VENUES.join(", ")}`);
  const sellsFrom = str(m, "sellsFrom", w, { def: "copied" });
  if (sellsFrom !== "copied" && sellsFrom !== "any") throw new ConfigError(`${w}.sellsFrom: "copied" (the leader we copied in that coin) or "any" (any listed leader)`);
  const extraPrograms = strList(m, "extraPrograms", w, { def: [], address: true })!;
  return {
    ticket,
    copy,
    openDustPct: num(m, "openDustPct", w, { min: 0, max: 99, def: 1 }),
    maxAgeSec: num(m, "maxAgeSec", w, { min: 1, max: 86_400, def: 20 }),
    minLeaderSol: num(m, "minLeaderSol", w, { min: 0, def: 0 }),
    venues,
    sells: bool(m, "sells", w, true),
    sellsFrom,
    minSellFraction: num(m, "minSellFraction", w, { min: 0, max: 1, def: 0 }),
    maxImpactBps: num(m, "maxImpactBps", w, { min: 0, max: 10_000, int: true, def: 500 }),
    minLeaderHeldFraction: num(m, "minLeaderHeldFraction", w, { min: 0, max: 1, def: 0.5 }),
    maxOverLeaderBps: num(m, "maxOverLeaderBps", w, { min: 0, max: 1_000_000, int: true, def: 3000 }),
    checkPrograms: bool(m, "checkPrograms", w, true),
    extraPrograms,
    sellFloorMarginBps: num(m, "sellFloorMarginBps", w, { min: 0, max: 10_000, int: true, def: 200 }),
    buyFloorMarginBps: num(m, "buyFloorMarginBps", w, { min: 0, max: 10_000, int: true, def: 200 }),
  } as Mirror;
};

function parseSource(raw: unknown): Source {
  const w = "config.source";
  const s = raw === undefined ? {} : raw;
  if (!isObj(s)) throw new ConfigError(`${w}: must be an object`);
  only(s, ["rpcUrlEnv", "wsUrlEnv", "poll", "fetchPerSec", "fetchBurst", "pollSec", "reconcileSec", "backfillLimit", "record"], w);
  return {
    ...(s.rpcUrlEnv !== undefined ? { rpcUrlEnv: str(s, "rpcUrlEnv", w, { re: ENV_NAME }) } : {}),
    ...(s.wsUrlEnv !== undefined ? { wsUrlEnv: str(s, "wsUrlEnv", w, { re: ENV_NAME }) } : {}),
    poll: bool(s, "poll", w, false),
    fetchPerSec: num(s, "fetchPerSec", w, { min: 0.05, max: 1000, def: 1 }),
    fetchBurst: num(s, "fetchBurst", w, { min: 1, max: 1000, int: true, def: 8 }),
    pollSec: num(s, "pollSec", w, { min: 1, max: 3600, def: 15 }),
    reconcileSec: num(s, "reconcileSec", w, { min: 0, max: 86_400, def: 300 }),
    backfillLimit: num(s, "backfillLimit", w, { min: 1, max: 10_000, int: true, def: 300 }),
    ...(s.record !== undefined ? { record: str(s, "record", w) } : {}),
  } as Source;
}

function parseNotify(raw: unknown): Notify {
  const w = "config.notify";
  const n = raw === undefined ? {} : raw;
  if (!isObj(n)) throw new ConfigError(`${w}: must be an object`);
  only(n, ["buys", "sells", "opensOnly", "minSol", "gaps", "link"], w);
  return {
    buys: bool(n, "buys", w, true),
    sells: bool(n, "sells", w, true),
    opensOnly: bool(n, "opensOnly", w, false),
    minSol: num(n, "minSol", w, { min: 0, def: 0 }),
    gaps: bool(n, "gaps", w, true),
    link: str(n, "link", w, { def: "https://alpha.candle.tv/token/{mint}" })!,
  };
}

/** This bot's sections (run mode), in the order they are parsed. */
export const SECTIONS = {
  leaders: ((raw, core) => parseLeaders(raw, core)) as SectionParser<Leader[]>,
  mirror: parseMirror,
  source: ((raw) => parseSource(raw)) as SectionParser<Source>,
};

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  const c = parseCore(raw, baseDir, SECTIONS) as Config;
  for (const [i, l] of c.leaders.entries()) {
    if (l.fraction !== undefined && c.mirror.ticket.mode !== "fraction") throw new ConfigError(`config.leaders[${i}].fraction: only with mirror.ticket.mode "fraction"`);
    if (l.sol !== undefined && c.mirror.ticket.mode !== "fixed") throw new ConfigError(`config.leaders[${i}].sol: only with mirror.ticket.mode "fixed"`);
    if (l.maxSol !== undefined && l.maxSol < c.mirror.ticket.minSol) throw new ConfigError(`config.leaders[${i}].maxSol: below mirror.ticket.minSol; it could never buy`);
  }
  return c;
}

export function loadConfig(path: string): Config {
  return loadCore(path, SECTIONS) as Config;
}

// ------------------------------------------------------------------------------------------------- watch-only

export const WATCH_SECTIONS = {
  leaders: ((raw) => parseLeaders(raw, null)) as SectionParser<Leader[]>,
  source: ((raw) => parseSource(raw)) as SectionParser<Source>,
  notify: ((raw) => parseNotify(raw)) as SectionParser<Notify>,
};
export type WatchModeConfig = WatchConfig<typeof WATCH_SECTIONS>;

export function parseWatchModeConfig(raw: unknown, baseDir = process.cwd()): WatchModeConfig {
  return parseWatchConfig(raw, baseDir, WATCH_SECTIONS);
}

export function loadWatchModeConfig(path: string): WatchModeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`${path}: ${(e as Error).message}`);
  }
  return parseWatchModeConfig(raw, dirname(resolve(path)));
}
