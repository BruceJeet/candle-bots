/** The wallet source for a config: its own RPC when `source.rpcUrlEnv` names one, a websocket unless `source.poll`. */
import { resolve } from "node:path";
import type { Logger } from "candle-bot-core/log";
import { addSecret } from "candle-bot-core/redact";
import { wsUrlFor } from "candle-bot-core/solana/logs-ws";
import { httpRpc, type Rpc } from "candle-bot-core/solana/rpc";
import { WalletSource, type Anchor, type WalletSourceOptions } from "candle-bot-core/sources/wallets";
import { walletRecorder } from "candle-bot-core/sources/walletReplay";
import { ConfigError, type Source } from "./config.ts";

export function makeSource(o: { source: Source; rpc: Rpc; wsUrl: string; log: Logger; configDir: string; since?: Record<string, Anchor>; env?: NodeJS.ProcessEnv; now?: () => number; extra?: Partial<WalletSourceOptions> }): WalletSource {
  const env = o.env ?? process.env;
  const s = o.source;
  let rpc = o.rpc;
  let wsUrl: string | null = o.wsUrl;
  if (s.rpcUrlEnv) {
    const url = env[s.rpcUrlEnv];
    if (!url) throw new ConfigError(`config.source.rpcUrlEnv: ${s.rpcUrlEnv} is not set`);
    addSecret(url);
    rpc = httpRpc(url);
    wsUrl = wsUrlFor(url);
  }
  if (s.wsUrlEnv) {
    const url = env[s.wsUrlEnv];
    if (!url) throw new ConfigError(`config.source.wsUrlEnv: ${s.wsUrlEnv} is not set`);
    addSecret(url);
    wsUrl = url;
  }
  if (s.poll) wsUrl = null;
  return new WalletSource({
    rpc, wsUrl, log: o.log,
    fetchPerSec: s.fetchPerSec, fetchBurst: s.fetchBurst, pollMs: s.pollSec * 1000, reconcileMs: s.reconcileSec * 1000, backfillLimit: s.backfillLimit,
    ...(o.since ? { since: o.since } : {}),
    ...(s.record ? { record: walletRecorder(resolve(o.configDir, s.record)) } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...o.extra,
  });
}
