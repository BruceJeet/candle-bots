/** Library entry: the types a custom exit strategy is written against, and the config parser. */
export type { Decision, ExitStrategy, MarketView, PositionView, StrategyFactory } from "candle-bot-core/strategies/types";
export { HOLD, StrategyConfigError } from "candle-bot-core/strategies/types";
export { parseConfig, loadConfig, ConfigError, LAUNCH_MODES } from "./config.ts";
export type { Config } from "./config.ts";
