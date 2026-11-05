/**
 * One Candle launch with its dev buy, then the dev bag managed by the core's exits and controls.
 *
 * Route: Candle's atomic launch (`buildAtomicLaunch` -> check -> `submitAtomicLaunch`), payer main (the account's
 * embedded wallet, which Candle signs server-side), the dev buy as the bundle's one first buy: the launch and the buy
 * land in one Jito bundle, in one block, or not at all.
 *
 * Before the first build (live), nothing is sent unless every pre-flight check passes:
 *  - `launch.minDevBuyOutRaw` is set (the submit is refused below it; `plan` previews the fill to set it from)
 *  - the dev buy fits the core caps (`buy.lifetimeSol`, `buy.maxOpen`)
 *  - `wallet` is the key's embedded (main) wallet, the one the dev bag lands in (Candle's portfolio read)
 *  - the account has not launched a token with the same name and symbol (Candle's list of the account's launched
 *    tokens), unless `launch.newLaunch` is true. One launch per spec, whichever state dir it runs from.
 *
 * The launch's identity is its `clientLaunchId`, written to the ledger (state `new`) before the first build and never
 * replaced. Every state is saved before the call it leads to, so a restart finds it:
 *
 *   new -> building -> build -> built -> (expected fill checked) -> submitting -> submit -> landed -> dev bag -> open
 *   building, built (from an earlier process, or older than BUILD_SUBMIT_MS), submitting, a timeout or an error after
 *   a request was sent -> unresolved: Candle's job is read (`getLaunchJob`) until it says confirmed (-> landed) or
 *   failed. A restart never builds.
 *
 * The bot never builds again on its own. The operator's RETRY_LAUNCH file asks for one build under the SAME id; it
 * acts only when a job read just now says `failed` or `JOB_NOT_FOUND` (the SDK's launchAtomic() recovery steps 3 and
 * 4) and neither PAUSE_BUYS nor STOP is set. Any other answer is logged and alerted with why, and the file is used up.
 * A new clientLaunchId is never sent while a launch may land.
 *
 * The dev bag is booked from the chain (core openFromFill). When Candle's answer names no dev-buy transaction, or one
 * that gave the wallet no tokens, the wallet's token-account history for the mint is read and checked transaction by
 * transaction; `adopt <signature>` books it by hand.
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
  /** The account's wallets (GET /api/v1/agent/portfolio): `embedded` is the main wallet. */
  getPortfolio(): Promise<{ embedded: Array<{ address: string }> }>;
  /** The tokens the account's own wallets launched (GET /api/v1/agent/fees), paged. */
  fees: { list(opts?: { cursor?: string; limit?: number }): Promise<{ page: Array<{ mint: string; name?: string | null; symbol?: string | null }>; isDone: boolean; continueCursor: string | null }> };
  /** Records, reserves and sends nothing (the `plan` preview). */
  dryRunAtomicLaunch?(req: any): Promise<{ fills: Array<{ index: number; amountRaw: string; feeRaw: string; expectedFill: { amountOutRaw: string; minAmountOutRaw: string } }>; graduatesInBundle?: boolean }>;
}

/** All legs share one blockhash (about 60 s from the build): submit only this soon after it. */
export const BUILD_SUBMIT_MS = 45_000;
/** How often an unresolved launch's job is read (and a failed pre-flight read is tried again). */
export const JOB_READ_MS = 30_000;
export const RETRY_FILE = "RETRY_LAUNCH";
/** Pages of the account's launched tokens read for the same-spec check (50 a page). More than that: refused. */
export const LAUNCH_LIST_PAGES = 20;
/** Signatures of the wallet's token account read when looking for the dev buy on chain. */
export const DEV_BUY_PAGE = 1000;
/** Pages of that history read at most (the dev buy is its oldest transaction); more: not found, alerted. */
export const DEV_BUY_PAGES = 10;
/** openFromFill refusals that may pass on a later read: the scan stops there and tries again later. */
const TRANSIENT = /^(tx_not_found|tx_read_failed|tx_unreadable|mint_busy|book_failed)/;

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

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export interface LauncherDeps {
  cfg: Config;
  ledger: Ledger;
  client: LaunchClient | null;
  rpc: Rpc;
  log: Logger;
  alerter: Alerter;
  /** Opens the dev bag (the engine's openFromFill). */
  openFromFill: CoreEngine["openFromFill"];
  /** A stop asked by signal (the engine's), read again right before a build. */
  shouldStop?: () => boolean;
  now?: () => number;
}

