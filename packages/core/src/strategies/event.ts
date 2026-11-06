/**
 * (0.6.0) event: a phased exit keyed to a dated event (a launch, a keynote, a listing): ride the build-up, hedge at
 * the event, keep a moonshot core.
 *
 *   { "strategy": "event", "events": { "<mint>": 1793900000000 },
 *     "rungs": [{ "at": 3, "sell": 0.2 }], "stopLoss": 0.3,
 *     "hedgeAtMin": 0, "hedgeKeep": 0.5, "afterMin": 60, "coreKeep": 0.2,
 *     "coreTakeProfit": 20, "coreMaxHoldHours": 168 }
 *
 * `events` maps each coin to its event time (ms; the bot fills it from its event list). Every phase is a target for the
 * share of the ORIGINAL position kept (as the ladder's rungs are targets for the share sold), so a restart, a failed
 * sell or a late tick never sells twice:
 *  - build-up (before the hedge): optional `rungs` (the ladder's: at a multiple, sell that share of the original, in
 *    all); optional `stopLoss` (a multiple: everything goes). Nothing else sells before the event.
 *  - hedge: from `hedgeAtMin` minutes after the event time (negative: before it), keep at most `hedgeKeep`.
 *  - after: from `afterMin` minutes after the event, keep at most `coreKeep` (the moonshot core).
 *  - core: `coreTakeProfit` (a multiple: the core goes) and `coreMaxHoldHours` after the event (the core goes); without
 *    them the core is held.
 * A coin with no event time in `events` holds (and is logged by the bot).
 */
import { create as ladder } from "./ladder.ts";
import { HOLD, checkParams, multiple, param, StrategyConfigError, type Decision, type ExitStrategy } from "./types.ts";

const KEYS = ["events", "rungs", "stopLoss", "hedgeAtMin", "hedgeKeep", "afterMin", "coreKeep", "coreTakeProfit", "coreMaxHoldHours"];

export function create(params: Record<string, unknown>): ExitStrategy {
  checkParams(params, KEYS, "event");
  const raw = params.events;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StrategyConfigError("exit (event).events: a map of mint to event time (ms); the bot fills it from its event list");
  const events = new Map<string, number>();
  for (const [m, t] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) throw new StrategyConfigError(`exit (event).events.${m}: an event time in ms`);
    events.set(m, t);
  }
  const has = (k: string) => params[k] !== undefined;
  const build = has("rungs") ? ladder({ rungs: params.rungs }) : null;
  const sl = has("stopLoss") ? param(params, "stopLoss", "event", { exclusiveMin: 0, max: 1 }) : 0;
  const hedgeAtMs = param(params, "hedgeAtMin", "event", { min: -10_080, max: 10_080, def: 0 }) * 60_000;
  const hedgeKeep = param(params, "hedgeKeep", "event", { min: 0, max: 1, def: 0.5 });
  const afterMs = param(params, "afterMin", "event", { min: -10_080, max: 525_600, def: 60 }) * 60_000;
  const coreKeep = param(params, "coreKeep", "event", { min: 0, max: 1, def: 0.2 });
  const coreTp = has("coreTakeProfit") ? param(params, "coreTakeProfit", "event", { exclusiveMin: 1 }) : Infinity;
  const coreMaxMs = has("coreMaxHoldHours") ? param(params, "coreMaxHoldHours", "event", { exclusiveMin: 0, max: 87_600 }) * 3_600_000 : Infinity;
  if (coreKeep > hedgeKeep) throw new StrategyConfigError("exit (event): coreKeep is above hedgeKeep (the core is what is left after the hedge)");
  if (afterMs < hedgeAtMs) throw new StrategyConfigError("exit (event): afterMin is before hedgeAtMin");
  if (coreMaxMs !== Infinity && coreMaxMs < afterMs) throw new StrategyConfigError("exit (event): coreMaxHoldHours ends before afterMin");

  /** Sell down to `keep` of the original (a fraction of what remains), or hold when already at or under it. */
  const keepAt = (soldFraction: number, keep: number, why: string): Decision => {
    const remaining = 1 - soldFraction;
    if (remaining <= keep + 1e-6 || remaining <= 0) return HOLD;
    return { action: "sell", fraction: keep <= 0 ? 1 : Math.min(1, (remaining - keep) / remaining), reason: `${why} (keep ${(keep * 100).toFixed(0)} %)` };
  };

  return {
    name: "event",
    needsBasis: build !== null || sl > 0 || coreTp !== Infinity,
    onTick(p, m) {
      const at = events.get(p.mint);
      if (at === undefined || p.remainingRaw <= 0n) return HOLD;
      const since = m.nowMs - at; // ms after the event (negative before)
      const x = multiple(p, m);
      if (since >= coreMaxMs) return { action: "sell", fraction: 1, reason: `core max hold ${Math.round(since / 3_600_000)} h after the event` };
      if (since >= afterMs) {
        const d = keepAt(p.soldFraction, coreKeep, "after the event");
        if (d.action === "sell") return d;
        if (x !== null && x >= coreTp) return { action: "sell", fraction: 1, reason: `core take profit ${x.toFixed(3)}x` };
        return HOLD;
      }
      if (since >= hedgeAtMs) return keepAt(p.soldFraction, hedgeKeep, "event hedge");
      // The build-up: only the stop loss and the ladder's rungs.
      if (sl > 0 && x !== null && x <= sl) return { action: "sell", fraction: 1, reason: `stop_loss ${x.toFixed(3)}x before the event` };
      return build ? build.onTick(p, m) : HOLD;
    },
  };
}
