# candle-spike-rider

Buys pump.fun and PumpSwap coins on a volume spike with buyers behind it, on a live price and volume series, and exits
them by a pluggable strategy. A Solana bot built on [candle-bot-core](../core) and `@candledottv/agent-sdk`.

```sh
npm install -g candle-spike-rider
candle-spike-rider scan --config examples/dry.json --for 600   # signals and what it would buy; never trades
candle-spike-rider run  --config examples/dry.json             # dry run: decides and logs, never trades
```

## What it watches

- `watchlist`: a fixed list of mints, a Candle feed bucket (`onfire`, `new`, `graduated`, `bluechip`, `finalstretch`,
  by 5 min volume), or both, within `maxCoins`. Coins this bot holds stay watched while it holds them.
- `series`: each watched coin's trade logs on one websocket (pump.fun curve or canonical PumpSwap pool), folded into
  1 min bars of price and SOL volume. A gap (a reconnect, a stall, a lagging socket, an unreadable log) is unknown,
  never zero, and the bars it touches are not complete. See the core README.

## When it buys

The `spike` rule, on ended bars:

| key | default | meaning |
|---|---|---|
| `recentBars` / `baselineBars` | 2 / 20 | the recent bars, and the baseline before them (minutes) |
| `minRatio` | 5 | recent volume per bar over the baseline's |
| `minVolumeSol` | 5 | SOL traded in the recent bars |
| `minBuyShare` | 0.55 | share of the recent volume that was buys |
| `minRisePct` / `maxRisePct` | 3 / 60 | the price over the recent bars: up at least this, and not already up more than this |
| `allowIncomplete` | false | act on bars with a gap |
| `maxImpactBps` | 300 | the ticket's impact on the venue (also the retry limit) |
| `cooldownMin` | 60 | a coin is not looked at again for this long after a signal |
| `buyWithinSec` | 20 | no attempt is built later than this after the decision |

A signal is checked again at the decision, then the coin's venue is read fresh. Only a pump.fun curve or the canonical
PumpSwap pool is bought, and only when the venue's own buy math quotes the ticket. Mayhem-mode and cashback venues,
coins quoted in another token and buys past the curve's tokens are skipped before any attempt. The engine keeps the
smaller of the bot's expected fill and its own read. A retry is rechecked on the venue: the ticket's impact, and the
drift against the decision fill (`retry.maxPriceDriftBps`, else `maxImpactBps`). The core's caps (`buy.maxOpen`,
`maxPerCoin`, `lifetimeSol`), `PAUSE_BUYS` and `STOP` apply as in every bot.

## Exits

Any core strategy (`tpsl`, `trail`, `ladder`, `time`, `hold`), or `fade`, which reads the series too:

```json
{ "strategy": "fade", "stopLoss": 0.7, "takeProfit": 2, "fadeRecentBars": 5, "fadeBaselineBars": 20,
  "fadeBelowRatio": 0.25, "dropWindowBars": 15, "dropFromHighPct": 25, "minHoldMin": 5, "maxHoldMin": 360 }
```

`fade` sells everything on the first of: take profit or stop loss (multiples of entry), the last `fadeRecentBars`
trading under `fadeBelowRatio` of the `fadeBaselineBars` before them, the last close `dropFromHighPct` under the high
of the bars since entry, or `maxHoldMin`. The series rules act only on complete bars and after `minHoldMin`.

## Known limits

- No server-side orders: the bot polls its series every `loopMs`, so it sees a spike a minute bar late (the rule reads
  ended bars), and a move faster than that can pass it by.
- Volume comes from pump.fun and PumpSwap trade logs only (Candle curve and DAMM v2 coins have no volume here, and are
  never bought). The public RPC holds about 100 log subscriptions; a private RPC is better for a large watchlist.
- Sparse gaps (an unreadable log here and there) can make long stretches of bars read incomplete; the rule then waits.

## License

MIT
