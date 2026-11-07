/** candle-spread-watcher: the config and the watcher, for use as a library. */
export { parseConfig, loadConfig, SECTIONS, ConfigError } from "./config.ts";
export type { Config, CoinSpec, PerpsSection, Rules } from "./config.ts";
export { SpreadWatcher } from "./watcher.ts";
export type { SpreadWatcherDeps } from "./watcher.ts";
export { makeWatcher, main, HELP } from "./cli.ts";
