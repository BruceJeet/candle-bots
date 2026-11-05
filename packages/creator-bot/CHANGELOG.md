# Changelog: candle-creator-bot

## 0.1.0

First release, on candle-bot-core 0.4.0 (pinned exactly).

- Follows a list of creators (Candle token-list creator or launch signer) through the core's launch source. Each
  creator has an optional label, ticket (at most `buy.sol`), and lifetime caps on entries and SOL, counted from the
  ledger's positions for that creator with the core's rules for what spent. The core's caps on top.
- Global filters as candle-launch-bot's: launch modes, max age, impact on the curve; a chain-first launch waits for
  Candle's market record; creator unknown waits. Optional: wait for the creator's own dev buy.
- `run`, `status` (per-creator use), `sell`; `STOP`, `PAUSE_BUYS`; a `follows` table in the ledger.
