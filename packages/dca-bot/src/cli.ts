/** The command line: run, plan, status, sell. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, acquireLock, asAddress, lamportsOf, memoryLogger } from "candle-bot-core";
import { args, context as coreContext, die, guardMain, run, status, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { buyQuote, readMarkets } from "candle-bot-core/market/reader";
import { decodeMint } from "candle-bot-core/market/mint";
import { tokenBalance } from "candle-bot-core/solana/rpc";
import { Scheduler } from "candle-bot-core/scheduler";
import { lotsOf, lotsSellRequestName, sellLots } from "candle-bot-core/lots";
import { loadConfig, ConfigError, type Config, type DcaSchedule } from "./config.ts";
import { ledgerPath, makeBot, sellImpactBps } from "./bot.ts";

export const HELP = `candle-dca-bot: buys, or sells, a fixed amount of a coin on a timer. Each schedule runs every everySec seconds
(optionally at a UTC time of day), never twice for one slot, also across a restart; missed runs are skipped (or one
catch-up run, "missed": "once"). Guards: a price cap, an impact cap, a budget per schedule, the core's caps.

  candle-dca-bot run    --config bot.json [--mode dry|live]   run the bot
  candle-dca-bot plan   --config bot.json                     what each schedule would do now, and when it would first
                                                              run (fresh reads; never trades, books nothing)
  candle-dca-bot status --config bot.json                     print status.json (schedules, runs, lots)
  candle-dca-bot sell   <mint> --config bot.json [--fraction 1]   sell over every lot of the coin

Start from examples/dry.json and set each schedule's mint. Controls in the state folder: STOP, PAUSE_BUYS,
PAUSE_SELLS. Docs: the README.
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

/** What one schedule would do if it ran now (fresh reads), in words. */
export async function planOne(ctx: Ctx, s: DcaSchedule): Promise<string> {
  let decimals: number;
  try {
    decimals = decodeMint((await ctx.rpc.call<any>("getAccountInfo", [s.mint, { encoding: "base64", commitment: "confirmed" }]))?.value).decimals;
  } catch (e) {
    return `would skip: mint unreadable (${String((e as Error)?.message ?? e).slice(0, 80)})`;
  }
  const m = (await readMarkets(ctx.rpc, [{ mint: s.mint, decimals }], Date.now(), { pump: true })).get(s.mint);
  if (!m || m.priceSol === null) return `would skip: no price (${m?.problem ?? "venue not readable"})`;
  const at = `price ${m.priceSol.toPrecision(6)} SOL on ${m.venue}`;
  if (s.side === "buy") {
    if (s.maxPriceSol !== null && m.priceSol > s.maxPriceSol) return `would skip: ${at}, over maxPriceSol ${s.maxPriceSol}`;
    const q = buyQuote(m, lamportsOf(s.sol!));
    if ("why" in q) return `would skip: ${at}, venue refused (${q.why})`;
    const cap = s.maxImpactBps ?? ctx.cfg.dca.maxImpactBps;
    if (q.impactBps > cap) return `would skip: ${at}, impact ${q.impactBps} bps > ${cap}`;
    return `would buy ${s.sol} SOL: ${at}, impact ${q.impactBps} bps, about ${q.expectedOutRaw} raw`;
  }
  if (s.minPriceSol !== null && m.priceSol < s.minPriceSol) return `would skip: ${at}, under minPriceSol ${s.minPriceSol}`;
  const bal = await tokenBalance(ctx.rpc, ctx.cfg.wallet, s.mint);
  if (bal === null) return `would skip: ${at}, balance unreadable`;
  if (bal <= 0n) return `would skip: ${at}, the wallet holds none`;
  let amount = s.fraction !== null ? (bal * BigInt(Math.round(s.fraction * 1e6))) / 1_000_000n : BigInt(Math.max(0, Math.floor((s.sol! / m.priceSol) * 10 ** decimals)));
  if (amount > bal) amount = bal;
  const imp = sellImpactBps(m, amount, decimals);
  if (s.maxImpactBps !== null) {
    if (typeof imp !== "number") return `would skip: ${at}, impact cap set, ${imp.why}`;
    if (imp > s.maxImpactBps) return `would skip: ${at}, impact ${imp} bps > ${s.maxImpactBps}`;
  }
  return `would sell ${amount} raw of the wallet's ${bal} (about ${((Number(amount) / 10 ** decimals) * m.priceSol).toFixed(6)} SOL): ${at}${typeof imp === "number" ? `, impact ${imp} bps` : ""}`;
}

/** `plan`: each schedule, when it would first run if started now, and what it would do now. Never trades. */
export async function plan(ctx: Ctx): Promise<number> {
  const mem = new Ledger(":memory:");
  try {
    const sched = new Scheduler({ ledger: mem, specs: ctx.cfg.dca.schedules, dry: true, log: memoryLogger() });
    for (const s of ctx.cfg.dca.schedules) {
      const first = sched.nextAt(s.id);
      const what = s.side === "buy" ? `buy ${s.sol} SOL` : s.fraction !== null ? `sell ${s.fraction * 100} % of what it holds` : `sell ${s.sol} SOL worth`;
      process.stdout.write(`${s.id}: ${what} of ${s.mint} every ${s.everySec} s${s.atUtc ? ` at ${s.atUtc} UTC` : ""}${s.maxRuns ? `, ${s.maxRuns} runs at most` : ""}${s.untilMs ? `, until ${new Date(s.untilMs).toISOString()}` : ""}${s.budgetSol ? `, budget ${s.budgetSol} SOL` : ""}\n`);
      process.stdout.write(`  first run if started now: ${first ? new Date(first).toISOString() : "none"}\n`);
      process.stdout.write(`  now: ${await planOne(ctx, s)}\n`);
    }
  } finally {
    mem.close();
  }
  return 0;
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
        }, { schedules: ctx.cfg.dca.schedules.length });
      }
      case "plan":
        return plan(context(config, "dry"));
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
