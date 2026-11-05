# Changelog: candle-bot-core

## 0.5.0

New API for bots that manage bags they did not buy, and for pump.fun venues. Everything is opt-in: a 0.4.x bot works as
is, its reads, ledger and orders unchanged.

- **pump.fun venue readers (money path), `market/pump`.** Bonding curve, canonical PumpSwap pool (with its signed
  virtual quote reserve), token accounts and pump's fee tiers decoded; `pumpCurveSell` and `pumpPoolSell` give a sell's
  SOL out after fees. Reproduced to the lamport on eight real mainnet sells. Refused, never guessed: a non-SOL quote, a
  mayhem PumpSwap pool, a pool whose base is not the coin.
- **`readMarkets(..., { pump, reserves })`**: venue found per mint from chain (`pump-curve`, `pumpswap`, `migrating`,
  `no_venue` besides Candle's curve and DAMM v2); real SOL per venue; `expectedSellOut`. `MarketView.venue` gains
  `pump-curve` and `pumpswap`. `dryPricer(..., { pump })` prices dry sells by the venue's math. Without options the
  read is 0.4.0's.
- **Mint checks, `market/mint`**: `decodeMint` (SPL Token, Token-2022 extensions) and `junkReason`.
- **Adoption, `adopt/adopter`**: `Adopter`, `parseAdoption` (list or whole wallet, `exclude`, `excludeStateDirs` read
  read-only every step, dust floor, transfer-fee cap, `noBasis`); basis from signatures, by hand, from the wallet's
  history, or none; bags followed as they grow or shrink outside the bot; `released` positions; `adopt` / `release`
  request files. Tables `adoptions`, `adoption_sigs`, created only by an Adopter.
- **Engine**: `EngineDeps.venues`, `.adopter` (its step in each full cycle; no surplus alert with one; its sell check
  before each sell of an adopted bag), `.pauseSells` (`PAUSE_SELLS` file). The engine's expected SOL out is recorded on
  pump-venue sells.
- **`trail` exit** with the mark kept in the ledger (`trail_marks`, created on first use); `ExitStrategy.needsBasis`,
  `.trailMark`; `Decision.resetTrail`; `PositionView.trailPeakSol`. Built-in strategies say whether they need a basis.
- **`ExecutorDeps.knownPrograms`**: a linked-payer build calling a program outside the set, or unreadable, is never
  signed (`UNKNOWN_PROGRAM` / `UNREADABLE_TX`). `programIdsOf`, `KNOWN_PROGRAMS` in `exec/trader`.
- **`ExecutorDeps.sellFloor`** (linked payer, sells): Candle's floor is checked against the venue's own price read just
  before signing (`SELL_FLOOR`). `sellFloor()` in `market/reader`.
- **Holder poller, `sources/holders`**: `HolderPoller` (largest accounts per owner, program-owned accounts left out,
  owners cached, a malformed answer throws; `balanceAt` and snapshots carry the answer's slot), `holderDiff`,
  `creatorOf` (a failed read throws `CreatorReadError`, never "no creator"); exported from the root as well.
- **`signer.store: "candle-cli"`** (opt-in): the Candle CLI's encrypted file store, read-only, with the keyring
  passphrase from `passphraseEnv` (`exec/cliStore`: `readCliEntry`, `cliFingerprint`); fails closed on any format
  it does not know. `scripts/cli-signer-check.ts`: an offline check of such a store.
- **Fix:** a build of a transaction version 1 or later is never signed (`TX_VERSION`, alerted; any bot, linked payer),
  and `signatureOfSigned` / `blockhashOfSigned` refuse such bytes instead of reading a wrong signature. Legacy and v0
  transactions, which Candle builds today, read as before.
- `Engine.market(mint)`: the last exit tick's read of a coin.
- **Transactions are read up to version 1** (`getTransaction`, `openFromFill`, the launch source):
  `maxSupportedTransactionVersion` 1, where 0.4.0 asked for 0 and the RPC refused a v1 transaction (-32015). Fills of
  v1 transactions book from their JSON as before (checked on two real v1 sells). Signing a v1 build stays refused
  (`TX_VERSION`).
- PDAs: `pumpCurve`, `pumpPoolAuthority`, `pumpSwapPool`, `pumpFeeConfig`; program ids `PUMP_PROGRAM`,
  `PUMP_AMM_PROGRAM`, `PUMP_FEE_PROGRAM`.

## 0.4.0

New API for bots that buy graduated coins or watch Candle launches. A 0.3.x bot works as is: none of its paths change.

- **DAMM v2 expected fill (money path).** `decodeDamm` also reads the pool's liquidity, max price, status, fee mode
  and base and dynamic fee fields; `dammBuy(pool, mint, lamports)` (pure) gives the fill and impact of a buy on the
  pool, the coin on either side. The fee is the pool's lowest base fee (exact on a flat-fee pool with no dynamic fee,
  as Candle's are; otherwise an upper bound on the fill). Checked against mainnet pools: token A's vault equals the
  reserve math to the raw unit, and a real buy's output is reproduced exactly.
- **The engine's expected fill on a graduated coin.** When the coin's curve is migrated, the engine reads its DAMM v2
  pool (the keeper's PDA, its creator checked against the curve's authority) and the expected fill is the smaller of
  the trigger's and `dammBuy`'s, as on the curve. An unreadable pool keeps the trigger's (logged
  `expected_fill_unverified`, why `pool not readable at the buy`). Before, a graduated coin always kept the trigger's.
- **`ExecutorDeps.dammBuys`** (default false): a graduated coin's buy retry rechecks the pool against
  `maxBuyImpactBps` twice: the ticket's impact there, and the price move since the decision (the ticket must still buy
  the order's expected fill less that many bps; the impact alone falls as the price rises). `IMPACT` past either,
  `POOL` for a pool that does not match, a read failure waits. Without it, as before, such a retry ends `CURVE`.
- `dammBuy` refuses (`pool_layout`) a fee mode or scheduler mode it does not know, rather than guess the fee.
- **`MarketRead.pool`**: the decoded pool for a graduated coin. Dry fills price a graduated coin's buy on its pool.
- **`Engine.openFromFill({ mint, signature, decimals?, reason, entry?, expectedQtyRaw? })`**: opens a position from a
  buy the engine did not place (a launch's dev buy; later, an adopted bag). Quantity and cost come from the
  transaction on chain (the wallet's deltas, fee and own-ATA rent apart), never from an API's number; a filled buy
  order `fill-<signature>` is booked with it, so the caps count it and the exits, the clamp and `sell` treat it as any
  position. Refused, nothing booked: a transaction that cannot be read, failed, gave no tokens, or cost no SOL
  (`no_spend`: a transfer or airdrop); a signature any order already carries (`already_booked`,
  `signature_other_mint`); decimals that disagree with the transaction's; a coin an attempt holds (`mint_busy`: the
  call holds the coin as the uncertain-buy scan does). A booking race answers `ok: false`, never throws. An
  `expectedQtyRaw` more than 1 % off the chain is logged and alerted (`fill_disagrees`). Live only.
- **`retry.maxPriceDriftBps`** (config, opt-in, unset by default): a curve buy's retry must still buy at least the
  order's decision fill less that many bps (`IMPACT` otherwise; an order with none ends too), so a retry cannot rebuild
  into a pump. Unset: exactly 0.3.1's curve recheck. Under `dammBuys` a pool retry with no decision fill ends `POOL`.
- **`orders.decision_out_raw`**: the fill both drift checks hold every retry to, set once (at booking, else from the
  first build quote) and never overwritten, so the limit does not compound per attempt (`expected_out_raw` still
  follows each build's quote, for the adoption cap). Added only by an Executor with a drift check on
  (`Ledger.ensureDecisionColumn`); without one the ledger is never migrated. Older orders fall back to
  `expected_out_raw`.
- **`Trigger.stop()` may return a promise**; `run` awaits it before the ledger closes (a trigger with a call in flight
  finishes it). A throwing `stop` is logged (`trigger_stop_failed`) and the ledger still closes.
- **`sources/candleLaunches`** (root export `CandleLaunches`): candle-launch-bot's launch detector (Candle's token
  list and the curve program on chain, deduped by mint, latency from block time), moved into the core unchanged so
  every bot that watches Candle launches shares it.

## 0.3.1

An alert, nothing else. A 0.3.0 config and trigger work as is.

- **`profile_risk_limit` alert.** When Candle answers an order attempt with `RISK_LIMIT_REACHED` (it has stopped the
  profile: every order is refused until an account owner clears it), the executor raises the alert key
  `profile_risk_limit` through the configured sinks (command, webhook), with the side, the mint and the order. One key
  for the profile: deduped across coins and re-announced on `alerts.renotifyMs` while refusals keep coming. The order is
  classified and retried exactly as in 0.3.0, and an alerter fault never reaches it. `RISK_LIMIT` and `RISK_LIMIT_KEY`
  are exported from `candle-bot-core/exec/executor`.

## 0.3.0

Order attempts run outside the money lock. The money rules are unchanged. A 0.1.0 or 0.2.0 trigger works as is.

- **Attempts off the lock (`Engine.run`).** Every order attempt (job read, build, sign, submit, settle) runs on its own
  instead of inside a sweep under the money lock. Under `run()` the lock is now held only by the exit tick's exits pass
  and the full cycle's short ledger steps (alerts, the surplus verdicts, status.json). A booking is one synchronous
  ledger transaction (the caps checked inside it, as before) and holds no lock.
- **One attempt per order, one per coin.** The Executor keeps the attempts it runs in memory (`live`) and every claim
  excludes them, whatever the order's lease says. A lease can run out while an attempt is still in its Candle calls;
  inside one process that no longer lets a second attempt claim the order. The lease (180 s) is unchanged and still
  covers a restart after a crash. At most one attempt per coin is in flight: a buy and a sell on one coin, or an
  uncertain buy's adoption scan and another attempt on that coin, never overlap. Balance decisions hold their coin too
  (`Executor.reserveMint`): a sell's clamp (`placeSell`) and a manual `sell` (its reopen scan included) run with no
  attempt on that coin live.
- **`buy.concurrency`** (new config key, default 4, 1 to 64): buy attempts in flight at once. 1 is 0.2.0's one at a
  time. **Sells have no limit and never wait for a buy.** When an attempt ends, the next due order starts at once
  (it no longer waits for the next cycle's sweep). Buys already booked wait for a free slot in claim order; one that
  waited longer than `exitMs` gets the impact recheck before its first build, as a retry does (no chasing a pump).
  With every slot taken, buys that may already have executed (a saved signature, a main-payer build) still settle
  beside them, settle-only, at most once per `loopMs`, so a landed buy is booked (and its exits run) while other buys
  hang. **An existing config gets 4 on upgrade**: set `buy.concurrency: 1` to keep 0.2.0's one buy at a time.
- **SOL with several buys in flight.** No reserve; the chain never overdraws. What happens to a buy the balance
  cannot cover, by payer (the `lifetimeSol` rule itself is unchanged: a rejection counts unless nothing was signed):
  - **embedded** (payer main): Candle executes inside the build and checks the balance there, so the buy is refused
    before execution: `rejected`, unspent, **not** counted toward `lifetimeSol`;
  - **linked**: Candle can build several buys against the same balance; each is signed and its submit is refused (at
    most `buy.concurrency - 1` of them). The executor ends it as any failed submit (signature checked on chain, its
    blockhash expired, then a rebuild Candle refuses): `rejected` after signing, **counted** toward `lifetimeSol`.
  Fund the wallet for what the caps allow, or set `buy.concurrency` 1.
- **STOP:** no attempt starts after STOP, no attempt starts a new build after it (one claimed before STOP settles what
  it has and hands the order back), and nothing is signed or submitted after it: a linked-payer build under way at
  STOP finishes, its unsigned transaction is dropped (it can never land) and the order goes back as it was. Known:
  that attempt still counts toward `retry.maxAttempts`. A submit already under way, or a main-payer build (Candle sends it inside the build), is followed
  to its end. `run()` returns after every attempt in flight has ended. **PAUSE_BUYS** is read again right before each
  buy build, with nothing awaited in between, and after the recheck read of a long-built job's probe and of a failed
  job's final check.
- **Exit tick:** due orders start first (never awaited), then the market read, the exit strategy on each position's
  row as it is after that read (a sell that filled meanwhile counts), and the crossing coins' balance reads all at once
  (`BALANCE_READS`, 16 at a time); each sell is booked and started as soon as its own read is back, and only if the row
  has not changed since the strategy decided. One sell that throws ends neither the others nor the pass. A stuck sell
  (one whose attempts keep failing) runs on its own backoff beside fresh ones and holds up none.
- **Batched curve reads.** A trigger that sets `readsCurves: true` (new, optional; the launch bot does) gets every due
  candidate's curve read in one `getMultipleAccounts` (100 keys a call) before its decides, each cached under its own
  key and time exactly like a single read (`ctx.readCurve` returns the same frozen copy; reused for at most `exitMs`).
  A batch that fails falls back to one read per curve (`curve_batch_failed`, logged). The fill bound still uses the
  engine's own read at most `exitMs` old.
- **Stop-loss timing.** A crossing is acted on by the next exit tick (at most `exitMs` later). Before its sell is
  built, only these can come first:
  - the lock's current holder, which under `run()` is never an order attempt, a booking or a trigger call: an earlier
    exit pass still in its reads (below), or a short ledger step (alerts, surplus verdicts, status.json);
  - the tick's one batched market read (`getMultipleAccounts`);
  - the coin's balance read (all crossing coins read together, 16 at a time);
  - an attempt already live on the same coin: with `maxPerCoin` 1 only that position's own earlier sell, which the
    exits pass waits for anyway (one exit in flight per position).

  No buy attempt, however slow or hung, and no other coin's sell comes first. Under an RPC outage each read is bounded
  by the RPC timeout (15 s): a crossing that comes while a pass is stuck in its reads waits for that pass, then its own
  pass's two reads, so the worst case is about `exitMs` + 4 × the RPC timeout (about 60 s) before the build starts. No
  Candle call comes before the sell's own build. One more cost, not a lock: the ledger commits to
  disk on every write (`synchronous=FULL`, unchanged), so a burst of many attempts at once keeps the process busy for
  a few ms per write. Measured on the bench (80 ms RPC, 150 ms Candle build, `exitMs` 500, median of runs):
  - with 6 s buy builds and launches arriving (0.2.0's probe P5): 0.3 s, worst 0.6 s (0.2.0: 4.7 s, worst 6.4 s);
  - with every buy build hung (no answer at all): under 0.8 s in the test suite;
  - 20 positions crossing at once, to the last sell build: 0.35 s, worst 0.8 s (0.2.0: 11.6 s);
  - at the start of a 50-launch burst: 0.8 s, worst 0.9 s (0.2.0 the same);
  - one crossing, nothing else going on: 0.4 s, worst 0.65 s (0.2.0: 0.5 s, worst 0.8 s).
- **Callers of `engine.cycle()`** keep 0.2.0's behavior: the whole cycle under the lock, attempts awaited in its
  sweeps, STOP between orders. `engine.lane()` keeps its 0.2.0 booking path too.
- Ledger: `claimDue` takes `excludeMints` (additive). Executor: `startDue`, `drain`, `liveCount`, `mintBusy`,
  `reserveMint`/`releaseMint`, `mintEpoch` (additive). The surplus check skips a coin whose attempt started or ended
  while its balance was read. A crash inside an attempt's last-resort handler is logged (`order_attempt_crashed`), never
  an unhandled rejection. No change to refusal rules, adoption, fills, the lease, or ledger durability.

## 0.2.0

Speed, with the money rules unchanged. A 0.1.0 trigger works as is.

- **`Engine.run(loopMs)`**, the new run loop (`runtime.run` uses it). Three loops share one money lock:
  - **exit tick**: every `exitMs` (new config key, default 500 ms, 200 ms to `loopMs`), sells in flight, one batched
    market read for the open coins, the exit strategy, new sells. With no open position the tick does nothing (no
    RPC). With 20 open positions at 500 ms it costs 2 `getMultipleAccounts` calls a second.
  - **full cycle**: every `loopMs` after the last one ended: sell requests, settle buys, the orders sweep (5 orders,
    each under the lock on its own), alerts, the surplus check, status.json.
  - **entries**: polls on a wake (`ctx.wake()`, new, debounced 10 ms quiet / 50 ms max) or every `loopMs`, and decides
    pending candidates **outside the lock**, `trigger.concurrency` at a time (new, default 1). A waiting candidate is
    asked again after `loopMs`. A buy verdict takes the lock: STOP, the caps again, the booking transaction (the caps
    checked once more inside it), then that order's build and submit. A verdict that comes back after STOP books
    nothing.
- **Stop-loss timing.** A crossing is acted on by the next exit tick: at most `exitMs` later, the tick starts as soon
  as it gets the money lock (it goes first among the waiters). Before its sell is built, these can come first:
  - **the current lock holder**: a booking's whole buy attempt (build, sign, submit), one settle or orders attempt, or
    the sell-requests step (every manual request file, each with a `tokenBalance` read, and for a failed buy the
    `reopenFailedBuy` history scan);
  - **the tick's own leading sell sweep**: up to 5 sell attempts already due, before its market read and exits pass;
  - **the market read** (one batched `getMultipleAccounts`);
  - **with k positions crossing at once**: k `tokenBalance` reads one after another (each up to the 15 s RPC timeout)
    and the sells ahead of the last one.

  One attempt can chain several Candle calls (each up to the 45 s SDK timeout) and, for an uncertain buy, paged
  `getSignaturesForAddress` reads, so **there is no fixed ceiling in seconds under a Candle or RPC outage**. Typical:
  under 0.6 s with every decide hung (`exitMs` 500). With a slow buy build holding the lock, the stop-loss waits for
  that build: 6 s buy builds gave stop-losses up to about 6 s. A trigger call never holds the lock, so a slow or hung
  decide never delays an exit. Making a sell independent of a slow buy build is executor work for a later release.
- **One curve read per buy.** `ctx.readCurve(mint, address?)` (new) reads a Candle curve through the engine. A read is
  reused for at most `exitMs`; the expected-fill bound uses one at most `exitMs` old and not failed, else reads again,
  and checks that age again under the lock (a booking that queued for the lock reads again).
- **Trigger calls that never return.** One still running `HUNG_DROP_TIMEOUTS` (3) timeouts after it timed out is given
  up on: a decide's candidate is dropped (`candidate_dropped`), a poll is called again (`poll_abandoned`). The abandoned call may still be running, so a trigger's `poll` and
  `decide` must tolerate a second call starting while an earlier one has not returned (a late result is ignored).
- **Callers of `engine.cycle()`** (bots that drive the engine themselves, and tests) keep the 0.1.0 shape, entries and
  exits in one locked cycle, with two changes: an entries step decides for at most 1 s (`LANE_BUDGET_MS`; the next
  step resumes where it stopped, round robin), and wakes are not served (only `run()` serves them). `engine.lane()`
  runs one entries round (poll, then every due decide) for such callers.
- `Trigger.start(ctx)` gets the engine's context.
- Exit pass: prices written in one transaction, only where they changed. Surplus balance reads 8 at a time.
  `getAccounts` sends its 100-key chunks together.
- No change to the executor, fills, refusal rules, adoption, the ledger or its durability.

## 0.1.0

First release. Taken from candle-launch-bot 0.1.3 with the money paths unchanged:

- ledger (positions, orders, attempts, alerts; lifetime and open caps), with bot tables kept to the bot's subclass;
- executor and trade rails (linked TEE wallet, embedded wallet): fills read from chain, sell clamps, capped retries,
  refusal classification (including `not_broadcast` for main-payer buys), uncertain-order recovery and adoption;
- exit strategies `hold`, `ladder`, `preGrad`, `time`, `tpsl` and the plug-in loader;
- Candle curve and DAMM v2 market reads, impact; Solana RPC, PDA, base58 and logs-socket helpers;
- controls (`STOP`, `PAUSE_BUYS`, sell requests, the state-dir lock), `status.json`, alerts, redaction, logging;
- the engine loop with a cycle budget, driven by a bot's `Trigger` (new: `trigger.ts`), and bot config sections
  (new: `parseConfig(raw, baseDir, sections)`);
- one change in the executor: the buy-retry impact limit is a required dependency (`maxBuyImpactBps`) instead of
  the launch bot's `filters.maxImpactBps`;
- the engine holds its caps whatever a trigger does: candidates and verdicts are read once into frozen copies (mint
  must be an address, chain solana, buy reason a non-empty string, typed fields), `onVerdict` gets copies, the config
  is deep-frozen, `ctx.ledger` is a read-only view (`LedgerView`), each trigger call has a timeout
  (`triggerTimeoutMs`, default 10 s), and a buy's expected fill is bounded by the engine's own curve read;
- `runtime.ts`: the run loop, `status` and `sell` commands, rail and executor wiring for a bot's command line.
