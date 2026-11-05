/**
 * (0.6.0) Watch-only bots: no wallet, no API key, no trade rail and no executor, ever. A watch-only bot reads chain and
 * public feeds and raises alerts. Its config refuses every trading section, so a watch-only config can never trade.
 *
 *   parseWatchConfig(raw, baseDir, sections)   the shared keys a watcher has, plus the bot's own sections
 *   watchContext(cfg)                          RPC, websocket URL, logger
 *   runWatch(ctx, make)                        lock, ledger (alert dedupe), alerter, the loop, STOP, signals, status.json
 */
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, ENV_NAME, deepFreeze, isObj, num, parseAlerts, str, type AlertsConfig, type SectionParser } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { makeAlerter, type Alerter } from "./alerts.ts";
import { makeLogger, type Logger } from "./log.ts";
import { addSecret, redact } from "./redact.ts";
import { httpRpc, PUBLIC_RPC, type Rpc } from "./solana/rpc.ts";
import { wsUrlFor } from "./solana/logs-ws.ts";
import { acquireLock, readControl } from "./engine.ts";

/** Keys a trading bot has and a watch-only config refuses (it never holds what a trade needs). */
export const TRADING_KEYS = ["wallet", "apiKeyEnv", "payer", "signer", "privyAppId", "linkedWalletId", "privyWalletId", "buy", "sell", "exit", "retry", "exitMs"];

export interface WatchConfigBase {
  mode: "watch";
  /** Candle's API base (public reads only; no key is ever sent). */
  apiUrl: string;
  rpcUrlEnv?: string;
  rpcWsUrlEnv?: string;
  stateDir: string;
  loopMs: number;
  alerts: AlertsConfig;
  configDir: string;
}

export type WatchConfig<S extends Record<string, SectionParser<unknown>> = {}> = WatchConfigBase & { [K in keyof S]: S[K] extends SectionParser<infer T> ? T : never };

const WATCH_KEYS = ["mode", "apiUrl", "rpcUrlEnv", "rpcWsUrlEnv", "stateDir", "loopMs", "alerts", "$schema", "comment"];

export function parseWatchConfig<S extends Record<string, SectionParser<unknown>>>(raw: unknown, baseDir: string, sections: S): WatchConfig<S> {
  if (!isObj(raw)) throw new ConfigError("config: must be a JSON object");
  for (const k of TRADING_KEYS) if (raw[k] !== undefined) throw new ConfigError(`config.${k}: this bot only watches and alerts; it never trades, so it takes no ${k}`);
  for (const k of Object.keys(raw)) if (!WATCH_KEYS.includes(k) && !(k in sections)) throw new ConfigError(`config: unknown key "${k}"`);
  const mode = str(raw, "mode", "config", { def: "watch" });
  if (mode !== "watch") throw new ConfigError('config.mode: "watch" (this bot only watches and alerts)');
  const apiUrl = str(raw, "apiUrl", "config", { def: "https://api.alpha.candle.tv" })!;
  if (!/^https?:\/\/[^\s]+$/.test(apiUrl)) throw new ConfigError("config.apiUrl: an http(s) URL");
  const rpcUrlEnv = str(raw, "rpcUrlEnv", "config", { optional: true, re: ENV_NAME });
  const rpcWsUrlEnv = str(raw, "rpcWsUrlEnv", "config", { optional: true, re: ENV_NAME });
  const stateDir = resolve(baseDir, str(raw, "stateDir", "config", { def: "./state" })!);
  const loopMs = num(raw, "loopMs", "config", { min: 500, max: 600_000, int: true, def: 5_000 });
  const alerts = parseAlerts(raw.alerts);
  const own: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(sections)) own[k] = p(raw[k], { mode: "dry", wallet: "", buy: {} as never, baseDir });
  return deepFreeze({ mode: "watch", apiUrl, ...(rpcUrlEnv ? { rpcUrlEnv } : {}), ...(rpcWsUrlEnv ? { rpcWsUrlEnv } : {}), stateDir, loopMs, alerts, ...own, configDir: resolve(baseDir) }) as WatchConfig<S>;
}

