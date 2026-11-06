# Changelog: candle-exit-manager

## 0.1.1

- Pins candle-bot-core 0.6.0 (batch 3: opt-in additions only; no change in this package).

## 0.1.0

First release, on candle-bot-core 0.5.0 (pinned exactly).

- Adopts bags already in the wallet (`adoption.mode`: a list of coins, or the whole wallet less `exclude`, other bots'
  open coins from `excludeStateDirs`, dust, junk mints, frozen accounts and anything it cannot price) and runs exits
  on them. It never buys (a `buy` section is refused).
- Venues read from chain per coin: Candle's curve and DAMM v2 pool, pump.fun curves, PumpSwap.
- Cost basis from given buy signatures, a cost entered by hand, or the wallet's own buys on chain; `noBasis` for exits
  that need one.
- Exits from the core, `trail` included, one per coin if set (`manager.exits`).
- Commands `run`, `status` (each bag: venue, basis, strategy, next exit), `sell`, `adopt`, `release`. Controls `STOP`
  and `PAUSE_SELLS`.
- TEE wallet: a build calling a program outside the known set is never signed (`manager.checkPrograms`,
  `extraPrograms`).
