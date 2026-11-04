# Changelog: candle-bot-core

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
