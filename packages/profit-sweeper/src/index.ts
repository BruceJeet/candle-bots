/** candle-profit-sweeper: the config, the per-coin targets, the sweeper, the trigger and the engine builder, for use as a library. */
export { parseConfig, loadConfig, SECTIONS, NO_BUYS, ConfigError } from "./config.ts";
export type { Config, Targets, Sweep } from "./config.ts";
export { ByMint, SweeperTrigger, loadExits, makeSweeper, assemble, knownProgramsFor, checkExcludeDirs, nextExit, ledgerPath } from "./bot.ts";
export type { Built } from "./bot.ts";
export { Sweeper, realizedOf, sol } from "./sweep.ts";
export type { SweepRow, SweeperDeps } from "./sweep.ts";
export { main, HELP } from "./cli.ts";
