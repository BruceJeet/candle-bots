# candle-wallet-mirror

Copies the trades of the wallets you list on [Candle](https://candle.tv). A leader's buy is copied with a fixed ticket
(or a share of the leader's SOL, capped), once per coin; the leader's sells are mirrored as the same share of what the
leader held; your exit strategy runs alongside. A watch-only mode alerts on the leaders' trades without a wallet or a
key. One config file, one process, a local SQLite ledger. Built on Candle's official SDK,
[`@candledottv/agent-sdk`](https://www.npmjs.com/package/@candledottv/agent-sdk) (pinned at 0.6.14), and
[candle-bot-core](https://www.npmjs.com/package/candle-bot-core), the engine
[candle-launch-bot](https://www.npmjs.com/package/candle-launch-bot) runs on.

Built by [Bruce Jeet](https://github.com/BruceJeet).

- **Seeing the leaders:** on chain, one `logsSubscribe` per leader on your RPC's websocket, each transaction read once
  and decoded from the leader's own balance changes. Venues: the pump.fun curve, PumpSwap, the Candle curve, Meteora
  DAMM v2, and Jupiter routes (counted by the same balance changes). A transaction that is not a clear buy or sell of
  one token for SOL is logged and skipped, never guessed.
- **Gaps:** after a reconnect (and at start), the leader's signatures since the last one read are read back, so a
  trade made while the socket was down is still seen. When that read cannot cover the gap, the bot says so (an alert,
  and the next trade is marked incomplete): a gap is never taken as "no trades".
- **What it copies:** by default a leader's **open** (a buy from flat: the leader held at most 1 % of what it holds
  after), once per leader and coin, only if the trade is at most `maxAgeSec` old when seen, on a venue you allow, and
  on a coin the bot can price (so its exits can run). No buy attempt is built after the leader's time plus `maxAgeSec`.
  Not copied: a coin the leader has already sold out of, or sold below `minLeaderHeldFraction` of its peak, by the
  time the bot decides; and a buy whose price (the venue's quote for your ticket) is more than `maxOverLeaderBps` over
  the leader's own fill (its SOL over its tokens; that SOL is all-in: venue fees, tips and platform fees it paid).
- **What it sells:** when a leader sells, each of your positions copied from that leader sells the same share of what
  the leader held before that sell (a leader that sells out: you sell out). The share comes from the leader's own
  balance in that transaction. Sells in the same slot as the copied buy count when the leader's balance shows they
  came after it. Small sells under `minSellFraction` add up and are mirrored together once they pass it. Your `exit`
  strategy (take profit, stop loss, time, ladder, trail...) runs as well.
- **Transfers:** a leader moving a coin you hold from it out of its wallet without a trade is alerted (it may sell
  from another wallet). Nothing is sold for it. To see these, the bot also reads the leaders' token transfers.
- **Caps:** the core's (`buy.maxOpen`, `buy.lifetimeSol`, `buy.maxPerCoin`, `PAUSE_BUYS`) and per leader
  (`maxEntries`, `maxSol`).
- **Execution, exits and dry mode** as candle-launch-bot: Candle's trade API from the embedded wallet or a TEE wallet;
  fills from the transaction; pump.fun coins priced on their own venue.

Solana only.

## Quick start

Node 22.18 or newer.

```sh
npm install -g candle-wallet-mirror          # or npx candle-wallet-mirror ...
cp "$(npm root -g)/candle-wallet-mirror/examples/watch.json" watch.json   # put your leaders in `leaders`
candle-wallet-mirror watch --config watch.json   # watch-only: alerts, no wallet, no key

cp "$(npm root -g)/candle-wallet-mirror/examples/dry.json" bot.json
candle-wallet-mirror run --config bot.json       # dry run: the whole loop with paper fills
```

For live: export the API key (`apiKeyEnv`), fund the wallet, set `"mode": "live"` and your `wallet`, run again.

## What it needs

- An **RPC** with a websocket (`rpcUrlEnv`, `rpcWsUrlEnv`). The public Solana RPC works for a few leaders, slowly: it
  allows about one transaction read per second after a short burst, so the default pace is 1 per second. For more
  leaders or busy ones, use your own RPC, for the watcher alone if you like (`source.rpcUrlEnv`).
- For `run`: a **Candle API key** with the `swap:write` scope (`apiKeyEnv`) and a **payer**: `embedded` (the account's
  embedded wallet; Candle signs) or `linked` (a TEE wallet signed on this machine). Setup is the same as
  candle-launch-bot's; its README walks through it. `watch` needs neither.
- The **leaders**: wallet addresses.

## Config reference

The core's sections (`mode`, `payer`, `apiKeyEnv`, `rpcUrlEnv`, `wallet`, `signer`, `stateDir`, `buy`, `sell`, `exit`,
`retry`, `alerts`) are the same as candle-launch-bot's. This bot adds:

```json
{
  "leaders": [
    { "address": "<leader address>", "label": "leader one", "sol": 0.01, "maxEntries": 5, "maxSol": 0.05 },
    { "address": "<another>" }
  ],
  "mirror": {
    "ticket": { "mode": "fixed", "fraction": 0.1, "minSol": 0.001 },
    "copy": "opens",
    "openDustPct": 1,
    "maxAgeSec": 20,
    "minLeaderSol": 0,
    "venues": ["pump-curve", "pumpswap", "candle-curve", "damm-v2", "jupiter"],
    "sells": true,
    "sellsFrom": "copied",
    "minSellFraction": 0,
    "minLeaderHeldFraction": 0.5,
    "maxOverLeaderBps": 3000,
    "maxImpactBps": 500
  },
  "source": { "fetchPerSec": 1, "fetchBurst": 8, "backfillLimit": 300, "reconcileSec": 300, "poll": false, "pollSec": 15 }
}
```

| Key | Meaning |
|---|---|
| `leaders[].address` | a wallet to copy; each listed once |
| `leaders[].label` | a name for logs, alerts and `status.json` (optional) |
| `leaders[].sol` | this leader's ticket with `ticket.mode` `fixed` (default `buy.sol`, never above it) |
| `leaders[].fraction` | this leader's share with `ticket.mode` `fraction` (default `mirror.ticket.fraction`) |
| `leaders[].maxEntries` / `maxSol` | lifetime caps for this leader (optional). Counted from the ledger's positions for the leader, as the core counts `lifetimeSol`: a buy Candle refused before anything was signed, or one that reverted, does not count. `maxSol` also cuts the last ticket to what is left |
| `mirror.ticket.mode` | `fixed`: `buy.sol` or the leader's `sol`; `fraction`: that share of the leader's SOL, capped at `buy.sol` |
| `mirror.ticket.minSol` | a ticket below this is not bought (default 0.001) |
| `mirror.copy` | `opens` (default): a buy from flat; `buys`: any buy, still once per leader and coin |
| `mirror.openDustPct` | what a leader may already hold for a buy to count as an open, % of its holding after (default 1) |
| `mirror.maxAgeSec` | the leader's trade must be at most this old (block time) when seen; no buy attempt is built after it (default 20) |
| `mirror.minLeaderSol` | skip leader buys smaller than this (default 0) |
| `mirror.venues` | venues (or the Jupiter route) whose trades are copied (default all) |
| `mirror.sells` | mirror the leaders' sells (default true) |
| `mirror.sellsFrom` | `copied` (default): only the leader the position copied; `any`: any listed leader's sell of the coin |
| `mirror.minSellFraction` | leader sells of a smaller share wait and add up; they are mirrored together once they pass it (default 0; a sell-out always is) |
| `mirror.minLeaderHeldFraction` | skip the copy when the leader, by the time the bot decides, holds less than this share of its peak since the buy (default 0.5; 0 off) |
| `mirror.maxOverLeaderBps` | skip the copy when your price is more than this many bps over the leader's fill (default 3000) |
| `mirror.maxImpactBps` | most price impact of the ticket (default 500); also the buy-retry limit |
| `mirror.checkPrograms`, `extraPrograms`, `sellFloorMarginBps`, `buyFloorMarginBps` | TEE wallet only, as the other bots |
| `source.rpcUrlEnv` / `wsUrlEnv` | a separate RPC for the watcher (default: the bot's) |
| `source.fetchPerSec` / `fetchBurst` | transaction reads per second after a burst (default 1, 8) |
| `source.backfillLimit` | most signatures one read-back takes before the gap is reported as unrecovered (default 300) |
| `source.reconcileSec` | with a websocket, a poll of each leader this often as a safety net (default 300; 0 off) |
| `source.poll` / `pollSec` | no websocket: poll each leader every `pollSec` |
| `source.record` | append every transaction read to this file (JSON lines), for `replay` |

### Watch-only config

`"mode": "watch"`, the core's watch-only keys (`stateDir`, `loopMs`, `rpcUrlEnv`, `rpcWsUrlEnv`, `alerts`), `leaders`
(address and label only), `source`, and:

| Key | Meaning |
|---|---|
| `notify.buys` / `sells` | alert on buys / sells (default true) |
| `notify.opensOnly` | buys: opens only, not adds (default false) |
| `notify.minSol` | skip trades smaller than this (default 0) |
| `notify.gaps` | alert when trades may be missing (default true) |
| `notify.link` | a link in each alert, `{mint}` replaced (default the coin's Candle page) |

A watch-only config takes no wallet, key, `buy`, `sell` or `exit`: it is refused.

## Commands

```sh
candle-wallet-mirror run    --config bot.json [--mode dry|live]
candle-wallet-mirror watch  --config watch.json [--seconds n]
candle-wallet-mirror status --config <file>
candle-wallet-mirror sell   <mint> --config bot.json [--fraction 1]
candle-wallet-mirror replay --file trades.jsonl [--wallet <address>]
```

## Controls

`STOP` and `PAUSE_BUYS` files in the state dir; `sell <mint>`. A restart picks up from the ledger: each leader is read
back from the last signature handled, a trade handled before is never handled again, a coin copied from a leader is
never copied from it again, and a sell owed for a leader's sell stays owed until a sell fills.

## State dir

| File | What |
|---|---|
| `ledger.sqlite` | positions (each with its leader in the entry context), orders, attempts, alerts; `leader_trades` (every leader trade handled, with what it meant: open, add, reduce, close), `mirror_copies` (each leader and coin decided), `mirror_sells` (sells owed for leaders' sells), `mirror_cursor` (last signature per leader) |
| `status.json` | equity, open positions, caps used, leaders with their cursors, the source (reads, gaps open and recent), sells owed, recent decisions |
| `events.jsonl` | one JSON line per event: `leader_trade`, `copy_buy`, `copy_skip`, `mirror_sell_owed`, `buy_order`, fills, exits, `leader_gap_recovered` |

## Known limits

- **Speed.** A copy follows the leader by the time it takes to see and read its transaction (1 to 2 s on the public
  RPC, Nov 2026) plus your own buy. You buy after the leader, at its price or worse.
- **Venues the bot can price.** A coin whose venue the core cannot read (a pool other than the Candle curve and its
  pool, the pump.fun curve, or PumpSwap) is not bought: its exits could not run.
- **One entry per coin.** `buy.maxPerCoin` is 1: two leaders opening the same coin give one copy, of whichever the bot
  decides first.
- **A restart drops undecided buys.** A leader buy seen but not yet decided when the bot stops is not decided after
  the restart: no buy is made for it (and never a second one). By then it is usually past `maxAgeSec` anyway.
- **Second token accounts.** The leader's holding comes from the token accounts its transaction lists; a second
  account of the same coin that the transaction does not touch is not seen.
- **Solana only.**

## License

MIT
