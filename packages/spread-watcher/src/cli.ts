/** The command line: run, check, status. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { watchContext, runWatch, type WatchCtx } from "candle-bot-core";
import { args, die, guardMain } from "candle-bot-core/runtime";
import { timedFetch } from "candle-bot-core/exec/trader";
import { readPerpMarkets } from "candle-bot-core/perps/sdkVenue";
import { perpUnits, readVenuePrices, spreadOf } from "candle-bot-core/market/venues";
import type { Alerter } from "candle-bot-core/alerts";
import type { Ledger } from "candle-bot-core/ledger";
import type { PerpMarket } from "candle-bot-core/perps/venue";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { SpreadWatcher } from "./watcher.ts";

export const HELP = `candle-spread-watcher: watches each listed coin's price on every venue it trades on (its own curve or pool, other
PumpSwap and Meteora DAMM v2 pools by address, its Hyperliquid perp) and alerts when the gap between two venues holds
above a threshold, with each venue's SOL depth. Watch-only: no wallet, no API key, it never trades.

  candle-spread-watcher run    --config spread.json      run the watcher (STOP in the state folder, or Ctrl-C, ends it)
  candle-spread-watcher check  --config spread.json      one read of every venue, printed (no alert, no state)
  candle-spread-watcher status --config spread.json      print status.json

Start from examples/watch.json. Alerts go to Telegram, Discord, a webhook or a command (config.alerts). Docs: the README.
`;

function load(path: string): Config {
  try {
    return loadConfig(path);
  } catch (e) {
    if (e instanceof ConfigError) die(e.message);
    throw e;
  }
}

/** The watcher on a watch context (a library user, or a test, can call it with its own context and perp reader). */
export function makeWatcher(ctx: WatchCtx<Config>, d: { ledger: Ledger; alerter: Alerter; now?: () => number; perpMarkets?: () => Promise<Map<string, PerpMarket>> }): SpreadWatcher {
  const fetchFn = timedFetch(20_000) as any;
  return new SpreadWatcher({ cfg: ctx.cfg, rpc: ctx.rpc, ledger: d.ledger, alerter: d.alerter, log: ctx.log, perpMarkets: d.perpMarkets ?? (() => readPerpMarkets(fetchFn, ctx.cfg.perps.network)), ...(d.now ? { now: d.now } : {}) });
}

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
    const cfg = load(opt.config ?? "spread.json");
    switch (cmd) {
      case "run": {
        const ctx = watchContext(cfg);
        const maxS = opt["max-seconds"] === undefined ? undefined : Number(opt["max-seconds"]);
        if (maxS !== undefined && !(maxS > 0)) die("--max-seconds: a number of seconds > 0");
        const stopAt = maxS === undefined ? null : Date.now() + maxS * 1000;
        return runWatch(ctx, async (d) => {
          const w = makeWatcher(ctx, d);
          if (stopAt === null) return w;
          // A timed run: the step sees the clock too, and STOP ends the loop at the time.
          return { step: (s: () => boolean) => w.step(() => s() || Date.now() >= stopAt), status: () => w.status(), stop: () => undefined };
        }, { startFields: { coins: cfg.coins.length, minSpreadBps: cfg.rules.minSpreadBps }, ...(stopAt !== null ? { maxSteps: Math.max(1, Math.ceil((maxS! * 1000) / cfg.loopMs)) } : {}) });
      }
      case "check": {
        const ctx = watchContext(cfg);
        const reads = await readVenuePrices(ctx.rpc, cfg.coins.map((c) => ({ mint: c.mint, pools: c.pools, own: c.own })), Date.now());
        const marks = cfg.coins.some((c) => c.perp) ? await readPerpMarkets(timedFetch(20_000) as any, cfg.perps.network).catch(() => null) : null;
        const sol = marks?.get("SOL")?.markPx ?? null;
        const out = cfg.coins.map((c) => {
          const prices = [...(reads.get(c.mint)?.prices ?? [])];
          if (c.perp) {
            const m = marks?.get(c.perp);
            const units = c.perpUnits ?? perpUnits(c.perp);
            prices.push({ venue: "perp", source: "perp", address: c.perp, priceSol: m?.markPx && sol ? m.markPx / units / sol : null, depthSol: null, ...(m?.markPx && sol ? {} : { problem: "no mark" }) });
          }
          const sp = spreadOf(prices, cfg.rules.minDepthSol, cfg.rules.perps);
          return { mint: c.mint, label: c.label, spreadBps: sp?.bps ?? null, venues: prices };
        });
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
        return 0;
      }
      case "status": {
        try {
          process.stdout.write(readFileSync(join(cfg.stateDir, "status.json"), "utf8") + "\n");
          return 0;
        } catch {
          die(`no status.json in ${cfg.stateDir} yet`);
        }
      }
      default:
        die(`unknown command ${cmd}`);
    }
  });
}
