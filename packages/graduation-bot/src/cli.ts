/** The command line: run, scan, status, sell. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Executor } from "candle-bot-core/exec/executor";
import { args, context as coreContext, die, guardMain, parts, run, sell, status, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { Detector } from "candle-bot-core/sources/candleLaunches";
import { readMarkets } from "candle-bot-core/market/reader";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { DEFAULT_DECIMALS, Engine, evaluate } from "./trigger.ts";
import { GraduationWatch } from "./watch.ts";

export const HELP = `candle-graduation-bot: buys Candle coins as their launch curve completes and their DAMM v2 pool opens, and
exits them by a strategy.

  candle-graduation-bot run    --config bot.json [--mode dry|live]  run the bot
  candle-graduation-bot scan   --config bot.json [--for 600]        print graduations and what it would buy; never trades
  candle-graduation-bot status --config bot.json                    print status.json
  candle-graduation-bot sell   <mint> --config bot.json [--fraction 1]

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

export function makeWatch(ctx: Ctx): GraduationWatch {
  const d = ctx.cfg.detect;
  const source = new Detector({ rpc: ctx.rpc, wsUrl: d.chain ? ctx.wsUrl : undefined, apiUrl: ctx.cfg.apiUrl, log: ctx.log }, { api: d.api, chain: d.chain, apiPollMs: d.apiPollMs, chainPollMs: d.chainPollMs, apiLimit: d.apiLimit });
  return new GraduationWatch({ rpc: ctx.rpc, source, log: ctx.log }, { curvePollMs: d.curvePollMs, watchHours: d.watchHours, maxWatched: d.maxWatched });
}

async function makeEngine(ctx: Ctx, ledger: Ledger) {
  // Buys fill on the DAMM v2 pool: the executor's retry recheck reads the pool (dammBuys) with this bot's impact limit.
  const { strategy, alerter, executor } = await parts(ctx, ledger, { maxBuyImpactBps: ctx.cfg.graduation.maxImpactBps, executor: (d) => new Executor({ ...d, dammBuys: true }) });
  const engine = new Engine({ cfg: ctx.cfg, ledger, watch: makeWatch(ctx), executor, strategy, rpc: ctx.rpc, log: ctx.log, alerter });
  return { engine, trigger: engine.trigger };
}

const openLedger = (ctx: Ctx) => () => new Ledger(join(ctx.cfg.stateDir, "ledger.sqlite"));

async function scan(ctx: Ctx, seconds: number | null): Promise<number> {
  const watch = makeWatch(ctx);
  await watch.start();
  const stopAt = seconds ? Date.now() + seconds * 1000 : Infinity;
  let quit = false;
  process.on("SIGINT", () => (quit = true));
  process.on("SIGTERM", () => (quit = true));
  const caps = { open: 0, entriesForMint: 0, lifetimeLamports: 0n, paused: false };
  while (!quit && Date.now() < stopAt) {
    for (const g of watch.drain()) {
      let m = null;
      try {
        m = (await readMarkets(ctx.rpc, [{ mint: g.mint, decimals: g.launch.decimals ?? DEFAULT_DECIMALS }], Date.now())).get(g.mint) ?? null;
      } catch { /* logged as not readable */ }
      const v = evaluate(ctx.cfg, g, m, caps, Date.now());
      ctx.log.info(v.verdict === "buy" ? "scan_would_buy" : "scan_skip", {
        mint: g.mint, symbol: g.launch.symbol, graduatedAtMs: g.graduatedAtMs, graduatedAt: g.graduatedAtSource, creator: g.launch.creator,
        ...(v.verdict === "buy" ? { impactBps: v.impactBps, sol: ctx.cfg.buy.sol, roomAboveFloor: v.roomAboveFloor } : { reason: v.reason }),
      });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  watch.stop();
  ctx.log.info("scan_done", { watch: watch.stats });
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
