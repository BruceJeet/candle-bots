/**
 * candle-bot-core: the shared core of Candle bots. A bot supplies a Trigger (trigger.ts) and its config sections;
 * the core runs the ledger, the executor, the exits, the controls and status.json. Every module is also importable
 * on its own path (`candle-bot-core/<module>`).
 */
export type { Candidate, BuyVerdict, Verdict, EntryCaps, LedgerView, PendingInfo, Trigger, TriggerContext } from "./trigger.ts";
export { Engine, readControl, acquireLock, lockHeld, lamportsOf, CYCLE_BUDGET_MS, TRIGGER_TIMEOUT_MS } from "./engine.ts";
export type { EngineDeps } from "./engine.ts";
export { parseConfig, loadConfig, deepFreeze, ConfigError, isObj, only, num, str, bool, strList, regex, ENV_NAME } from "./config.ts";
export type { Config, Mode, Payer, SignerConfig, SectionParser, Sections, BotConfig, Obj } from "./config.ts";
export { Ledger } from "./ledger.ts";
export type { PositionRow, OrderRow, PositionStatus, OrderStatus, Side, QtySource } from "./ledger.ts";
export { Executor, errorInfo } from "./exec/executor.ts";
export type { ExecutorDeps, DryPricer, ErrorInfo } from "./exec/executor.ts";
export type { TradeRail } from "./exec/trader.ts";
export { Alerter, makeAlerter } from "./alerts.ts";
export type { AlertSink, AlertConfig } from "./alerts.ts";
export { makeLogger, memoryLogger } from "./log.ts";
export type { Logger, Level } from "./log.ts";
export { redact, redactDeep, addSecret, errorJson } from "./redact.ts";
export { readMarkets, dryPricer } from "./market/reader.ts";
export type { MarketRead, CoinRef, QuoteSource } from "./market/reader.ts";
export { decodeCandleCurve, buyImpact, curveProgress } from "./market/curve.ts";
export type { CandleCurve } from "./market/curve.ts";
export { httpRpc, tokenBalance, PUBLIC_RPC } from "./solana/rpc.ts";
export type { Rpc } from "./solana/rpc.ts";
export { asAddress } from "./solana/base58.ts";
export { WSOL, candleCurve } from "./solana/pda.ts";
export { loadStrategy } from "./strategies/load.ts";
export type { Decision, ExitStrategy, MarketView, PositionView, StrategyFactory } from "./strategies/types.ts";
export { HOLD, StrategyConfigError, checkParams, param, multiple } from "./strategies/types.ts";
export { args, context, die, guardMain, parts, run, sell, status, buildRail, SDK_TIMEOUT_MS } from "./runtime.ts";
export type { Ctx, Parts } from "./runtime.ts";
