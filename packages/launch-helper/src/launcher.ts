/**
 * One Candle launch with its dev buy, then the dev bag managed by the core's exits and controls.
 *
 * Route: Candle's atomic launch (`buildAtomicLaunch` -> check -> `submitAtomicLaunch`), payer main (the account's
 * embedded wallet, which Candle signs server-side), the dev buy as the bundle's one first buy: the launch and the buy
 * land in one Jito bundle, in one block, or not at all.
 *
 * The launch's identity is its `clientLaunchId`, written to the ledger (state `new`) before the first build and never
 * replaced, not even after a failure. Every state is saved before the call it leads to, so a restart finds it:
 *
 *   new -> build -> built -> (expected fill checked) -> submitting -> submit -> landed -> dev bag opened -> open
 *   built (from an earlier process, or older than BUILD_SUBMIT_MS), submitting, a timeout or an error after a request
 *   was sent -> unresolved: Candle's job is read (`getLaunchJob`) until it says confirmed (-> landed) or failed.
 *   A failed launch, or one refused before anything was sent, stays so: the bot never builds again on its own. The
 *   operator's RETRY_LAUNCH file asks for one more build under the SAME id (Candle starts a clean attempt under it).
 *
 * A dry run calls nothing: it logs the plan in full.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Engine as CoreEngine, lamportsOf } from "candle-bot-core/engine";
import type { Candidate, Trigger, TriggerContext } from "candle-bot-core/trigger";
import type { Alerter } from "candle-bot-core/alerts";
import type { Executor } from "candle-bot-core/exec/executor";
import { errorInfo } from "candle-bot-core/exec/executor";
import type { Logger } from "candle-bot-core/log";
import type { Rpc } from "candle-bot-core/solana/rpc";
import type { ExitStrategy } from "candle-bot-core/strategies/types";
import type { Config, LaunchSpec } from "./config.ts";
import type { LaunchRow, Ledger } from "./ledger.ts";

/** What the launcher needs from Candle's client (the SDK's CandleClient; a fake in tests). */
export interface LaunchClient {
  buildAtomicLaunch(req: any): Promise<{ clientLaunchId: string; bundleId: string; legs: Array<{ index: number; role: string; signer: string; expectedFill?: { amountOutRaw: string } }>; expiresAt: number }>;
  submitAtomicLaunch(req: { bundleId: string; signedTxsBase64: string[] }): Promise<{ status: "landed"; bundleId: string; mint: string; signatures: string[] } | { status: "failed"; bundleId: string; revertedSignature?: string } | { status: "timeout"; bundleId: string }>;
  getLaunchJob(clientLaunchId: string): Promise<{ status: string; mint?: string; devBuy?: { signature: string }; signature?: string }>;
}

/** All legs share one blockhash (about 60 s from the build): submit only this soon after it. */
export const BUILD_SUBMIT_MS = 45_000;
/** How often an unresolved launch's job is read. */
export const JOB_READ_MS = 30_000;
export const DECIMALS = 6;
export const RETRY_FILE = "RETRY_LAUNCH";

/** The launch body Candle gets (without the id): from the spec only. */
export function launchBody(spec: LaunchSpec): Record<string, unknown> {
  const socials = Object.fromEntries(Object.entries({ website: spec.website, twitter: spec.twitter, telegram: spec.telegram }).filter(([, v]) => v));
  return {
    chain: "solana",
    name: spec.name,
    symbol: spec.symbol,
    imageUrl: spec.imageUrl,
    ...(spec.description ? { description: spec.description } : {}),
    ...(Object.keys(socials).length ? { socials } : {}),
    mode: spec.mode,
    payer: { type: "main" },
    firstBuys: [{ payer: { type: "main" }, amountRaw: lamportsOf(spec.devBuySol).toString() }],
  };
}

export function specHash(spec: LaunchSpec): string {
  return createHash("sha256").update(JSON.stringify(launchBody(spec))).digest("hex");
}

export interface LauncherDeps {
  cfg: Config;
  ledger: Ledger;
  client: LaunchClient | null;
  log: Logger;
  alerter: Alerter;
  /** Opens the dev bag (the engine's openFromFill). */
  openFromFill: CoreEngine["openFromFill"];
  now?: () => number;
}

