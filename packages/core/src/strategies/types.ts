/**
 * Exit strategies. One file per strategy in this folder, exporting `create(params)`; the engine loads it by the
 * config's `exit.strategy` name. Adding a strategy is one new file and no engine change.
 *
 * `onTick` is called once per cycle for each open position that has no exit order in flight. It returns
 * `hold` or `sell` with a fraction of the position's REMAINING quantity (0 < fraction <= 1).
 */
import type { SeriesView } from "../sources/series.ts";

export interface PositionView {
  mint: string;
  openedAtMs: number;
  /** Tokens booked at entry (raw units, from the on-chain fill). */
  qtyRaw: bigint;
  /** Tokens still held by this position (raw). */
  remainingRaw: bigint;
  decimals: number;
  /** SOL per whole token paid at entry, all-in (cost / quantity). */
  entryPriceSol: number;
  /** Highest market price seen since entry (SOL per whole token). */
  peakPriceSol: number;
  /** Share of the original quantity already sold, 0..1. */
  soldFraction: number;
  /**
   * (0.5.0) For a strategy with `trailMark`: the highest price since entry (or adoption) or since its last sell that
   * asked `resetTrail`, persisted in the ledger (a restart keeps it). Absent otherwise.
   */
  trailPeakSol?: number;
}

export interface MarketView {
  /** SOL per whole token now, or null when unreadable this cycle. */
  priceSol: number | null;
  /** Graduation progress 0..1 while on the curve; 1 once migrated; null when unknown. */
  progress: number | null;
  migrated: boolean;
  /** (0.5.0) "pump-curve" and "pumpswap" only when the bot reads pump.fun venues (EngineDeps.venues). */
  venue: "curve" | "damm" | "pump-curve" | "pumpswap" | "unknown";
  nowMs: number;
  /**
   * (0.6.0) The coin's price and volume series (sources/series) when the bot opts in (EngineDeps.exitSeries with a
   * series); absent otherwise, and null when the coin is not watched. Read `complete` before acting on a bar.
   */
  series?: SeriesView | null;
}

/** `resetTrail` (0.5.0): once this sell is booked, the position's trail mark restarts at the price now. */
export type Decision = { action: "hold" } | { action: "sell"; fraction: number; reason: string; resetTrail?: boolean };

export interface ExitStrategy {
  readonly name: string;
  onTick(position: PositionView, market: MarketView): Decision;
  /**
   * (0.5.0) True when the strategy reads a cost basis (multiples of the entry price): a position adopted without one
   * cannot use it (see the adoption config's noBasis). Built-ins say so; a strategy that leaves it unset is taken to
   * need one.
   */
  readonly needsBasis?: boolean;
  /** (0.5.0) True when the strategy reads PositionView.trailPeakSol: the engine keeps the mark in the ledger. */
  readonly trailMark?: boolean;
}

export type StrategyFactory = (params: Record<string, unknown>) => ExitStrategy;

export const HOLD: Decision = { action: "hold" };

export class StrategyConfigError extends Error {}

/** Shared parameter checks: unknown keys refused, numbers range-checked. */
export function checkParams(params: Record<string, unknown>, allowed: string[], name: string): void {
  for (const k of Object.keys(params)) if (k !== "strategy" && !allowed.includes(k)) throw new StrategyConfigError(`exit (${name}): unknown key "${k}"`);
}

export function param(params: Record<string, unknown>, key: string, name: string, opts: { min?: number; max?: number; def?: number; exclusiveMin?: number } = {}): number {
  const v = params[key];
  if (v === undefined) {
    if (opts.def !== undefined) return opts.def;
    throw new StrategyConfigError(`exit (${name}).${key}: required`);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new StrategyConfigError(`exit (${name}).${key}: must be a number`);
  if (opts.min !== undefined && v < opts.min) throw new StrategyConfigError(`exit (${name}).${key}: must be >= ${opts.min}`);
  if (opts.exclusiveMin !== undefined && v <= opts.exclusiveMin) throw new StrategyConfigError(`exit (${name}).${key}: must be > ${opts.exclusiveMin}`);
  if (opts.max !== undefined && v > opts.max) throw new StrategyConfigError(`exit (${name}).${key}: must be <= ${opts.max}`);
  return v;
}

export function multiple(p: PositionView, m: MarketView): number | null {
  if (m.priceSol === null || !(p.entryPriceSol > 0)) return null;
  return m.priceSol / p.entryPriceSol;
}
