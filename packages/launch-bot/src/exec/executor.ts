/**
 * The core executor (candle-bot-core), fed this bot's buy-retry impact limit: `filters.maxImpactBps`, as in 0.1.3.
 * Everything else about orders lives in the core.
 */
import { Executor as CoreExecutor, type ExecutorDeps as CoreDeps } from "candle-bot-core/exec/executor";
import type { Config } from "../config.ts";

export * from "candle-bot-core/exec/executor";

export type ExecutorDeps = Omit<CoreDeps, "cfg" | "maxBuyImpactBps"> & { cfg: Config; maxBuyImpactBps?: number };

export class Executor extends CoreExecutor {
  constructor(d: ExecutorDeps) {
    super({ ...d, maxBuyImpactBps: d.maxBuyImpactBps ?? d.cfg.filters.maxImpactBps });
  }
}
