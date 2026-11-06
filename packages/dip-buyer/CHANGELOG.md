# Changelog: candle-dip-buyer

## 0.1.0 (unreleased)

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
