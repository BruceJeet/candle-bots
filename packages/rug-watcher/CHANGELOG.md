# Changelog: candle-rug-watcher

## Unreleased

- Pins candle-bot-core 0.6.0 (batch 3: opt-in additions only; no change in this package).

## 0.1.0

First release, on candle-bot-core 0.5.0 (pinned exactly).

- Watches the coins a wallet holds (the core's adoption: a list, or the whole wallet less `exclude`, other bots' open
  coins from `excludeStateDirs`, dust and junk mints) and sells, or only alerts, when a rule fires. It never buys.
- Rules, each optional with its own threshold, `sell` share and `alertOnly`: `liquidityPull` (a pool's SOL, DAMM v2 or
  PumpSwap, falls X % in a window), `priceCrash` (price falls X % in a window), `devDump` (the creator sells X % of its
  holding, or goes under a share of supply), `holderExit` (a top-N wallet sells X % of supply in a window).
- Each firing is recorded once (`rug_events` in the ledger), alerted with the numbers that tripped it, and its sell
  goes through the engine's exit path. `PAUSE_SELLS` holds the sell, never the alert.
- The dev rule needs two agreeing reads, ignores answers at an older slot, and is off for a coin whose creator is the
  bot's own wallet. An owed sell is checked against the current rules; `dismiss` settles an event by hand.
- Commands `run`, `status` (each coin: venue, pool SOL, creator, rules fired), `sell`, `adopt`, `release`, `dismiss`.
