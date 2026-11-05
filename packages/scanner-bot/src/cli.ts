/** The command line: run, status. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { watchContext, runWatch, LogsSeries, CandleFeed, Watchlist, type WatchCtx } from "candle-bot-core";
import { args, die, guardMain } from "candle-bot-core/runtime";
import { loadConfig, ConfigError, type Config } from "./config.ts";
import { Scanner } from "./scanner.ts";

export const HELP = `candle-scanner-bot: watches pump.fun and PumpSwap coins (a list, or a Candle feed bucket) and alerts when a rule
fires: a volume spike, a dip, a breakout, a hot 5 min on the Candle feed. Watch-only: no wallet, no API key, it never
trades.

  candle-scanner-bot run    --config scan.json      run the scanner (STOP in the state folder, or Ctrl-C, ends it)
  candle-scanner-bot status --config scan.json      print status.json

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

/** The scanner and its sources on a watch context (a library user, or a test, can call it with its own context). */
export function makeScanner(ctx: WatchCtx<Config>, d: { ledger: any; alerter: any; now?: () => number; fetch?: typeof fetch; socket?: any }): Scanner {
  const cfg = ctx.cfg;
  const now = d.now ?? Date.now;
  const series = new LogsSeries({ rpc: ctx.rpc, wsUrl: ctx.wsUrl, log: ctx.log, alerter: d.alerter, now, ...(d.socket ? { socket: d.socket } : {}) }, { maxSubscriptions: cfg.series.maxSubscriptions, maxCoins: cfg.watchlist.maxCoins, maxBars: cfg.series.maxBars, maxSlotLag: cfg.series.maxSlotLag });
  const f = cfg.watchlist.feed;
  const feed = f ? new CandleFeed({ apiUrl: cfg.apiUrl, log: ctx.log, alerter: d.alerter, now, ...(d.fetch ? { fetch: d.fetch } : {}) }, { buckets: f.buckets, ...(f.where ? { where: f.where } : {}), everyMs: f.everySec * 1000 }) : null;
  const watchlist = new Watchlist({ series, feed, alerter: d.alerter, log: ctx.log, now }, { mints: cfg.watchlist.mints, maxCoins: cfg.watchlist.maxCoins, ...(f ? { maxFeedCoins: f.maxCoins } : {}), dropAfterMs: cfg.watchlist.dropAfterMin * 60_000 });
  return new Scanner({ cfg, ledger: d.ledger, alerter: d.alerter, log: ctx.log, series, watchlist, feed, now });
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
    const cfg = load(opt.config ?? "scan.json");
    switch (cmd) {
      case "run": {
        const ctx = watchContext(cfg);
        return runWatch(ctx, async (d) => makeScanner(ctx, d), { startFields: { rules: Object.keys(cfg.rules).filter((k) => !["allowIncomplete", "link"].includes(k)), watchlist: { mints: cfg.watchlist.mints.length, feed: cfg.watchlist.feed?.buckets ?? [] } } });
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
