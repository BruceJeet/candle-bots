/** The command line: init, scan, run, status, sell. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { Detector } from "./detect/detector.ts";
import { Engine } from "./engine.ts";
import { Executor } from "./exec/executor.ts";
import { evaluate } from "./filters.ts";
import { Ledger } from "./ledger.ts";
import { decodeCandleCurve } from "candle-bot-core/market/curve";
import { candleCurve } from "candle-bot-core/solana/pda";
import { args, context as coreContext, die, guardMain, parts, run, sell, status, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { init, terminalAsk } from "./init.ts";

export const HELP = `candle-launch-bot: buys Candle launches as they appear and exits them by a strategy.

  candle-launch-bot init   [--out bot.json] [--yes] [flags]   write a config (dry mode unless --mode live)
  candle-launch-bot scan   --config bot.json [--for 600]       detect and print what it would buy; never trades
  candle-launch-bot run    --config bot.json [--mode dry|live] run the bot
  candle-launch-bot status --config bot.json                   print status.json
  candle-launch-bot sell   <mint> --config bot.json [--fraction 1]

init flags (all optional; with --yes nothing is asked; defaults shown):
  --mode dry|live (dry)  --payer embedded|linked (embedded)  --key-env <env var with the API key> (CANDLE_API_KEY)
  --wallet <address> (looked up when the key is set)  --api-url <https url>
  --sol 0.01  --max-open 3  --lifetime-sol (10 tickets)  --modes open,exp-custom  --max-age 60  --max-impact 300
  --slippage 500
  --exit hold|tpsl|time|ladder|preGrad (tpsl)  --take-profit 2  --stop-loss 0.5  --trailing <0-1>  --after-sec 900
  --progress 0.8  --fraction 1  --rungs 2:0.3,5:0.3,10:0.2
  --exit-module ./my-exit.js  --exit-params '{"arm":1.5}'   your own strategy file and its params
  --signer keychain|file|env (keychain)  --signer-env <env var with the PEM>  --signer-path <file>
  --signer-pass-env <env var with the file's passphrase>      payer linked only
  --rpc-env <env var with an RPC url>  --rpc-ws-env <env var with a websocket url>
  --webhook <env var with an alert webhook url>  --state-dir <dir> (./state-dry or ./state-live)
  --out bot.json  --force (overwrite)

Controls: create STOP or PAUSE_BUYS in the state folder. Docs: the README.
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
  const { strategy, alerter, executor } = await parts(ctx, ledger, { maxBuyImpactBps: ctx.cfg.filters.maxImpactBps, executor: (d) => new Executor({ ...d, cfg: ctx.cfg }) });
  const detector = new Detector({ rpc: ctx.rpc, wsUrl: ctx.cfg.detect.chain ? ctx.wsUrl : undefined, apiUrl: ctx.cfg.apiUrl, log: ctx.log }, ctx.cfg.detect);
  const engine = new Engine({ cfg: ctx.cfg, ledger, detector, executor: executor as Executor, strategy, rpc: ctx.rpc, log: ctx.log, alerter, markets: ctx.client });
  return { engine, trigger: engine.trigger };
}

const openLedger = (ctx: Ctx) => () => new Ledger(join(ctx.cfg.stateDir, "ledger.sqlite"));

async function scan(ctx: Ctx, seconds: number | null): Promise<number> {
  const det = new Detector({ rpc: ctx.rpc, wsUrl: ctx.cfg.detect.chain ? ctx.wsUrl : undefined, apiUrl: ctx.cfg.apiUrl, log: ctx.log }, ctx.cfg.detect);
  await det.start();
  const stopAt = seconds ? Date.now() + seconds * 1000 : Infinity;
  const waiting = new Map<string, number>();
  let quit = false;
  process.on("SIGINT", () => (quit = true));
  process.on("SIGTERM", () => (quit = true));
  const caps = { open: 0, entriesForMint: 0, lifetimeLamports: 0n, paused: false };
  while (!quit && Date.now() < stopAt) {
    for (const l of det.drain()) waiting.set(l.mint, Date.now());
    for (const mint of [...waiting.keys()]) {
      const l = det.get(mint)!;
      let v = evaluate(ctx.cfg, l, null, caps, Date.now());
      if (v.verdict === "wait" && /unknown/.test(v.reason)) {
        try {
          const m: any = await ctx.client.getMarket("solana", mint);
          if (m?.tier && !l.launchMode) l.launchMode = m.tier;
          if (m?.metadata?.name && l.name === undefined) l.name = m.metadata.name;
          if (m?.metadata?.symbol && l.symbol === undefined) l.symbol = m.metadata.symbol;
        } catch { /* not indexed yet */ }
        v = evaluate(ctx.cfg, l, null, caps, Date.now());
      }
      if (v.verdict === "wait" && v.reason === "curve not readable yet") {
        try {
          const r = await ctx.rpc.call<any>("getAccountInfo", [l.curve ?? candleCurve(mint), { encoding: "base64", commitment: "confirmed" }]);
          v = evaluate(ctx.cfg, l, r?.value ? decodeCandleCurve(r.value) : null, caps, Date.now());
        } catch { /* next round */ }
      }
      if (v.verdict === "wait") continue;
      waiting.delete(mint);
      const s = det.sightingsFor(mint);
      ctx.log.info(v.verdict === "buy" ? "scan_would_buy" : "scan_skip", {
        mint, symbol: l.symbol, name: l.name, mode: l.launchMode, creator: l.creator, signer: l.signer, firstSource: l.source,
        apiLatencyMs: s.api?.latencyMs ?? null, chainLatencyMs: s.chain?.latencyMs ?? null, ...(v.verdict === "buy" ? { impactBps: v.impactBps, sol: ctx.cfg.buy.sol } : { reason: v.reason }),
      });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  det.stop();
  ctx.log.info("scan_done", { api: det.stats.api, chain: det.stats.chain });
  return 0;
}

/** The entry point: never lets an error out unredacted (the SDK puts RPC URLs in its messages). */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  return guardMain(() => mainInner(argv));
}

async function mainInner(argv: string[]): Promise<number> {
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
  if (cmd === "init") {
    const interactive = !opt.yes && process.stdin.isTTY === true;
    const t = interactive ? terminalAsk() : null;
    try {
      return await init(opt, { env: process.env, fetch, out: (s) => void process.stdout.write(s), ...(t ? { ask: t.ask } : {}) });
    } catch (e) {
      if (e instanceof ConfigError || (e as Error)?.name === "StrategyConfigError") die(String((e as Error).message));
      throw e;
    } finally {
      t?.close();
    }
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
    case "sell":
      if (!pos[1]) die("sell <mint> [--fraction f]");
      {
        const ctx = context(config);
        return sell(ctx, pos[1], opt.fraction ? Number(opt.fraction) : 1, openLedger(ctx), (ledger) => makeEngine(ctx, ledger));
      }
    default:
      die(`unknown command ${cmd}`);
  }
}
