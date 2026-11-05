/** candle-scanner-bot: the config, the rules, the scanner and its builder, for use as a library. */
export { parseConfig, loadConfig, SECTIONS, ConfigError } from "./config.ts";
export type { Config, Rules, WatchlistSection, SeriesSection } from "./config.ts";
export { Scanner, evaluate } from "./scanner.ts";
export type { Firing, RuleName, ScannerDeps } from "./scanner.ts";
export { makeScanner, main, HELP } from "./cli.ts";
