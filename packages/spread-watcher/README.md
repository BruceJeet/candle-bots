# candle-spread-watcher

Watches each listed coin's price on every venue it trades on and alerts when the gap between two venues holds above a
threshold. The venues are the coin's own curve or pool, other PumpSwap and Meteora DAMM v2 pools named by address, and
its Hyperliquid perp. Watch-only: no wallet, no API key, it never trades. Built on [candle-bot-core](../core).

```sh
npm install -g candle-spread-watcher
candle-spread-watcher check --config examples/watch.json   # one read of every venue, printed
candle-spread-watcher run   --config examples/watch.json   # watch and alert
```

## Venues

- `own` (default true) reads the coin's own venue as the core finds it: Candle curve or its DAMM v2 pool, pump.fun
  curve, or the canonical PumpSwap pool.
- `pools` adds pools by address: `{ "venue": "pumpswap" | "damm", "address": "..." }`. A pool counts only if it pairs
  the coin with SOL. A PumpSwap pool in mayhem mode, a disabled DAMM v2 pool or accounts that do not match are refused
  and shown with why.
- `perp` adds a Hyperliquid perp. Its price per whole coin in SOL is its mark over the units per contract (`perpUnits`,
  default 1,000 for a `k` market like `kBONK`, else 1) over SOL's own mark. Marks are read every `perps.everySec`; marks
  older than three reads are dropped.

Every pool price is SOL per whole token from the pool's own state, with the SOL in the pool (`depthSol`).

## The rule

| key | default | meaning |
|---|---|---|
| `minSpreadBps` | 300 | the widest gap between two venues, in bps of the lower price |
| `minReads` | 3 | held on this many reads in a row (a failed read breaks the run) |
| `minDepthSol` | 5 | a pool counts only with this much SOL in it |
| `perps` | true | compare perps too (they have no depth) |
| `cooldownMin` | 30 | one alert per coin per this long, kept across restarts |
| `link` | `https://alpha.candle.tv/token/{mint}` | added to each alert |

An alert names both venues, their prices and their depth. Alerts go to Telegram, Discord, a webhook or a command
(`alerts`, as in the other bots). A spread on a quote is not a fill: the depth says how much would move it.

`status.json` lists every coin's venues with prices, depth and problems, the current spread and its run.

## License

MIT
