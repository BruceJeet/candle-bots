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
(sell parts at multiples, keep a core), `preGrad` (sell before graduation), `trail` (a trailing stop from a high-water
mark the ledger keeps; see below). Pick one with `"exit": { "strategy": ... }`,
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
(null if unreadable), `progress` (0..1), `migrated`, `venue` (`curve` / `damm`, and `pump-curve` / `pumpswap` for a
bot that reads pump.fun venues), `nowMs`. Return `{ action: "hold" }` or `{ action: "sell", fraction, reason }`,
`fraction` a share of what remains. Two optional flags on the strategy: `needsBasis` (it reads the entry price; a bag
adopted without a cost basis cannot use it; unset counts as true) and `trailMark` (the engine keeps
`position.trailPeakSol` for it; a sell decision with `resetTrail: true` restarts the mark at the price then). Types: `ExitStrategy`, `PositionView`,
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

## Opening a position from a fill the engine did not place

`engine.openFromFill({ mint, signature, decimals?, reason, entry?, expectedQtyRaw? })` books a position from a
transaction on chain: the wallet's token gain is the quantity, and the cost basis is the wallet's SOL delta less the
network fee and its own token-account rent for that mint. Everything else the wallet paid in that transaction counts
as cost: a transaction that launched a coin and bought it in one would carry the launch's costs too (Candle's atomic
launch puts the dev buy in its own transaction, so its cost is the buy). The decimals come from the transaction's
token balances (a caller's value must agree).

It answers `{ ok: true, positionId, qtyRaw, costLamports }`, or `{ ok: false, reason }` and books nothing:
`tx_not_found` (read again later), `tx_failed`, `no_tokens`, `no_spend` (tokens that cost no SOL: a transfer or
airdrop never opens a cost-0 position), `already_booked` (any order already carries this signature, as its own or as a
double execution's extra), `signature_other_mint`, `decimals_disagree`, `decimals_unknown`, `mint_busy` (an attempt
or a reservation holds the coin: try again), `dry`. The whole call holds the coin (`Executor.reserveMint`), as the
uncertain-buy scan does, so the two never adopt one transaction at once, and the booking re-checks the signature inside
its database transaction; a lost race answers `ok: false`, never throws. An API's number (`expectedQtyRaw`) is only
compared: the chain wins. The position gets a filled buy order `fill-<signature>` (idempotent for the same mint), so
`maxPerCoin`, `maxOpen` and `lifetimeSol` count it and the strategy, the sell clamp and `sell` treat it as any other.
candle-launch-helper opens its dev bag with it.

## Retry price drift (opt-in)

A buy rebuilt after a failed attempt is rechecked against `maxBuyImpactBps`: the ticket's own impact on the curve.
That impact falls as the price rises, so on its own it lets a retry rebuild into a pump. `retry.maxPriceDriftBps`
(config, unset by default) adds the price check: the retry must still buy at least the order's **decision fill** less
that many bps, or it ends `IMPACT`; an order with no decision fill ends too. Unset, a curve retry is checked exactly as
in 0.3.1. A graduated coin's retry under `dammBuys` always has this check, at `maxBuyImpactBps`, and refuses (`POOL`)
an order with no decision fill.

The decision fill (`orders.decision_out_raw`) is set once: at booking, from the decision's expected fill (the smaller
of the trigger's and the engine's own read), or, for an order booked without one, from its first build quote. It is
never overwritten, so the limit holds the total move since the decision, not each step: a climb of 5 % per attempt
is refused once the total passes the limit. `expected_out_raw` still follows each build's quote (the uncertain-buy
adoption cap uses it). The column is added only when a drift check is on (an Executor with `retry.maxPriceDriftBps`
set or `dammBuys`): a ledger whose bot never turns one on is never migrated. An order booked before the column existed
is held to its `expected_out_raw`.

## pump.fun venues (opt-in)