type Preflight = "go" | "refused" | "wait";

type StepCtx = { dry: boolean; paused: boolean; stopping: boolean };

export class Launcher {
  private d: LauncherDeps;
  private now: () => number;
  private running: Promise<void> | null = null;
  private closed = false;
  /** Builds answered in this process (a `built` row from another process is never submitted). */
  private builtHere = new Set<string>();
  private jobReadAt = 0;
  private preflightAt = 0;
  private scanAt = 0;
  private planLogged = false;
  private bagTries = 0;

  constructor(d: LauncherDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  /** Start one step if none is running (never two at once, however often it is called). Never throws. */
  kick(ctx: StepCtx): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.running) {
      this.running = this.step(ctx)
        .catch((e) => this.d.log.error("launch_step_failed", { error: String((e as Error)?.stack ?? e).slice(0, 2000) }))
        .finally(() => (this.running = null));
    }
    return this.running;
  }

  /** No new step starts; resolves when the running one (a build or a submit can take minutes) has ended. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.running) {
      this.d.log.info("launch_step_wait", { note: "waiting for the launch call in flight before closing" });
      await this.running;
    }
  }

  private file(name: string): string {
    return join(this.d.cfg.stateDir, name);
  }

  private paused(): boolean {
    return existsSync(this.file("PAUSE_BUYS"));
  }

  private stopping(): boolean {
    return existsSync(this.file("STOP")) || !!this.d.shouldStop?.();
  }

  row(): LaunchRow | undefined {
    return this.d.ledger.launchRow();
  }

  private useRetryFile(as: "done" | "ignored"): void {
    try {
      renameSync(this.file(RETRY_FILE), this.file(`${RETRY_FILE}.${as}`));
    } catch {
      /* gone already */
    }
  }

  async step(ctx: StepCtx): Promise<void> {
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
      if ((await this.preflight(true)) !== "go") return;
      // The id is saved before anything is sent: a restart finds it and never makes another.
      row = this.d.ledger.createLaunch({ clientLaunchId: `clh-${randomUUID()}`, specHash: hash, specJson: JSON.stringify(launchBody(spec)), now: this.now() });
      this.d.log.info("launch_id_saved", { clientLaunchId: row.client_launch_id });
      if (ctx.paused || this.paused() || ctx.stopping || this.stopping()) return;
      return this.buildThenSubmit(row, ctx);
    }
    if (row.spec_hash !== hash) {
      this.d.alerter.raise("launch:other_spec", `the state dir holds launch ${row.client_launch_id} (another spec); this config's launch is not sent. Use a new stateDir for a new launch.`);
      return;
    }
    if (ctx.dry) return;
    switch (row.state) {
      case "new": {
        // An id saved after a build was asked for, never built: a build may have been sent. Read the job.
        if (row.attempts > 0) {
          this.unresolved(row, "state new after a build attempt");
          return;
        }
        // An id saved, never built (the process stopped in between): the pre-flight again, then the build.
        if (ctx.paused || ctx.stopping) return;
        if ((await this.preflight(true)) !== "go") return;
        return this.buildThenSubmit(row, ctx);
      }
      case "building":
        this.unresolved(row, "a build was in flight when the process stopped");
        return;
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
        if (existsSync(this.file(RETRY_FILE))) return this.retry(row, ctx);
        return this.reconcile(row);
      case "landed":
        return this.openBag(row);
      case "failed":
      case "refused":
        if (existsSync(this.file(RETRY_FILE))) return this.retry(row, ctx);
        this.d.alerter.raise(`launch:${row.state}`, `launch ${row.client_launch_id} ${row.state}${row.error ? ` (${row.error})` : ""}; nothing more is sent. Create ${RETRY_FILE} in the state dir to build once more under the same id (it acts only if Candle's job says failed or not found).`);
        return;
      case "open":
        return;
    }
  }

  private async buildThenSubmit(row: LaunchRow, ctx: StepCtx): Promise<void> {
    // Read again right before the build: a STOP, a signal or PAUSE_BUYS may have come during the pre-flight reads.
    if (this.paused() || this.stopping()) {
      this.d.log.info("launch_build_held", { clientLaunchId: row.client_launch_id, why: this.paused() ? "PAUSE_BUYS" : "STOP" });
      return;
    }
    await this.build(row);
    const after = this.row()!;
    // Straight on to the submit while the bundle's blockhash is fresh, unless PAUSE_BUYS or STOP arrived meanwhile.
    if (after.state === "built") return this.step({ ...ctx, paused: ctx.paused || this.paused(), stopping: ctx.stopping || this.stopping() });
  }

  /**
   * The checks before the first build. True: go. False: nothing is sent now (alerted with why; a check that could
   * not be read is tried again after JOB_READ_MS).
   */
  private async preflight(sameSpec: boolean): Promise<Preflight> {
    const cfg = this.d.cfg;
    const spec = cfg.launch;
    const refuse = (key: string, why: string): Preflight => {
      this.preflightAt = 0;
      this.d.log.warn("launch_preflight_refused", { check: key, why });
      this.d.alerter.raise(`launch:preflight:${key}`, `launch not sent: ${why}`);
      return "refused";
    };
    if (spec.minDevBuyOutRaw === undefined) return refuse("floor", "launch.minDevBuyOutRaw is required in live mode (the dev buy's on-chain minimum is 0 inside the bundle; run `plan` for Candle's preview fill)");
    const ticket = lamportsOf(spec.devBuySol);
    const spent = this.d.ledger.lifetimeBuyLamports(false);
    if (spent + ticket > lamportsOf(cfg.buy.lifetimeSol)) return refuse("caps", `the dev buy (${spec.devBuySol} SOL) would take live buys past buy.lifetimeSol (${cfg.buy.lifetimeSol} SOL; ${Number(spent) / 1e9} SOL used)`);
    const open = this.d.ledger.positionsByStatus("opening", "open", "exit_stuck").filter((p) => !p.dry).length;
    if (open >= cfg.buy.maxOpen) return refuse("caps", `${open} live positions open, buy.maxOpen is ${cfg.buy.maxOpen}`);
    const client = this.d.client;
    if (!client) return "wait";
    if (this.now() - this.preflightAt < JOB_READ_MS && this.preflightAt !== 0) return "wait";
    this.preflightAt = this.now();
    let embedded: string[];
    try {
      embedded = ((await client.getPortfolio()).embedded ?? []).map((w) => w.address);
    } catch (e) {
      this.d.log.warn("launch_preflight_read_failed", { check: "wallet", code: errorInfo(e).code });
      return "wait";
    }
    if (!embedded.includes(cfg.wallet)) return refuse("wallet", `config wallet ${cfg.wallet} is not the key's embedded (main) wallet (${embedded.join(", ") || "none listed"}): the dev bag would land where this bot does not look`);
    if (sameSpec && !spec.newLaunch) {
      let cursor: string | undefined;
      let done = false;
      for (let i = 0; i < LAUNCH_LIST_PAGES && !done; i++) {
        let page;
        try {
          page = await client.fees.list({ limit: 50, ...(cursor ? { cursor } : {}) });
        } catch (e) {
          this.d.log.warn("launch_preflight_read_failed", { check: "launched", code: errorInfo(e).code });
          return "wait";
        }
        // A row without a name or symbol cannot be judged: refused rather than passed (fail closed).
        const blank = page.page.find((t) => !norm(t.name) || !norm(t.symbol));
        if (blank) return refuse("launched", `the account's launched token ${blank.mint} is listed without a name or symbol, so the same-spec check cannot judge it; set launch.newLaunch: true if ${spec.name} (${spec.symbol}) is known not to be launched`);
        const same = page.page.find((t) => norm(t.name) === norm(spec.name) && norm(t.symbol) === norm(spec.symbol));
        if (same) return refuse("launched", `the account already launched ${spec.name} (${spec.symbol}) as ${same.mint}; set launch.newLaunch: true to launch the same name and symbol again`);
        if (!page.isDone && !page.continueCursor) return refuse("launched", "Candle's list of the account's launched tokens says it is not done but gives no next page; the same-spec check could not finish");
        done = page.isDone;
        cursor = page.continueCursor ?? undefined;
      }
      if (!done) return refuse("launched", `the account's launched tokens run past ${LAUNCH_LIST_PAGES} pages; the same-spec check could not finish (set launch.newLaunch: true to skip it)`);
    }
    this.preflightAt = 0;
    return "go";
  }

  /** RETRY_LAUNCH: one build under the same id, only after a job read says failed or JOB_NOT_FOUND. */
  private async retry(row: LaunchRow, ctx: StepCtx): Promise<void> {
    const ignore = (why: string) => {
      this.useRetryFile("ignored");
      this.d.log.warn("launch_retry_ignored", { clientLaunchId: row.client_launch_id, state: row.state, why });
      this.d.alerter.raise("launch:retry_ignored", `${RETRY_FILE} ignored for launch ${row.client_launch_id} (${row.state}): ${why}`);
    };
    if (ctx.paused || this.paused()) return ignore("PAUSE_BUYS is set");
    if (ctx.stopping || this.stopping()) return ignore("STOP is set");
    const client = this.d.client;
    if (!client) return;
    let verdict: "failed" | "not_found";
    try {
      const job = await client.getLaunchJob(row.client_launch_id);
      if (job.status === "confirmed") {
        ignore("the job is confirmed: the launch landed");
        return this.confirmed(row, job);
      }
      if (job.status !== "failed") return ignore(`the job is ${job.status}: the launch may still land (read it again later)`);
      verdict = "failed";
    } catch (e) {
      const i = errorInfo(e);
      // A read that did not answer leaves the file in place: the next step reads again.
      if (i.code !== "JOB_NOT_FOUND") {
        this.d.log.warn("launch_job_read_failed", { clientLaunchId: row.client_launch_id, code: i.code, for: "retry" });
        return;
      }
      verdict = "not_found";
    }
    // Pre-flight again (the floor, the caps, the wallet); the same-spec check would find nothing new for this id.
    const pf = await this.preflight(false);
    if (pf === "wait") return;   // a read did not answer (or too soon): the file stays, the next step tries again
    if (pf === "refused") return ignore("a pre-flight check refused (see the alert)");
    // Read again after the awaits above, before the state changes.
    if (this.paused()) return ignore("PAUSE_BUYS is set");
    if (this.stopping()) return;   // a stop: the file stays for the next run
    this.useRetryFile("done");
    this.d.log.info("launch_retry", { clientLaunchId: row.client_launch_id, from: row.state, job: verdict });
    this.d.ledger.updateLaunch(row.id, { state: "new", error: null, updated_at: this.now() });
    return this.buildThenSubmit(this.row()!, ctx);
  }

  private unresolved(row: LaunchRow, why: string): void {
    this.d.ledger.updateLaunch(row.id, { state: "unresolved", error: why, updated_at: this.now() });
    this.d.log.warn("launch_unresolved", { clientLaunchId: row.client_launch_id, bundleId: row.bundle_id, why });
    this.jobReadAt = 0;
  }

  private async build(row: LaunchRow): Promise<void> {
    const client = this.d.client;
    if (!client) return;
    // Saved before the call: a restart in `building` reads the job and never builds on its own.
    this.d.ledger.updateLaunch(row.id, { state: "building", attempts: row.attempts + 1, updated_at: this.now() });
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
      spec.minDevBuyOutRaw === undefined ? "launch.minDevBuyOutRaw is not set" :
      out < spec.minDevBuyOutRaw ? `expected fill ${out} < minDevBuyOutRaw ${spec.minDevBuyOutRaw}` : null;
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

  private confirmed(row: LaunchRow, job: { mint?: string; devBuy?: { signature: string } }): Promise<void> | void {
    if (!job.mint) {
      this.d.log.warn("launch_confirmed_no_mint", { clientLaunchId: row.client_launch_id });
      this.d.alerter.raise("launch:no_mint", `launch ${row.client_launch_id}: Candle's job says confirmed but names no mint; the bag is not managed until it does (or adopt it by signature)`);
      return;
    }
    this.d.ledger.updateLaunch(row.id, { state: "landed", mint: job.mint, dev_buy_signature: job.devBuy?.signature ?? null, error: null, updated_at: this.now() });
    this.d.log.info("launch_landed", { clientLaunchId: row.client_launch_id, mint: job.mint, from: "job", devBuySignature: job.devBuy?.signature ?? null });
    return this.openBag(this.row()!);
  }

  private async reconcile(row: LaunchRow): Promise<void> {
    const client = this.d.client;
    if (!client) return;
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
        // The build never began on Candle's side. A same-id build is safe, but only on the operator's RETRY_LAUNCH.
        this.d.log.info("launch_job_not_found", { clientLaunchId: row.client_launch_id, note: `create ${RETRY_FILE} to build once under the same id` });
        return;
      }
      this.d.log.warn("launch_job_read_failed", { clientLaunchId: row.client_launch_id, code: i.code });
      return;
    }
    if (job.status === "confirmed") return this.confirmed(row, job);
    if (job.status === "failed") {
      this.d.ledger.updateLaunch(row.id, { state: "failed", error: "job failed", updated_at: this.now() });
      this.d.log.warn("launch_failed", { clientLaunchId: row.client_launch_id, from: "job" });
      return;
    }
    this.d.log.info("launch_waiting", { clientLaunchId: row.client_launch_id, job: job.status });
  }

  /** Mark the launch's bag open (a booking by openFromFill, here or by `adopt`). */
  private bagOpen(row: LaunchRow, r: { positionId: number; qtyRaw: bigint; costLamports: bigint }, sig: string, from: string): void {
    this.d.ledger.updateLaunch(row.id, { state: "open", position_id: r.positionId, dev_buy_signature: sig, updated_at: this.now() });
    this.d.log.info("dev_bag_open", { clientLaunchId: row.client_launch_id, mint: row.mint, position: r.positionId, qtyRaw: r.qtyRaw, costLamports: r.costLamports, signature: sig, from });
  }

  private book(row: LaunchRow, mint: string, sig: string) {
    return this.d.openFromFill({ mint, signature: sig, reason: "dev buy", entry: { launch: row.client_launch_id, mint, from: "dev buy" }, expectedQtyRaw: row.expected_out_raw && /^\d+$/.test(row.expected_out_raw) ? BigInt(row.expected_out_raw) : null });
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
    let reason = "no dev-buy signature from Candle";
    if (sig) {
      const r = await this.book(row, row.mint, sig);
      if (r.ok) return this.bagOpen(row, r, sig, "candle");
      reason = r.reason;
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
          /* the chain scan below */
        }
      }
      if (r.reason === "tx_not_found" || r.reason.startsWith("tx_read_failed") || r.reason === "mint_busy") {
        // Not readable yet: read again next cycle; alert now and then.
        this.bagTries++;
        if (this.bagTries % 10 === 0) this.d.alerter.raise("launch:dev_bag", `launch ${row.client_launch_id}: the dev buy ${sig} could not be booked yet (${r.reason}); reading again`);
        return;
      }
    }
    // No usable signature from Candle: find the dev buy in the wallet's history for the mint.
    if (await this.scanForDevBuy(row, row.mint)) return;
    this.d.alerter.raise("launch:dev_bag", `launch ${row.client_launch_id} landed (${row.mint}) but its dev buy is not booked (${reason}${sig ? `, signature ${sig}` : ""}); the chain scan found none yet. Book it by hand: candle-launch-helper adopt <signature>`);
  }

  /**
   * Find the dev buy in the wallet's token-account history for the mint: the whole history (paged), walked oldest
   * first. Transactions that gave the wallet none of this coin are passed over. The first one that did is the dev buy
   * (the launch's own bundle bought first, and opened the account): it is booked if openFromFill accepts it. Anything
   * else ends the scan without a booking: a refusal that may pass later (unreadable yet, coin busy) is tried again
   * next time; a definite one (no SOL spent, already booked) is alerted for `adopt`. A later buy is never taken.
   */
  private async scanForDevBuy(row: LaunchRow, mint: string): Promise<boolean> {
    if (this.scanAt !== 0 && this.now() - this.scanAt < JOB_READ_MS) return false;
    this.scanAt = this.now();
    const fail = (step: string, e: unknown) => {
      this.d.log.warn("dev_buy_scan_failed", { clientLaunchId: row.client_launch_id, step, error: String((e as Error)?.message ?? e).slice(0, 200) });
      return false;
    };
    let accts: string[];
    try {
      const r = await this.d.rpc.call<any>("getTokenAccountsByOwner", [this.d.cfg.wallet, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      accts = (r?.value ?? []).map((a: any) => a?.pubkey).filter((k: unknown) => typeof k === "string");
    } catch (e) {
      return fail("token accounts", e);
    }
    if (accts.length !== 1) {
      this.d.log.warn("dev_buy_scan_skipped", { clientLaunchId: row.client_launch_id, tokenAccounts: accts.length, note: "one token account expected" });
      return false;
    }
    const all: Array<{ signature: string; err: unknown }> = [];
    let before: string | undefined;
    let complete = false;
    for (let i = 0; i < DEV_BUY_PAGES; i++) {
      let page: Array<{ signature: string; err: unknown }>;
      try {
        page = (await this.d.rpc.call<any>("getSignaturesForAddress", [accts[0], { limit: DEV_BUY_PAGE, commitment: "confirmed", ...(before ? { before } : {}) }])) ?? [];
      } catch (e) {
        return fail("history", e);
      }
      all.push(...page);
      if (page.length < DEV_BUY_PAGE) {
        complete = true;
        break;
      }
      before = page[page.length - 1].signature;
    }
    if (!complete) {
      this.d.log.warn("dev_buy_scan_skipped", { clientLaunchId: row.client_launch_id, note: `history longer than ${DEV_BUY_PAGES * DEV_BUY_PAGE} signatures` });
      return false;
    }
    for (const s of all.reverse()) {
      if (s.err) continue;
      const r = await this.book(row, mint, s.signature);
      if (r.ok) {
        this.d.log.warn("dev_buy_found_on_chain", { clientLaunchId: row.client_launch_id, signature: s.signature });
        this.bagOpen(row, r, s.signature, "chain scan");
        return true;
      }
      if (r.reason === "no_tokens") continue;
      this.d.log.warn("dev_buy_scan_stopped", { clientLaunchId: row.client_launch_id, signature: s.signature, reason: r.reason, transient: TRANSIENT.test(r.reason) });
      return false;
    }
    return false;
  }

  /**
   * The operator's `adopt <signature>`: book the dev bag from that transaction (openFromFill checks it: this wallet,
   * this mint, SOL spent, tokens received, not booked already). The launch row, if any, is marked open.
   */
  async adopt(signature: string, mintArg?: string, force = false): Promise<string> {
    const row = this.row();
    if (row?.state === "open" && !force) return `the launch's bag is already open (position ${row.position_id}, from ${row.dev_buy_signature}); a second booking would count twice. --force books it anyway`;
    const mint = mintArg ?? row?.mint ?? null;
    if (!mint) return "no mint: the launch row names none; pass --mint <mint>";
    if (row?.mint && mintArg && row.mint !== mintArg) return `the launch row's mint is ${row.mint}, not ${mintArg}`;
    const r = row ? await this.book(row, mint, signature) : await this.d.openFromFill({ mint, signature, reason: "dev buy (adopted)", entry: { mint, from: "adopt" } });
    if (!r.ok) return `not booked: ${r.reason}`;
    if (row && row.state !== "open") {
      if (!row.mint) this.d.ledger.updateLaunch(row.id, { mint, updated_at: this.now() });
      this.bagOpen({ ...row, mint }, r, signature, "adopt");
    }
    return `position ${r.positionId}: ${r.qtyRaw} raw for ${r.costLamports} lamports`;
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

  /** Engine.run has ended (STOP or a signal): wait for a launch call in flight before the ledger closes. */
  stop(): Promise<void> {
    return this.launcher.close();
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
    this.launcher = new Launcher({ cfg: d.cfg, ledger: d.ledger, client: d.client, rpc: d.rpc, log: d.log, alerter: d.alerter, openFromFill: (p) => this.openFromFill(p), shouldStop: () => this.stopping, now: d.now });
    trigger.launcher = this.launcher;
  }
}
