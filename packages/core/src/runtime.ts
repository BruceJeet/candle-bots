/**
 * What a bot's command line needs around the engine, the same for every bot: the run context (config, RPC, Candle
 * client, events.jsonl), the trade rail for the configured payer, the executor and alerts, the run loop (state-dir
 * lock, STOP and signals, trigger start and stop), and the `status` and `sell` commands.
 */
import { CandleClient } from "@candledottv/agent-sdk";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeAlerter, type Alerter } from "./alerts.ts";
import { deepFreeze, type Config } from "./config.ts";
import { acquireLock, type Engine } from "./engine.ts";
import { Executor } from "./exec/executor.ts";
import { EmbeddedRail, makeSecretStore, resolveEmbedded, resolveWallet, SdkRail, timedFetch, type TradeRail } from "./exec/trader.ts";
import type { Ledger } from "./ledger.ts";
import { makeLogger, type Logger } from "./log.ts";
import { dryPricer } from "./market/reader.ts";
import { addSecret, redact } from "./redact.ts";
import { PUBLIC_RPC, httpRpc, type Rpc } from "./solana/rpc.ts";
import { wsUrlFor } from "./solana/logs-ws.ts";
import { loadStrategy } from "./strategies/load.ts";
import type { ExitStrategy } from "./strategies/types.ts";
import type { Trigger } from "./trigger.ts";

/** Longest a single Candle API call may take (build, sign relay, submit, reads). */
export const SDK_TIMEOUT_MS = 45_000;

export function args(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) opt[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opt[k] = argv[++i];
      else opt[k] = "true";
    } else pos.push(a);
  }
  return { pos, opt };
}

/** Print (redacted) and exit. */
export function die(msg: string, code = 2): never {
  process.stderr.write(redact(msg) + "\n");
  process.exit(code);
}

export interface Ctx<C extends Config = Config> {
  cfg: C;
  rpc: Rpc;
  wsUrl: string;
  client: CandleClient;
  log: Logger;
}

/**
 * The run context for a loaded config. `modeOverride` (--mode) may only turn a live config dry: live needs
 * "mode": "live" in the file.
 */
export function context<C extends Config>(cfg: C, modeOverride?: string): Ctx<C> {
  if (modeOverride) {
    if (modeOverride !== "dry" && modeOverride !== "live") die("--mode: dry or live");
    if (modeOverride === "live" && cfg.mode !== "live") die('--mode live needs "mode": "live" in the config too (and, for payer linked, its signer)');
    cfg = deepFreeze({ ...cfg, mode: modeOverride });
  }
  const apiKey = process.env[cfg.apiKeyEnv];
  addSecret(apiKey);
  const rpcUrl = (cfg.rpcUrlEnv && process.env[cfg.rpcUrlEnv]) || PUBLIC_RPC;
  const wsUrl = (cfg.rpcWsUrlEnv && process.env[cfg.rpcWsUrlEnv]) || wsUrlFor(rpcUrl);
  addSecret(rpcUrl);
  addSecret(wsUrl);
  mkdirSync(cfg.stateDir, { recursive: true });
  const log = makeLogger({ file: join(cfg.stateDir, "events.jsonl") });
  // Every SDK request carries a timeout: the SDK's own requests have none.
  const client = new CandleClient({ apiUrl: cfg.apiUrl, apiKey: apiKey || undefined, privyAppId: cfg.privyAppId, solanaRpcUrl: rpcUrl, fetch: timedFetch(SDK_TIMEOUT_MS) });
  return { cfg, rpc: httpRpc(rpcUrl), wsUrl, client, log };
}

