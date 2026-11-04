/**
 * The manual trigger: buys a coin you name by dropping a file into the state folder.
 *
 *   <stateDir>/buy/<anything>.json   { "mint": "<address>" }   (optional "sol": a smaller ticket than buy.sol)
 *
 * Each file is read once and deleted. The coin must be on its Candle curve (SOL-quoted, not migrated or full) with a
 * buy impact within `manual.maxImpactBps`; a curve that cannot be read yet waits, up to `manual.maxWaitSec`. The engine
 * then applies its caps (PAUSE_BUYS, maxPerCoin, maxOpen, lifetimeSol) and the configured exit strategy takes over.
 *
 * Uses only the public API of candle-bot-core.
 */
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigError, WSOL, asAddress, buyImpact, candleCurve, decodeCandleCurve, isObj, lamportsOf, num, only, readControl,
  type Candidate, type PendingInfo, type Rpc, type Trigger, type TriggerContext, type Verdict,
} from "candle-bot-core";

export interface ManualConfig {
  /** Most buy impact on the curve (bps); also the executor's limit when a failed buy is rebuilt. */
  maxImpactBps: number;
  /** How long a request waits for a readable curve before it is skipped (s); also the buy order's deadline. */
  maxWaitSec: number;
}

export function parseManual(raw: unknown): ManualConfig {
  const m = raw === undefined ? {} : raw;
  if (!isObj(m)) throw new ConfigError("config.manual: must be an object");
  only(m, ["maxImpactBps", "maxWaitSec"], "config.manual");
  return {
    maxImpactBps: num(m, "maxImpactBps", "config.manual", { min: 0, max: 10_000, def: 300 }),
    maxWaitSec: num(m, "maxWaitSec", "config.manual", { min: 1, max: 3600, def: 60 }),
  };
}

interface Request {
  mint: string;
  sol?: number;
  file: string;
}

export class ManualTrigger implements Trigger {
  readonly name = "manual";
  readonly candidateLabel = "requests";
  readonly buyIdPrefix = "ceb";
  readonly sellIdPrefix = "ces";
  private dir: string;
  private cfg: ManualConfig;
  private rpc: Rpc;

  constructor(stateDir: string, cfg: ManualConfig, rpc: Rpc) {
    this.dir = join(stateDir, "buy");
    this.cfg = cfg;
    this.rpc = rpc;
  }

  poll(ctx: TriggerContext): Candidate[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter((n) => /^[A-Za-z0-9._-]+\.json$/.test(n));
    } catch {
      return [];
    }
    const out: Candidate[] = [];
    for (const n of names.sort()) {
      const path = join(this.dir, n);
      const text = readControl(path);
      try {
        unlinkSync(path);
      } catch {
        /* gone */
      }
      let req: Request | null = null;
      try {
        const j = JSON.parse(text ?? "");
        const mint = asAddress(j?.mint);
        const sol = j?.sol === undefined ? undefined : Number(j.sol);
        if (mint && (sol === undefined || (Number.isFinite(sol) && sol > 0))) req = { mint, sol, file: n };
      } catch {
        req = null;
      }
      if (!req) {
        ctx.log.warn("buy_request_bad", { file: n });
        continue;
      }
      ctx.log.info("buy_request", { mint: req.mint, file: n, sol: req.sol ?? null });
      out.push({ mint: req.mint, chain: "solana", seenAtMs: ctx.now(), source: "file", reason: `file ${n}`, meta: req });
    }
    return out;
  }

  async decide(c: Candidate, ctx: TriggerContext, pending: PendingInfo): Promise<Verdict> {
    const req = c.meta as Request;
    const deadline = pending.firstSeenMs + this.cfg.maxWaitSec * 1000;
    if (ctx.now() > deadline) return { verdict: "skip", reason: `no readable curve in ${this.cfg.maxWaitSec}s` };
    const caps = ctx.caps(c.mint);
    if (caps.paused) return { verdict: "skip", reason: "PAUSE_BUYS" };
    let curve;
    try {
      const r = await this.rpc.call<any>("getAccountInfo", [candleCurve(c.mint), { encoding: "base64", commitment: "confirmed" }]);
      if (!r?.value) return { verdict: "wait", reason: "curve not readable yet" };
      curve = decodeCandleCurve(r.value);
    } catch {
      return { verdict: "wait", reason: "curve not readable yet" };
    }
    if (curve.baseMint !== c.mint) return { verdict: "skip", reason: "curve names another mint" };
    if (curve.quoteMint !== WSOL) return { verdict: "skip", reason: "curve is not SOL-quoted" };
    if (curve.migrated) return { verdict: "skip", reason: "already graduated" };
    if (curve.quoteReserve >= curve.migrationThreshold) return { verdict: "skip", reason: "curve full (migrating)" };
    const ticket = lamportsOf(req.sol ?? ctx.cfg.buy.sol);
    let impact;
    try {
      impact = buyImpact(curve, ticket);
    } catch (e) {
      return { verdict: "skip", reason: (e as Error).message };
    }
    if (impact.impactBps > this.cfg.maxImpactBps) return { verdict: "skip", reason: `impact ${impact.impactBps} bps > ${this.cfg.maxImpactBps}` };
    return {
      verdict: "buy",
      reason: `manual (${req.file}), impact ${impact.impactBps} bps`,
      lamports: ticket,
      deadlineAtMs: deadline,
      expectedOutRaw: impact.expectedOutRaw,
      context: { request: req.file, impactBps: impact.impactBps },
      log: { sol: Number(ticket) / 1e9, impactBps: impact.impactBps, file: req.file },
    };
  }
}
