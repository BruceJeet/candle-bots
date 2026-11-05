/** The command line: plan, run, status, sell, adopt. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CandleClient } from "@candledottv/agent-sdk";
import { timedFetch } from "candle-bot-core/exec/trader";
import { acquireLock } from "candle-bot-core/engine";
import { args, context as coreContext, die, guardMain, parts, run, sell, status, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { Engine, launchBody, type LaunchClient } from "./launcher.ts";

export const HELP = `candle-launch-helper: fires the Candle launch you describe, with its dev buy in the same bundle, then manages the
dev bag with the core's exits and controls.

  candle-launch-helper plan   --config launch.json [--offline]       print the launch body and, with the API key set,
                                                                     Candle's dry-run preview of the dev buy's fill
                                                                     (dryRunAtomicLaunch: records and sends nothing)
  candle-launch-helper run    --config launch.json [--mode dry|live] launch (live), then manage the bag
  candle-launch-helper status --config launch.json                   print status.json
  candle-launch-helper sell   <mint> --config launch.json [--fraction 1]
  candle-launch-helper adopt  <signature> --config launch.json [--mint <mint>]
                                                                     book the dev bag from its transaction (bot stopped)

One launch per spec: a live run refuses when the account already launched the same name and symbol (launch.newLaunch
overrides), and a state dir never launches twice. Controls: STOP, PAUSE_BUYS (no launch fires), RETRY_LAUNCH (one more
build under the same clientLaunchId, only when Candle's job says failed or not found). Docs: the README.
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
  // Live: Candle's client for the launch calls, with a longer timeout than trades (a submit can take ~160 s and a
  // same-id rebuild ~95 s, per the SDK). Dry: none, so nothing can be built or sent.
  const apiKey = process.env[ctx.cfg.apiKeyEnv];
  if (ctx.cfg.mode === "live" && !apiKey) die(`${ctx.cfg.apiKeyEnv} is not set (the Candle API key)`);
  const client = ctx.cfg.mode === "live" ? (new CandleClient({ apiUrl: ctx.cfg.apiUrl, apiKey, fetch: timedFetch(LAUNCH_TIMEOUT_MS) }) as unknown as LaunchClient) : null;
  const engine = new Engine({ cfg: ctx.cfg, ledger, client, executor, strategy, rpc: ctx.rpc, log: ctx.log, alerter });
  return { engine, trigger: engine.trigger };
}

/**
 * `plan`: the launch body, and with a client Candle's dry-run preview of the dev buy's fill (dryRunAtomicLaunch:
 * the build's checks; records, reserves and sends nothing). Its clientLaunchId is a throwaway, never built.
 */
export async function planOutput(cfg: Config, client: LaunchClient | null, skipped: string | null): Promise<Record<string, unknown>> {
  const body = launchBody(cfg.launch);
  const out: Record<string, unknown> = { route: "atomic (build, check the dev buy's expected fill, submit)", body, minDevBuyOutRaw: cfg.launch.minDevBuyOutRaw?.toString() ?? null };
  if (!client?.dryRunAtomicLaunch) {
    out.preview = skipped ?? "skipped (no client)";
    return out;
  }
  try {
    const r = await client.dryRunAtomicLaunch({ ...body, clientLaunchId: `clh-plan-${randomUUID()}` });
    const fill = r.fills?.[0]?.expectedFill ?? null;
    out.preview = { devBuyExpectedOutRaw: fill?.amountOutRaw ?? null, devBuyMinOutRaw: fill?.minAmountOutRaw ?? null, graduatesInBundle: r.graduatesInBundle ?? null, note: "set launch.minDevBuyOutRaw at or below devBuyExpectedOutRaw (the submit is refused under it)" };
  } catch (e) {
    out.preview = { error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  return out;
}

/** Longest a launch call may take (the SDK: a submit up to ~160 s). */
export const LAUNCH_TIMEOUT_MS = 180_000;

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
        const apiKey = process.env[cfg.apiKeyEnv];
        const skip = opt.offline ? "skipped (--offline)" : !apiKey ? `skipped (${cfg.apiKeyEnv} not set)` : null;
        const client = skip ? null : (new CandleClient({ apiUrl: cfg.apiUrl, apiKey, fetch: timedFetch(LAUNCH_TIMEOUT_MS) }) as unknown as LaunchClient);
        const out = await planOutput(cfg, client, skip);
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
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
      case "adopt": {
        if (!pos[1]) die("adopt <signature> [--mint <mint>]");
        const ctx = context(config);
        const lock = acquireLock(ctx.cfg.stateDir);
        if (!lock) die(`the bot is running (${ctx.cfg.stateDir}/lock): stop it, then adopt`);
        const ledger = openLedger(ctx)();
        try {
          const { engine } = await makeEngine(ctx, ledger);
          const r = await engine.launcher.adopt(pos[1], opt.mint);
          process.stdout.write(r + "\n");
          return /^position \d+/.test(r) ? 0 : 1;
        } finally {
          ledger.close();
          lock.release();
        }
      }
      default:
        die(`unknown command ${cmd}`);
    }
  });
}