`market/pump` decodes pump.fun's bonding curve, the canonical PumpSwap pool a coin migrates to, a token account and
pump's fee config, and gives the SOL a sell of `n` raw tokens brings: `pumpCurveSell`, `pumpPoolSell` (pure, no I/O).
The layouts are the programs' own on-chain IDLs; the math was reproduced to the lamport on real sells (five on curves,
legacy, v0 and v1 transactions; three on a PumpSwap pool):

- curve: `out = n * vq / (vt + n)` on the virtual reserves, less the protocol and creator fees, each
  `ceil(out * bps / 10_000)`;
- PumpSwap: the quote reserve is the SOL vault **plus the pool's signed `virtual_quote_reserves`** (i128 at byte 245;
  boosted pools carry about 17.5 SOL there, so the raw vault ratio is off), the base reserve is the coin vault; lp,
  protocol and coin-creator fees as above;
- the fee tier is the last one at or under the market cap (`vq * supply / vt` on the curve, `Q * supply / B` on the
  pool), from pump's fee program config.

Refused rather than guessed: a quote other than SOL, a mayhem-mode PumpSwap pool, a pool whose base is not the coin.
A mayhem-mode curve's ordinary sell follows the same math. On a cashback coin the expected out leaves the cashback fee
out (it overstates by those bps).

