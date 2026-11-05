/** The command line: run, status, sell. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { args, context as coreContext, die, guardMain, parts, run, sell, status, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { Detector } from "candle-bot-core/sources/candleLaunches";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { Engine } from "./trigger.ts";

export const HELP = `candle-creator-bot: buys the new Candle launches of the creators you list, with a ticket and caps per creator,
and exits them by a strategy.

  candle-creator-bot run    --config bot.json [--mode dry|live]  run the bot
  candle-creator-bot status --config bot.json                    print status.json (each creator's entries and SOL used)
  candle-creator-bot sell   <mint> --config bot.json [--fraction 1]

Start from examples/dry.json and put your creators in follow.creators. Controls: STOP or PAUSE_BUYS in the state folder.
Docs: the README.
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

async function makeEngine(ctx: Ctx, ledger: Ledger) {
  const { strategy, alerter, executor } = await parts(ctx, ledger, { maxBuyImpactBps: ctx.cfg.follow.maxImpactBps });
  const d = ctx.cfg.detect;
  const source = new Detector({ rpc: ctx.rpc, wsUrl: d.chain ? ctx.wsUrl : undefined, apiUrl: ctx.cfg.apiUrl, log: ctx.log }, d);
  const engine = new Engine({ cfg: ctx.cfg, ledger, source, executor, strategy, rpc: ctx.rpc, log: ctx.log, alerter, markets: ctx.client });
  return { engine, trigger: engine.trigger };
}

const openLedger = (ctx: Ctx) => () => new Ledger(join(ctx.cfg.stateDir, "ledger.sqlite"));

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
        return run(ctx, openLedger(ctx), (ledger) => makeEngine(ctx, ledger), { creators: ctx.cfg.follow.creators.length });
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
