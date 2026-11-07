# Changelog: candle-dca-bot

## 0.1.0

First release, on candle-bot-core 0.7.0 (pinned exactly; it ships the scheduler and lots).

- Schedules that buy (`sol` per run) or sell (`sol` worth, or a `fraction` of what the bot holds) one coin every
  `everySec`, optionally at a UTC time of day, with jitter, `maxRuns` and `until`.
- Runs are claimed in the ledger before the bot acts: a restart never fires a run twice. A run in flight blocks the
  next; missed slots are skipped (`missed: "skip"`) or caught up once (`"once"`).
- Guards: a price cap (buys) or floor (sells), an impact cap, a budget per buy schedule, and the core's caps.
- Every buy is its own lot; the wallet's bag of a schedule's coin is booked as a lot at start; sells go over the
  lots, the largest first, through the core's clamp.
- Optional exits (any core strategy) on the lots it bought.
- `plan` prints what each schedule would do now; never trades.
