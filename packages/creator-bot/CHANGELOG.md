# Changelog: candle-creator-bot

## Unreleased

- Pins candle-bot-core 0.6.0 (batch 3: opt-in additions only; no change in this package).

## 0.1.1

- On candle-bot-core 0.5.0 (pinned exactly). Same CLI, config, state dir, ledger, `status.json` fields, events and
  order handling: every 0.5.0 core addition is opt-in and this bot turns none on. One core fix reaches it (TEE wallet
  only): a build of transaction version 1 or later is never signed (the order ends `TX_VERSION`, alerted) instead of
  having a wrong signature read from it. Legacy and v0 transactions, which Candle builds today, go as before.
- Transactions of version 1 are now read (fills, launch transactions); before, the RPC refused them.

## 0.1.0

First release, on candle-bot-core 0.4.0 (pinned exactly).

- Follows a list of creators (Candle token-list creator or launch signer) through the core's launch source. Each
  creator has an optional label, ticket (at most `buy.sol`), and lifetime caps on entries and SOL, counted from the
  ledger's positions for that creator with the core's rules for what spent. The core's caps on top.
- Global filters as candle-launch-bot's: launch modes, max age, impact on the curve; a chain-first launch waits for
  Candle's market record; creator unknown waits. Optional: wait for the creator's own dev buy.
- `run`, `status` (per-creator use), `sell`; `STOP`, `PAUSE_BUYS`; a `follows` table in the ledger.
