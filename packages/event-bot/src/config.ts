/**
 * The one config file: the core's shared sections (candle-bot-core) plus `events` (the dated events: a coin and a
 * time each) and `entry` (when, before each event, the coin is bought, and the limits). The exit is any core strategy;
 * `event` (the phased exit) gets each coin's event time from `events` (a config never sets exit.events itself).
 * Unknown keys are refused at every level.
 */
import { parseConfig as parseCore, loadConfig as loadCore, ConfigError, isObj, only, num, bool, str, strList, type Config as CoreConfig } from "candle-bot-core/config";
import { asAddress } from "candle-bot-core/solana/base58";
import { create as eventExit, EVENT_DEFAULTS } from "candle-bot-core/strategies/event";

export { ConfigError } from "candle-bot-core/config";

export interface EventItem {
  mint: string;
  /** The event time (ms), from an ISO 8601 time with its offset (e.g. "2026-12-01T17:00:00Z"). */
  atMs: number;
  label: string;
}

export interface Entry {
  /** The buy window opens this many hours before the event... */
  fromHours: number;
  /** ...and closes this many minutes before it (a buy is never built after). */
  untilMin: number;
  /** The ticket's price impact on the venue, bps (the fee apart). Also the buy-retry limit. */
  maxImpactBps: number;
  /** No attempt of a buy is built more than this many seconds after its decision (nor after the window closes). */
  buyWithinSec: number;
  /** A coin skipped in its window is looked at again after this long (min). */
  retryMin: number;
  /** Linked payer: sign only builds whose programs are known (the core's list plus extraPrograms). Default true. */
  checkPrograms: boolean;
  extraPrograms: string[];
  /**
   * Linked payer: a sell is never signed below the venue's own expected out less sell.maxSlippageBps and this (pump.fun
   * venues only; on another venue, or when the read fails, only Candle's own floor applies).
   */
  sellFloorMarginBps: number;
  /** Linked payer: a buy is never signed with a floor under the decision fill less buy.maxSlippageBps and this. */
  buyFloorMarginBps: number;
}

export type Config = CoreConfig & { events: EventItem[]; entry: Entry };

function parseEvents(raw: unknown): EventItem[] {
  const w = "config.events";
  if (!Array.isArray(raw) || raw.length === 0) throw new ConfigError(`${w}: a non-empty list of { mint, at, label? }`);
  if (raw.length > 200) throw new ConfigError(`${w}: at most 200 events`);
  const seen = new Set<string>();
  return raw.map((e, i) => {
    const k = `${w}[${i}]`;
    if (!isObj(e)) throw new ConfigError(`${k}: { mint, at, label? }`);
    only(e, ["mint", "at", "label"], k);
    const mint = str(e, "mint", k)!;
    if (asAddress(mint) !== mint) throw new ConfigError(`${k}.mint: "${mint}" is not a Solana address`);
    const at = str(e, "at", k)!;
    // An explicit offset is required: a time without one would read as the machine's local time.
    const g = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(at);
    if (!g) throw new ConfigError(`${k}.at: an ISO 8601 time with its offset, e.g. "2026-12-01T17:00:00Z"`);
    // A date that does not exist (Feb 30, 24:00) would roll over to another day without a word: refused.
    const [y, mo, d, hh, mm, ss] = [g[1], g[2], g[3], g[4], g[5], g[6] ?? "0"].map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || hh > 23 || mm > 59 || ss > 59) throw new ConfigError(`${k}.at: "${at}" is not a real date and time`);
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) throw new ConfigError(`${k}.at: not a time`);
    if (seen.has(mint)) throw new ConfigError(`${k}.mint: ${mint} is listed twice (one event per coin)`);
    seen.add(mint);
    return { mint, atMs, label: str(e, "label", k, { def: "" })! };
  });
}

function parseEntry(raw: unknown): Entry {
  const w = "config.entry";
  const d = raw === undefined ? {} : raw;
  if (!isObj(d)) throw new ConfigError(`${w}: must be an object`);
  only(d, ["fromHours", "untilMin", "maxImpactBps", "buyWithinSec", "retryMin", "checkPrograms", "extraPrograms", "sellFloorMarginBps", "buyFloorMarginBps"], w);
  const out: Entry = {
    fromHours: num(d, "fromHours", w, { min: 0.1, max: 8760, def: 72 }),
    untilMin: num(d, "untilMin", w, { min: -10_080, max: 525_600, def: 60 }),
    maxImpactBps: num(d, "maxImpactBps", w, { min: 0, max: 10_000, def: 300 }),
    buyWithinSec: num(d, "buyWithinSec", w, { min: 5, max: 3600, int: true, def: 60 }),
    retryMin: num(d, "retryMin", w, { min: 1, max: 1440, int: true, def: 10 }),
    checkPrograms: bool(d, "checkPrograms", w, true),
    extraPrograms: strList(d, "extraPrograms", w, { def: [], address: true })!,
    sellFloorMarginBps: num(d, "sellFloorMarginBps", w, { min: 0, max: 10_000, int: true, def: 200 }),
    buyFloorMarginBps: num(d, "buyFloorMarginBps", w, { min: 0, max: 10_000, int: true, def: 200 }),
  };
  if (out.untilMin >= out.fromHours * 60) throw new ConfigError(`${w}: the window closes (untilMin before the event) before it opens (fromHours before it)`);
  return out;
}

export const SECTIONS = { events: parseEvents, entry: parseEntry };

/** The exit's event times, from the event list (the `event` strategy reads them). */
export function eventTimes(c: Pick<Config, "events">): Record<string, number> {
  return Object.fromEntries(c.events.map((e) => [e.mint, e.atMs]));
}

/** The event exit is checked at load, with the event times filled in (a config never sets exit.events). */
function checked(c: Config): Config {
  if (c.exit.strategy === "event") {
    if (c.exit.events !== undefined) throw new ConfigError("config.exit.events: filled from config.events; leave it out");
    // The buy window must close before the hedge: a buy after it would be sold down at the next exit tick.
    const hedgeAtMin = typeof c.exit.hedgeAtMin === "number" ? c.exit.hedgeAtMin : EVENT_DEFAULTS.hedgeAtMin;
    if (-c.entry.untilMin >= hedgeAtMin) throw new ConfigError(`config.entry.untilMin: the buy window closes ${-c.entry.untilMin} min after the event, at or after the hedge (exit.hedgeAtMin ${hedgeAtMin}): a buy then would be sold at once`);
    try {
      const { strategy: _s, ...params } = c.exit;
      eventExit({ ...params, events: eventTimes(c) });
    } catch (e) {
      throw new ConfigError(String((e as Error).message));
    }
  }
  return c;
}

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
  return checked(parseCore(raw, baseDir, SECTIONS) as Config);
}

export function loadConfig(path: string): Config {
  return checked(loadCore(path, SECTIONS) as Config);
}
