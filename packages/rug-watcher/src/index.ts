/** candle-rug-watcher: the config, the rules, the watcher, the trigger and the engine builder, for use as a library. */
export { parseConfig, loadConfig, SECTIONS, NO_BUYS, ConfigError } from "./config.ts";
export type { Config, Rules, Watch, Action, WindowRule, DevRule, HolderRule } from "./config.ts";
export { windowDrop, devTrips, holderTrips, watchedHolders, prune, pct } from "./rules.ts";
export type { Sample, Trip, DevState, HolderSample } from "./rules.ts";
export { RugWatch, HOLDER_FAIL_ALERT, CREATOR_RETRY_MS } from "./watch.ts";
export type { WatchDeps, EventRow, RuleName } from "./watch.ts";
export { RugExit, WatcherTrigger, makeWatcher, assemble, knownProgramsFor, checkExcludeDirs, ledgerPath, VENUES } from "./watcher.ts";
export type { Built } from "./watcher.ts";
export { main, HELP } from "./cli.ts";
