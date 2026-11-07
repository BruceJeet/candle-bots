/** The command line: run, plan, status, flatten, resume, accept. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "candle-bot-core/ledger";
import { makeAlerter } from "candle-bot-core/alerts";
import { acquireLock, readControl } from "candle-bot-core/engine";
import { makeLogger, type Logger } from "candle-bot-core/log";
import { addSecret, redact } from "candle-bot-core/redact";
import { args, die, guardMain, SDK_TIMEOUT_MS } from "candle-bot-core/runtime";
import { httpRpc, PUBLIC_RPC, type Rpc } from "candle-bot-core/solana/rpc";
import { makeSecretStore, timedFetch } from "candle-bot-core/exec/trader";
import { HedgeBook } from "candle-bot-core/perps/book";
import { PaperPerpsVenue } from "candle-bot-core/perps/paper";
import { readPerpMarkets, SdkPerpsVenue, type PerpsClient } from "candle-bot-core/perps/sdkVenue";
import { newClientId, type PerpAccount, type PerpsVenue } from "candle-bot-core/perps/venue";
import { planHedge } from "candle-bot-core/perps/planner";
import { bagUsd, readSpotBags } from "candle-bot-core/perps/spot";
import { DatabaseSync } from "node:sqlite";
import { perpsClient, resolvePerpsWallet } from "candle-bot-core/perps/wallet";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { Hedger } from "./hedger.ts";

export const HELP = `candle-perps-hedger: hedges the spot bags of a Solana wallet with Hyperliquid perps through Candle. A short on the
coin's own perp when Hyperliquid lists it (named in config), else on a proxy (SOL), sized by a ratio or a fitted beta;
rebalanced outside a band, within a max leverage and a max margin; reduce-only closes; fees and funding booked.

  candle-perps-hedger run     --config hedge.json [--mode dry] [--max-seconds n]
                                                                 run the hedger (dry: paper perps, real reads, no key)
  candle-perps-hedger plan    --config hedge.json                one read and the plan it gives; never trades
  candle-perps-hedger status  --config hedge.json                print status.json
  candle-perps-hedger flatten --config hedge.json                close every hedge (reduce-only) and hold flat: writes FLATTEN
  candle-perps-hedger resume  --config hedge.json                remove FLATTEN and PAUSE_OPENS
  candle-perps-hedger accept  <coin> --config hedge.json         (stopped) take over the account's position in <coin> as the hedger's;
                                                                 from then on the hedger sizes it to the bags (it may reduce or close it)

Start from examples/dry.json. Controls in the state folder: STOP (stop), PAUSE_OPENS (no new or larger hedges; closes
still run), FLATTEN (close every hedge). Docs: the README.
`;

export interface Ctx {
  cfg: Config;
  rpc: Rpc;
  log: Logger;
}

export function context(configPath: string, modeOverride?: string): Ctx {
  let cfg: Config;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    if (e instanceof ConfigError) die(e.message);
    throw e;
  }
  if (modeOverride) {
    if (modeOverride !== "dry" && modeOverride !== "live") die("--mode: dry or live");
    if (modeOverride === "live" && cfg.mode !== "live") die('--mode live needs "mode": "live" in the config too');
    cfg = { ...cfg, mode: modeOverride };
  }
  const rpcUrl = (cfg.rpcUrlEnv && process.env[cfg.rpcUrlEnv]) || PUBLIC_RPC;
  addSecret(rpcUrl);
  mkdirSync(cfg.stateDir, { recursive: true });
  return { cfg, rpc: httpRpc(rpcUrl), log: makeLogger({ file: join(cfg.stateDir, "events.jsonl") }) };
}

/** A client for reads only: any order through it throws. */
const NO_ORDERS: PerpsClient = {
  perpsOpen: async () => { throw new Error("read-only venue: no orders"); },
  perpsClose: async () => { throw new Error("read-only venue: no orders"); },
  perpsLeverage: async () => { throw new Error("read-only venue: no orders"); },
} as unknown as PerpsClient;

/**
 * The venue for this config: paper in dry mode; in live mode the SDK venue with the key, the resolved EVM TEE wallet
 * and its signer (`readOnly`: the SDK venue with no client, for `accept`: /info reads only, no key).
 */
