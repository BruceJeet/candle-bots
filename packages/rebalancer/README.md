# candle-rebalancer

Holds a wallet at target weights across coins and SOL. On a schedule it reads the wallet and every target coin's
venue, sells what is over its band, then buys what is under, within a minimum trade size and a cap on the SOL moved per
run. Candle coins (the launch curve and its DAMM v2 pool), pump.fun curves and PumpSwap. A Solana bot built on
[candle-bot-core](../core) and `@candledottv/agent-sdk`.

```sh
npm install -g candle-rebalancer
cp "$(npm root -g)/candle-rebalancer/examples/dry.json" bot.json   # then set the target coins' mints and your wallet
candle-rebalancer plan --config bot.json   # the full plan for the wallet now; never trades, books nothing
candle-rebalancer run  --config bot.json   # dry run: paper fills, never trades
```

## Targets

```json
"rebalance": {
  "targets": { "<mint A>": 0.3, "<mint B>": 0.2 },
  "solWeight": 0.5,
  "bandPct": 5, "minTradeSol": 0.01, "maxSolPerRun": 0.2, "reserveSol": 0.05, "maxImpactBps": 300,
  "schedule": { "everySec": 21600, "atUtc": "00:00", "jitterSec": 300, "missed": "once" }
}
```

The weights and `solWeight` sum to 1 (up to 20 coins). The wallet's value is its free SOL (the balance less
`reserveSol`) plus each target coin at its price on its venue. Coins the config does not name are not counted and
never traded.

## A run

1. **Read and plan.** The SOL balance, each target coin's balance and its venue are read fresh. The plan is logged in
   full (`rebalance_plan` in `events.jsonl`): each coin's value, weight, target and distance, every order and every
   trade dropped, with why. **A coin the bot cannot price, or a balance it cannot read, blocks the run**: nothing is
   traded, the run ends `blocked` and an alert says which coin. Nothing is guessed.
2. **Sells first.** A coin over its target by more than `bandPct` percentage points sells down to its target, the
   farthest off first, through the core (the sell clamped to the wallet's balance, one attempt per coin).
3. **Then buys,** once every sell has ended: the wallet is read again and the buys are planned from it, so they spend
   SOL the sells really brought. A coin under its target by more than the band is bought up to it, the farthest off
   first. Buys are paid only from SOL above SOL's own target less the band, so a buy never takes SOL's weight out of
   its band. Each buy is at most `buy.sol`. Each is decided by the engine like any bot's buy: the venue is read again,
   its own buy math must quote the ticket, the impact must be within `maxImpactBps`, and the engine's caps apply
   (`PAUSE_BUYS`, `buy.maxOpen`, `buy.lifetimeSol`).
4. **Caps.** `maxSolPerRun` caps the SOL moved by the whole run, sells and buys together (at the plan's prices); the
   sells take it first. An order under `minTradeSol` is dropped. What a cap leaves undone, the next run picks up.

| key | default | meaning |
|---|---|---|
| `bandPct` | 5 | trade a coin only when its weight is off its target by more than this (percentage points) |
| `minTradeSol` | 0.01 | drop orders smaller than this |
| `maxSolPerRun` | required | the SOL moved per run, sells and buys together |
| `reserveSol` | 0.05 | SOL never counted or spent (fees, rent) |
| `maxImpactBps` | 300 | a buy's impact on its venue (fees apart), at the decision and on every retry |
| `buyWithinSec` | 60 | no buy attempt is built later than this after it was planned |
| `checkPrograms` / `extraPrograms` | true / [] | linked payer: only builds calling known programs are signed |
| `sellFloorMarginBps` / `buyFloorMarginBps` | 200 / 200 | linked payer: the sell and buy floors, as in the other bots |
| `minValueSol` | 0.001 | the smallest wallet bag booked as a lot |
| `maxTransferFeeBps` | 0 | a mint with a transfer fee up to this may be booked |
| `walletLots` | true | book the wallet's bags of the targets as lots |
| `excludeStateDirs` | [] | other bots' state folders on this wallet (each must hold a ledger at start) |

## The schedule

`schedule` takes `everySec` (at least 10 s), and optionally `atUtc` (`"HH:MM"` UTC; `everySec` must then divide a day
or be whole days), `jitterSec`, `graceSec`, `missed` (`skip`, the default, or `once`), `maxRuns` and `until` (an ISO
time with its zone). Each run is claimed in the ledger before the bot acts, so a restart never fires it again. A run
in flight (its sells or buys still being built, retried or settled) blocks the next. Slots passed meanwhile follow
`missed`: `skip` runs nothing for them, `once` runs one catch-up run. A run that finds an order of a target coin in
flight is skipped. **After a restart** a run that was in flight places nothing more: its orders run to their end
and it ends then (no buy phase for it); the next run plans afresh.

## Lots and the wallet's bags

When the bot starts, each target coin the wallet already holds (and in which the bot has never had a position)
becomes a lot: the wallet's balance on chain, if the mint passes the core's junk check and the coin has a venue the
core can price, worth at least `minValueSol`. Its cost is its value at the mark then. Every buy is its own lot after
that. Sells take the largest lot first. Tokens that turn up later are alerted (`surplus`), never booked: the plan
values the wallet's balance, but sells only what the bot's lots hold. There is no exit strategy: the rebalancer sells
only to rebalance (and on `sell`). A frozen token account is never booked.

**Run the rebalancer on a wallet of its own, or list the other bots' state folders** in `rebalance.excludeStateDirs`:
a coin any of them holds is never booked as a lot here, and a wallet lot of it is never sold here. A listed ledger
that cannot be read stops both (fail closed, alerted). `rebalance.walletLots: false` turns wallet lots off: the plan
still values the wallet's bags, but only the coins the bot bought are sold. A coin whose wallet read fails holds
every run back until it is read (alerted after 5 min).

## Dry runs

`plan` prints the full plan for the wallet as it is now (both sides; the buys count the sells' SOL at the plan's
prices) and exits. It needs no key and books nothing. `run` in dry mode books paper fills: the wallet is never
touched, so a dry run's holdings are its own lots and its SOL is the wallet's less its dry buys plus its dry sells.

## Controls

`STOP`, `PAUSE_BUYS` (a run's buys are skipped), `PAUSE_SELLS` (a run's sells are skipped; its buys still go) in the
state folder. `sell <mint> [--fraction f]` sells over every lot of a coin. `status` prints `status.json`: the
schedule, the last plan, the lots per target.

## Known limits

- Prices are spot prices on each coin's venue; the plan does not model a sale's own impact on the value it brings.
  The buy phase reads the wallet again after the sells, so buys spend what the sells really brought.
- A fraction sold from a lot is exact to 1e-6 of that lot.
- Every lot counts against `buy.maxOpen`, wallet lots included (each buy is a lot).
- The schedule's run count and history are kept in the ledger; a new state folder starts them from zero.
- Use the bot's own `sell` command. A `sell-*.json` request file written by hand (the core's format) sells one lot
  only.
- A run's reads are given about 5 s per loop: on a slow RPC its buys come with a later loop, never lost.
- Spend: `buy.lifetimeSol` counts tickets only; Candle's platform fee (0.25 % a side), network fees and about
  0.002 SOL of token-account rent per new coin come on top.

## License

MIT
