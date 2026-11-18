# Changelog: candle-spike-rider

## 0.1.1

On candle-bot-core 0.8.0 (pinned exactly). Nothing in the rule changes.

- `series.maxCoinKbPerMin` / `series.busyRecheckMin`: a cap on the trade-log stream's cost (Helius meters websocket
  data). A feed coin streaming over the cap is dropped for a while; held coins never are. `status.json` shows the
  stream's cost under `spike.series.stream`.
- Completed pump.fun curves quoted in another token no longer hold a watch place forever.
- `engine:exits_unread` alert when exit reads for held coins keep failing; `sell_floor_unread` logged and counted.
- core 0.8.0: bracketed sell floor; dry fills charge Candle's fee and the network fee. (The previous npm release pinned core 0.6.0.)

## 0.1.0

First version, on candle-bot-core 0.6.0.

- Watches a list and/or a Candle feed bucket, with a live 1 min price and volume series per coin from pump.fun and
  PumpSwap trade logs.
- Buys a coin whose last `recentBars` traded `minRatio` times its `baselineBars` baseline, at least `minVolumeSol`,
  `minBuyShare` of it buys, with the price up `minRisePct` to `maxRisePct` %. Complete bars only, unless
  `allowIncomplete`.
- Buys only on a pump.fun curve or the canonical PumpSwap pool, quoted by the venue's own buy math: mayhem-mode and
  cashback venues, other quote mints and buys past the curve are skipped before any attempt; impact within
  `maxImpactBps`. Retries are rechecked on the venue (impact and drift against the decision fill).
- Exits by any core strategy; `fade` reads the series (volume fade, drop from high) as well as price.
- `scan` prints signals and what it would buy, and never trades.
- The rule needs the whole baseline watched (`recentBars + baselineBars` complete minutes) and reads the price rise from
  the last close before the recent bars, so a quiet minute right before a burst does not hide it.
