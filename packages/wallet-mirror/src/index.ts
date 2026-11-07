/** candle-wallet-mirror: the trigger, the exit, the watcher, the config and the ledger, for use as a library. */
export { MirrorTrigger, MirrorExit, makeMirror, assemble, knownProgramsFor } from "./trigger.ts";
export type { LeaderBuy, MarketReader, MirrorDeps, Built } from "./trigger.ts";
export { LeaderWatcher, watchCursors } from "./watch.ts";
export { makeSource } from "./source.ts";
export { parseConfig, loadConfig, parseWatchModeConfig, loadWatchModeConfig, SECTIONS, WATCH_SECTIONS, ConfigError } from "./config.ts";
export type { Config, Leader, Mirror, Source, Notify, WatchModeConfig } from "./config.ts";
export { Ledger } from "./ledger.ts";
export type { LeaderTradeRow, MirrorSellRow } from "./ledger.ts";
export { main, HELP } from "./cli.ts";
