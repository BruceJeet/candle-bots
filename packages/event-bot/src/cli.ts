/** The command line: run, plan, status, sell. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "candle-bot-core/engine";
import { Executor } from "candle-bot-core/exec/executor";
import { KNOWN_PROGRAMS } from "candle-bot-core/exec/trader";
import { Ledger } from "candle-bot-core/ledger";
import { sellFloor } from "candle-bot-core/market/reader";
import { args, context as coreContext, die, guardMain, parts, run, sell, status, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { loadConfig, ConfigError, eventTimes, type Config } from "./config.ts";
import { EventTrigger, windowOf } from "./trigger.ts";
import { EVENT_DEFAULTS } from "candle-bot-core/strategies/event";

export const HELP = `candle-event-bot: buys coins tied to a dated event (a launch, a keynote, a listing) in a window before it, and exits
them in phases keyed to the event: ride the build-up, hedge at the event, keep a moonshot core.

  candle-event-bot run    --config bot.json [--mode dry|live]  run the bot
  candle-event-bot plan   --config bot.json                    print each event's buy window and exit phases; never trades
  candle-event-bot status --config bot.json                    print status.json
  candle-event-bot sell   <mint> --config bot.json [--fraction 1]

Start from examples/dry.json. Controls: create STOP or PAUSE_BUYS in the state folder. Docs: the README.
`;

type Ctx = CoreCtx<Config>;

function context(configPath: string, modeOverride?: string): Ctx {
  let cfg: Config;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    if (e instanceof ConfigError) die(e.message);
    throw e;
  }
  return coreContext(cfg, modeOverride);
}

/**
 * The engine: buys checked on their own venue (Candle curve, DAMM v2 pool, pump.fun curve, PumpSwap pool) by the
 * engine and the executor's retry recheck; the `event` exit gets each coin's event time.
 */
export async function makeEngine(ctx: Ctx, ledger: Ledger, d: { now?: () => number } = {}) {
  const c = ctx.cfg;
  const linked = c.payer === "linked";
  const known = linked && c.entry.checkPrograms ? new Set([...KNOWN_PROGRAMS, ...c.entry.extraPrograms]) : undefined;
  const floor = linked ? sellFloor(ctx.rpc, c.sell.maxSlippageBps, c.entry.sellFloorMarginBps) : undefined;
  const { strategy, alerter, executor } = await parts(ctx, ledger, {
    maxBuyImpactBps: c.entry.maxImpactBps,
    executor: (x) => new Executor({ ...x, dammBuys: true, pumpBuys: true, ...(known ? { knownPrograms: known } : {}), ...(floor ? { sellFloor: floor } : {}) }),
    venues: { pump: true },
    ...(c.exit.strategy === "event" ? { exitParams: { events: eventTimes(c) } } : {}),
    ...(d.now ? { now: d.now } : {}),
  });
  const trigger = new EventTrigger({ cfg: c, log: ctx.log, ...(d.now ? { now: d.now } : {}) });
  const engine = new Engine({ cfg: c, ledger, trigger, executor, strategy, rpc: ctx.rpc, log: ctx.log, alerter, pumpBuys: true, venues: { pump: true }, ...(d.now ? { now: d.now } : {}) });
  return { engine, trigger };
}

const openLedger = (ctx: Ctx) => () => new Ledger(join(ctx.cfg.stateDir, "ledger.sqlite"));

/** Each event's buy window and, for the event exit, its phases in clock time. */
export function plan(cfg: Config, now = Date.now()): Array<Record<string, unknown>> {
  const x = cfg.exit as Record<string, any>;
  return cfg.events.map((e) => {
    const w = windowOf(cfg, e);
    const iso = (t: number) => new Date(t).toISOString();
    const row: Record<string, unknown> = { mint: e.mint, label: e.label, event: iso(e.atMs), buyFrom: iso(w.opens), buyUntil: iso(w.closes), window: now < w.opens ? "not open" : now >= w.closes ? "closed" : "open" };
    if (x.strategy === "event") {
      const v = { ...EVENT_DEFAULTS, ...x };
      row.hedge = `${iso(e.atMs + v.hedgeAtMin * 60_000)}: keep ${(v.hedgeKeep * 100).toFixed(0)} %`;
      row.core = `${iso(e.atMs + v.afterMin * 60_000)}: keep ${(v.coreKeep * 100).toFixed(0)} %`;
      if (x.coreMaxHoldHours !== undefined) row.coreEnds = iso(e.atMs + x.coreMaxHoldHours * 3_600_000);
    }
    return row;
  });
}

/** The entry point: never lets an error out unredacted (the SDK puts RPC URLs in its messages). */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  return guardMain(async () => {
    const { pos, opt } = args(argv);
    const cmd = pos[0];
    if (!cmd || cmd === "help" || opt.help) {
      process.stdout.write(HELP);
      return cmd || opt.help ? 0 : 2;
    }
    if (cmd === "version" || opt.version) {
      process.stdout.write(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version + "\n");
      return 0;
    }
    const config = opt.config ?? "bot.json";
    switch (cmd) {
      case "run": {
        const ctx = context(config, opt.mode);
        return run(ctx, openLedger(ctx), (ledger) => makeEngine(ctx, ledger));
      }
      case "plan": {
        const ctx = context(config, "dry");
        for (const r of plan(ctx.cfg)) process.stdout.write(JSON.stringify(r) + "\n");
        return 0;
      }
      case "status":
        return status(context(config));
      case "sell": {
        if (!pos[1]) die("sell <mint> [--fraction f]");
        const ctx = context(config);
        return sell(ctx, pos[1], opt.fraction ? Number(opt.fraction) : 1, openLedger(ctx), (ledger) => makeEngine(ctx, ledger));
      }
      default:
        die(`unknown command ${cmd}`);
    }
  });
}
