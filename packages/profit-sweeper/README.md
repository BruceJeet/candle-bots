# candle-exit-manager

Runs exits on bags that are already in a Solana wallet: bought by hand, by another tool, or left over. It adopts them
and sells by a strategy you pick, a trailing stop included. It never buys. One config file, one process, a local
SQLite ledger. Built on Candle's official SDK, [`@candledottv/agent-sdk`](https://www.npmjs.com/package/@candledottv/agent-sdk)
(pinned at 0.6.14), and [candle-bot-core](https://www.npmjs.com/package/candle-bot-core).

Built by [Bruce Jeet](https://github.com/BruceJeet).

- **Which bags:** a list of coins you name, or the whole wallet. In whole-wallet mode every token is adopted except the
  ones you exclude, the ones another bot holds (`excludeStateDirs`: their ledgers are read every cycle), dust under
  `minValueSol`, and anything it cannot judge or price.
- **Venues:** Candle coins (launch curve, then the DAMM v2 pool), pump.fun coins on their bonding curve, and pump.fun
  coins that moved to PumpSwap. The venue is read from chain per coin; prices and expected sell proceeds come from each
  venue's own math and fees.
- **Junk filter:** a coin is not adopted (and an adopted one is not sold) when its mint can take the tokens back or
  stop a transfer: a token-2022 transfer hook, a permanent delegate, non-transferable, frozen by default, paused,
  confidential transfers, a transfer fee over your cap, or an extension it does not know. A frozen token account too.
- **Cost basis:** from the buy signatures you give, a cost you enter, or the wallet's own buys found on chain;
  otherwise none. Exits that need a basis (`tpsl`, `ladder`, `trail` with `activate`) skip a bag without one unless you
  choose to use the price at adoption (`noBasis: "mark"`).
- **Exits:** `trail` (a trailing stop; the high-water mark survives restarts), `tpsl`, `ladder`, `time`, `hold`,
  `preGrad`, or your own file; one per coin if you like (`manager.exits`).
- **Execution** through Candle's trade API, from your account's embedded wallet or a TEE wallet signed on your machine.
  Fills are booked from the transaction; sells are clamped to the wallet balance; retries are capped with backoff. With
  a TEE wallet, a transaction that calls a program the manager does not know is never signed.
- **Dry mode** adopts into its own ledger and logs every exit it would take; it signs nothing.

Solana only.

## Quick start

Node 22.18 or newer.

```sh
npm install -g candle-exit-manager      # or npx candle-exit-manager ...
cp "$(npm root -g)/candle-exit-manager/examples/dry.json" bot.json
# set "wallet" in bot.json to the wallet whose bags you want managed
candle-exit-manager run    --config bot.json      # dry run: adopts and logs the exits it would take
candle-exit-manager status --config bot.json      # each bag: venue, basis, next exit
```

When the dry run looks right, use a new `stateDir` for live, set your API key, `"mode": "live"`, and run again:

```sh
export CANDLE_API_KEY=cndl_live_...
candle-exit-manager run --config bot.json
```

## What it needs

- A **Candle API key** with the `swap:write` scope, in an environment variable (`apiKeyEnv`), never in the file.
  A coin Candle did not launch (pump.fun, PumpSwap) sells through Candle's Jupiter route: check that your Candle plan
  covers trading coins Candle did not launch.
- A **payer**: `embedded` (your account's embedded Solana wallet; Candle signs) or `linked` (a TEE wallet bound to the
  key, signed on this machine with the key's signer). Setup is the same as candle-launch-bot's; its README walks
  through it.
- An **RPC**: `rpcUrlEnv` names an env var with your Solana RPC URL. The public one works for a dry run but is
  rate-limited.

## Sharing a wallet with other bots

If another bot trades from the same wallet, list its state dir in `adoption.excludeStateDirs`. Every cycle the manager
opens that bot's `ledger.sqlite` read-only (one short query, then closed; a SQLite reader never blocks the other
bot) and never adopts a coin it holds open. If the other bot opens a position in a coin the manager already manages,
the manager releases that coin (stops managing it, sells nothing) and alerts. A listed dir with no `ledger.sqlite`
refuses to start. If a listed ledger cannot be read while running, the manager adopts nothing new and grows nothing
until it can, and alerts; sells use the last good read for up to 5 minutes, then are held and alerted.

A bot that keeps its ledger in another format cannot be read: put its coins in `adoption.exclude` instead.

## Controls

Files in the state dir, read every cycle:

- `STOP`: finish the cycle, write status, exit 0. The file stays until you remove it.
- `PAUSE_SELLS`: every new exit is held; prices, peaks and trail marks keep updating. A sell already booked keeps going.
  Remove it and the next tick decides.
- `candle-exit-manager sell <mint> [--fraction 0.5]`: a manual sell through the same order path (works under
  `PAUSE_SELLS`).
- `candle-exit-manager adopt <mint> [--signatures s1,s2 | --cost-sol 0.2 | --basis mark]`: adopt one coin now (list
  mode, or one the manager let go of before).
- `candle-exit-manager release <mint>`: stop managing a coin. Nothing is sold; the tokens stay in the wallet. A
  released coin is not adopted again unless you `adopt` it.

With the manager running, `sell`, `adopt` and `release` hand it a request file; with it stopped, they run directly.
`SIGINT`/`SIGTERM` stop the same way as `STOP`. A restart picks up from the ledger.

## Bags that change outside the manager

The manager compares each bag with the wallet every `adoption.everyMs`. A change counts once two reads at least a minute
apart agree and no order of that coin is in flight (a balance read lagging behind one of its own sells is not a change).

- **More tokens:** the bag grows. Tokens from a buy the wallet made (found on chain) add that buy's cost; tokens that
  arrived any other way add at the bag's average entry price, so they never make its multiple look better.
- **Fewer tokens:** the bag shrinks to the wallet's balance; the difference is written off, never counted as a sell and
  never sold again. At zero the bag closes.

Both are alerted.

## State dir

| File | What |
|---|---|
| `ledger.sqlite` | positions (one per adopted bag), orders, every attempt with its full error, `adoptions` (basis source, when), trail marks, alerts |
| `status.json` | every cycle: open positions with venue and price, `managed` (each bag's basis, strategy and next exit), `adoption.skipped` (coins left alone and why), `sellsPaused` |
| `events.jsonl` | one JSON line per event (also on stdout): `adopted`, `adoption_skip` (with the reason), `adopted_grown`, `adopted_shrunk`, `released`, `sell_order`, fills, `exits_paused` |
| `requests/` | `sell`, `adopt` and `release` requests while the manager runs |
| `lock` | one process per state dir |

## Config reference

`examples/dry.json` is a working start. Besides the shared keys (`mode`, `payer`, `apiKeyEnv`, `rpcUrlEnv`,
`wallet`, `stateDir`, `loopMs`, `exitMs`, `sell`, `exit`, `retry`, `alerts`; see candle-launch-bot's README), a
`buy` section is refused: this bot never buys.

```jsonc
"adoption": {
  "mode": "wallet",                         // or "list"
  "mints": [ "Mint…", { "mint": "Mint…", "signatures": ["…"] }, { "mint": "Mint…", "costSol": 0.2 }, { "mint": "Mint…", "basis": "mark" } ],
  "exclude": [],
  "excludeStateDirs": [ "../launch-bot/state" ],
  "minValueSol": 0.001,
  "maxTransferFeeBps": 0,
  "noBasis": "skip",
  "historyPages": 3,
  "everyMs": 15000
},
"manager": {
  "exits": { "Mint…": { "strategy": "tpsl", "takeProfit": 3, "stopLoss": 0.5 } },
  "checkPrograms": true,
  "extraPrograms": []
},
"exit": { "strategy": "trail", "trailBps": 2500 }
```

| Key | Meaning |
|---|---|
| `adoption.mode` | `list`: only `mints` (and `adopt` requests). `wallet`: every token in the wallet, less the exclusions |
| `adoption.mints` | coins and, optionally, how to find each one's cost: buy `signatures`, `costSol`, or `basis: "mark"` |
| `adoption.exclude` | never adopted (wrapped SOL never is) |
| `adoption.excludeStateDirs` | other bots' state dirs on the same wallet; their open coins are never adopted |
| `adoption.minValueSol` | a bag worth less (at its venue's sell price) is dust and left alone (default 0.001) |
| `adoption.maxTransferFeeBps` | a token-2022 transfer fee above this refuses the coin (default 0: any fee refuses) |
| `adoption.noBasis` | for an exit that needs a cost basis when none is found: `skip` (default) or `mark` (the value at adoption) |
| `adoption.historyPages` | pages of 100 signatures per token account read to find the wallet's own buys (default 3; 0: never) |
| `adoption.everyMs` | how often the wallet is read for new bags and changes (default 15000) |
| `manager.exits` | a coin's own exit, instead of `exit` |
| `manager.checkPrograms` | TEE wallet: refuse to sign a build that calls a program outside the known set (default true) |
| `manager.extraPrograms` | programs to add to that set |
| `manager.sellFloorMarginBps` | TEE wallet, pump.fun venues: a sell is not signed when Candle's floor sits more than `sell.maxSlippageBps` plus this under the venue's own price (default 200) |
| `exit` | the default exit. `trail`: `trailBps` (sell this far under the high), `activate` (arm at this multiple of the entry; needs a basis), `sell` (share of the rest per hit) |

## How the money paths work

The same as every candle-bot-core bot (fills from the transaction, sells clamped to the balance, one live transaction
per order, refusals read from their structure, uncertain orders recovered from chain). What is particular here:

- **Quantity is the wallet's.** A bag's size is the wallet's balance when it is adopted, then follows the wallet as
  described above. A sell never asks for more than the wallet holds.
- **Expected proceeds are the venue's.** On pump.fun curves and PumpSwap the engine computes what a sell should bring
  (reproduced to the lamport on real sells, fees included) and records it on the order; Candle's build sets the
  slippage floor (`sell.maxSlippageBps`).
- **Checks before every sell of an adopted bag:** the mint passes the junk filter again (read at most a minute
  before), no other bot holds the coin, and with a TEE wallet the built transaction calls only known programs and its
  floor is not far under the venue's own price (`manager.sellFloorMarginBps`). Any of these failing holds the sell and
  alerts.

## Known limits

- **Only the canonical PumpSwap pool.** A pump.fun coin is priced on the pool it migrated to; other pools of the same
  coin are not read. Mayhem-mode PumpSwap pools and coins quoted in anything but SOL are not priced (not adopted).
- **Inner calls.** The known-program check reads a transaction's top-level calls; a token's own hook is caught by the
  mint check instead. With the embedded wallet Candle signs inside the build, so the check cannot run there.
- **Other bots' ledgers** must be candle-bots ledgers (`ledger.sqlite`). Anything else: use `adoption.exclude`.
- **Cost from history** is the average cost of the buys found in the last `historyPages` pages, not the cost of the
  exact tokens held.
- **Solana only.**

## Development

From the repo root: `npm run typecheck`, `npm run build`. Adoption, the venue readers, the trail and the controls are
candle-bot-core's (`adopt/adopter`, `market/pump`, `market/mint`, `strategies/trail`); this package is the config
sections (`adoption`, `manager`), the per-coin exits (`src/manager.ts`) and the command line.

## License

MIT
