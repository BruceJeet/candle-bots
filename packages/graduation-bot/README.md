# candle-graduation-bot

Buys [Candle](https://candle.tv) coins the moment their launch curve completes and their DAMM v2 pool opens, and exits
them by a strategy you pick. One config file, one process, a local SQLite ledger. Built on Candle's official SDK,
[`@candledottv/agent-sdk`](https://www.npmjs.com/package/@candledottv/agent-sdk) (pinned at 0.6.14), and
[candle-bot-core](https://www.npmjs.com/package/candle-bot-core), the engine
[candle-launch-bot](https://www.npmjs.com/package/candle-launch-bot) runs on.

Built by [Bruce Jeet](https://github.com/BruceJeet).

- **What it buys:** a Candle coin that has just graduated: its curve is marked migrated and its DAMM v2 pool exists,
  created by the curve's own authority. Never a coin still on its curve.
- **Detection:** coins come from Candle's public token list and the launch-curve program on chain (the same source as
  candle-launch-bot); their curves are read together every `detect.curvePollMs`. The graduation time is the block time
  of the pool's activation slot.
- **Filters** (all optional): seconds since graduation, time from launch to graduation, price impact of your ticket on
  the pool, room above the pool's price floor, creator allow and deny lists. Plus the core's caps (ticket size, open
  positions, lifetime spend, entries per coin). A coin launched by your own wallet is never bought.
- **Execution** through Candle's trade API, from your account's embedded wallet or a TEE wallet signed on your
  machine. Fills are booked from the transaction, sells are clamped to the wallet balance, retries are capped with
  backoff, and a retry re-reads the pool so it never chases a pump past `graduation.maxImpactBps`.
- **Exits:** `hold`, `tpsl`, `time`, `ladder`, or your own file. `preGrad` is refused (these coins have graduated).
- **Dry mode** runs everything except the trade.

Solana only.

## Quick start

Node 22.18 or newer.

```sh
npm install -g candle-graduation-bot      # or npx candle-graduation-bot ...
cp "$(npm root -g)/candle-graduation-bot/examples/dry.json" bot.json
candle-graduation-bot scan --config bot.json --for 600   # print graduations and what it would buy; never trades
candle-graduation-bot run  --config bot.json             # dry run: the whole loop with paper fills
```

When the dry run looks right, set your API key, fund the wallet, set `"mode": "live"` and your `wallet` in bot.json,
and run again:

```sh
export CANDLE_API_KEY=cndl_live_...
candle-graduation-bot run --config bot.json
```

## What it needs

- A **Candle API key** with the `swap:write` scope, in an environment variable (`apiKeyEnv`), never in the file.
- A **payer**: `embedded` (your account's embedded Solana wallet; Candle signs; the key is all it needs) or `linked`
  (a TEE wallet bound to the key, signed on this machine with the key's signer). Setup for both is the same as
  candle-launch-bot's; its README walks through it.
- An **RPC**: `rpcUrlEnv` names an env var with your Solana RPC URL (the public one works for a dry run, but it is
  rate-limited; the curve poll reads every watched coin every 2 s).

## How a graduation is seen

1. Candle's token list (all of it, `detect.apiLimit` 200) and the curve program on chain report coins.
2. Every `detect.curvePollMs` the bot reads all watched curves in one call. A coin read on its curve is marked seen.
3. When a curve says migrated, the bot reads the coin's DAMM v2 pool (the address Candle's keeper creates). If the pool
   is not there yet, the coin stays watched; if its creator is not the curve's authority, the coin is dropped.
4. The graduation time is the block time of the pool's activation slot. If that cannot be read, and the bot saw the
   coin on its curve earlier, the time it first saw it migrated counts. Otherwise the time is unknown and the coin is
   not bought: a coin that was already graduated when the bot started is never mistaken for a fresh one.
5. The trigger reads the curve and pool again, checks the filters and the caps, and asks for a buy. The engine bounds
   the expected fill with its own read of the pool.

A coin is watched for `detect.watchHours` after its launch, at most `detect.maxWatched` at once.

## Controls

Files in the state dir, read at the top of every cycle:

- `STOP`: finish the cycle, write status, exit 0. The file stays until you remove it.
- `PAUSE_BUYS`: no new entries; exits keep running.
- `candle-graduation-bot sell <mint> [--fraction 0.5]`: a manual sell through the same order path.

`SIGINT`/`SIGTERM` stop the same way as `STOP`. A restart picks up from the ledger.

## State dir

| File | What |
|---|---|
| `ledger.sqlite` | positions, orders, every attempt with its full error, the `graduations` decided (graduation time and its source, decision, reason), alerts |
| `status.json` | every cycle: equity, open positions, caps used, `graduation.watch` (coins watched, polls, graduations seen), recent decisions |
| `events.jsonl` | one JSON line per event (also on stdout): `graduation_detected` (with the lag from graduation), `graduation_skip`, `buy_order`, fills, exits |
| `lock` | one process per state dir |

## Config reference

The core's sections (`mode`, `payer`, `apiKeyEnv`, `rpcUrlEnv`, `rpcWsUrlEnv`, `wallet`, `signer`, `stateDir`, `buy`,
`sell`, `exit`, `retry`, `alerts`) are the same as candle-launch-bot's. This bot adds:

```json
{
  "graduation": {
    "maxSecondsSinceGraduation": 300,
    "minLaunchToGraduationSec": 60,
    "maxLaunchToGraduationSec": 86400,
    "maxImpactBps": 300,
    "minRoomAboveFloor": 0.5,
    "creatorAllow": ["<address>"],
    "creatorDeny": ["<address>"]
  },
  "detect": { "api": true, "chain": true, "apiPollMs": 10000, "chainPollMs": 15000, "apiLimit": 200, "curvePollMs": 2000, "watchHours": 72, "maxWatched": 1000 }
}
```

| Key | Meaning |
|---|---|
| `graduation.maxSecondsSinceGraduation` | buy only this soon after the pool opened (default 300). No order is built after it |
| `graduation.min/maxLaunchToGraduationSec` | how long the curve took to fill, launch to graduation (optional) |
| `graduation.maxImpactBps` | price impact of `buy.sol` on the pool, fee apart (default 300); also the limit a retry is checked against |
| `graduation.minRoomAboveFloor` | the pool's price over its floor, minus 1 (optional). Near 0, nothing can be sold into the pool |
| `graduation.creatorAllow` / `creatorDeny` | the token list's creator or the launch transaction's signer (optional) |
| `detect.api` / `detect.chain` | where coins are seen (at least one) |
| `detect.apiPollMs`, `chainPollMs`, `apiLimit` | the token list poll, the chain signature backstop, rows read per poll |
| `detect.curvePollMs` | how often watched curves are read (one batched call, 100 accounts each) |
| `detect.watchHours`, `maxWatched` | how long and how many coins are watched |

## How the money paths work

The same as every candle-bot-core bot (fills from the transaction, sells clamped to the balance, one live transaction
per order, refusals read from their structure, uncertain orders recovered from chain). What is particular to this bot:

- **The expected fill is the pool's.** The engine reads the coin's DAMM v2 pool and computes what the ticket buys
  there (concentrated-liquidity math, the pool's fee on the side it collects it). The smaller of that and the trigger's
  number caps the tokens an uncertain buy may adopt.
- **A retry re-reads the pool.** Before a failed buy is rebuilt, its impact on the pool is checked again against
  `graduation.maxImpactBps`; an unreadable pool waits, a pool that moved past the limit ends the buy (`IMPACT`).
- **Routing is Candle's.** A graduated coin's trade goes through Candle's trade API, which routes it (through Jupiter,
  usually via the coin's pool). The pool math is the bound, not the route: a fill routed elsewhere that beats it is
  still booked from the transaction.

## Known limits

- **Thin pools.** A freshly graduated pool can be thin; `graduation.maxImpactBps` is checked before every buy.
- **Floor pools.** Some pools sit at their price floor with no sell route; exits are held until a route exists and an
  alert goes out when that lasts (`alerts.holdAlertMs`). `graduation.minRoomAboveFloor` keeps them out at entry.
- **One entry per coin.** `buy.maxPerCoin` is 1.
- **Solana only.**

## Development

From the repo root: `npm run typecheck`, `npm run build`. The engine loop, orders and exits are candle-bot-core's; this
package is the watch (`src/watch.ts`), the trigger and its filters (`src/trigger.ts`), the config sections
(`graduation`, `detect`) and the command line.

## License

MIT
