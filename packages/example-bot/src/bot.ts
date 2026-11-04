/**
 * The example bot: candle-bot-core + the manual trigger + one config section. This file is the whole bot besides the
 * trigger: its config, its engine and its command line.
 */
import { join } from "node:path";
import {
  ConfigError, Engine, Ledger, args, context, die, guardMain, loadConfig, parseConfig, parts, run, sell, status,
  type BotConfig, type Ctx, type Logger, type Parts, type Rpc,
} from "candle-bot-core";
import { ManualTrigger, parseManual } from "./trigger.ts";

export const SECTIONS = { manual: parseManual };
export type Config = BotConfig<typeof SECTIONS>;

export function parseBotConfig(raw: unknown, baseDir = process.cwd()): Config {
  return parseConfig(raw, baseDir, SECTIONS);
}

/** The engine for a config, a ledger and the parts the core builds (strategy, alerts, executor). */
export function makeEngine(cfg: Config, ledger: Ledger, rpc: Rpc, p: Pick<Parts, "strategy" | "alerter" | "executor"> & { log: Logger; now?: () => number }): { engine: Engine; trigger: ManualTrigger } {
  const trigger = new ManualTrigger(cfg.stateDir, cfg.manual, rpc);
  const engine = new Engine({ cfg, ledger, trigger, executor: p.executor, strategy: p.strategy, rpc, log: p.log, alerter: p.alerter, now: p.now });
  return { engine, trigger };
}

export const HELP = `candle-example-bot: buys a coin you name in a file, exits it by a strategy (candle-bot-core example).

  candle-example-bot run    --config bot.json [--mode dry|live]
  candle-example-bot status --config bot.json
  candle-example-bot sell   <mint> --config bot.json [--fraction 1]

Buy: write {"mint": "<address>"} to <stateDir>/buy/<name>.json. Controls: STOP or PAUSE_BUYS in the state folder.
`;

function ctxFor(path: string, mode?: string): Ctx<Config> {
  let cfg: Config;
  try {
    cfg = loadConfig(path, SECTIONS);
  } catch (e) {
    if (e instanceof ConfigError) die(e.message);
    throw e;
  }
  return context(cfg, mode);
}

async function build(ctx: Ctx<Config>, ledger: Ledger) {
  const p = await parts(ctx, ledger, { maxBuyImpactBps: ctx.cfg.manual.maxImpactBps });
  return makeEngine(ctx.cfg, ledger, ctx.rpc, { ...p, log: ctx.log });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  return guardMain(async () => {
    const { pos, opt } = args(argv);
    const cmd = pos[0];
    if (!cmd || cmd === "help" || opt.help) {
      process.stdout.write(HELP);
      return cmd || opt.help ? 0 : 2;
    }
    const config = opt.config ?? "bot.json";
    const ledgerOf = (ctx: Ctx<Config>) => () => new Ledger(join(ctx.cfg.stateDir, "ledger.sqlite"));
    switch (cmd) {
      case "run": {
        const ctx = ctxFor(config, opt.mode);
        return run(ctx, ledgerOf(ctx), (l) => build(ctx, l));
      }
      case "status":
        return status(ctxFor(config));
      case "sell": {
        if (!pos[1]) die("sell <mint> [--fraction f]");
        const ctx = ctxFor(config);
        return sell(ctx, pos[1], opt.fraction ? Number(opt.fraction) : 1, ledgerOf(ctx), (l) => build(ctx, l));
      }
      default:
        die(`unknown command ${cmd}`);
    }
  });
}
