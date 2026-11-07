# candle-perps-hedger

Hedges the spot bags of a Solana wallet with Hyperliquid perps through Candle. Each bag gets a short on its own perp
when you name one and Hyperliquid lists it, else on a proxy (SOL by default). The bot sizes the short by a ratio or a
fitted beta, rebalances it outside a band, keeps it within a max leverage and a max margin, closes it reduce-only when
the bag is gone, and books fees and funding. Built on [candle-bot-core](../core) and `@candledottv/agent-sdk`.

```sh
npm install -g candle-perps-hedger
candle-perps-hedger plan --config examples/dry.json                     # one read and the orders it would send; never trades
candle-perps-hedger run  --config examples/dry.json --max-seconds 60    # dry run: real reads, paper perps, no key
```

## What it needs

| mode | needs |
|---|---|
| `dry` | a Solana wallet address to read (`spot.wallet`) and an RPC (public by default). No key: the perps are paper. |
| `live` | a Candle API key with scope `perps:write` (`apiKeyEnv`), an EVM TEE wallet bound to that key (`perps.wallet`, its `0x` address), its P-256 signer (`perps.signer`, the same stores as the other bots), a first deposit and `candle perps setup` on that wallet. The Hyperliquid account must be in standard mode. |

`network` is `mainnet` or `testnet` (Hyperliquid's). The SDK refuses a build for the other network, and asset indexes
differ between the two, so the bot always reads them. Start live on testnet.

Every perps order goes through the SDK: `perpsOpen` (a market IOC within `perps.slippageBps` of the mid), `perpsClose`
(a reduce-only IOC) and `perpsLeverage`. Candle builds each order and the SDK checks it against its own read of
Hyperliquid. Candle's relay then signs it and the SDK submits it. The bot reads markets, the account, fills and
funding from Hyperliquid's public `/info`.

## How it sizes the hedge

- **Bags:** every coin the wallet holds (`spot.mode: "wallet"`, less `spot.exclude`; wrapped SOL, USDC and USDT are
  always excluded), or the listed mints (`"list"`). Each bag is priced in SOL on its venue (Candle curve or its DAMM v2
  pool, pump.fun curve, PumpSwap), then in USD at Hyperliquid's SOL mark. A bag is not hedged when its venue holds
  less than `spot.minLiquiditySol` (default 5 SOL) or it is worth less than `hedge.minBagUsd` (default 20).
- **Instrument:** `hedge.coins["<mint>"].perp` names the coin's own perp (`"WIF"`, `"kBONK"`). Hyperliquid has no mint
  addresses, so it is never matched by ticker. A listed perp with a mark is used at ratio 1 by default. If it is
  delisted or missing, the bag goes to the proxy. If it still holds a short when that happens, that short is closed
  first, and no proxy hedge is put on top. `perp: null` leaves a coin unhedged.
- **Ratio:** `hedge.ratio` (default 1) or a coin's own `ratio`. With `hedge.beta` set, the bot records each bag's USD
  price and the proxy's mark every `everySec`. Once there are `minSamples` pairs within `windowMin`, it uses their beta
  (clamped to `min`..`max`) for proxy hedges that have no configured ratio.
- **Target:** a short of ratio x the bag's USD value, summed per perp coin, sized at the mark and rounded toward zero
  at the market's size step.

| key | default | meaning |
|---|---|---|
| `bandPct` | 20 | the band: no order while the position is within the larger of this share of the target and `minOrderUsd` |
| `minOrderUsd` | 11 | the band's floor in USD, so no order is smaller (Hyperliquid's minimum order is 10 USD) |
| `maxLeverage` | 3 | the leverage set on each hedge coin, capped at the market's own max |
| `maxMarginUsd` | required | notional / leverage over every hedge, at most this; also at most 90 % of the account value |
| `maxNotionalUsd` | none | optional cap on the total notional |
| `unpricedCloseSec` | 60 | a bag not priced for this long counts zero: its hedge is closed |

Over a cap, every target is scaled down by the same factor, and the bot alerts. Positions it cannot change this step
count against the caps first.

## Orders and safety

- One order per coin per step. More short: a market open. Less short: a reduce-only close of the difference. A bag
  sold, a bag unpriced past `unpricedCloseSec`, or `FLATTEN`: a reduce-only close of the whole position. A long on a
  hedge coin is closed.
- No venue read, no order.
- Before the venue is asked, every order is written to the book (`hedge.sqlite`) under a fresh client id (the order's
  cloid). An order with no clear answer (a timeout, a submit that failed, an unreadable leg) freezes its coin. The bot
  then only reads the venue's record of that client id. It books the fill when the venue has one. When the venue has no
  record after `perps.settleSec` (default 120) and no unexplained fill on the coin, it writes the order off. A restart
  reads the same book, so an order in doubt is never sent again.
- The book's position on each coin (the sum of its fills) is checked against the account's every step. A difference
  held for `perps.mismatchSec` (default 30) is alerted, and the coin gets no new or larger orders. It can still be
  closed whole when nothing should be hedged on it. `accept <coin>` (with the bot stopped) takes the account's
  position over as the hedger's. From then on the hedger sizes that position to the bags, so it may reduce or close
  it.
- The coins it trades are the proxy, the configured perps and coins it traded before. Positions on other coins are
  never touched. Use a perps wallet of its own: funding is booked per coin.
- Leverage and margin mode (`perps.marginMode`, default `isolated`) are set on a coin once per run, before its first
  open. A refusal skips the open and is alerted.
- Fees (Hyperliquid's own `fee`, the builder fee included) and funding (signed: negative paid) are read every
  `perps.fillsEverySec` and booked once each. A fill on a hedge coin from an order that is not the bot's is alerted
  and not counted.

Controls in the state folder: `STOP` ends the run. `PAUSE_OPENS` blocks new or larger hedges; closes still run.
`FLATTEN` (the `flatten` command) closes every hedge and holds flat until `resume`.

`status.json` holds the account, each coin's target and position, each bag (venue, value, hedge, status), the frozen
coins, orders in doubt, the book, fees, funding and closed P&L, and the last orders.

## Dry runs

`mode: "dry"` reads Hyperliquid and Solana for real and trades on paper. An order fills at once at the mark, moved
`perps.paper.slippageBps` (5) against it, and pays `perps.paper.feeBps` (14.5: a 4.5 bps taker fee plus Candle's 10 bps
builder fee). Funding is charged each hour at the last read rate. Opens under 10 USD are refused. A state folder
belongs to one mode, network and account.

## Commands

```
candle-perps-hedger run     --config hedge.json [--mode dry] [--max-seconds n]
candle-perps-hedger plan    --config hedge.json        one read and the plan; never trades, opens the book read-only
candle-perps-hedger status  --config hedge.json
candle-perps-hedger flatten --config hedge.json        writes FLATTEN
candle-perps-hedger resume  --config hedge.json        removes FLATTEN and PAUSE_OPENS
candle-perps-hedger accept  <coin> --config hedge.json (stopped) book the account's position in <coin> as the hedger's
```

`plan` uses the configured ratios, not fitted betas, and does not run the position check. A run can therefore send
less than `plan` shows.

## License

MIT
