/** candle-spike-rider: the rule, the config and the wiring, for use as a library. */
export { spikeRule } from "./rule.ts";
export type { SpikeRule } from "./rule.ts";
export { parseConfig, loadConfig, SECTIONS, ConfigError } from "./config.ts";
export type { Config, Spike } from "./config.ts";
export { main, HELP, makeEngine, makeTrigger, scan } from "./cli.ts";
