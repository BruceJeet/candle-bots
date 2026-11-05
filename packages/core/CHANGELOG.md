# Changelog: candle-bot-core

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
