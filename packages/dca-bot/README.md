# candle-dca-bot

Buys, or sells, a fixed amount of a coin on a timer (dollar-cost averaging). Each schedule runs on a fixed grid, never
twice for one slot, also across a restart. Candle coins (the launch curve and its DAMM v2 pool), pump.fun curves and
PumpSwap. A Solana bot built on [candle-bot-core](../core) and `@candledottv/agent-sdk`.

```sh
npm install -g candle-dca-bot
cp "$(npm root -g)/candle-dca-bot/examples/dry.json" bot.json   # then set each schedule's mint
candle-dca-bot plan --config bot.json    # when each schedule would run, and what it would do now; never trades
candle-dca-bot run  --config bot.json    # dry run: paper fills, never trades
```

## Schedules

```json
"dca": {
  "maxImpactBps": 300,
  "schedules": [
    { "id": "daily-buy", "mint": "<mint>", "side": "buy", "sol": 0.01, "everySec": 86400, "atUtc": "14:00",
      "jitterSec": 600, "maxRuns": 30, "budgetSol": 0.3, "maxPriceSol": 0.00002 },
    { "id": "weekly-trim", "mint": "<mint>", "side": "sell", "fraction": 0.1, "everySec": 604800, "missed": "once",
      "minPriceSol": 0.00001 }
  ]
}
```

| key | meaning |
|---|---|
| `id` | a stable name (letters, digits, `-`, `_`): the ledger keeps the schedule's runs under it |
| `mint`, `side` | the coin, and `buy` or `sell` |
| `sol` | buy: SOL spent per run (at most `buy.sol`). Sell: SOL worth sold per run, at the price then |
| `fraction` | sell only: the share of what the bot holds of the coin, per run |
| `everySec` | the interval, at least 10 s |
| `atUtc` | optional, `"HH:MM"` or `"HH:MM:SS"` UTC: the grid's time of day. `everySec` must then divide a day or be whole days |
| `jitterSec` | optional: each run fires up to this many seconds after its slot (drawn once, kept across restarts) |
| `missed` | `skip` (default) or `once`: what happens to slots missed while the bot was down or a run was still in flight |
| `graceSec` | optional: how late a slot may still run as on time (default half the interval, at most 60 s) |
| `maxRuns`, `until` | optional: the most runs (catch-up runs count), and an ISO time with its zone after which no run starts |
| `maxPriceSol` | buy only: no buy above this price (SOL per whole token) |
| `minPriceSol` | sell only: no sell under this price |
| `maxImpactBps` | buy: at most `dca.maxImpactBps` (a stricter cap for this schedule). Sell: opt-in, pump.fun venues only (below) |
| `budgetSol` | buy only: the most this schedule commits over all its runs |

**Timing.** Without `atUtc` the first run is when the bot first starts with the schedule, then every `everySec`. With
`atUtc` the slots are that time of day plus whole intervals. A run that starts late (the loop, the jitter) still
serves its slot; the next slot is the grid's, never moved. Each run is claimed in the ledger before the bot acts on
it, so a restart never fires it again. A run in flight (its order still being built, retried or settled) blocks the
schedule's next run. Slots passed meanwhile follow `missed`: `skip` runs nothing for them, `once` runs one catch-up
run however many were missed. A run that fails a guard, or comes while `PAUSE_BUYS` (buys) or `PAUSE_SELLS` (sells)
is set, is skipped and recorded; it is never held for later.

**After a restart** a run that was in flight places nothing more. Its orders already booked run to their end (the
core's recovery reads the chain), then the run ends. A run that booked nothing before the restart ends `interrupted`.

## Buys

A buy run is one candidate for the engine. The bot reads the coin's venue fresh and checks the price cap, the
venue's own buy math for the ticket (a mayhem-mode or cashback pump venue, another quote mint or a buy past the curve
are refused before any attempt), the impact cap and the schedule's budget. The engine then applies its caps:
`PAUSE_BUYS`, `buy.maxOpen` (lots held at once), `buy.lifetimeSol` (all buys ever) and `buy.sol` (the largest
ticket). It keeps the smaller of the bot's expected fill and its own read. No attempt is built more than
`dca.buyWithinSec` (default 60) after the run started. A retry is rechecked on the venue: the ticket's impact, and the
drift against the decision fill (`retry.maxPriceDriftBps`, else `dca.maxImpactBps`).

**Lots.** Every run's buy is its own position (a lot) with its own fill, cost and exit, so one coin can hold many.
`buy.maxPerCoin` is not a key here. The core's sell clamp, surplus check and buy recovery count every lot of a coin.

