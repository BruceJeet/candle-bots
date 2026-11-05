# Changelog: candle-graduation-bot

## 0.1.1

- On candle-bot-core 0.5.0 (pinned exactly). Same CLI, config, state dir, ledger, `status.json` fields, events and
  order handling: every 0.5.0 core addition is opt-in and this bot turns none on. One core fix reaches it (TEE wallet
  only): a build of transaction version 1 or later is never signed (the order ends `TX_VERSION`, alerted) instead of
  having a wrong signature read from it. Legacy and v0 transactions, which Candle builds today, go as before.
- Transactions of version 1 are now read (fills, launch transactions); before, the RPC refused them.

## 0.1.0

First release, on candle-bot-core 0.4.0 (pinned exactly).

- Watches Candle coins (Candle's token list and the launch-curve program, the core's launch source) and reads their
  curves together every `detect.curvePollMs`. A graduation is a migrated curve with its DAMM v2 pool there, created
  by the curve's authority; its time is the block time of the pool's activation slot.
- Filters: seconds since graduation, launch-to-graduation time, impact on the pool, room above the pool floor,
  creator allow and deny lists; never the bot's own wallet's launches. The core's caps on top.
- Buys fill on the pool: the expected fill is the pool's (core `dammBuy`), the executor's retry recheck reads the pool
  (`dammBuys`). `preGrad` exits are refused.
- `run`, `scan`, `status`, `sell`; `STOP`, `PAUSE_BUYS`; a `graduations` table in the ledger.
