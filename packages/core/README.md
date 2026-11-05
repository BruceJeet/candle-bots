# candle-bot-core

The shared core of [Candle](https://candle.tv) trading bots on Solana. A bot is a **trigger** (which coins to buy, and
when) plus a **config section**. The core does everything else: the local SQLite ledger, the order executor and its
money rules, the exit strategies, the controls, alerts and `status.json`. Built on Candle's SDK,
[`@candledottv/agent-sdk`](https://www.npmjs.com/package/@candledottv/agent-sdk) (pinned at 0.6.14).

It came out of [candle-launch-bot](https://www.npmjs.com/package/candle-launch-bot), which runs on it. The money paths
are that bot's, unchanged.

```sh
npm install candle-bot-core
```

Node 22.18 or newer. ESM only.

## What a bot is

```
each cycle (the engine):
  controls: STOP, PAUSE_BUYS, sell requests
  sells in flight -> market reads -> exit strategy -> new sells
  settle buys that may have executed
  trigger.poll()               new candidates join the pending set
  trigger.decide(candidate)    wait (ask again next cycle) | skip | buy
  the engine's caps            PAUSE_BUYS, maxPerCoin, maxOpen, lifetimeSol, ticket <= buy.sol
  a buy order -> the executor -> a position -> the exit strategy
  alerts, surplus check, status.json
```

A bot writes the two middle lines. It never places an order, books a fill or touches a position: a buy verdict is a
request the engine may still refuse.

**Timing (0.3.0).** `run()` keeps exits, entries and order attempts apart. An **exit tick** every `exitMs` (default
500 ms) reads the open coins' markets in one call, runs the exit strategy, reads the crossing coins' balances together
and books and starts each sell at once. **Entries** run as soon as the trigger's source calls `ctx.wake()` (or every
`loopMs`): candidates are decided outside the money lock, `trigger.concurrency` at a time, and a buy verdict is booked
in one ledger transaction (caps checked inside it). **Order attempts** (build, sign, submit) never run under the lock:
one per order and per coin, up to `buy.concurrency` buys at once (default 4), sells with no limit and never behind a
buy. A **full cycle** every `loopMs` handles sell requests, alerts and status. So a stop-loss is acted on by the next
exit tick (at most `exitMs` later) after one market read and its coin's balance read: no buy, however slow or hung,
and no trigger call comes first. Typically under a second; under an RPC outage each read is bounded by the RPC
timeout, about `exitMs` + 4 × 15 s at worst. See the CHANGELOG. A trigger without `wake` still works: it is polled
every `loopMs`.

## The trigger interface

```ts
import type { Candidate, PendingInfo, Trigger, TriggerContext, Verdict } from "candle-bot-core";

interface Candidate {
  mint: string;
  chain: string;          // "solana"
  seenAtMs: number;
  source: string;         // your word: "api", "file", "clock", ...
  reason?: string;
  meta?: unknown;         // your data; stored with the position unless the verdict gives `context`
}

type Verdict =
  | { verdict: "buy"; reason: string;            // the order's reason
      lamports?: bigint;                          // ticket, at most buy.sol (default buy.sol)
      deadlineAtMs?: number | null;               // no attempt is built after this
      expectedOutRaw?: bigint | null;             // caps adopting tokens of an uncertain buy
      decimals?: number; context?: unknown;
      log?: Record<string, unknown> | ((nowMs: number) => Record<string, unknown>) }
  | { verdict: "wait"; reason: string }
  | { verdict: "skip"; reason: string };

interface Trigger {
  readonly name: string;
  readonly candidateLabel?: string;   // status.json stats key, default "candidates"
  readonly buyIdPrefix?: string;      // clientTradeId prefixes, default "bot" / "bots"
  readonly sellIdPrefix?: string;
  start?(ctx: TriggerContext): Promise<void>;   // sources; run() calls it before the first cycle (keep ctx for ctx.wake())
  stop?(): void;
  poll(ctx: TriggerContext): Candidate[] | Promise<Candidate[]>;
  decide(c: Candidate, ctx: TriggerContext, pending: PendingInfo): Verdict | Promise<Verdict>;
  onVerdict?(c: Candidate, v: Verdict, ctx: TriggerContext, pending: PendingInfo): void;
  afterEntries?(ctx: TriggerContext): void;
  status?(pending: Array<{ candidate: Candidate } & PendingInfo>): Record<string, unknown>;
}
```

`TriggerContext` (0.2.0 adds `readCurve(mint, address?)` and `wake()`) gives the config (deep-frozen), a read-only view of the ledger (this run's mode only), the RPC, the
logger, the alerter, `dry`, `now()`, `caps(mint)` and `shouldStop()`; the context itself is frozen. `PendingInfo` is when
the candidate joined and its last wait reason.

The engine never trusts the trigger's objects:

- a candidate is copied when `poll` returns: `mint` must be a Solana address as given (no padding) and `chain`
  `"solana"`, else it is refused (`candidate_refused`); later calls get the engine's frozen copy;
- a verdict is read once, field by field, into the engine's own frozen copy: only an exact `"wait"`, `"skip"` or a
  well-typed `"buy"` (non-empty `reason`, bigint `lamports`, ...) counts, anything else is a skip; the caps, the order
  and `onVerdict` (which gets a copy) all work from that copy, so changing the trigger's object afterwards changes
  nothing;
- `ctx.readCurve(mint)` reads the Candle curve through the engine, once per account per entries step, and returns a
  frozen `CurveRead` (`ok` with the curve, `missing`, `failed`, `invalid`); a trigger that uses it makes a buy cost one
  curve read, because the engine's own expected-fill check reuses that read;
- the expected fill of a buy (the cap on adopting tokens of an uncertain buy) is the smaller of the trigger's and the
  engine's own read of the Candle curve; with no readable curve, the trigger's (logged `expected_fill_unverified`);
- `onVerdict` and `afterEntries` are not awaited; one that returns a promise that rejects is logged and alerted;
- `ctx.rpc`, `ctx.log` and `ctx.alerter` are frozen wrappers: a trigger cannot replace what the engine and the
  executor use; after the engine's curve read, the caps are checked once more (PAUSE_BUYS may have arrived);
- each `poll` and `decide` call has a time limit (`triggerTimeoutMs`, default 10 s, within the cycle budget left but
  never under 5 s). A call
  that throws or does not answer costs that cycle's entries step (logged `cycle_step_failed`); the candidate stays
  pending and is not asked again until the hung call ends; exits, sells and STOP run as usual.

The trigger boundary protects against buggy triggers, not against malicious code in the same process.
These guards hold against mistakes and against ordinary trigger code doing odd things through what it is handed. They
are not a sandbox: code running in the same process can still import `fs`, open the ledger file or read the keys
store, so run only bot code you trust with your wallet.

`onVerdict` sees every verdict after the engine's caps, so a buy the caps refuse arrives as a skip; without it the
engine logs `candidate_wait` and `candidate_skip`.

```ts
// what ctx.ledger offers (no writes; a bot's own tables live on the bot's own Ledger subclass, passed to its trigger)
interface LedgerView {
  position(id: number): Readonly<PositionRow> | undefined;
  positions(...statuses: PositionStatus[]): ReadonlyArray<Readonly<PositionRow>>;
  ordersFor(positionId: number): ReadonlyArray<Readonly<OrderRow>>;
  entriesForMint(mint: string): number;   // what maxPerCoin counts
  lifetimeBuyLamports(): bigint;          // what lifetimeSol counts
  openCount(): number;                    // what maxOpen counts
}
```

## Writing a bot

A bot package depends on `candle-bot-core` and has three parts. The example bot in the candle-bots repo
(`packages/example-bot`) is all of this in about 200 lines.

**1. The config section.** The core parses the shared sections (`mode`, `payer`, `wallet`, `signer`, `buy`, `sell`,
`exit`, `retry`, `alerts`, ...). Your sections are parsed by your functions, with the same helpers, after `sell` and
before `exit`; unknown keys are refused everywhere.

```ts
import { parseConfig, loadConfig, isObj, only, num, ConfigError, type BotConfig } from "candle-bot-core";

function parseManual(raw: unknown) {
  const m = raw === undefined ? {} : raw;
  if (!isObj(m)) throw new ConfigError("config.manual: must be an object");
  only(m, ["maxImpactBps", "maxWaitSec"], "config.manual");
  return { maxImpactBps: num(m, "maxImpactBps", "config.manual", { min: 0, max: 10_000, def: 300 }),
           maxWaitSec: num(m, "maxWaitSec", "config.manual", { min: 1, def: 60 }) };
}
export const SECTIONS = { manual: parseManual };
export type Config = BotConfig<typeof SECTIONS>;   // the core Config & { manual: ... }
const cfg = loadConfig("bot.json", SECTIONS);
```

**2. The trigger.** A class with `poll` and `decide` (above).

**3. The command line.** `runtime` has the rest:

```ts
import { Engine, Ledger, args, context, parts, run, sell, status, guardMain } from "candle-bot-core";

const ctx = context(cfg, opt.mode);                     // RPC, Candle client, events.jsonl; --mode
const ledger = () => new Ledger(join(ctx.cfg.stateDir, "ledger.sqlite"));
const make = async (l: Ledger) => {
  const p = await parts(ctx, l, { maxBuyImpactBps: ctx.cfg.manual.maxImpactBps });   // strategy, rail, alerts, executor
  const trigger = new ManualTrigger(ctx.cfg.stateDir, ctx.cfg.manual, ctx.rpc);
  return { trigger, engine: new Engine({ cfg: ctx.cfg, ledger: l, trigger, executor: p.executor, strategy: p.strategy, rpc: ctx.rpc, log: ctx.log, alerter: p.alerter }) };
};
await run(ctx, ledger, make);                            // lock, signals, trigger start/stop, the loop
```

`maxBuyImpactBps` is required: when a failed buy is rebuilt, the executor re-reads the Candle curve and refuses a buy
whose impact has moved past it, so a retry never chases a pump. A bot that keeps its own records subclasses `Ledger`
and creates its tables in the constructor (`create table if not exists`); the core schema stays the same for every bot.

## The exit interface

Built in: `hold`, `tpsl` (take profit, stop loss, optional trailing stop), `time` (sell after a time), `ladder`
(sell parts at multiples, keep a core), `preGrad` (sell before graduation). Pick one with `"exit": { "strategy": ... }`,
or write one file:

```js
// my-exit.js   "exit": { "strategy": "breakeven", "module": "./my-exit.js", "arm": 1.5 }
export function create(params) {
  const arm = Number(params.arm ?? 1.5);
  return {
    name: "breakeven",
    onTick(p, m) {
      if (m.priceSol === null) return { action: "hold" };
      const armed = p.peakPriceSol >= p.entryPriceSol * arm;
      return armed && m.priceSol <= p.entryPriceSol ? { action: "sell", fraction: 1, reason: "back to entry" } : { action: "hold" };
    },
  };
}
```

`onTick(position, market)` runs once per cycle for each open position with no exit order in flight. `position`:
`mint, openedAtMs, qtyRaw, remainingRaw, decimals, entryPriceSol, peakPriceSol, soldFraction`. `market`: `priceSol`
(null if unreadable), `progress` (0..1), `migrated`, `venue` (`curve` / `damm`), `nowMs`. Return `{ action: "hold" }`
or `{ action: "sell", fraction, reason }`, `fraction` a share of what remains. Types: `ExitStrategy`, `PositionView`,
`MarketView`, `Decision`. A strategy gets its own copy of its params (it may keep state in them). A strategy that
throws on a position three ticks in a row raises an alert (`position:<id>:strategy_error`): that position does not
exit by itself until it is fixed.

## Candle launches as a source

`candle-bot-core/sources/candleLaunches` (root export `CandleLaunches`) watches Candle launches from two sources at
once: Candle's public token list (no key) and the launch-curve program on chain (`logsSubscribe`, with signature
polling as a fallback and a backstop). Each mint is reported once, by whichever source saw it first; both sightings
and their latencies from the launch transaction's block time are kept. A trigger starts it in `start(ctx)`, sets
`onNew = () => ctx.wake()` for the fast entry lane, and takes new launches with `drain()` in `poll`:

```ts
import { CandleLaunches, type Launch } from "candle-bot-core";
const launches = new CandleLaunches({ rpc, wsUrl, apiUrl: cfg.apiUrl, log }, { api: true, chain: true, apiPollMs: 3000, chainPollMs: 15_000, apiLimit: 20 });
// Launch: mint, launchedAtMs, detectedAtMs, creator (token list), signer (launch tx fee payer), launchMode, curve, decimals, ...
```

candle-launch-bot, candle-graduation-bot and candle-creator-bot use it.

## Buying a graduated coin (DAMM v2)

A Candle coin whose curve completes trades on its Meteora DAMM v2 pool. `market/curve` decodes the pool and
`dammBuy(pool, mint, lamports)` gives what a buy fills there: `expectedOutRaw`, `impactBps` (the swap's average price
over spot, fee apart, as `buyImpact` on the curve) and `feeBps`. Pure: no I/O. One liquidity range, the coin on either
side, the pool's fee taken on the side its `collect_fee_mode` says, at its lowest base fee (the dynamic fee only adds,
so the fill is exact on a flat-fee pool and an upper bound otherwise). It throws `buy_past_range`, `pool_disabled`,
`pool_mismatch`, `pool_not_quote` and `pool_reserves`.