`readMarkets(rpc, coins, nowMs, { pump: true })` finds each coin's venue from chain (which accounts exist): a Candle
curve or its DAMM v2 pool first, then a pump curve not complete (`pump-curve`), then the canonical PumpSwap pool
(`pumpswap`); a complete pump curve without its pool is `migrating`, nothing at all is `no_venue`. One batched read per
coin set (5 keys a coin, plus the two fee configs) and a second for the PumpSwap vaults. `{ reserves: true }` adds each
venue's real SOL (`quoteLiquidityLamports`). Without options the read is exactly 0.4.0's. `expectedSellOut(read, raw)`
answers for the pump venues. A bot turns it on with `EngineDeps.venues`; the engine then records its own expected SOL
out on each pump-venue sell (`orders.decision_out_raw` when the column exists; Candle's build still sets the floor).

**Buys (0.6.0):** `pumpCurveBuy(curve, lamports, fees)` and `pumpPoolBuy(state, mint, lamports, supply, fees)` give
the raw coin a spend of `lamports` brings (the programs' `buy_exact_quote_in`: the fees come off the input), with the
lamports that reach the venue, the fees, and the impact (the ticket's average price over spot, fees apart, as
`buyImpact` and `dammBuy` report it). Reproduced to the raw unit on real buys (three on curves, four on PumpSwap pools,
each read just before):

- net: `n0 = floor(S * 1e4 / (1e4 + fees))`, less the lamports by which `n0` plus its fees (each
  `ceil(n0 * bps / 1e4)`) overshoots the spend `S`, on both venues. That is the programs' rule: on 163 real PumpSwap
  buys it matched every one, and on 4 of them it is 1 lamport under the most that fits;
- out: `floor(vt * (n - 1) / (vq + n - 1))` on the curve, `floor(B * (n - 1) / (Q + n - 1))` on the pool, with `Q` the
  SOL vault plus `virtual_quote_reserves` before the trade (the programs swap one lamport less than the net);
- the fee tier at the market cap before the trade.

A curve's own `creator_fee_bps` (byte 115), when larger than the tier's creator fee, is the creator fee, on buys and
sells. Real trades on three such curves (100, 150 and 300 bps, all quoted in another token) paid it. A value over
1000 bps is not trusted: the math refuses it, and the sell floor then falls back to Candle's own floor.

Refused rather than guessed: a mayhem-mode curve (two real exact-in buys there follow this math, but other trades on
the same curve paid no fee, so the fee is not known in advance), a cashback curve or pool, a buy past the curve's real
tokens, and everything the sell side refuses. On a curve with no creator set the creator fee is still counted (a lower
expected out; no real buy showed one). `buyQuote(read, lamports)`
answers on whichever venue a read found (Candle curve, DAMM v2, pump curve, PumpSwap), or `{ why }`.

A bot that buys pump.fun coins turns on **`pumpBuys`** in both places:
- `EngineDeps.pumpBuys`: a coin with no Candle curve gets the engine's own expected fill from a fresh read of its
  venue, the smaller of that and the trigger's (as for Candle coins). A buy the math refuses keeps the trigger's
  value, logged with why (`pump_buy_unquoted`, `expected_fill_unverified`).
- `ExecutorDeps.pumpBuys`: a retry of such a buy reads the venue fresh and is refused when the ticket's impact there
  is over `maxBuyImpactBps` (`IMPACT`), or when it would buy less than the order's decision fill less
  `retry.maxPriceDriftBps` (`maxBuyImpactBps` when that is unset; `IMPACT`). An order with no decision fill, or a venue
  the math refuses, is refused (`VENUE`). A read that does not answer (the venue, a PumpSwap vault, a fee config, the
  mint, a pool or curve absent for a moment, a migration) is retried, and refused (`VENUE`) once the venue has been
  unread for 30 min (`PUMP_UNREAD_MAX_MS`). Without `pumpBuys` such a retry is refused
  (`CURVE`), as before.

The PumpSwap virtual quote reserve moves between trades, so an expected fill is only as good as its read: both checks
read fresh.

## Adopting bags already in the wallet (opt-in)

`adopt/adopter` lets a bot manage tokens it did not buy. Config section (`parseAdoption`):

```jsonc
"adoption": {
  "mode": "wallet",                  // or "list": only the mints below
  "mints": [ "Mint…", { "mint": "Mint…", "signatures": ["…"] }, { "mint": "Mint…", "costSol": 0.2 }, { "mint": "Mint…", "basis": "mark" } ],
  "exclude": [ "Mint…" ],            // never adopted (WSOL never is)
  "excludeStateDirs": [ "../other-bot/state" ],  // any mint open there is never adopted, checked every step
  "minValueSol": 0.001,              // dust below this
  "maxTransferFeeBps": 0,            // a token-2022 transfer fee over this refuses the mint
  "noBasis": "skip",                 // or "mark": what an exit that needs a basis gets when none is found
  "historyPages": 3,                 // pages of 100 signatures per token account for the basis from chain
  "everyMs": 15000
}
```

Pass an `Adopter` as `EngineDeps.adopter`: its step runs in each full cycle, it replaces the surplus alert (it follows
the wallet itself), and its `sellCheck` must pass before any sell of an adopted bag is booked.

- **Quantity** is always the wallet's balance (`qty_source: "wallet"`).
- **Basis**, in order: the given signatures (each a buy of the coin by this wallet, read from chain; their average
  cost per token, for every token held); `costSol`; the
  wallet's own buys in its history (tokens in and SOL out; transfers and airdrops are not buys), their average cost per
  token times the tokens held; else none. The source is on the `adoptions` row and in the position's entry.
- **Never adopted:** a frozen token account; a mint that fails the junk check (below); a coin with no venue the core
  can price; dust; a coin open in another bot's ledger, or one whose buy there failed but may have landed (that bot's
  `sell` can still reopen it); an excluded mint; a coin this bot managed before (closed or released) unless an `adopt`
  request names it. Each skip is logged with its reason and looked at again after 10 min; a read that failed (an RPC
  error, a rate limit) after 1 min, and is not taken as a verdict on the coin. One step looks at 20 coins at most
  (least recently looked at first), so a wallet full of airdropped junk is worked through over several steps.
- **Other bots' ledgers** are opened read-only with a 250 ms busy timeout, read with one query, and closed. SQLite in
  WAL mode never blocks a writer for a reader, and no lock is held between steps. One that cannot be read stops new
  adoptions and growth for that step and is alerted. A sell of an adopted bag uses the last good read for up to 5 min
  when a fresh one fails (a busy moment never holds a stop); past that the sell is held and `adoption:exits_blocked` is
  alerted. A mint that turns up open there after it was adopted here is released: no longer managed, nothing sold.
- **Bags that change outside the bot** (seen on two reads at least 60 s apart, with no order of the coin in flight):
  more tokens grow the position, at the cost of a buy found in the history since adoption, else at the position's
  average entry (a transfer never lowers it); fewer tokens shrink it and the difference is written down (never booked
  as a sell, never sold); at zero it closes. Both are alerted.
- `adopt()` is public: batch 4's wallet mirror books a copied buy through it (list mode, the buy's signature as basis).

