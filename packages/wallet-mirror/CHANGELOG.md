# Changelog: candle-wallet-mirror

## 0.1.0

First release, on candle-bot-core 0.7.0 (pinned exactly; it ships the wallet watcher).

- Copies listed wallets' trades: a fixed ticket or a share of the leader's SOL per copied buy, opens by
  default, once per leader and coin, a maximum age at detection and at execution, leader caps; the leaders' sells
  mirrored as the same share of what they held; the exit strategy alongside. A watch-only mode (`watch`) and `replay`.
  Needs the wallet watcher in candle-bot-core (`sources/wallets`, `market/walletTrade`, `sources/walletPositions`,
  `sources/walletReplay`).
