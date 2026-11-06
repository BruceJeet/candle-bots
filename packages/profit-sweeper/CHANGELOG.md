# Changelog: candle-profit-sweeper

## 0.1.1

- Pins candle-bot-core 0.6.0 (batch 3: opt-in additions only; no change in this package).

## 0.1.0

First release, on candle-bot-core 0.5.0 (pinned exactly).

- Sells the wallet's bags at targets (the core's exits, one per coin if set, on bags adopted as candle-exit-manager
  does) and asks for the realized profit to be sent to a home address. It never moves funds and never buys.
- `sweep.home` is required, a full address, never the bot's own wallet; there is no default.
- One sweep request at a time: recorded in the ledger before anything else, written to `sweeps/<requestId>.json`,
  alerted, and re-announced until it is closed. A restart never makes a second request for the same profit.
- `swept <requestId> --signature <sig>` closes it once the chain shows that transaction paid home from the wallet
  (the amount home received is recorded); `--unverified` closes it at the requested amount; `cancel` closes it
  uncounted.
- Realized profit: proceeds, less the cost of the tokens sold or written off, less network fees, over positions with
  a cost basis. The request never asks for more than the balance less `sweep.reserveSol`.