/** The trade rail for a live run (null in dry mode): embedded (Candle signs) or linked (the local key signer). */
export async function buildRail(ctx: Ctx): Promise<{ rail: TradeRail | null; linkedWalletId?: string }> {
  if (ctx.cfg.mode !== "live") return { rail: null };
  const apiKey = process.env[ctx.cfg.apiKeyEnv];
  if (!apiKey) die(`${ctx.cfg.apiKeyEnv} is not set (the Candle API key)`);
  if (ctx.cfg.payer === "embedded") {
    const e = await resolveEmbedded(ctx.cfg, apiKey, timedFetch(SDK_TIMEOUT_MS));
    ctx.log.info("wallet_resolved", { wallet: e.address, payer: "embedded", permission: e.permission });
    return { rail: new EmbeddedRail(new CandleClient({ apiUrl: ctx.cfg.apiUrl, apiKey, fetch: timedFetch(SDK_TIMEOUT_MS) })) };
  }
  const w = await resolveWallet(ctx.cfg, apiKey, timedFetch(SDK_TIMEOUT_MS));
  const store = await makeSecretStore(ctx.cfg, w);
  const client = new CandleClient({ apiUrl: ctx.cfg.apiUrl, apiKey, privyAppId: w.privyAppId, secretStore: store, fetch: timedFetch(SDK_TIMEOUT_MS) });
  if (!(await store.get(w.linkedWalletId))) die(`no signer key for TEE wallet ${ctx.cfg.wallet} in the ${ctx.cfg.signer!.store} store (key ${w.keyPrefix})`);
  ctx.log.info("wallet_resolved", { wallet: ctx.cfg.wallet, linkedWalletId: w.linkedWalletId, keyPrefix: w.keyPrefix, signer: ctx.cfg.signer!.store });
  return { rail: new SdkRail(client, w), linkedWalletId: w.linkedWalletId };
}

export interface Parts {
  strategy: ExitStrategy;
  rail: TradeRail | null;
  linkedWalletId?: string;
  alerter: Alerter;
  executor: Executor;
}

/**
 * Everything an engine needs besides its trigger: the exit strategy, the rail, alerts and the executor. Refuses a
 * state dir that holds the other mode's positions. `maxBuyImpactBps` is the bot's buy-retry impact limit.
 * `executor` lets a bot use its own Executor subclass.
 */
export async function parts(ctx: Ctx, ledger: Ledger, opts: { maxBuyImpactBps: number; executor?: (d: ConstructorParameters<typeof Executor>[0]) => Executor }): Promise<Parts> {
  const strategy = await loadStrategy(ctx.cfg.exit, ctx.cfg.configDir).catch((e) => die(String(e.message)));
  const { rail, linkedWalletId } = await buildRail(ctx);
  const decimals = new Map<string, number>();
  const modes = ledger.modes();
  if ((ctx.cfg.mode === "dry" && modes.live) || (ctx.cfg.mode === "live" && modes.dry))
    die(`${ctx.cfg.stateDir} holds ${modes.live ? "live" : "dry"} positions; use a separate stateDir for ${ctx.cfg.mode} runs`);
  let alerter: Alerter;
  try {
    alerter = makeAlerter(ctx.cfg.alerts, ledger, ctx.log);
  } catch (e) {
    die(String((e as Error).message));
  }
  const deps = {
    cfg: ctx.cfg, ledger, rail, linkedWalletId, rpc: ctx.rpc, log: ctx.log, alerter, maxBuyImpactBps: opts.maxBuyImpactBps,
    buysPaused: () => existsSync(join(ctx.cfg.stateDir, "PAUSE_BUYS")),
    dry: dryPricer(ctx.rpc, ctx.client, (m) => decimals.get(m) ?? ledger.allPositions().find((p) => p.mint === m)?.decimals ?? 6),
  };
  const executor = opts.executor ? opts.executor(deps) : new Executor(deps);
  return { strategy, rail, linkedWalletId, alerter, executor };
}

/**
 * The run loop: one process per state dir (lock), SIGINT/SIGTERM stop cleanly, the trigger's sources start before the
 * first cycle and stop after the last, status.json is written on the way out. `make` builds the engine on the ledger.
 */
