# Changelog: candle-launch-helper

## 0.1.0

First release, on candle-bot-core 0.4.0 (pinned exactly).

- One Candle launch per state dir through the atomic route (payer main): build, the dev buy's expected fill checked,
  submit within 45 s; the dev buy as the bundle's first buy.
- `clientLaunchId` saved before the first build, never replaced; every state saved before its call; restarts,
  timeouts and errors reconcile from Candle's launch job; failed or refused launches wait for `RETRY_LAUNCH` (same id).
- The dev bag becomes a core position from its transaction on chain (core `openFromFill`); exits, `sell`, `STOP`,
  `PAUSE_BUYS` as every bot. Dry mode calls nothing. `plan`, `run`, `status`, `sell`.