The engine uses it on its own: a buy verdict on a coin whose curve is migrated gets the smaller of the trigger's
expected fill and the engine's read of the pool. A bot whose buys fill on pools passes `dammBuys: true` to its executor
(`parts(ctx, ledger, { maxBuyImpactBps, executor: (d) => new Executor({ ...d, dammBuys: true }) })`) so a retry
rechecks the pool (the ticket's impact, and the price move since the decision) rather than ending as `CURVE`. `readMarkets` returns the pool as `MarketRead.pool`.

## How money is handled

- **Quantity is what the chain says.** Fills are booked from the transaction's balance changes, never the quote;
  network fee and token-account rent are kept apart. An unreadable transaction is read again; after several failures
  the core books Candle's `actualOutRaw` (or the build's `minOutRaw`) and alerts. Each position records its source.
- **Sells are clamped** to the wallet's balance less what the bot's other positions in the coin own. A zero or
  unreadable balance refuses the sell and alerts; a shortfall writes the position down so it can close.
- **One live transaction per order.** The signature and blockhash are saved before submit. Before any rebuild the saved
  signature is checked on chain and the blockhash must be expired by block height. Rebuilds reuse the order's
  `clientTradeId`, so Candle replays rather than trades twice.
- **Refusals are read from structure** (`code`, `status`, `stage`, `reason`), never message text. Only Candle's own
  non-retryable 4xx before anything was broadcast ends an order at once; for the embedded wallet, a buy build Candle
  refused with no stage or `stage: "not_broadcast"` counts as unspent only when every attempt was such a refusal.
  Network errors, timeouts and 5xx are retried, on a cap with jittered backoff per order.
