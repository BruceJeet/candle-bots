/** The command line: run, status, sell, adopt, release. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, acquireLock, asAddress } from "candle-bot-core";
import { args, context as coreContext, die, guardMain, run, sell, status, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { checkExcludeDirs, ledgerPath, makeManager } from "./manager.ts";

export const HELP = `candle-exit-manager: runs exits on bags already in the wallet (bought by hand or by another tool). It adopts them
(a list of coins, or the whole wallet), then sells by a strategy (a trailing stop included). It never buys.

  candle-exit-manager run     --config bot.json [--mode dry|live]   run the manager
  candle-exit-manager status  --config bot.json                     print status.json (each bag: venue, basis, next exit)
  candle-exit-manager sell    <mint> --config bot.json [--fraction 1]
  candle-exit-manager adopt   <mint> --config bot.json [--signatures s1,s2 | --cost-sol 0.2 | --basis mark]
  candle-exit-manager release <mint> --config bot.json              stop managing a coin; nothing is sold

Start from examples/dry.json. Controls in the state folder: STOP (stop), PAUSE_SELLS (hold every exit, keep reading).
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

const openLedger = (ctx: Ctx) => () => new Ledger(ledgerPath(ctx.cfg));

/** adopt / release: a request file while the manager runs; done here (under the lock) while it is stopped. */
async function request(ctx: Ctx, kind: "adopt" | "release", mint: string, opt: Record<string, string>): Promise<number> {
  if (asAddress(mint) !== mint) die(`${mint} is not a mint address`);
  const body: Record<string, unknown> = { mint };
  if (kind === "adopt") {
    if (opt.signatures) body.signatures = opt.signatures.split(",").map((s) => s.trim()).filter(Boolean);
    if (opt["cost-sol"] !== undefined) {
      const c = Number(opt["cost-sol"]);
      if (!(c >= 0)) die("--cost-sol: a number >= 0");
      body.costSol = c;
    }
    if (opt.basis !== undefined) {
      if (opt.basis !== "mark") die("--basis: mark");
      body.basis = "mark";
    }
    if (Object.keys(body).length > 2) die("give one of --signatures, --cost-sol, --basis");
  }
  const lock = acquireLock(ctx.cfg.stateDir);
  if (!lock) {
    const dir = join(ctx.cfg.stateDir, "requests");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${kind}-${Date.now()}-${process.pid}.json`);
    writeFileSync(f + ".tmp", JSON.stringify(body));
    renameSync(f + ".tmp", f);
    process.stdout.write(`the manager is running: request written to ${f}; watch events.jsonl for ${kind}_request\n`);
    return 0;
  }
  const ledger = openLedger(ctx)();
  try {
    const { adopter } = await makeManager(ctx, ledger);
    if (kind === "release") {
      const a = adopter.managed().find((r) => r.mint === mint);
      const r = a ? adopter.release(a.position_id, "release command") : "no adopted position for that mint";
      process.stdout.write(r + "\n");
      return a && r.startsWith("released") ? 0 : 1;
    }
    // Stopped: the same path as the request, run once now.
    const dir = join(ctx.cfg.stateDir, "requests");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `adopt-${Date.now()}-${process.pid}.json`);
    writeFileSync(f, JSON.stringify(body));
    await adopter.step(() => false, true);
    const p = adopter.managed().find((r) => r.mint === mint);
    const skip = adopter.skips.find((s) => s.mint === mint);
    process.stdout.write(p ? `adopted: position ${p.position_id} (basis ${p.basis_source})\n` : `not adopted${skip ? `: ${skip.why}` : ""}\n`);
    return p ? 0 : 1;
  } finally {
    ledger.close();
    lock.release();
  }
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
        try {
          checkExcludeDirs(ctx.cfg);
        } catch (e) {
          die((e as Error).message);
        }
        return run(ctx, openLedger(ctx), async (ledger) => {
          const b = await makeManager(ctx, ledger);
          return { engine: b.engine, trigger: b.trigger };
        }, { adoption: ctx.cfg.adoption.mode, excludeStateDirs: ctx.cfg.adoption.excludeStateDirs.length });
      }
      case "status":
        return status(context(config));
      case "sell": {
        if (!pos[1]) die("sell <mint> [--fraction f]");
        const ctx = context(config);
        return sell(ctx, pos[1], opt.fraction ? Number(opt.fraction) : 1, openLedger(ctx), async (ledger) => ({ engine: (await makeManager(ctx, ledger)).engine }));
      }
      case "adopt":
      case "release": {
        if (!pos[1]) die(`${cmd} <mint>`);
        return request(context(config), cmd, pos[1], opt);
      }
      default:
        die(`unknown command ${cmd}`);
    }
  });
}
