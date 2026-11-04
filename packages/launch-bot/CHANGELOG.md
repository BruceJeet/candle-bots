# Changelog: candle-launch-bot

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
