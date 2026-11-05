/** The command line: plan, run, status, sell. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { args, context as coreContext, die, guardMain, parts, run, sell, status, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { Engine, launchBody, type LaunchClient } from "./launcher.ts";

export const HELP = `candle-launch-helper: fires the Candle launch you describe, with its dev buy in the same bundle, then manages the
dev bag with the core's exits and controls.

  candle-launch-helper plan   --config launch.json                   print the launch body; calls nothing
  candle-launch-helper run    --config launch.json [--mode dry|live] launch (live), then manage the bag
  candle-launch-helper status --config launch.json                   print status.json
  candle-launch-helper sell   <mint> --config launch.json [--fraction 1]

One launch per state dir; a run never launches twice. Controls: STOP, PAUSE_BUYS (no launch fires), RETRY_LAUNCH
(one more build under the same clientLaunchId after a failed or refused launch). Docs: the README.
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
  const { strategy, alerter, executor } = await parts(ctx, ledger, { maxBuyImpactBps: 10_000 });
  // Live: Candle's client (the API key's). Dry: none, so nothing can be built or sent.
  const client = ctx.cfg.mode === "live" ? (ctx.client as unknown as LaunchClient) : null;
  const engine = new Engine({ cfg: ctx.cfg, ledger, client, executor, strategy, rpc: ctx.rpc, log: ctx.log, alerter });
  return { engine, trigger: engine.trigger };
}

const openLedger = (ctx: Ctx) => () => new Ledger(join(ctx.cfg.stateDir, "ledger.sqlite"));

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
    const config = opt.config ?? "launch.json";
    switch (cmd) {
      case "plan": {
        let cfg: Config;
        try {
          cfg = loadConfig(config);
        } catch (e) {
          if (e instanceof ConfigError) die(e.message);
          throw e;
        }
        process.stdout.write(JSON.stringify({ route: "atomic (build, check the dev buy's expected fill, submit)", body: launchBody(cfg.launch) }, null, 2) + "\n");
        return 0;
      }
      case "run": {
        const ctx = context(config, opt.mode);
        return run(ctx, openLedger(ctx), (ledger) => makeEngine(ctx, ledger));
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