export interface WatchCtx<C extends WatchConfigBase = WatchConfigBase> {
  cfg: C;
  rpc: Rpc;
  wsUrl: string;
  log: Logger;
}

export function watchContext<C extends WatchConfigBase>(cfg: C, opts: { log?: Logger; env?: NodeJS.ProcessEnv } = {}): WatchCtx<C> {
  const env = opts.env ?? process.env;
  const rpcUrl = (cfg.rpcUrlEnv && env[cfg.rpcUrlEnv]) || PUBLIC_RPC;
  const wsUrl = (cfg.rpcWsUrlEnv && env[cfg.rpcWsUrlEnv]) || wsUrlFor(rpcUrl);
  addSecret(rpcUrl);
  addSecret(wsUrl);
  mkdirSync(cfg.stateDir, { recursive: true });
  const log = opts.log ?? makeLogger({ file: join(cfg.stateDir, "events.jsonl") });
  return { cfg, rpc: httpRpc(rpcUrl), wsUrl, log };
}

/** What a watch-only bot gives runWatch. */
export interface Watcher {
  /** One pass (reads, rules, alerts). It must not throw for a failed read; a throw is logged and the loop goes on. */
  step(shouldStop: () => boolean): Promise<void>;
  status(): Record<string, unknown>;
  stop?(): void | Promise<void>;
}

/**
 * The loop: one process per state dir, a ledger only for alert dedupe and history, the bot's alert sinks, a step every
 * loopMs, STOP (a file in the state dir) and SIGINT/SIGTERM end it cleanly, status.json after each step.
 */
export async function runWatch<C extends WatchConfigBase>(ctx: WatchCtx<C>, make: (d: { ledger: Ledger; alerter: Alerter }) => Promise<Watcher>, opts: { env?: NodeJS.ProcessEnv; startFields?: Record<string, unknown>; maxSteps?: number } = {}): Promise<number> {
  const lock = acquireLock(ctx.cfg.stateDir);
  if (!lock) {
    ctx.log.error("locked", { stateDir: ctx.cfg.stateDir });
    return 1;
  }
  const ledger = new Ledger(join(ctx.cfg.stateDir, "ledger.sqlite"));
  let stopping = false;
  const onSig = () => {
    if (!stopping) ctx.log.info("signal_stop");
    stopping = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  const shouldStop = () => stopping || readControl(join(ctx.cfg.stateDir, "STOP")) !== null;
  let w: Watcher | null = null;
  let steps = 0;
  const started = Date.now();
  const writeStatus = () => {
    try {
      const p = join(ctx.cfg.stateDir, "status.json");
      const body = { mode: "watch", startedAt: new Date(started).toISOString(), at: new Date().toISOString(), steps, ...(w ? w.status() : {}) };
      writeFileSync(p + ".tmp", redact(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)));
      renameSync(p + ".tmp", p);
    } catch (e) {
      ctx.log.warn("status_write_failed", { error: String((e as Error).message) });
    }
  };
  try {
    const alerter = makeAlerter(ctx.cfg.alerts, ledger, ctx.log, opts.env);
    w = await make({ ledger, alerter });
    ctx.log.info("start", { mode: "watch", stateDir: ctx.cfg.stateDir, loopMs: ctx.cfg.loopMs, ...(opts.startFields ?? {}) });
    while (!shouldStop() && (opts.maxSteps === undefined || steps < opts.maxSteps)) {
      const t0 = Date.now();
      try {
        await w.step(shouldStop);
      } catch (e) {
        ctx.log.error("watch_step_failed", { error: String((e as Error)?.stack ?? e).slice(0, 800) });
      }
      steps++;
      writeStatus();
      const wait = Math.max(0, ctx.cfg.loopMs - (Date.now() - t0));
      const until = Date.now() + wait;
      while (!shouldStop() && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(250, until - Date.now())));
    }
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
    try {
      await w?.stop?.();
    } catch (e) {
      ctx.log.error("watch_stop_failed", { error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
    writeStatus();
    ledger.close();
    lock.release();
    ctx.log.info("stopped", { steps });
  }
  return 0;
}
