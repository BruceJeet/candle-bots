/** candle-dip-buyer: the rule, the config and the wiring, for use as a library. */
export { dipRule } from "./rule.ts";
export type { DipRule } from "./rule.ts";
export { parseConfig, loadConfig, SECTIONS, ConfigError } from "./config.ts";
export type { Config, Dip } from "./config.ts";
export { main, HELP, makeEngine, makeTrigger, scan } from "./cli.ts";
