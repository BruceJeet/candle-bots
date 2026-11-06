/** candle-event-bot: the trigger, the config and the wiring, for use as a library. */
export { EventTrigger, windowOf } from "./trigger.ts";
export type { TriggerDeps } from "./trigger.ts";
export { parseConfig, loadConfig, eventTimes, SECTIONS, ConfigError } from "./config.ts";
export type { Config, EventItem, Entry } from "./config.ts";
export { main, HELP, makeEngine, plan } from "./cli.ts";
