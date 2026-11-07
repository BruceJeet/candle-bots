# Changelog: candle-spread-watcher

## 0.1.0

First release, on candle-bot-core 0.7.0 (pinned exactly; it ships `market/venues`).

- Watch-only: no wallet, no key, never trades.
- Each coin's price on its own venue, on listed PumpSwap and Meteora DAMM v2 pools, and on its Hyperliquid perp, with
  each pool's SOL depth.
- An alert when the widest gap between two venues deep enough to count holds at or above `minSpreadBps` for `minReads`
  reads. One alert per coin per cooldown, kept across restarts.
- `check` prints one read of every venue.