export async function makeVenue(ctx: Ctx, opts: { readOnly?: boolean; now?: () => number } = {}): Promise<PerpsVenue> {
  const { cfg } = ctx;
  const infoFetch = timedFetch(20_000);
  if (cfg.mode === "dry") {
    return new PaperPerpsVenue({ network: cfg.network, path: join(cfg.stateDir, "hedge.sqlite"), markets: () => readPerpMarkets(infoFetch as any, cfg.network), startUsd: cfg.perps.paper.startUsd, feeBps: cfg.perps.paper.feeBps, slippageBps: cfg.perps.paper.slippageBps, minOrderUsd: 10, ...(opts.now ? { now: opts.now } : {}) });
  }
  if (opts.readOnly) return new SdkPerpsVenue({ network: cfg.network, address: cfg.perps.wallet!, walletId: cfg.perps.walletId ?? "read-only", privyWalletId: "read-only", client: NO_ORDERS, fetch: infoFetch as any });
  const apiKey = process.env[cfg.apiKeyEnv!];
  if (!apiKey) die(`${cfg.apiKeyEnv} is not set (the Candle API key)`);
  addSecret(apiKey);
  const w = await resolvePerpsWallet({ apiUrl: cfg.apiUrl, address: cfg.perps.wallet!, walletId: cfg.perps.walletId, privyWalletId: cfg.perps.privyWalletId, privyAppId: cfg.perps.privyAppId }, apiKey, timedFetch(SDK_TIMEOUT_MS));
  const store = await makeSecretStore({ signer: cfg.perps.signer } as any, w, process.env, (message) => ctx.log.warn("signer_store_permissions", { message }));
  if (!(await store.get(w.linkedWalletId))) die(`no signer key for EVM TEE wallet ${cfg.perps.wallet} in the ${cfg.perps.signer!.store} store (key ${w.keyPrefix})`);
  const client = perpsClient({ apiUrl: cfg.apiUrl, apiKey, privyAppId: w.privyAppId, secretStore: store, network: cfg.network, fetch: timedFetch(SDK_TIMEOUT_MS) });
  ctx.log.info("perps_wallet_resolved", { wallet: w.address, walletId: w.linkedWalletId, keyPrefix: w.keyPrefix, network: cfg.network, signer: cfg.perps.signer!.store });
  return new SdkPerpsVenue({ network: cfg.network, address: w.address, walletId: w.linkedWalletId, privyWalletId: w.privyWalletId, client, fetch: infoFetch as any });
}

/**
 * The loop: one process per state dir (lock), a step every loopMs, STOP and SIGINT/SIGTERM end it cleanly,
 * status.json after each step. `maxSteps` / `maxMs` end it early (tests, a timed dry run).
 */
export async function runHedger(ctx: Ctx, venue: PerpsVenue, opts: { now?: () => number; maxSteps?: number; maxMs?: number; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void> } = {}): Promise<number> {
  const { cfg, log } = ctx;
  const lock = acquireLock(cfg.stateDir);
  if (!lock) {
    log.error("locked", { stateDir: cfg.stateDir });
    process.stderr.write(`another process holds ${cfg.stateDir}/lock\n`);
    return 1;
  }
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ledger = new Ledger(join(cfg.stateDir, "ledger.sqlite"));
  const book = new HedgeBook(join(cfg.stateDir, "hedge.sqlite"), now);
  let stopping = false;
  const onSig = () => {
    if (!stopping) log.info("signal_stop");
    stopping = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  const shouldStop = () => stopping || readControl(join(cfg.stateDir, "STOP")) !== null;
  const started = now();
  const wallStart = Date.now();
  let h: Hedger | null = null;
  const writeStatus = () => {
    try {
      const p = join(cfg.stateDir, "status.json");
      const body = { mode: cfg.mode, startedAt: new Date(started).toISOString(), at: new Date(now()).toISOString(), ...(h ? h.status() : {}) };
      writeFileSync(p + ".tmp", redact(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)));
      renameSync(p + ".tmp", p);
    } catch (e) {
      log.warn("status_write_failed", { error: String((e as Error).message) });
    }
  };
  try {
    const alerter = makeAlerter(cfg.alerts, ledger, log, opts.env);
    h = new Hedger({ cfg, venue, book, rpc: ctx.rpc, log, alerter, now });
    log.info("start", { mode: cfg.mode, network: cfg.network, venue: venue.kind, spotWallet: cfg.spot.wallet, perpsWallet: cfg.perps.wallet, proxy: cfg.hedge.proxy, maxLeverage: cfg.hedge.maxLeverage, maxMarginUsd: cfg.hedge.maxMarginUsd, stateDir: cfg.stateDir });
    let steps = 0;
    while (!shouldStop() && (opts.maxSteps === undefined || steps < opts.maxSteps) && (opts.maxMs === undefined || Date.now() - wallStart < opts.maxMs)) {
      const t0 = now();
      try {
        await h.step(shouldStop);
      } catch (e) {
        log.error("hedge_step_failed", { error: String((e as Error)?.stack ?? e).slice(0, 800) });
      }
      steps++;
      writeStatus();
      const until = t0 + cfg.loopMs;
      while (!shouldStop() && now() < until && (opts.maxMs === undefined || Date.now() - wallStart < opts.maxMs)) await sleep(Math.min(250, until - now()));
    }
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
    writeStatus();
    book.close();
    if (venue instanceof PaperPerpsVenue) venue.close_();
    ledger.close();
    lock.release();
    log.info("stopped");
  }
  return 0;
}

