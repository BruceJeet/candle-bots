# Changelog: candle-graduation-bot

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