## Sells

A sell run sells from what the bot holds of the coin: its lots. It reads the venue fresh, checks the price floor and
(if set) the impact cap, then sells `fraction` of the lots' total, or `sol` worth at the price, never more than the
lots hold. The largest lot goes first, whole, then the next; a lot sold in part is the last order of the run. Each
order goes through the core: the wallet's balance is read and the sell clamped to it, one attempt per coin at a time.

**The wallet's bag.** When the bot starts, a schedule's coin that the wallet already holds, and in which the bot has
never had a position, becomes a lot: the wallet's balance on chain, if the mint passes the core's junk check and the
coin has a venue the core can price, worth at least `dca.minValueSol` (0.001). Its cost is its value at the mark then.
That happens once per coin; tokens that turn up later are alerted (`surplus`), never booked. A wallet lot is sold only
by a sell schedule or `sell`, never by the exit strategy. The token account must not be frozen.

**Run each bot on a wallet of its own, or list the other bots' state folders** in `dca.excludeStateDirs`: a coin any
of them holds is never booked here, and a wallet lot of it is never sold here. A listed ledger that cannot be read
stops both (fail closed, alerted). `dca.walletLots: false` turns wallet lots off: the bot then sells only what it
bought. A coin whose wallet read fails holds every run back until it is read (alerted after 5 min).

**The sell impact cap** compares the venue's own gross out (before fees) with the spot value. Only pump.fun curves
and PumpSwap have that math in the core: on a Candle curve or DAMM v2 coin a schedule with a sell `maxImpactBps` is
skipped every run ("sell impact not computable"). Leave the cap out for those coins.

## Exits

`exit` (optional, default `hold`) is any core strategy, run on each lot the bot bought: `tpsl`, `trail`, `ladder`,
`time`, `hold`. For example `{ "strategy": "tpsl", "takeProfit": 2 }` sells each lot that doubles from its own entry.

## Limits and controls

| key | default | meaning |
|---|---|---|
| `dca.maxImpactBps` | 300 | the buy impact cap, at the decision and on every retry |
| `dca.buyWithinSec` | 60 | no buy attempt is built later than this after its run started |
| `dca.checkPrograms` / `extraPrograms` | true / [] | linked payer: only builds calling known programs are signed |
| `dca.sellFloorMarginBps` | 200 | linked payer, pump.fun venues: a sell is never signed below the venue's expected out less `sell.maxSlippageBps` and this |
| `dca.buyFloorMarginBps` | 200 | linked payer: a buy is never signed with a floor under the decision fill less `buy.maxSlippageBps` and this |
| `dca.minValueSol` | 0.001 | the smallest wallet bag booked as a lot |
| `dca.maxTransferFeeBps` | 0 | a mint with a transfer fee up to this may be booked |
| `dca.walletLots` | true | book the wallet's bags of the schedules' coins as lots |
| `dca.excludeStateDirs` | [] | other bots' state folders on this wallet (each must hold a ledger at start) |

With payer `embedded` the three linked-payer checks do not apply: Candle signs inside the build. A config with only
sell schedules needs no `buy` section (every buy cap is then zero).

Controls in the state folder: `STOP`, `PAUSE_BUYS`, `PAUSE_SELLS`. `sell <mint> [--fraction f]` sells over every lot of
the coin (a request file while the bot runs). `status` prints `status.json`: each schedule's next run, run count, last
result and lots, and the budget used.

## Known limits

- One buy schedule per coin (the engine keeps one candidate per coin). Merge two buy schedules of a coin into one.
- Every lot counts against `buy.maxOpen`, wallet lots included: a schedule that buys every hour needs room for its
  lots.
- A schedule's run count, history and budget are kept under its `id`: renaming the `id` starts a new schedule (its
  budget and `maxRuns` count from zero).
- Use the bot's own `sell` command. A `sell-*.json` request file written by hand (the core's format) sells one lot
  only.
- A run's reads are given about 5 s per loop: on a slow RPC its buy comes with a later loop, never lost.
- Runs fire on the loop (`loopMs`, default 2 s) after their slot; `jitterSec` adds to that.
- A fraction sold from a lot is exact to 1e-6 of that lot.
- Spend: `buy.lifetimeSol` and `budgetSol` count tickets only. Candle's platform fee (0.25 % a side), network fees and
  about 0.002 SOL of token-account rent per new coin come on top: fund the wallet with some room above them.

## License

MIT