function touch(ctx: Ctx, name: string): void {
  const p = join(ctx.cfg.stateDir, name);
  writeFileSync(p, new Date().toISOString() + "\n");
}

/** `accept <coin>`: with the hedger stopped, book the account's position in <coin> as the hedger's own. */
async function accept(ctx: Ctx, coin: string): Promise<number> {
  const lock = acquireLock(ctx.cfg.stateDir);
  if (!lock) die(`the hedger is running (${ctx.cfg.stateDir}/lock): stop it first, then accept`);
  const book = new HedgeBook(join(ctx.cfg.stateDir, "hedge.sqlite"));
  const venue = await makeVenue(ctx, { readOnly: true });
  try {
    if (book.unresolved().length) die(`orders not reconciled yet (${book.unresolved().map((r) => r.id).join(", ")}): run the hedger until they are`);
    const acct = await venue.account();
    const venuePos = acct.positions.find((p) => p.coin === coin)?.szi ?? 0;
    const delta = +(venuePos - book.expected(coin)).toPrecision(12);
    if (delta === 0) {
      process.stdout.write(`${coin}: the book already matches the account (${venuePos})\n`);
      return 0;
    }
    book.accept(coin, delta, `accept command: account ${venuePos}, book ${book.expected(coin)}`, newClientId());
    ctx.log.info("position_accepted", { coin, venue: venuePos, delta });
    process.stdout.write(`${coin}: booked ${delta} as the hedger's; the book now holds ${book.expected(coin)}\n`);
    return 0;
  } finally {
    book.close();
    if (venue instanceof PaperPerpsVenue) venue.close_();
    lock.release();
  }
}

/** The book and paper positions as a running hedger left them, read-only (no write, no lock). */
function readStateReadOnly(stateDir: string): { coins: string[]; unresolved: Array<{ id: number; coin: string; status: string }>; paper: Array<{ coin: string; szi: number; entry_px: number | null }> } {
  const p = join(stateDir, "hedge.sqlite");
  const out = { coins: [] as string[], unresolved: [] as Array<{ id: number; coin: string; status: string }>, paper: [] as Array<{ coin: string; szi: number; entry_px: number | null }> };
  if (!existsSync(p)) return out;
  const db = new DatabaseSync(p, { readOnly: true });
  try {
    const has = (t: string) => !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t);
    if (has("hedge_orders")) {
      out.coins = (db.prepare("select distinct coin from hedge_orders").all() as any[]).map((r) => r.coin);
      out.unresolved = db.prepare("select id, coin, status from hedge_orders where status in ('sent', 'unknown')").all() as any[];
    }
    if (has("paper_positions")) out.paper = db.prepare("select coin, szi, entry_px from paper_positions where szi != 0").all() as any[];
  } finally {
    db.close();
  }
  return out;
}

/**
 * `plan`: one read of the venue and the wallet, and the plan the hedger would act on, printed. Never sends an order
 * and never writes the state dir (the book is opened read-only). Fitted betas are not read: configured ratios apply.
 */
