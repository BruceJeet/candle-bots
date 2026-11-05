/** candle-creator-bot: the trigger, the filters, the config and the ledger, for use as a library. */
export { CreatorTrigger, Engine, candleHasMarket, followedOf, NO_CANDLE_MARKET } from "./trigger.ts";
export type { TriggerDeps, EngineDeps, LaunchSource, MarketInfoSource } from "./trigger.ts";
export { ageAndMode, onCurve } from "./filters.ts";
export type { FilterVerdict } from "./filters.ts";
export { parseConfig, loadConfig, SECTIONS, ConfigError, LAUNCH_MODES, DEFAULT_MODES } from "./config.ts";
export type { Config, Creator, Follow, Detect } from "./config.ts";
export { Ledger } from "./ledger.ts";
export type { FollowRow } from "./ledger.ts";
export { main, HELP } from "./cli.ts";
