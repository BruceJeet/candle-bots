/** candle-exit-manager: the config, the per-coin strategy, the trigger and the engine builder, for use as a library. */
export { parseConfig, loadConfig, SECTIONS, NO_BUYS, ConfigError } from "./config.ts";
export type { Config, Manager } from "./config.ts";
export { ByMint, ManagerTrigger, loadExits, makeManager, assemble, knownProgramsFor, checkExcludeDirs, nextExit, ledgerPath } from "./manager.ts";
export type { Built } from "./manager.ts";
export { main, HELP } from "./cli.ts";
