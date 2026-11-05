# candle-scanner-bot

Watches pump.fun and PumpSwap coins and tells you when something happens: a volume spike, a dip, a breakout, or a coin
the Candle feed shows trading hard. **Watch-only:** no wallet, no API key, and it never trades. A config with a
wallet, a key or a trading section is refused. Alerts go to Telegram, Discord, a webhook or a command. Built on
[candle-bot-core](https://www.npmjs.com/package/candle-bot-core).

Built by [Bruce Jeet](https://github.com/BruceJeet).

## Quick start

Node 22.18 or newer.

```sh
npm install -g candle-scanner-bot      # or npx candle-scanner-bot ...
cp "$(npm root -g)/candle-scanner-bot/examples/watch.json" scan.json
# add an alert sink to scan.json (below), then:
candle-scanner-bot run    --config scan.json      # STOP in the state folder, or Ctrl-C, ends it
candle-scanner-bot status --config scan.json
```

Alert sinks (`alerts` in the config; the secrets stay in environment variables):

```jsonc
"alerts": {
  "telegram": { "botTokenEnv": "TELEGRAM_BOT_TOKEN", "chatIdEnv": "TELEGRAM_CHAT_ID" },
  "discordWebhookEnv": "DISCORD_WEBHOOK_URL"
}
```

A JSON `webhookEnv` and a `command` work too, as in every candle-bot. Without a sink, alerts go to `events.jsonl`
only.

## What it watches

- **`watchlist.mints`:** coins you name, always watched.
- **`watchlist.feed`:** a bucket of Candle's public market feed (`onfire`, `new`, `graduated`, `bluechip`,
  `finalstretch`). Coins are taken by 5 min volume, up to `feed.maxCoins`, with an optional server-side `where`
  filter, e.g. `{ "marketCap": { "lt": 150000 } }`. A coin leaves after `dropAfterMin` out of the bucket.
- **`watchlist.maxCoins`** caps everything. Coins the cap leaves out are alerted.

## Where the numbers come from

- **Volume:** each coin's own trade logs on chain, one subscription per coin on one websocket, at `confirmed`
  commitment.
  - On the pump.fun bonding curve: the curve's trade events.
  - After migration: the canonical PumpSwap pool's buy and sell events. The pool is matched to its coin by reading
    the pool account.
  - Failed transactions are dropped. Volume is in SOL, fees excluded.
- **Price:** on-chain reads of the curve or the pool every step (`loopMs`).
- **Bars:** 1 min each, up to 24 h per coin.
- **A gap is unknown, never zero.** A gap is any of: a reconnect, a subscription not confirmed or refused, a coin past
  `series.maxSubscriptions` (default 50), a coin on a venue this version cannot read trades for (Candle's own curve,
  DAMM v2: price only). Each kind is alerted.
- By default a rule does not fire on bars with a gap (`rules.allowIncomplete: false`). When it does, the alert says
  `[incomplete]`.
- **`feedVolume`** uses the Candle feed's own rolling 5 min USD value, and says so in the alert. That value is coarse:
  windows can disagree with each other, and the feed gives no observed time for its 5 min and 1 h windows (the row's
  update time is used). About 6 in 10 `onfire` rows carried a 5 min volume when checked.

## Rules

| Rule | Fires when |
|---|---|
| `volumeSpike` | the last `recentBars` minutes trade `minRatio` times the per-minute volume of the `baselineBars` before them, and at least `minVolumeSol` SOL |
| `dip` | the last close is `minFallPct` % under the high of the last `windowBars` minutes |
| `breakout` | the last close is `minRisePct` % over the low of the last `windowBars` minutes |
| `feedVolume` | the feed's rolling 5 min volume is at least `minVolume5mUsd` USD (needs `watchlist.feed`) |

Each rule takes `cooldownMin`: one alert per coin and rule per cooldown, kept in the ledger, so a restart does not
repeat one. `rules.link` (default `https://alpha.candle.tv/token/{mint}`, `""` for none) goes at the end of each alert.

## Controls and state

- **Controls:** `STOP` in the state folder ends it cleanly, as do `SIGINT` and `SIGTERM`.
- **`status.json`**, every step: the watchlist, the series (watched, subscribed, socket up), the feed, the rules,
  and the coins with a rule firing now.
- **`events.jsonl`:** one JSON line per event (`scan_fired`, `watchlist_changed`, the socket's state, alerts).
- **`ledger.sqlite`:** alerts and `scan_fired` (the last firing per coin and rule).

## Known limits

- **Trade logs for pump.fun and PumpSwap only.** Candle curve and DAMM v2 coins get price, but their volume is a
  gap.
- **Subscriptions:** one public-RPC socket held 100 per-coin subscriptions in a probe (Nov 2026), so the default
  `maxSubscriptions` is 50. Past it, coins are alerted and left out. A private RPC is the way to watch more.
- **No backfill:** what was missed while disconnected stays a gap.
- **Bar times are receive times,** not block times. A socket that falls more than `series.maxSlotLag` slots
  (default 150) behind the chain turns every coin's bars incomplete, and is alerted.
- **Only the trading program's own events count,** so a program logging look-alike events cannot fake volume.
- **Server-side orders.** Candle's own price-triggered orders (`/trade/agent/orders`) are not used: the bots poll their
  series. A later version may.
- **Solana only.**

## License

MIT
