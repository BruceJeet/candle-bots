# Changelog: candle-scanner-bot

## 0.1.0

First release, on candle-bot-core 0.5.0 (pinned exactly).

- Watch-only: no wallet, no API key, no executor. A config with a wallet, a key or a trading section is refused.
- **Watchlist:** a list of coins and/or a Candle feed bucket (`new`, `graduated`, `onfire`, `bluechip`,
  `finalstretch`, with an optional `where` filter), within one cap.
- **Series:** volume from each coin's pump.fun or PumpSwap trade logs (failed transactions dropped), and price from
  on-chain reads, in 1 min bars. A gap is unknown, never zero.
- **Rules:**
  - `volumeSpike`: the last bars against a trailing baseline, with a minimum SOL volume;
  - `dip`: the fall from the window high;
  - `breakout`: the rise from the window low;
  - `feedVolume`: the Candle feed's rolling 5 min USD volume, labelled as such.
  - By default a rule fires only on complete numbers.
- **One alert per coin and rule per cooldown,** kept in the ledger across restarts. Alerts go to Telegram, Discord, a
  webhook or a command.
