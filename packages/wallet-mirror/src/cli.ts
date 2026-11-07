/** The command line: run, watch, status, sell, replay. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { watchContext, runWatch } from "candle-bot-core";
import { args, context as coreContext, die, guardMain, run, sell, status, type Ctx as CoreCtx } from "candle-bot-core/runtime";
import { LeaderBook } from "candle-bot-core/sources/walletPositions";
import { replayWallets } from "candle-bot-core/sources/walletReplay";
import { loadConfig, loadWatchModeConfig, ConfigError, type Config, type WatchModeConfig } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { makeSource } from "./source.ts";
import { makeMirror } from "./trigger.ts";
import { LeaderWatcher, watchCursors } from "./watch.ts";

export const HELP = `candle-wallet-mirror: copies the trades of the wallets you list. A leader's buy is copied with a fixed ticket
(or a share of the leader's SOL, capped), once per coin; the leader's sells are mirrored as the same share of what it
held; your exit strategy runs alongside. Leaders are followed on chain (pump.fun curve, PumpSwap, Candle curve, Meteora
DAMM v2, Jupiter routes).

  candle-wallet-mirror run    --config bot.json [--mode dry|live]   copy the leaders
  candle-wallet-mirror watch  --config watch.json [--seconds n]     watch-only: alerts on the leaders' trades (no wallet, no key)
  candle-wallet-mirror status --config <file>                       print status.json
  candle-wallet-mirror sell   <mint> --config bot.json [--fraction 1]
  candle-wallet-mirror replay --file trades.jsonl [--wallet <address>]   decode a recording (source.record) again

Start from examples/dry.json (or examples/watch.json) and put your leaders in \`leaders\`. Controls: STOP or PAUSE_BUYS
in the state folder. Docs: the README.
`;

type Ctx = CoreCtx<Config>;

function load<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ConfigError) die(e.message);
    throw e;
  }
}

function context(configPath: string, modeOverride?: string): Ctx {
  return coreContext(load(() => loadConfig(configPath)), modeOverride);
}

const openLedger = (ctx: Ctx) => () => new Ledger(join(ctx.cfg.stateDir, "ledger.sqlite"));

/** "watch" when the file says mode watch. */
function modeOf(path: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return typeof raw?.mode === "string" ? raw.mode : null;
  } catch {
    return null;
  }
}

async function runMirror(ctx: Ctx): Promise<number> {
  return run(ctx, openLedger(ctx), async (ledger) => {
    // source.transfers (default on): a leader moving a coin we hold out of its wallet is alerted.
    const source = load(() => makeSource({ source: ctx.cfg.source, rpc: ctx.rpc, wsUrl: ctx.wsUrl, log: ctx.log, configDir: ctx.cfg.configDir, since: ledger.cursors(), extra: { transfers: ctx.cfg.source.transfers } }));
    const { engine, trigger } = await makeMirror(ctx, ledger, source);
    return { engine, trigger };
  }, { leaders: ctx.cfg.leaders.length, ticket: ctx.cfg.mirror.ticket.mode, copy: ctx.cfg.mirror.copy, sells: ctx.cfg.mirror.sells });
}

async function runWatchMode(cfg: WatchModeConfig, seconds: number | null): Promise<number> {
  const ctx = watchContext(cfg);
  if (seconds !== null) setTimeout(() => process.emit("SIGTERM"), seconds * 1000).unref();
  return runWatch(ctx, async ({ ledger, alerter }) => {
    const source = load(() => makeSource({ source: cfg.source, rpc: ctx.rpc, wsUrl: ctx.wsUrl, log: ctx.log, configDir: cfg.configDir, since: watchCursors(ledger) }));
    const w = new LeaderWatcher({ cfg, ledger, alerter, log: ctx.log, source });
    await w.start();
    return w;
  }, { startFields: { leaders: cfg.leaders.length, poll: cfg.source.poll } });
}

function replay(file: string, wallet: string | undefined): number {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    die(`${file}: ${(e as Error).message}`);
  }
  const r = replayWallets(text);
  const book = new LeaderBook();
  const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
  for (const e of r.events) {
    if (wallet && e.wallet !== wallet) continue;
    const m = book.apply(e);
    process.stdout.write(JSON.stringify({ at: new Date(e.seenAtMs).toISOString(), leader: e.wallet, mint: e.mint, side: e.side, kind: m.kind, fraction: m.fraction, solRaw: e.solRaw, tokenRaw: e.tokenRaw, venue: e.venue, venues: e.venues, signature: e.signature, slot: e.slot, blockTime: e.blockTime }, big) + "\n");
  }
  for (const s of r.skipped) if (!wallet || s.wallet === wallet) process.stdout.write(JSON.stringify({ skipped: s.reason, leader: s.wallet, signature: s.signature }) + "\n");
  return 0;
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
    switch (cmd) {
      case "run": {
        const config = opt.config ?? "bot.json";
        if (modeOf(config) === "watch") die(`${config} is a watch-only config: use \`watch\``);
        return runMirror(context(config, opt.mode));
      }
      case "watch": {
        const config = opt.config ?? "watch.json";
        const secs = opt.seconds !== undefined ? Number(opt.seconds) : null;
        if (secs !== null && !(secs > 0)) die("--seconds: a number above 0");
        return runWatchMode(load(() => loadWatchModeConfig(config)), secs);
      }
      case "status": {
        const config = opt.config ?? "bot.json";
        if (modeOf(config) === "watch") {
          const cfg = load(() => loadWatchModeConfig(config));
          try {
            process.stdout.write(readFileSync(join(cfg.stateDir, "status.json"), "utf8") + "\n");
            return 0;
          } catch {
            die(`no status.json in ${cfg.stateDir} yet`);
          }
        }
        return status(context(config));
      }
      case "sell": {
        if (!pos[1]) die("sell <mint> [--fraction f]");
        const ctx = context(opt.config ?? "bot.json");
        return sell(ctx, pos[1], opt.fraction ? Number(opt.fraction) : 1, openLedger(ctx), async (ledger) => {
          const source = load(() => makeSource({ source: ctx.cfg.source, rpc: ctx.rpc, wsUrl: ctx.wsUrl, log: ctx.log, configDir: ctx.cfg.configDir }));
          return makeMirror(ctx, ledger, source);
        });
      }
      case "replay": {
        if (!opt.file) die("replay --file <recording.jsonl> [--wallet <address>]");
        return replay(opt.file, opt.wallet);
      }
      default:
        die(`unknown command ${cmd}`);
    }
  });
}