export class Launcher {
  private d: LauncherDeps;
  private now: () => number;
  private running: Promise<void> | null = null;
  /** Builds answered in this process (a `built` row from another process is never submitted). */
  private builtHere = new Set<string>();
  private jobReadAt = 0;
  private planLogged = false;
  private bagTries = 0;

  constructor(d: LauncherDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  /** Start one step if none is running (never two at once, however often it is called). Never throws. */
  kick(ctx: { dry: boolean; paused: boolean; stopping: boolean }): Promise<void> {
    if (!this.running) {
      this.running = this.step(ctx)
        .catch((e) => this.d.log.error("launch_step_failed", { error: String((e as Error)?.stack ?? e).slice(0, 2000) }))
        .finally(() => (this.running = null));
    }
    return this.running;
  }

  private paused(): boolean {
    return existsSync(join(this.d.cfg.stateDir, "PAUSE_BUYS"));
  }

  private stopping(): boolean {
    return existsSync(join(this.d.cfg.stateDir, "STOP"));
  }

  row(): LaunchRow | undefined {
    return this.d.ledger.launchRow();
  }

  private retryAsked(): boolean {
    const f = join(this.d.cfg.stateDir, RETRY_FILE);
    if (!existsSync(f)) return false;
    try {
      renameSync(f, f + ".done");
    } catch {
      return false;
    }
    return true;
  }

  async step(ctx: { dry: boolean; paused: boolean; stopping: boolean }): Promise<void> {
    const spec = this.d.cfg.launch;
    const hash = specHash(spec);
    let row = this.row();
    if (!row) {
      if (ctx.dry) {
        if (!this.planLogged) {
          this.planLogged = true;
          this.d.log.info("launch_plan", { dry: true, route: "atomic", body: launchBody(spec), devBuySol: spec.devBuySol, minDevBuyOutRaw: spec.minDevBuyOutRaw ?? null, note: "dry run: nothing is built or sent" });
        }
        return;
      }
      if (ctx.paused || ctx.stopping) return;
      // The id is saved before anything is sent: a restart finds it and never makes another.
      row = this.d.ledger.createLaunch({ clientLaunchId: `clh-${randomUUID()}`, specHash: hash, specJson: JSON.stringify(launchBody(spec)), now: this.now() });
      this.d.log.info("launch_id_saved", { clientLaunchId: row.client_launch_id });
    }
    if (row.spec_hash !== hash) {
      this.d.alerter.raise("launch:other_spec", `the state dir holds launch ${row.client_launch_id} (another spec); this config's launch is not sent. Use a new stateDir for a new launch.`);
      return;
    }
    if (ctx.dry) return;
    switch (row.state) {
      case "new": {
        if (ctx.paused || ctx.stopping) return;
        await this.build(row);
        const after = this.row()!;
        // Straight on to the submit while the bundle's blockhash is fresh, unless PAUSE_BUYS or STOP arrived meanwhile.
        if (after.state === "built") return this.step({ ...ctx, paused: ctx.paused || this.paused(), stopping: ctx.stopping || this.stopping() });
        return;
      }
      case "built":
        if (!this.builtHere.has(row.client_launch_id) || this.now() - (row.built_at ?? 0) > BUILD_SUBMIT_MS) {
          this.unresolved(row, "built, not submitted by this process in time");
          return;
        }
        if (ctx.paused || ctx.stopping) {
          // PAUSE_BUYS or STOP between build and submit: nothing is sent.
          this.unresolved(row, ctx.paused ? "PAUSE_BUYS before submit" : "STOP before submit");
          return;
        }
        return this.submit(row);
      case "submitting":
        this.unresolved(row, "submit was in flight when the process stopped");
        return;
      case "unresolved":
        return this.reconcile(row);
      case "landed":
        return this.openBag(row);
      case "failed":
      case "refused":
        if (this.retryAsked()) {
          this.d.log.info("launch_retry", { clientLaunchId: row.client_launch_id, from: row.state });
          this.d.ledger.updateLaunch(row.id, { state: "new", error: null, updated_at: this.now() });
          return this.step(ctx);
        } else this.d.alerter.raise(`launch:${row.state}`, `launch ${row.client_launch_id} ${row.state}${row.error ? ` (${row.error})` : ""}; nothing more is sent. Create ${RETRY_FILE} in the state dir to build once more under the same id.`);
        return;
      case "open":
        return;
    }
  }

  private unresolved(row: LaunchRow, why: string): void {
    this.d.ledger.updateLaunch(row.id, { state: "unresolved", error: why, updated_at: this.now() });
    this.d.log.warn("launch_unresolved", { clientLaunchId: row.client_launch_id, bundleId: row.bundle_id, why });
    this.jobReadAt = 0;
  }

  private async build(row: LaunchRow): Promise<void> {
    const client = this.d.client;
    if (!client) return;
    this.d.ledger.updateLaunch(row.id, { attempts: row.attempts + 1, updated_at: this.now() });
    let b;
    try {
      b = await client.buildAtomicLaunch({ ...JSON.parse(row.spec_json), clientLaunchId: row.client_launch_id });
    } catch (e) {
      const i = errorInfo(e);
      // Candle's own non-retryable 4xx with nothing staged: refused, nothing built. Anything else may have begun.
      // Only on the first build of this id: after a retry an earlier attempt may have been sent (and landed), and a
      // 409 may be Candle still resolving one. Those read the job instead.
      if (row.attempts === 0 && i.candle && !i.retryable && (i.status ?? 0) >= 400 && (i.status ?? 0) < 500 && i.status !== 409 && !i.stage && i.code !== "IDEMPOTENCY_CONFLICT") {
        this.d.ledger.updateLaunch(row.id, { state: "refused", error: `build refused: ${i.code}`, updated_at: this.now() });
        this.d.log.warn("launch_refused", { clientLaunchId: row.client_launch_id, code: i.code, status: i.status });
        return;
      }
      this.unresolved(row, `build error ${i.code}`);
      return;
    }
    const buy = b.legs.find((l) => l.role === "buy");
    this.d.ledger.updateLaunch(row.id, { state: "built", bundle_id: b.bundleId, built_at: this.now(), legs_json: JSON.stringify(b.legs.map(({ index, role, signer, expectedFill }) => ({ index, role, signer, expectedFill }))), expected_out_raw: buy?.expectedFill?.amountOutRaw ?? null, updated_at: this.now() });
    this.builtHere.add(row.client_launch_id);
    this.d.log.info("launch_built", { clientLaunchId: row.client_launch_id, bundleId: b.bundleId, legs: b.legs.length, devBuyExpectedOutRaw: buy?.expectedFill?.amountOutRaw ?? null });
  }

  private async submit(row: LaunchRow): Promise<void> {
    const client = this.d.client;
    if (!client) return;
    const legs = JSON.parse(row.legs_json ?? "[]") as Array<{ index: number; role: string; signer: string; expectedFill?: { amountOutRaw: string } }>;
    const spec = this.d.cfg.launch;
    // The buy leg's own minAmountOut is 0 inside the bundle: Candle's expected fill is the check, before anything is sent.
    const buys = legs.filter((l) => l.role === "buy");
    const out = buys.length === 1 && buys[0].expectedFill && /^\d+$/.test(buys[0].expectedFill.amountOutRaw) ? BigInt(buys[0].expectedFill.amountOutRaw) : null;
    const why =
      legs.some((l) => l.signer !== "server") ? "a leg needs a client signature (only main-payer legs are expected)" :
      out === null ? "no expected fill for the dev buy" :
      out <= 0n ? "expected fill is zero" :
      spec.minDevBuyOutRaw !== undefined && out < spec.minDevBuyOutRaw ? `expected fill ${out} < minDevBuyOutRaw ${spec.minDevBuyOutRaw}` : null;
    if (why) {
      this.d.ledger.updateLaunch(row.id, { state: "refused", error: why, updated_at: this.now() });
      this.d.log.warn("launch_not_submitted", { clientLaunchId: row.client_launch_id, why });
      return;
    }
    this.d.ledger.updateLaunch(row.id, { state: "submitting", updated_at: this.now() });
    let r;
    try {
      r = await client.submitAtomicLaunch({ bundleId: row.bundle_id!, signedTxsBase64: [] });
    } catch (e) {
      this.unresolved(row, `submit error ${errorInfo(e).code}`);
      return;
    }
    if (r.status === "landed") {
      const buyLeg = legs.find((l) => l.role === "buy");
      const sig = buyLeg ? r.signatures[buyLeg.index] ?? null : null;
      this.d.ledger.updateLaunch(row.id, { state: "landed", mint: r.mint, signatures_json: JSON.stringify(r.signatures), dev_buy_signature: sig, error: null, updated_at: this.now() });
      this.d.log.info("launch_landed", { clientLaunchId: row.client_launch_id, mint: r.mint, signatures: r.signatures, devBuySignature: sig });
      return this.openBag(this.row()!);
    }
    if (r.status === "failed") {
      this.d.ledger.updateLaunch(row.id, { state: "failed", error: `bundle failed${(r as any).revertedSignature ? ` (${(r as any).revertedSignature})` : ""}`, updated_at: this.now() });
      this.d.log.warn("launch_failed", { clientLaunchId: row.client_launch_id, bundleId: row.bundle_id });
      return;
    }
    // A timeout may still land (retryable or not): never a new id; read the job.
    this.unresolved(row, "submit timeout");
  }

  private async reconcile(row: LaunchRow): Promise<void> {
    const client = this.d.client;
    if (!client) return;
    // The operator may ask for a build under the SAME id while unresolved: Candle resolves the first attempt before
    // anything new (it answers 409 while that is open, which comes back here).
    if (this.retryAsked()) {
      this.d.log.info("launch_retry", { clientLaunchId: row.client_launch_id, from: "unresolved" });
      this.d.ledger.updateLaunch(row.id, { state: "new", error: null, updated_at: this.now() });
      return this.build(this.row()!).then(() => undefined);
    }
    if (this.now() - this.jobReadAt < JOB_READ_MS) return;
    this.jobReadAt = this.now();
    if (this.now() - row.updated_at > this.d.cfg.launch.unresolvedAlertMin * 60_000)
      this.d.alerter.raise("launch:unresolved", `launch ${row.client_launch_id} (bundle ${row.bundle_id ?? "none"}) unresolved since ${new Date(row.updated_at).toISOString()} (${row.error ?? ""}); no new launch is sent. Report the clientLaunchId to whoever operates the key.`);
    let job;
    try {
      job = await client.getLaunchJob(row.client_launch_id);
    } catch (e) {
      const i = errorInfo(e);
      if (i.code === "JOB_NOT_FOUND") {
        // The build never began on Candle's side. Rebuilding under the same id is safe, but this bot never builds on its
        // own after an error: it waits for RETRY_LAUNCH (read at the top of the next reconcile).
        this.d.log.info("launch_job_not_found", { clientLaunchId: row.client_launch_id });
        return;
      }
      this.d.log.warn("launch_job_read_failed", { clientLaunchId: row.client_launch_id, code: i.code });
      return;
    }
    if (job.status === "confirmed" && job.mint) {
      this.d.ledger.updateLaunch(row.id, { state: "landed", mint: job.mint, dev_buy_signature: job.devBuy?.signature ?? null, error: null, updated_at: this.now() });
      this.d.log.info("launch_landed", { clientLaunchId: row.client_launch_id, mint: job.mint, from: "job", devBuySignature: job.devBuy?.signature ?? null });
      return this.openBag(this.row()!);
    }
    if (job.status === "failed") {
      this.d.ledger.updateLaunch(row.id, { state: "failed", error: "job failed", updated_at: this.now() });
      this.d.log.warn("launch_failed", { clientLaunchId: row.client_launch_id, from: "job" });
      return;
    }
    this.d.log.info("launch_waiting", { clientLaunchId: row.client_launch_id, job: job.status });
  }

  private async openBag(row: LaunchRow): Promise<void> {
    if (!row.mint) return;
    let sig = row.dev_buy_signature;
    if (!sig && this.d.client) {
      try {
        sig = (await this.d.client.getLaunchJob(row.client_launch_id)).devBuy?.signature ?? null;
      } catch {
        sig = null;
      }
      if (sig) this.d.ledger.updateLaunch(row.id, { dev_buy_signature: sig, updated_at: this.now() });
    }
    if (!sig) {
      this.d.alerter.raise("launch:dev_buy_unknown", `launch ${row.client_launch_id} landed (${row.mint}) but its dev-buy transaction is not known yet; the bag is not managed until it is`);
      return;
    }
    const r = await this.d.openFromFill({ mint: row.mint, signature: sig, decimals: DECIMALS, reason: "dev buy", entry: { launch: row.client_launch_id, mint: row.mint, from: "dev buy" }, expectedQtyRaw: row.expected_out_raw && /^\d+$/.test(row.expected_out_raw) ? BigInt(row.expected_out_raw) : null });
    if (r.ok) {
      this.d.ledger.updateLaunch(row.id, { state: "open", position_id: r.positionId, updated_at: this.now() });
      this.d.log.info("dev_bag_open", { clientLaunchId: row.client_launch_id, mint: row.mint, position: r.positionId, qtyRaw: r.qtyRaw, costLamports: r.costLamports });
      return;
    }
    if (r.reason === "no_tokens" && this.d.client) {
      // The stored signature gave the wallet no tokens (maybe the launch leg): take the job's dev-buy signature.
      try {
        const js = (await this.d.client.getLaunchJob(row.client_launch_id)).devBuy?.signature ?? null;
        if (js && js !== sig) {
          this.d.ledger.updateLaunch(row.id, { dev_buy_signature: js, updated_at: this.now() });
          this.d.log.warn("dev_buy_signature_replaced", { clientLaunchId: row.client_launch_id, was: sig, now: js });
          return;
        }
      } catch {
        /* the next cycle reads again */
      }
    }
    this.bagTries++;
    if (this.bagTries % 10 === 0 || r.reason !== "tx_not_found") this.d.alerter.raise("launch:dev_bag", `launch ${row.client_launch_id}: the dev buy ${sig} could not be booked (${r.reason}); read again next cycle`);
  }
}

export interface EngineDeps {
  cfg: Config;
  ledger: Ledger;
  client: LaunchClient | null;
  executor: Executor;
  strategy: ExitStrategy;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  now?: () => number;
}

/** No candidates: each poll moves the launch one step (in the background, one step at a time). */
export class LaunchTrigger implements Trigger {
  readonly name = "launch-helper";
  readonly candidateLabel = "launches";
  readonly buyIdPrefix = "clh";
  readonly sellIdPrefix = "chs";
  launcher!: Launcher;