**Mint checks** (`market/mint`): `decodeMint` reads SPL Token and Token-2022 mints and their extensions; `junkReason`
refuses a transfer hook with a program set, a permanent delegate, non-transferable, a frozen default account state, a
paused mint, confidential transfers, a transfer fee over the cap, and any extension it does not know. Metadata, group,
close-authority, interest-bearing and scaled-UI extensions pass (they never change who controls a transfer). An
adopted bag's mint is checked again before each sell (at most a minute old).

## Trailing stop

`"exit": { "strategy": "trail", "trailBps": 2000, "activate": 1.5, "sell": 0.5 }` sells when the price falls
`trailBps` under the highest price since entry or adoption. `activate` (optional, needs a basis) arms it only once the
high reached that multiple of the entry. `sell` (default 1) is the share of what remains each hit sells; after a
partial hit that fills, the mark restarts at the price of the hit, so the next hit needs another full fall from a new
high. A partial sell that ends without filling (refused, reverted, out of attempts) leaves the mark where it was. The mark is
kept in the ledger (`trail_marks`, created on first use), so a restart does not reset it. A gap through the trail sells
at the price then, like any stop.

## PAUSE_SELLS (opt-in)

With `EngineDeps.pauseSells`, a `PAUSE_SELLS` file in the state folder holds every exit the strategy would take; reads,
prices, peaks and trail marks go on. `sell` by hand still works, and a sell order already booked before the file
appeared keeps going (it may be in flight). Remove the file and the next tick decides again.

## The Candle CLI's file store as the signer (opt-in, linked payer)

`"signer": { "store": "candle-cli", "passphraseEnv": "CANDLE_KEYRING_PASSPHRASE" }` reads the key signer from the
Candle CLI's own encrypted file store (`credentials.enc` in `configDir`, default `$CANDLE_CONFIG_DIR`, else
`~/.config/candle`). That is where the CLI keeps signers on a machine with no OS keychain. The signer is picked from
the CLI's index (`config.json` `keySigners.entries`) by key prefix and the wallet's signer quorum, and its public key is
checked against the index.
- Read-only: the bot never writes the store.
- Fail closed: a wrong passphrase, a missing or ambiguous index entry, an entry in a format this version does not know
  (CLI 0.13.9's: PBKDF2-SHA256 and AES-GCM-256, the SDK's `EncryptedFileSecretStore` format), or a public key that
  does not match the index each refuse. None of them guesses.
- The passphrase comes only from the named environment variable, and is redacted from every log line.
- `scripts/cli-signer-check.ts` checks a store offline: it loads the signer, prints its CNDL fingerprint, and signs
  and verifies a test payload.

## Only known programs are signed (opt-in, linked payer)

