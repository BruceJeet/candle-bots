# Changelog: candle-rebalancer

## 0.1.0

First release, on candle-bot-core 0.7.0 (pinned exactly; it ships the scheduler and lots).

- Holds a wallet at target weights (coins plus SOL) on a schedule: sells what is over its band first, then, once the
  sells have ended, buys what is under from the wallet as it is then.
- `maxSolPerRun` caps the SOL moved per run (sells first), `minTradeSol` drops small orders, `buy.sol` caps each buy,
  and buys never take SOL out of its own band.
- A coin it cannot price, or a balance it cannot read, blocks the run: alerted, nothing traded.
- The full plan is logged each run; `plan` prints it for the wallet now and never trades.
- Runs are claimed in the ledger before the bot acts: a restart never fires a run twice, and a run in flight blocks
  the next.
