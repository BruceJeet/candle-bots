/** candle-dca-bot: the config, the trigger, the engine builder and the command line, for use as a library. */
export { parseConfig, loadConfig, SECTIONS, NO_BUYS, ConfigError } from "./config.ts";
export type { Config, Dca, DcaSchedule } from "./config.ts";
export { DcaTrigger, makeBot, assemble, knownProgramsFor, sellImpactBps, ledgerPath, VERDICT_MAX_MS } from "./bot.ts";
export type { Built, DcaDeps } from "./bot.ts";
export { main, HELP, plan, planOne, sellCommand } from "./cli.ts";
