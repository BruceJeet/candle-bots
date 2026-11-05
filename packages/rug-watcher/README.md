# candle-rug-watcher

Watches the coins a Solana wallet holds and sells, or only alerts, when a coin starts to look like a rug: the pool's
SOL is pulled, the price crashes, the creator dumps, or a large holder leaves. It never buys. One config file, one
process, a local SQLite ledger. Built on Candle's official SDK,
[`@candledottv/agent-sdk`](https://www.npmjs.com/package/@candledottv/agent-sdk) (pinned at 0.6.14), and
[candle-bot-core](https://www.npmjs.com/package/candle-bot-core).

Built by [Bruce Jeet](https://github.com/BruceJeet).

- **Which coins:** a list you name, or the whole wallet, adopted the same way as candle-exit-manager: other bots' coins
  (`excludeStateDirs`), dust, junk mints and anything it cannot price are left alone.
- **Venues:** Candle coins (launch curve, then the DAMM v2 pool), pump.fun bonding curves, PumpSwap. Read from chain
  per coin, every exit tick.
- **Rules,** each optional, each with its own threshold, its own `sell` share (of what remains) and `alertOnly`:

  | Rule | Fires when |
  |---|---|
  | `liquidityPull` | the SOL in the coin's pool (DAMM v2, PumpSwap) falls `dropPct` % from its high in the last `windowSec` |
  | `priceCrash` | the price falls `dropPct` % from its high in the last `windowSec` |
  | `devDump` | the creator's wallet holds `soldPct` % less than the most it held while watched, or falls under `floorPct` % of supply |
  | `holderExit` | a wallet that was among the `topN` holders in the window now holds `soldPctOfSupply` % of supply less than its high in the window |

- **Every firing alerts** (the core's sinks: Telegram, webhook, a command) with the numbers that tripped it, whether
  or not it sells.
- **Sells** go through the same order path as every candle-bot-core bot: fills booked from the transaction, clamped to
  the wallet balance, retries capped with backoff, uncertain orders recovered from chain.
- **Dry mode** adopts into its own ledger, runs the rules, and logs every alert and sell it would make; it signs
  nothing.

Solana only.

## Quick start

Node 22.18 or newer.

```sh
npm install -g candle-rug-watcher      # or npx candle-rug-watcher ...
cp "$(npm root -g)/candle-rug-watcher/examples/dry.json" bot.json
# set "wallet" in bot.json to the wallet to watch
candle-rug-watcher run    --config bot.json      # dry run: watches and logs what it would do
candle-rug-watcher status --config bot.json      # each coin: venue, pool SOL, creator, rules fired
```

When the dry run looks right, use a new `stateDir` for live, set your API key, `"mode": "live"`, and run again:

```sh
export CANDLE_API_KEY=cndl_live_...
candle-rug-watcher run --config bot.json
```

**The dev and holder rules need an RPC that serves `getTokenLargestAccounts`.** Solana's public RPC refuses that call
(HTTP 429, "Too many requests for a specific RPC call", on every try as of November 2026); the watcher then reads the
holders as unknown, fires nothing on them, and alerts after three polls. The price and liquidity rules work on any RPC.

What it needs (API key with `swap:write`, a payer, an RPC) is the same as candle-exit-manager's; its README has the
details, and the section on sharing a wallet with other bots applies here word for word.

## Once per event

- `priceCrash`, `liquidityPull`: after a firing the window starts again from the value then. Another firing needs a
  new fall of `dropPct` from there. A move from the launch curve to a pool starts both windows again (that is not a
  pull).
- `devDump`: each part (`soldPct`, `floorPct`) fires once per position. The creator's highest holding since the coin
  was adopted is kept in the ledger, so a dump while the watcher was stopped fires on the first poll after. A coin
  released and adopted again starts from the creator's holding then.
- `holderExit`: once per wallet per position. Before it fires, the wallet's whole balance (all its token accounts) is
  read: the largest-accounts list can show only some of them.
- One of the watcher's own sells filling (a rule's, or the `exit` strategy's) restarts the price and pool windows, so
  its own impact on a thin pool is not read as a crash or a pull.

Firings are kept in the ledger (`rug_events`): a restart never fires the same event again. A selling firing stays owed
until a sell with its reason (`rug:<rule>#<event>`) has filled; a refused sell is retried on the engine's clock (and
goes `exit_stuck`, then the slow retry, like any exit). Two rules firing together each sell their share of what
remains.

## Controls

Files in the state dir, read every cycle:

- `STOP`: finish the cycle, write status, exit 0.
- `PAUSE_SELLS`: rules keep running and alerting; their sells (and the `exit` strategy's) are held. Lift it and what is
  owed sells on the next tick.
- `candle-rug-watcher sell <mint> [--fraction 0.5]`, `adopt <mint>`, `release <mint>`: as candle-exit-manager.

## Who is the creator

- **pump.fun coins:** the bonding curve names its creator on chain.
- **Other coins:** the fee payer of the mint's oldest transaction, found by paging the mint's history (at most 10
  pages of 1000). On Candle that is often a payer wallet, not the person who launched the coin. Name the creator by
  hand where you know it: `rules.devDump.creators: { "<mint>": "<wallet>" }`.
- A coin with no creator found is alerted once; the dev rule does not run for it, and the lookup is retried hourly.
- The dev rule watches the creator's wallet. Tokens moved to another wallet first and sold from there look like a
  dump of the creator's holding (it holds less), not like a sale of that other wallet.

## Holders: how they are read

A poll, not a stream: every `watch.holdersPollMs` (default 15 s), at most `watch.maxCoinsPerPoll` coins a poll.

- One `getTokenLargestAccounts` (the 20 largest token accounts) and one `getTokenSupply` per coin per poll. One
  `getMultipleAccounts` reads the owners of accounts not seen before (owners are cached).
- One `getTokenAccountsByOwner` reads the creator's holding (dev rule). Another reads each watched wallet that fell
  out of the largest list (at most `topN` a poll).
- Accounts owned by programs (bonding curves, pools, vaults, lockers: addresses off the ed25519 curve) are not
  holders. Your own wallet, the creator (when the dev rule is on), and `holderExit.exclude` are never counted as
  large holders.
- Lag: the poll interval plus about a second (confirmed commitment). A wallet outside the 20 largest accounts is not
  seen until it is in them.
- A failed read is unknown, never a sale. A failing coin is polled less often (2x, 4x, up to 16x the interval), and
  three failed polls in a row are alerted.
- One poll stops after `watch.pollBudgetMs` (default 3 s); the coins left are due first next cycle. Set
  `watch.holdersRpcUrlEnv` to read holders through their own RPC, so a rate limit on these heavy calls never reaches
  the balance read before a sell.
- A creator found on chain that holds none of the coin at the first read is alerted once (it may be the wrong
  wallet).

## Config reference

`examples/dry.json` is a working start. Besides the shared keys (see candle-launch-bot's README) and `adoption` (see
candle-exit-manager's), a `buy` section is refused.

```jsonc
"rules": {
  "liquidityPull": { "dropPct": 40, "windowSec": 120, "sell": 1 },
  "priceCrash":    { "dropPct": 50, "windowSec": 300, "sell": 0.5 },
  "devDump":       { "soldPct": 50, "floorPct": 1, "creators": { "Mint…": "Wallet…" } },
  "holderExit":    { "topN": 10, "soldPctOfSupply": 3, "windowSec": 600, "exclude": [], "alertOnly": true }
},
"watch": { "holdersPollMs": 15000, "maxCoinsPerPoll": 10, "pollBudgetMs": 3000, "holdersRpcUrlEnv": "HOLDERS_RPC_URL", "checkPrograms": true, "extraPrograms": [], "sellFloorMarginBps": 200 },
"exit": { "strategy": "hold" }
```

| Key | Meaning |
|---|---|
| `rules.*.sell` | share of what remains to sell when the rule fires (0 to 1, default 1) |
| `rules.*.alertOnly` | alert, never sell (default false) |
| `liquidityPull`, `priceCrash` | `dropPct` (1 to 99), `windowSec` (5 to 86400) |
| `devDump` | `soldPct` and/or `floorPct` (% of supply); `creators` by hand |
| `holderExit` | `topN` (1 to 20, default 10), `soldPctOfSupply`, `windowSec` (default 600), `exclude` |
| `watch.holdersPollMs` | how often each coin's holders are read (min 2000, default 15000) |
| `watch.maxCoinsPerPoll` | coins read in one poll (default 10); the rest wait for the next |
| `watch.pollBudgetMs` | longest one poll runs (default 3000) |
| `watch.holdersRpcUrlEnv` | an env var with an RPC URL for holder and creator reads (default: the bot's RPC) |
| `watch.checkPrograms`, `extraPrograms`, `sellFloorMarginBps` | TEE wallet signing checks, as candle-exit-manager's `manager.*` |
| `exit` | the exit strategy for everything the rules do not sell (default `hold`; a `trail` works too) |

## State dir

| File | What |
|---|---|
| `ledger.sqlite` | positions, orders, attempts, `adoptions`, `rug_events` (every firing: rule, numbers, sell share, when its sell filled), `rug_creators` (each coin's creator, its source, its highest holding) |
| `status.json` | every cycle: `watched` (each coin's venue, pool SOL, creator, rules fired), `rules`, `adoption.skipped`, `sellsPaused` |
| `events.jsonl` | one JSON line per event: `rug_rule` (with its numbers), `rug_creator`, `rug_holders_unreadable`, adoption events, sells and fills |

## Known limits

- **Price and pool SOL** are sampled on the engine's market reads (every `exitMs` while it watches, every `loopMs` at
  least), held in memory: after a restart the windows start empty.
- **Holders are polled** (above). A fast dump between two polls is seen at the next one. A wallet fires once per
  position: its second dump is not a new event.
- **Gaps:** a crash that happens while the watcher is stopped, or while reads fail, for longer than `windowSec` is
  never seen as a crash (the window starts again after the gap). The dev rule still sees a dump made while stopped.
- **Liquidity** is the SOL side of the pool. A bonding curve has no pool to pull; its falls are price crashes.
- **Only the canonical PumpSwap pool** is read, as candle-exit-manager.
- **Solana only.**

## Development

From the repo root: `npm run typecheck`, `npm run build`. The rules are pure functions (`src/rules.ts`); the watcher
(`src/watch.ts`) keeps the samples, makes the holder reads and records each firing; `src/watcher.ts` wires the core's
adopter, engine and holder poller (`candle-bot-core/sources/holders`).

## License

MIT
