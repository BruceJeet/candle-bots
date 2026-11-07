/** candle-perps-hedger: the config, the hedger and its loop, for use as a library. */
export { parseConfig, loadConfig, ConfigError } from "./config.ts";
export type { Config, SpotSection, PerpsSection, BetaSection } from "./config.ts";
export { Hedger } from "./hedger.ts";
export type { HedgerDeps } from "./hedger.ts";
export { main, HELP, runHedger, makeVenue, context } from "./cli.ts";
export type { Ctx } from "./cli.ts";
