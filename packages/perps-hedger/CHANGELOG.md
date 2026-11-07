# Changelog: candle-perps-hedger

## 0.1.0

First release. Needs the candle-bot-core release that ships `perps/` (the core is not bumped in this branch).

- Hedges the spot bags of a Solana wallet (whole wallet or a list) with Hyperliquid perps through the Candle SDK
  (`perpsOpen`, `perpsClose`, `perpsLeverage` only). The hedge is on the coin's own perp when one is named and listed,
  else on a proxy (SOL). It is sized by a ratio or a fitted beta.
- A band, a max leverage, a max margin (and 90 % of the account value), an optional max notional.
- Reduce-only closes: a bag sold, a bag unpriced past `unpricedCloseSec`, `FLATTEN`.
- Restart safety: each order is written before the call under a fresh client id. A coin with an order in doubt is
  frozen and reconciled by that client id. The book is checked against the account each step. `accept <coin>` takes
  over a position.
- Fees and funding are booked from Hyperliquid's own rows. Dry runs use paper perps on real reads.
- `network`: mainnet or testnet.
