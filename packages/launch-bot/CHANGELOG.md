# Changelog: candle-launch-bot

## 0.4.4

- Pins candle-bot-core 0.6.0 (batch 3: opt-in additions only; no change in this package).

## 0.4.3

- On candle-bot-core 0.5.0 (pinned exactly). Same CLI, config, state dir, ledger, `status.json` fields, events and
  order handling: every 0.5.0 core addition is opt-in and this bot turns none on. One core fix reaches it (TEE wallet
  only): a build of transaction version 1 or later is never signed (the order ends `TX_VERSION`, alerted) instead of
  having a wrong signature read from it. Legacy and v0 transactions, which Candle builds today, go as before.
- Transactions of version 1 are now read (fills, launch transactions); before, the RPC refused them.

## 0.4.2

- New optional config key `retry.maxPriceDriftBps` (from candle-bot-core 0.4.0), unset by default: a buy's retry
  must still buy the order's expected fill less that many bps, so it cannot rebuild into a pump. Unset, nothing
  changes.
- On candle-bot-core 0.4.0 (pinned exactly). The launch detector moved into the core (`candle-bot-core/sources/
  candleLaunches`); `src/detect/detector.ts` re-exports it. With `retry.maxPriceDriftBps` unset, no behavior change:
  same CLI, config, state dir, ledger, `status.json` fields, events and order handling.

## 0.4.1

- On candle-bot-core 0.3.1 (pinned exactly): when Candle stops the profile and answers an order `RISK_LIMIT_REACHED`
  (every order refused until an account owner clears it), the alert `profile_risk_limit` goes to the configured
  `alerts` command or webhook, and again every `alerts.renotifyMs` while refusals keep coming.
- Nothing else changes: same CLI, config, state dir, ledger, `status.json` fields, events and order handling.

## 0.4.0

- On candle-bot-core 0.3.0 (pinned exactly): buy and sell attempts (build, sign, submit) no longer run under the
  money lock. A stop-loss sell is never queued behind a buy, including a buy whose Candle build hangs. Up to
  `buy.concurrency` buys build at once (new optional config key, **default 4**; set it to 1 to keep 0.3.0's one buy at
  a time). A burst of launches is decided and built in parallel, and its curves are read in one batched call instead
  of one each. STOP: nothing is signed or submitted after it.
- Same CLI, config file (one new optional key, `buy.concurrency`), state dir, ledger, `status.json` fields and events.
  With `buy.concurrency` 1, money outcomes are 0.3.0's. With more, buys can be built against the same SOL balance:
  the chain never overdraws, and a buy the balance cannot cover ends failed after its submit is refused (see the core
  CHANGELOG).

## 0.3.0

- On candle-bot-core 0.2.0 (pinned exactly): a launch the detector sees wakes the engine and is decided at once
  (about 0.1 s instead of up to `loopMs`), four launches at a time, outside the money lock; exits run on their own
  tick every `exitMs` (new optional config key, default 500 ms), so a slow Candle or RPC read in a launch's decide
  never delays a stop-loss.
- The curve is read once per buy (through the core's `ctx.readCurve`, shared with its expected-fill check).
- Same CLI, config file (one new optional key, `exitMs`), state dir, ledger, `status.json` fields and events; money
  outcomes unchanged. Events can come earlier and in a different order relative to the exit steps' events.

## 0.2.0

- Runs on [candle-bot-core](https://www.npmjs.com/package/candle-bot-core) 0.1.0 (pinned exactly): the ledger, executor, exit
  strategies, controls and engine loop moved there unchanged; this package is the launch trigger, its `filters` and
  `detect` config sections, `init` and `scan`. Lives in the candle-bots repo as `packages/launch-bot`.
- No behavior change: same CLI, config file, state dir, `status.json`, `events.jsonl` events and ledger file (a 0.1.3
  ledger opens with no migration).
- No direct dependency on `@candledottv/agent-sdk` any more (it comes through the core, same pin 0.6.14).

## 0.1.3

- The `not_broadcast` refusal rule (a main-payer buy that Candle refused before execution is unspent) is for buys.

## 0.1.2 and earlier

See the candle-launch-bot repository's history.