  poll(ctx: TriggerContext): Candidate[] {
    void this.launcher.kick({ dry: ctx.dry, paused: ctx.caps("So11111111111111111111111111111111111111112").paused, stopping: ctx.shouldStop() });
    return [];
  }

  decide() {
    return { verdict: "skip" as const, reason: "the launch helper buys only its own dev buy" };
  }

  status(): Record<string, unknown> {
    const r = this.launcher.row();
    return { launch: r ? { clientLaunchId: r.client_launch_id, state: r.state, attempts: r.attempts, bundleId: r.bundle_id, mint: r.mint, devBuySignature: r.dev_buy_signature, position: r.position_id, error: r.error } : { state: "not sent" } };
  }
}

/** The launch helper's engine: the core engine with the launch trigger. */
export class Engine extends CoreEngine {
  readonly launcher: Launcher;
  constructor(d: EngineDeps) {
    const trigger = new LaunchTrigger();
    super({ cfg: d.cfg, ledger: d.ledger, trigger, executor: d.executor, strategy: d.strategy, rpc: d.rpc, log: d.log, alerter: d.alerter, now: d.now });
    this.launcher = new Launcher({ cfg: d.cfg, ledger: d.ledger, client: d.client, log: d.log, alerter: d.alerter, openFromFill: (p) => this.openFromFill(p), now: d.now });
    trigger.launcher = this.launcher;
  }
}
