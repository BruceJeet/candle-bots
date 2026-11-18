# Changelog: candle-dip-buyer

## 0.1.1

- **The fade exit's volume rule needs `exit.minHoldMin` >= `fadeRecentBars + fadeBaselineBars + 1`** (refused at
  load otherwise), so its baseline is bars after entry, the entry minute's bar excluded. With the baseline reaching back into the fall the bot bought, every
  calm after a dip read as a fade: in a dry run all 8 trades were sold that way 6-9 min after entry.
- The example's exit is fade's price rules only (stop loss 0.7, take profit 2, max hold 360 min).
- Core: the watchlist keeps only coins the series can read.
- core 0.8.0: bracketed sell floor, exit-read alerts (`engine:exits_unread`, `sell_floor_unread`); dry fills charge Candle's fee and the network fee. (The previous npm release pinned core 0.6.0.)

## 0.1.0

First version, on candle-bot-core 0.6.0.

- Watches a list and/or a Candle feed bucket, with a live 1 min price and volume series per coin from pump.fun and
  PumpSwap trade logs.
- Buys a coin down `minFallPct` % from its `windowBars`-min high, with `minWindowVolumeSol` traded in the window, and
  (optional) up `minBouncePct` % from its `bounceBars`-min low. Complete bars only, unless `allowIncomplete`.
- Buys only on a pump.fun curve or the canonical PumpSwap pool, quoted by the venue's own buy math: mayhem-mode and
  cashback venues, other quote mints and buys past the curve are skipped before any attempt; impact within
  `maxImpactBps`. Retries are rechecked on the venue (impact and drift against the decision fill).
- Exits by any core strategy; `fade` reads the series (volume fade, drop from high) as well as price.
- `scan` prints signals and what it would buy, and never trades.
