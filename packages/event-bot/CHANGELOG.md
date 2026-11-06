# Changelog: candle-event-bot

## 0.1.0 (unreleased)

First version, on candle-bot-core 0.6.0.

- `events`: a list of coins, each with a dated event (ISO 8601 with its offset) and a label.
- Buys each coin once (`buy.maxPerCoin`) in a window before its event (`entry.fromHours` to `entry.untilMin`), on its
  own venue: the Candle curve, its DAMM v2 pool, the pump.fun curve or the canonical PumpSwap pool, quoted by that
  venue's math. Refused venues (mayhem-mode, cashback, another quote mint, a venue it does not know) and an impact over
  `entry.maxImpactBps` are skipped before any attempt. Retries are rechecked on the venue (impact and drift).
- The `event` exit (core): optional ladder rungs and a stop loss during the build-up, a hedge at the event (keep
  `hedgeKeep`), a moonshot core after it (keep `coreKeep`), and the core's own take profit and max hold.
- `plan` prints each event's buy window and exit phases in clock time; never trades.
