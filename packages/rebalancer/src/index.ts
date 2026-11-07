/** candle-rebalancer: the plan (pure), the config, the trigger, the engine builder and the command line, for use as a library. */
export { plan, planText } from "./plan.ts";
export type { Plan, PlanCoin, PlanInput, PlanOrder, PlanRow } from "./plan.ts";
export { parseConfig, loadConfig, SECTIONS, SCHEDULE_ID, MAX_TARGETS, ConfigError } from "./config.ts";
export type { Config, Rebalance } from "./config.ts";
export { RebalanceTrigger, makeBot, assemble, knownProgramsFor, snapshot, ledgerPath, VERDICT_MAX_MS } from "./bot.ts";
export type { Built, RebalanceDeps } from "./bot.ts";
export { main, HELP, planCommand, sellCommand } from "./cli.ts";