With `ExecutorDeps.knownPrograms`, a built transaction is parsed before signing: if a top-level instruction calls a
program outside the set (`exec/trader` `KNOWN_PROGRAMS`: System, compute budget, both token programs, ATA, memo,
Jupiter v6, DFlow, pump.fun, PumpSwap, Candle's curve, DAMM v2), or the transaction cannot be read, it is never signed:
the order ends `rejected` (`UNKNOWN_PROGRAM` / `UNREADABLE_TX`) and is alerted. Inner calls are not visible this way: a
token's transfer hook is caught by the mint check instead. The embedded wallet cannot be checked: Candle signs inside
the build.

**Transaction versions.** A linked-payer build of version 1 or later (its first byte is the version, not the signature
count) is never signed: the order ends `rejected` (`TX_VERSION`) and is alerted, because its signature could not be
saved before submit. `signatureOfSigned` and `blockhashOfSigned` refuse such bytes too. Legacy and v0 read as before.

## A floor on sells (opt-in, linked payer)

`ExecutorDeps.sellFloor` (`market/reader` `sellFloor(rpc, slippageBps, marginBps)`): before a linked-payer sell is
signed, the coin's venue is read again and its own expected out computed (pump.fun venues). If Candle's floor
(`minOutRaw`) sits more than the slippage plus the margin under it, the sell is not signed (`SELL_FLOOR`, alerted); the
next exit is a new order. A read that fails, or a venue without the math (Candle's curve, DAMM v2), means no check:
Candle's own floor still applies. The embedded wallet executes inside the build, so this cannot run there.

(0.6.0) The reader's `sellFloor` answers only for pump.fun venues (the pump curve, PumpSwap). On a Candle curve or DAMM
v2 coin, or when the read fails, it answers null, and only Candle's own floor applies.

## A floor on buys (opt-in, linked payer)

`ExecutorDeps.buyFloorMarginBps` (0.6.0): a buy build whose `minOutRaw` is under the order's decision fill, less the
order's slippage and this margin, is never signed (rejected, `BUY_FLOOR`, alerted). This covers the first attempt too;
the venue rechecks only run on retries. The decision fill is the engine's checked value at booking, else the first
build's quote. With payer `main` it does not apply, since Candle signs inside the build.

## Holders of a coin (polled)

`sources/holders` (0.5.0): `HolderPoller(rpc).snapshot(mint)` gives the wallets among the 20 largest token accounts
(one `getTokenLargestAccounts`, owners resolved once each with `getMultipleAccounts`, one `getTokenSupply`), summed
per owner, largest first. Accounts owned by programs (addresses off the ed25519 curve: curves, pools, vaults) are left
out. A malformed answer throws: unknown, never "nobody holds it". `balanceOf(owner, mint)` reads one wallet's holding.
`holderDiff(prev, cur)` gives each owner's change (an owner gone from the list is left out, not counted as zero).
`creatorOf(rpc, mint)` names a coin's creator: the pump.fun curve's `creator`, else the fee payer of the mint's oldest
transaction (paged, capped; on Candle often a payer wallet).

It is a poll: lag is the interval plus about a second. A streamed source can replace it behind the same two calls
(`HolderSource`: `snapshot`, `balanceOf`), keeping its own state.

## A price and volume series per coin (opt-in)

`sources/series`: a `SeriesStore` keeps 1 min bars per coin, at most `maxBars` (default 1440, 24 h) and `maxCoins`
(default 200). A `SeriesSource` answers `series(mint)` with `{ bars, lastTick, gaps }`, plus `subscribe`,
`unsubscribe` and `watched`. Give one to the engine as `EngineDeps.series`, and a trigger reads it as `ctx.series`.
- **A bar is complete** only when its minute has ended, lies wholly inside the time the coin was watched, and no gap
  touched it.
- **A gap is unknown, never zero volume.** A gap is any of: a coin still subscribing, a reconnect, a subscription
  refused or not confirmed, the subscription cap, the coin cap, a venue with no trade-log source, a coin not quoted in
  SOL. A quiet minute with no gap is a true zero.
- **Nothing is backfilled.** A bar from any later backfill would say `backfilled: true`.
- **Gaps are bounded without losing one.** Closed gaps with the same reason that share a bar merge. Past `maxGaps`
  (default 200) the oldest closed gaps merge into one span over both, so the bars between them read incomplete too:
  many sparse gaps (an unreadable log here and there) can make most of the 24 h read incomplete. That fails safe; a
  rule that needs complete bars then waits.

`sources/logsSeries`, a `LogsSeries` (a `SeriesSource`):
- **Volume** comes from the trade events in each coin's own logs subscription: its pump.fun curve PDA, or its
  canonical PumpSwap pool, at `confirmed` commitment. Failed transactions are dropped, and each transaction is counted
  once.
- **Price** comes from the core's market reads (the curve's and the pool's effective reserves).
- **The PumpSwap pool-to-coin map** is built from the pool account (its base mint, quoted in WSOL), never from an
  event.
- **One websocket carries every coin** (`solana/logs-multi`), up to `maxSubscriptions` (default 50; a probe on the
  public RPC held 100). Coins past the cap are a gap, and alerted.
- Candle curve and DAMM v2 coins have no trade-log source in this version: price only, and their volume is a gap.
- **Which events count:** a trade event counts only from its own program's frame in the log's invoke stack: pump for
  `TradeEvent`, PumpSwap for `BuyEvent`/`SellEvent`. A line any other program logs is ignored, and a stack the log
  cannot account for (a depth mismatch, `Log truncated`) ends reading for that transaction. The log copy of each
  event is used; pump's self-CPI copy of the same event is ignored.
- **Liveness:**
  - A stall (no message, not even a ping reply, for 90 s) is a gap from the last message, and the socket is rebuilt
    at once.
  - A notification more than `maxSlotLag` slots (default 150) behind the chain, judged against a `getSlot` read every
    30 s, puts every coin in a gap until notifications catch up.
  - A coin is in a `resolving` gap until its venue is read.
  - A refused or unconfirmed subscription is retried with backoff and alerted after 3 failures in a row.
  - A socket that does not open (or does not finish closing) within 15 s is dropped and replaced; one reconnect is
    pending at most.
  - A subscribed coin whose market price moves more than `silencePct` (1 %) from its price at the last trade log, and
    stays moved for `silenceMs` (45 s) with no log, had trades the socket did not deliver (a subscription the server
    dropped without saying). The clock starts at the move, so a quiet coin's first trade, seen by a price poll a
    moment before its own log, is not a verdict. Its bars since the last log are a gap (`logs silent`), alerted once
    per coin, and it is subscribed again in place (no socket rebuild); the gap ends when that is confirmed. A dropped
    subscription on a coin whose price stays flat is not caught.
  - Unsubscribes the server leaves unanswered (each may keep a subscription on its side) are counted; past
    `maxUnansweredUnsubscribes` (20) the socket is rebuilt, which drops them all.
  - A transaction whose log cannot be read to its end (truncated, or an unaccounted invoke stack) makes that minute a
    gap, counted (`partialLogs`) and alerted. So does a trade event whose quote cannot be read. A coin quoted in
    another token is an open gap for as long as it is watched (its SOL volume is never known).
- **Times:** a trade is placed in the bar of the moment it was received, not its block time (usually seconds apart,
  more under a lag, which is then a gap). While a coin moves from its curve to its pool, the market read says
  `migrating` and the coin has no log source (a gap) until the pool is found.

`sources/candleFeed`, a `CandleFeed`:
- It reads Candle's public market feed (`/api/v1/markets/feed`, no key): one or more of the buckets `new`,
  `graduated`, `onfire`, `bluechip`, `finalstretch`, incrementally through `since_seq`.
- It keeps each coin's rolling `volume5m` / `volume1h` / `volume24h` (USD) and `priceUsd`, **each with its own
  observed time**, labelled `candle-feed` and never complete. It writes no bars, and never folds one window into
  another.
- Failed polls (a 503 after a server restart included) back off and are alerted.
- Times come from the feed only: a window's own `marketObservedAt`, else the row's `updatedAt`. The 5 m and 1 h
  windows never have their own, so they take the row's time. A value with no time is stale and never fires. A full
  page (500 rows) is alerted and the bucket is read in full next time.

`sources/watchlist`, a `Watchlist`: which coins to watch.
- **Sources:** a fixed list (never dropped), coins a bot pushes for a while, and a feed bucket (by 5 m volume), within
  one cap.
- A feed coin leaves after `dropAfterMs` out of the feed.
- **Hysteresis:** coins already watched rank by their 5 m volume times `feedStickiness` (default 1.25). A
  newcomer takes a place only by trading 25 % more than the coin it displaces, so coins at the cut do not churn,
  and a much hotter coin gets in at once.
- The cap is alerted when it leaves coins out.

`market/indicators` (pure, on ended bars, each with `complete`): `fallFromHigh`, `riseFromLow`, `volumeVsBaseline`
(ratio and z-score), `vwap`. `market/pumpEvents` (pure) decodes pump.fun `TradeEvent` and PumpSwap `BuyEvent` /
`SellEvent` from `Program data:` log lines. `sources/replay`: `SeriesRecorder` writes snapshots, and `ReplaySeries` /
`replay()` serve them back by time, so a rule can be run on a recording; the same recording gives the same decisions.

## Buying on the series (opt-in)

`seriesBuy` gives a `SeriesBuyTrigger(name, prefixes, deps, rule, options)`: a trigger that runs a rule
(`(view, mint, feed) => { reason, numbers } | null`) on every coin of a watchlist and buys where it fires. The dip
buyer and the spike rider are built on it.

- **Each poll:** the coins the bot holds are pushed onto the watchlist (a series-aware exit keeps their bars), the
  watchlist steps, the series is read, and the rule runs on every watched coin not held. A coin whose rule fires is
  a candidate, then cools down for `cooldownMin`.
- **decide:**
  - The rule runs again on the series as it is now.
  - The coin's venue is read fresh. Only a pump.fun curve or the canonical PumpSwap pool is bought.
  - The venue's buy math must quote the ticket, and `buyQuote` refuses mayhem-mode and cashback venues, other
    quote mints and buys past the curve's tokens. These are skipped **before any attempt**: the executor's recheck
    only covers retries.
  - The impact must be within `maxImpactBps`.
  - The verdict's expected fill is the venue's own value, never a lower one. The engine keeps the smaller of it and
    its own read, so a lower value would loosen the drift check. The verdict also carries a deadline,
    `buyWithinSec`.
- Pair it with EngineDeps `pumpBuys`, `series`, `exitSeries` and `venues: { pump: true }`, and ExecutorDeps
  `pumpBuys`. `runtime.parts(..., { venues })` prices dry runs on the same venues.

`sources/stack` holds the `watchlist` and `series` config sections every series bot shares
(`parseWatchlistSection`, `parseSeriesSection`), `seriesStack()`, which builds the LogsSeries, the Candle feed and
the Watchlist from them, and `checkWindows()`, which refuses a rule or fade window that cannot fit in `series.maxBars`.

**Series-aware exits:** with `EngineDeps.exitSeries` (and a `series`), the exit strategy gets `MarketView.series`:
the coin's view, or null when it is not watched. Without it the field is absent and `MarketView` is as before. The
`fade` strategy reads it:

```json
{ "strategy": "fade", "stopLoss": 0.7, "takeProfit": 2, "fadeRecentBars": 5, "fadeBaselineBars": 20,
  "fadeBelowRatio": 0.25, "dropWindowBars": 15, "dropFromHighPct": 25, "minHoldMin": 5, "maxHoldMin": 360 }
```

It sells everything on the first of:
- take profit or stop loss (multiples of entry);
- volume fade: the last `fadeRecentBars` trading under `fadeBelowRatio` of the `fadeBaselineBars` before them;
- a drop: the last close `dropFromHighPct` under the high of the last `dropWindowBars` bars after entry (the entry
  bar and earlier never count, so a fall it bought into is no reason to sell);
- `maxHoldMin`.

The series rules act only on complete bars and after `minHoldMin`. The fade rule's recent bars and the drop rule's
window are bars wholly after entry. With no series, or a gap, they hold and the price rules still apply, so with a
series rule `stopLoss` or `maxHoldMin` is required.

## The event exit (opt-in)

`strategies/event`: a phased exit keyed to a coin's dated event. The bot fills `events` (mint to event time, ms), e.g.
through `runtime.parts(..., { exitParams: { events } })`. The phases:
- build-up: optional ladder `rungs` and `stopLoss`;
- hedge: from `hedgeAtMin`, keep at most `hedgeKeep`;
- core: from `afterMin`, keep at most `coreKeep`;
- core exit: `coreTakeProfit` or `coreMaxHoldHours`.

Every phase is a target for the share of the original kept, so it never sells twice. The event bot's README has the
details.

## Watch-only bots

`watch.ts`: `parseWatchConfig` takes the shared keys a watcher has (`mode: "watch"`, `apiUrl`, `rpcUrlEnv`,
`rpcWsUrlEnv`, `stateDir`, `loopMs`, `alerts`) plus the bot's sections. **Every trading key is refused**:
`wallet`, `apiKeyEnv`, `payer`, `signer`, `buy`, `sell`, `exit`, `retry` and the wallet ids. So a watch-only config
can never trade.

`runWatch` runs a `Watcher`'s `step()` every `loopMs`, with the lock, a ledger for alert dedupe, the alert sinks,
`STOP`, signals and `status.json`. It builds no executor and no trade rail, and reads no key.

**Alert sinks** (any bot, opt-in): `alerts.discordWebhookEnv`, posted as Discord messages; `alerts.telegram:
{ botTokenEnv, chatIdEnv }`, posted through the Bot API. Besides those, there are the existing `webhookEnv` and
`command`.

## Timed runs and lots (opt-in)

`scheduler` (batch 5): a `Scheduler` runs schedules on a fixed grid, every `everySec` (at least 10 s), optionally
anchored to a UTC time of day (`atUtc`), with `jitterSec`, `maxRuns` and `until`. `parseSchedule` reads one from a
config object.
- **Claimed before acting.** `due()` claims each due run in one ledger transaction (run count, run in flight, next
  slot) before the bot acts on it. A restart finds the run in flight (`inflight()`), never due again; the bot settles
  it and calls `finish(id, run, status, detail)`. `setRef` keeps what the bot needs for that (its orders).
- **A run in flight blocks the next** of its schedule.
- **Missed slots** (the bot down, or a run still in flight): `missed: "skip"` (default) runs nothing for them;
  `"once"` runs one catch-up run however many were missed. A slot within `graceSec` plus the jitter is on time.
- Jitter is drawn once per slot and stored. A changed grid re-anchors after the last slot run; the history stays.
- Two tables in the bot's ledger (`schedules`, `schedule_runs`), created by the Scheduler; dry and live rows apart.

`lots`: for a bot that buys one coin many times, one position per buy (a lot). `withLots(cfg)` lifts
`buy.maxPerCoin` for that bot (the parser keeps 1 for every other bot). The sell clamp, the surplus check and the buy
recovery already count every position of a coin, and one attempt per coin runs at a time.
- `sellLots(engine, ...)` sells an amount over a coin's lots through `Engine.placeSell`, the largest lot first; a lot
  with an order in flight is passed over; a lot sold in part is the last order.
- `WalletLots` is an adoption hook (`EngineDeps.adopter`): a configured coin the wallet holds, in which the bot has
  never had a position, is booked once as a lot (the balance on chain, the junk check, a priceable venue,
  `minValueSol`, cost at the mark). Tokens that turn up later are alerted (`coin:<mint>:surplus`), never booked. A
  wallet lot's mint passes the junk check again before each sell. `ready` turns true after its first step.
- `LotExits` runs the bot's exit on the lots it bought and holds the wallet lots.
- `runBuyOrders` finds a run's buys again by the `{ schedule, run }` in their entry context, after a restart too.

candle-dca-bot and candle-rebalancer are built on both.

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
`/exec/fills`, `/market/reader`, `/market/curve`, `/market/pump`, `/market/mint`, `/adopt/adopter`, `/solana/rpc`, `/solana/pda`, `/solana/base58`, `/solana/logs-ws`,
`/strategies/load`, `/strategies/types`, `/sources/candleLaunches`, `/sources/holders`, `/sources/series`, `/sources/logsSeries`, `/sources/candleFeed`, `/sources/watchlist`, `/sources/replay`, `/sources/stack`, `/seriesBuy`, `/strategies/fade`, `/strategies/event`, `/market/indicators`, `/market/pumpEvents`, `/solana/logs-multi`, `/watch`, `/alerts`, `/log`, `/redact`, `/scheduler`, `/lots`.

In a checkout of the repo, the `source` export condition (`node --conditions=source`) resolves them to the
TypeScript sources, so nothing needs building while you work.

## License

MIT