export async function run<L extends Ledger>(ctx: Ctx, openLedger: () => L, make: (ledger: L) => Promise<{ engine: Engine; trigger: Trigger }>, startFields: Record<string, unknown> = {}): Promise<number> {
  const lock = acquireLock(ctx.cfg.stateDir);
  if (!lock) die(`another process holds ${ctx.cfg.stateDir}/lock`);
  const ledger = openLedger();
  const { engine, trigger } = await make(ledger);
  let stopping = false;
  const stop = () => {
    if (!stopping) ctx.log.info("signal_stop");
    stopping = true;
    engine.requestStop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  ctx.log.info("start", { mode: ctx.cfg.mode, payer: ctx.cfg.payer, wallet: ctx.cfg.wallet, strategy: ctx.cfg.exit.strategy, stateDir: ctx.cfg.stateDir, ticketSol: ctx.cfg.buy.sol, maxOpen: ctx.cfg.buy.maxOpen, lifetimeSol: ctx.cfg.buy.lifetimeSol, ...startFields });
  await trigger.start?.(engine.ctx);
  try {
    // Full cycles every loopMs, fast entry lanes on a wake in between (Engine.run).
    await engine.run(ctx.cfg.loopMs);
  } finally {
    try {
      await trigger.stop?.();
    } catch (e) {
      ctx.log.error("trigger_stop_failed", { error: String((e as Error)?.message ?? e).slice(0, 500) });
    }
    engine.writeStatus();
    ledger.close();
    lock.release();
    ctx.log.info("stopped");
  }
  return 0;
}

/** `status`: print status.json. */
export function status(ctx: Ctx): number {
  const p = join(ctx.cfg.stateDir, "status.json");
  if (!existsSync(p)) die(`no ${p} yet (has the bot run?)`, 1);
  process.stdout.write(readFileSync(p, "utf8") + "\n");
  return 0;
}

/**
 * `sell <mint>`: with the bot running, hand it a request file (it runs the sell through its own executor); with the
 * bot stopped, take the lock and run the sell here, sweeping only that order.
 */
export async function sell<L extends Ledger>(ctx: Ctx, mint: string, fraction: number, openLedger: () => L, make: (ledger: L) => Promise<{ engine: Engine }>): Promise<number> {
  if (!(fraction > 0 && fraction <= 1)) die("--fraction must be in (0, 1]");
  const lock = acquireLock(ctx.cfg.stateDir);
  if (!lock) {
    // The bot is running: hand it the request; it runs the sell through its own executor.
    const dir = join(ctx.cfg.stateDir, "requests");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `sell-${Date.now()}-${process.pid}.json`);
    writeFileSync(f + ".tmp", JSON.stringify({ mint, fraction }));
    renameSync(f + ".tmp", f); // the bot only reads complete files
    process.stdout.write(`the bot is running: request written to ${f}; watch events.jsonl for manual_sell_request\n`);
    return 0;
  }
  const ledger = openLedger();
  try {
    const { engine } = await make(ledger);
    const r = await engine.manualSell(mint, fraction);
    process.stdout.write(r + "\n");
    const m = /^order (\d+)$/.exec(r);
    if (!m) return 1;
    const id = Number(m[1]);
    const exec = engine.executor;
    for (let i = 0; i < 600; i++) {
      await exec.sweep(1, { onlyIds: [id] }); // only this order: never a stale buy queued by an earlier run
      const o = ledger.order(id)!;
      if (!["pending", "inflight"].includes(o.status)) {
        process.stdout.write(`order ${id}: ${o.status}${o.last_error_code ? " (" + o.last_error_code + ")" : ""}\n`);
        return o.status === "filled" ? 0 : 1;
      }
      await new Promise((r) => setTimeout(r, Math.max(500, Math.min(5000, o.next_attempt_at - Date.now()))));
    }
    process.stdout.write(`order ${id} still open; it resumes on the next run\n`);
    return 1;
  } finally {
    ledger.close();
    lock.release();
  }
}

/** Run a command function so no error leaves unredacted (the SDK puts RPC URLs in its messages). */
export async function guardMain(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (e) {
    process.stderr.write(redact(String((e as Error)?.stack ?? e)) + "\n");
    return 1;
  }
}
