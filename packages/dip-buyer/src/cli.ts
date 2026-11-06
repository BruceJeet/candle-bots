/** The command line: run, scan, status, sell. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "candle-bot-core/engine";
import { Executor } from "candle-bot-core/exec/executor";
import { Ledger } from "candle-bot-core/ledger";
import { Alerter } from "candle-bot-core/alerts";
import { args, context as coreContext, die, guardMain, parts, run, sell, status, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { SeriesBuyTrigger } from "candle-bot-core/seriesBuy";
import { KNOWN_PROGRAMS } from "candle-bot-core/exec/trader";
import { sellFloor } from "candle-bot-core/market/reader";
import { seriesStack } from "candle-bot-core/sources/stack";
import type { TriggerContext } from "candle-bot-core/trigger";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { dipRule } from "./rule.ts";

export const HELP = `candle-dip-buyer: watches pump.fun and PumpSwap coins (a list, or a Candle feed bucket), buys one when it is down a
set share from its recent high (optionally once it turns up), and exits it by a strategy (fade reads the series too).

  candle-dip-buyer run    --config bot.json [--mode dry|live]  run the bot
  candle-dip-buyer scan   --config bot.json [--for 600]        print signals and what it would buy; never trades
  candle-dip-buyer status --config bot.json                    print status.json
  candle-dip-buyer sell   <mint> --config bot.json [--fraction 1]

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

/** The trigger and its sources (a library user, or a test, can pass its own socket, fetch and clock). */
export function makeTrigger(ctx: Ctx, alerter: Alerter, d: { now?: () => number; fetch?: typeof fetch; socket?: any } = {}) {
  const c = ctx.cfg;
  const stack = seriesStack({ rpc: ctx.rpc, wsUrl: ctx.wsUrl, apiUrl: c.apiUrl, log: ctx.log, alerter, ...d }, c.watchlist, c.series);
  const trigger = new SeriesBuyTrigger("dip", { buy: "cdb", sell: "cds" }, { ticketSol: c.buy.sol, ...stack, log: ctx.log, ...(d.now ? { now: d.now } : {}) }, dipRule(c.dip), { maxImpactBps: c.dip.maxImpactBps, cooldownMin: c.dip.cooldownMin, buyWithinSec: c.dip.buyWithinSec });
  return { trigger, ...stack };
}

/** The engine: pump.fun buys checked on their own venue (engine and executor), the series given to the exit too. */
export async function makeEngine(ctx: Ctx, ledger: Ledger, d: { now?: () => number; fetch?: typeof fetch; socket?: any } = {}) {
  const c = ctx.cfg;
  // Linked payer: only known programs are signed, and a sell is never signed below the venue's own expected out.
  const linked = c.payer === "linked";
  const known = linked && c.dip.checkPrograms ? new Set([...KNOWN_PROGRAMS, ...c.dip.extraPrograms]) : undefined;
  const floor = linked ? sellFloor(ctx.rpc, c.sell.maxSlippageBps, c.dip.sellFloorMarginBps) : undefined;
  const { strategy, alerter, executor } = await parts(ctx, ledger, { maxBuyImpactBps: c.dip.maxImpactBps, executor: (x) => new Executor({ ...x, pumpBuys: true, ...(known ? { knownPrograms: known } : {}), ...(floor ? { sellFloor: floor } : {}) }), venues: { pump: true } });
  const { trigger, series } = makeTrigger(ctx, alerter, d);
  const engine = new Engine({ cfg: ctx.cfg, ledger, trigger, executor, strategy, rpc: ctx.rpc, log: ctx.log, alerter, series, exitSeries: true, pumpBuys: true, venues: { pump: true }, ...(d.now ? { now: d.now } : {}) });
  return { engine, trigger };
}

const openLedger = (ctx: Ctx) => () => new Ledger(join(ctx.cfg.stateDir, "ledger.sqlite"));

/** Signals and what the bot would buy, on the live series; never trades, writes nothing to the state folder. */
export async function scan(ctx: Ctx, seconds: number | null): Promise<number> {
  const ledger = new Ledger(":memory:");
  const alerter = new Alerter(ledger, ctx.log, [], 3_600_000);
  const { trigger } = makeTrigger(ctx, alerter);
  const stopAt = seconds ? Date.now() + seconds * 1000 : Infinity;
  let quit = false;
  process.on("SIGINT", () => (quit = true));
  process.on("SIGTERM", () => (quit = true));
  const tctx = {
    cfg: ctx.cfg, rpc: ctx.rpc, log: ctx.log, alerter, dry: true, now: () => Date.now(), shouldStop: () => quit,
    caps: () => ({ open: 0, entriesForMint: 0, lifetimeLamports: 0n, paused: false }),
    ledger: { positions: () => [], position: () => undefined, ordersFor: () => [], entriesForMint: () => 0, lifetimeBuyLamports: () => 0n, openCount: () => 0 },
  } as unknown as TriggerContext;
  while (!quit && Date.now() < stopAt) {
    for (const c of await trigger.poll(tctx)) {
      const v = await trigger.decide(c, tctx);
      ctx.log.info(v.verdict === "buy" ? "scan_would_buy" : "scan_skip", { mint: c.mint, signal: c.reason, ...(v.verdict === "buy" ? { sol: ctx.cfg.buy.sol, reason: v.reason } : { reason: v.reason }) });
    }
    await new Promise((r) => setTimeout(r, ctx.cfg.loopMs));
  }
  trigger.stop();
  ctx.log.info("scan_done", trigger.status());
  ledger.close();
  return 0;
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
      case "scan":
        return scan(context(config, "dry"), opt.for ? Number(opt.for) : null);
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
