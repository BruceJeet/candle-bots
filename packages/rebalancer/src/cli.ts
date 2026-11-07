/** The command line: run, plan, status, sell. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, acquireLock, asAddress } from "candle-bot-core";
import { args, context as coreContext, die, guardMain, run, status, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { lotsOf, lotsSellRequestName, sellLots } from "candle-bot-core/lots";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { ledgerPath, makeBot, snapshot } from "./bot.ts";
import { plan, planText } from "./plan.ts";

export const HELP = `candle-rebalancer: holds a wallet at target weights across coins and SOL. On its schedule it reads the wallet and
every target coin's venue, sells the coins over their band (down to target), then buys the coins under it, within a
minimum trade size and a cap on SOL moved per run. A coin it cannot price blocks the run (alerted); nothing is guessed.

  candle-rebalancer run    --config bot.json [--mode dry|live]   run the bot
  candle-rebalancer plan   --config bot.json                     the full plan for the wallet now (fresh reads; never
                                                                 trades, books nothing)
  candle-rebalancer status --config bot.json                     print status.json (weights, last plan, runs, lots)
  candle-rebalancer sell   <mint> --config bot.json [--fraction 1]   sell over every lot of the coin

Start from examples/dry.json and set the targets' mints. Controls in the state folder: STOP, PAUSE_BUYS, PAUSE_SELLS.
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

/** `plan`: the full plan for the wallet as it is now (both sides, the buys counting the sells' SOL). Never trades. */
export async function planCommand(ctx: Ctx): Promise<number> {
  const snap = await snapshot({ cfg: ctx.cfg, ledger: null, rpc: ctx.rpc, now: Date.now });
  if ("why" in snap) {
    process.stdout.write(`BLOCKED: ${snap.why}; no orders\n`);
    return 1;
  }
  const p = plan(snap.input);
  process.stdout.write(planText(p) + "\n");
  return p.blocked ? 1 : 0;
}

/** `sell <mint>`: over every lot of the coin. A request file while the bot runs; done here (under the lock) when stopped. */
export async function sellCommand(ctx: Ctx, mint: string, fraction: number): Promise<number> {
  if (asAddress(mint) !== mint) die(`${mint} is not a mint address`);
  if (!(fraction > 0 && fraction <= 1)) die("--fraction must be in (0, 1]");
  const lock = acquireLock(ctx.cfg.stateDir);
  if (!lock) {
    const dir = join(ctx.cfg.stateDir, "requests");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, lotsSellRequestName());
    writeFileSync(f + ".tmp", JSON.stringify({ mint, fraction }));
    renameSync(f + ".tmp", f);
    process.stdout.write(`the bot is running: request written to ${f}; watch events.jsonl for manual_sell_request\n`);
    return 0;
  }
  const ledger = openLedger(ctx)();
  try {
    const { engine } = await makeBot(ctx, ledger);
    const dry = ctx.cfg.mode === "dry";
    const held = lotsOf(ledger, dry, mint).reduce((t, p) => t + BigInt(p.remaining_raw), 0n);
    if (held <= 0n) {
      process.stdout.write("no open lot of that coin\n");
      return 1;
    }
    const r = await sellLots(engine, ledger, dry, mint, (held * BigInt(Math.round(fraction * 1e6))) / 1_000_000n, "manual", true);
    if (!r.orders.length) {
      process.stdout.write(`refused: ${r.why.join("; ") || "nothing booked"}\n`);
      return 1;
    }
    process.stdout.write(`orders ${r.orders.join(", ")}\n`);
    for (let i = 0; i < 600; i++) {
      await engine.executor.sweep(r.orders.length, { onlyIds: r.orders });
      const open = r.orders.map((id) => ledger.order(id)!).filter((o) => ["pending", "inflight"].includes(o.status));
      if (!open.length) break;
      await new Promise((res) => setTimeout(res, Math.max(500, Math.min(5000, Math.min(...open.map((o) => o.next_attempt_at)) - Date.now()))));
    }
    let ok = true;
    for (const id of r.orders) {
      const o = ledger.order(id)!;
      process.stdout.write(`order ${id}: ${o.status}${o.last_error_code ? " (" + o.last_error_code + ")" : ""}\n`);
      if (o.status !== "filled") ok = false;
    }
    return ok ? 0 : 1;
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
        return run(ctx, openLedger(ctx), async (ledger) => {
          const b = await makeBot(ctx, ledger);
          return { engine: b.engine, trigger: b.trigger };
        }, { targets: Object.keys(ctx.cfg.rebalance.targets).length, maxSolPerRun: ctx.cfg.rebalance.maxSolPerRun });
      }
      case "plan":
        return planCommand(context(config, "dry"));
      case "status":
        return status(context(config));
      case "sell": {
        if (!pos[1]) die("sell <mint> [--fraction f]");
        return sellCommand(context(config), pos[1], opt.fraction ? Number(opt.fraction) : 1);
      }
      default:
        die(`unknown command ${cmd}`);
    }
  });
}
