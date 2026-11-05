/** candle-graduation-bot: the trigger, the watch, the config and the ledger, for use as a library. */
export { GraduationTrigger, Engine, evaluate, DEFAULT_DECIMALS } from "./trigger.ts";
export type { GradVerdict, TriggerDeps, EngineDeps } from "./trigger.ts";
export { GraduationWatch } from "./watch.ts";
export type { Graduation, LaunchSource, WatchOptions, WatchDeps } from "./watch.ts";
export { parseConfig, loadConfig, SECTIONS, ConfigError } from "./config.ts";
export type { Config, Graduation as GraduationFilters, Detect } from "./config.ts";
export { Ledger } from "./ledger.ts";
export type { GraduationRow } from "./ledger.ts";
export { main, HELP } from "./cli.ts";