- **Uncertain orders are recovered, not guessed.** An order that may have executed reads Candle's trade job, then the
  wallet's token history inside the order's attempt windows: its own transactions are booked (all of them, on a double
  execution), tokens received for SOL since the order are adopted up to a cap on the expected fill, anything else is
  alerted and left alone.
- **Caps are the engine's**, applied to every buy verdict: `PAUSE_BUYS`, `buy.maxPerCoin` (1), `buy.maxOpen`,
  `buy.lifetimeSol` (a lifetime cap on tickets committed, counting any buy that may have spent), and a ticket no larger
  than `buy.sol`. A buy past its deadline or while paused is never built.
- **Controls** never block the loop: `STOP` and `PAUSE_BUYS` files in the state folder, `sell` requests, one process
  per state folder (a lock), a dry run that never touches live rows.

## Modules

The root export is the API above. Every module is also importable on its own path, the same version:
`candle-bot-core/ledger`, `/engine`, `/trigger`, `/config`, `/runtime`, `/exec/executor`, `/exec/trader`,
`/exec/fills`, `/market/reader`, `/market/curve`, `/solana/rpc`, `/solana/pda`, `/solana/base58`, `/solana/logs-ws`,
`/strategies/load`, `/strategies/types`, `/sources/candleLaunches`, `/alerts`, `/log`, `/redact`.

In a checkout of the repo, the `source` export condition (`node --conditions=source`) resolves them to the
TypeScript sources, so nothing needs building while you work.

## License

MIT