async function planOnce(ctx: Ctx): Promise<number> {
  const { cfg } = ctx;
  const fetchFn = timedFetch(20_000) as any;
  const markets = await readPerpMarkets(fetchFn, cfg.network);
  const state = readStateReadOnly(cfg.stateDir);
  const now = Date.now();
  const account: PerpAccount = cfg.mode === "live"
    ? await new SdkPerpsVenue({ network: cfg.network, address: cfg.perps.wallet!, walletId: "read-only", privyWalletId: "read-only", client: NO_ORDERS, fetch: fetchFn }).account()
    : { readAt: now, accountValueUsd: cfg.perps.paper.startUsd, marginUsedUsd: null, positions: state.paper.map((p) => ({ coin: p.coin, szi: p.szi, entryPx: p.entry_px, unrealizedPnl: null, leverage: null })) };
  const bags = await readSpotBags(ctx.rpc, { wallet: cfg.spot.wallet, mode: cfg.spot.mode, mints: cfg.spot.mints, exclude: new Set(cfg.spot.exclude), maxBags: cfg.spot.maxBags });
  const solUsd = markets.get("SOL")?.markPx ?? null;
  const managed = new Set<string>([cfg.hedge.proxy, ...state.coins, ...Object.values(cfg.hedge.coins).map((c) => c.perp).filter((c): c is string => !!c)]);
  const frozen = new Map(state.unresolved.map((r) => [r.coin, `order ${r.id} (${r.status}) not reconciled yet`] as [string, string]));
  const plan = planHedge({
    now, markets, managed, frozen, cfg: cfg.hedge, accountValueUsd: account.accountValueUsd,
    positions: new Map(account.positions.map((p) => [p.coin, p.szi])),
    bags: bags.filter((b) => b.qtyRaw > 0n && !(b.liquiditySol !== null && b.liquiditySol < cfg.spot.minLiquiditySol)).map((b) => ({ mint: b.mint, valueUsd: solUsd === null ? null : bagUsd(b, solUsd), pricedAt: b.priceSol === null ? null : now })),
    flatten: existsSync(join(cfg.stateDir, "FLATTEN")), pauseOpens: existsSync(join(cfg.stateDir, "PAUSE_OPENS")),
  });
  process.stdout.write(JSON.stringify({ mode: cfg.mode, network: cfg.network, solUsd, account, orders: plan.orders, lines: plan.lines, bags: plan.bags.map((b) => ({ ...b, venue: bags.find((x) => x.mint === b.mint)?.venue })), capped: plan.capped, frozen: Object.fromEntries(frozen), note: "plan only: nothing was sent" }, null, 2) + "\n");
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  return guardMain(async () => {
    const { pos, opt } = args(argv);
    const cmd = pos[0];
    if (!cmd || cmd === "help" || opt.help) {
      process.stdout.write(HELP);
      return cmd || opt.help ? 0 : 2;
    }
    if (cmd === "version" || opt.version) {
      process.stdout.write(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version + "\n");
      return 0;
    }
    const config = opt.config ?? "hedge.json";
    switch (cmd) {
      case "run": {
        const ctx = context(config, opt.mode);
        const maxS = opt["max-seconds"] === undefined ? undefined : Number(opt["max-seconds"]);
        if (maxS !== undefined && !(maxS > 0)) die("--max-seconds: a number of seconds > 0");
        const venue = await makeVenue(ctx);
        return runHedger(ctx, venue, maxS !== undefined ? { maxMs: maxS * 1000 } : {});
      }
      case "plan":
        return planOnce(context(config));
      case "status": {
        const ctx = context(config);
        const p = join(ctx.cfg.stateDir, "status.json");
        if (!existsSync(p)) die(`no ${p} yet (has the hedger run?)`, 1);
        process.stdout.write(readFileSync(p, "utf8") + "\n");
        return 0;
      }
      case "flatten": {
        const ctx = context(config);
        touch(ctx, "FLATTEN");
        process.stdout.write(`wrote ${join(ctx.cfg.stateDir, "FLATTEN")}: the hedger closes every hedge (reduce-only) and holds flat until \`resume\`\n`);
        return 0;
      }
      case "resume": {
        const ctx = context(config);
        for (const f of ["FLATTEN", "PAUSE_OPENS"]) rmSync(join(ctx.cfg.stateDir, f), { force: true });
        process.stdout.write("removed FLATTEN and PAUSE_OPENS\n");
        return 0;
      }
      case "accept": {
        if (!pos[1] || !/^[A-Za-z0-9]{1,20}$/.test(pos[1])) die("accept <coin> (a Hyperliquid coin name, e.g. SOL)");
        return accept(context(config), pos[1]);
      }
      default:
        die(`unknown command ${cmd}`);
    }
  });
}
