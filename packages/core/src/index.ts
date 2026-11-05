/**
 * candle-bot-core: the shared core of Candle bots. A bot supplies a Trigger (trigger.ts) and its config sections;
 * the core runs the ledger, the executor, the exits, the controls and status.json. Every module is also importable
 * on its own path (`candle-bot-core/<module>`).
 */
export type { Candidate, BuyVerdict, CurveRead, Verdict, EntryCaps, LedgerView, PendingInfo, Trigger, TriggerContext } from "./trigger.ts";
export { Engine, readControl, acquireLock, lockHeld, lamportsOf, CYCLE_BUDGET_MS, TRIGGER_TIMEOUT_MS, LANE_BUDGET_MS, WAKE_DEBOUNCE_MS, WAKE_DEBOUNCE_MAX_MS } from "./engine.ts";
export type { EngineDeps, AdoptionHook } from "./engine.ts";
export { parseConfig, loadConfig, deepFreeze, ConfigError, isObj, only, num, str, bool, strList, regex, ENV_NAME } from "./config.ts";
export type { Config, Mode, Payer, SignerConfig, SectionParser, Sections, BotConfig, Obj } from "./config.ts";
export { Ledger } from "./ledger.ts";
export type { PositionRow, OrderRow, PositionStatus, OrderStatus, Side, QtySource } from "./ledger.ts";
export { Executor, errorInfo } from "./exec/executor.ts";
export type { ExecutorDeps, DryPricer, ErrorInfo } from "./exec/executor.ts";
export type { TradeRail } from "./exec/trader.ts";
export { programIdsOf, KNOWN_PROGRAMS } from "./exec/trader.ts";
export { Alerter, makeAlerter } from "./alerts.ts";
export type { AlertSink, AlertConfig } from "./alerts.ts";
export { makeLogger, memoryLogger } from "./log.ts";
export type { Logger, Level } from "./log.ts";
export { redact, redactDeep, addSecret, errorJson } from "./redact.ts";
export { readMarkets, dryPricer, expectedSellOut, sellFloor } from "./market/reader.ts";
export type { MarketRead, CoinRef, QuoteSource, ReadOptions } from "./market/reader.ts";
export { decodePumpCurve, decodePumpPool, decodeFeeConfig, decodeTokenAccount, feesAt, pumpCurveSell, pumpPoolSell, pumpCurvePrice, pumpPoolPrice, pumpPoolState, pumpCurveProgress } from "./market/pump.ts";
export type { PumpCurve, PumpPool, PumpPoolState, FeeConfig, PumpFees, SellOut } from "./market/pump.ts";
export { decodeMint, junkReason, EXT as MINT_EXTENSIONS } from "./market/mint.ts";
export type { MintInfo, MintExtension, JunkOptions } from "./market/mint.ts";
export { Adopter, parseAdoption, RECONCILE_CONFIRM_MS } from "./adopt/adopter.ts";
export type { AdoptionConfig, AdoptMint, AdopterDeps, AdoptionRow, CoinHolds, Basis } from "./adopt/adopter.ts";
export { decodeCandleCurve, buyImpact, curveProgress, decodeDamm, dammBuy } from "./market/curve.ts";
export type { CandleCurve, DammPool, BuyImpact } from "./market/curve.ts";
export { Detector as CandleLaunches } from "./sources/candleLaunches.ts";
export type { Launch, Sighting, DetectorDeps as CandleLaunchesDeps, DetectorOptions as CandleLaunchesOptions } from "./sources/candleLaunches.ts";
export { HolderPoller, holderDiff, creatorOf } from "./sources/holders.ts";
export type { Holder, HolderSnapshot, HolderSource } from "./sources/holders.ts";
export { httpRpc, tokenBalance, PUBLIC_RPC } from "./solana/rpc.ts";
export type { Rpc } from "./solana/rpc.ts";
export { asAddress } from "./solana/base58.ts";
export { WSOL, candleCurve, dammPool, pumpCurve, pumpSwapPool, pumpPoolAuthority, pumpFeeConfig, PUMP_PROGRAM, PUMP_AMM_PROGRAM, PUMP_FEE_PROGRAM } from "./solana/pda.ts";
export { loadStrategy } from "./strategies/load.ts";
export type { Decision, ExitStrategy, MarketView, PositionView, StrategyFactory } from "./strategies/types.ts";
export { HOLD, StrategyConfigError, checkParams, param, multiple } from "./strategies/types.ts";
export { args, context, die, guardMain, parts, run, sell, status, buildRail, SDK_TIMEOUT_MS } from "./runtime.ts";
export type { Ctx, Parts } from "./runtime.ts";
