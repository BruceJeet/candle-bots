# Changelog: candle-launch-helper

## 0.1.2

- Pins candle-bot-core 0.6.0 (batch 3: opt-in additions only; no change in this package).

## 0.1.1

- On candle-bot-core 0.5.0 (pinned exactly). Same CLI, config, state dir, ledger, `status.json` fields, events and
  order handling: every 0.5.0 core addition is opt-in and this bot turns none on. One core fix reaches it (TEE wallet
  only): a build of transaction version 1 or later is never signed (the order ends `TX_VERSION`, alerted) instead of
  having a wrong signature read from it. Legacy and v0 transactions, which Candle builds today, go as before.
- Transactions of version 1 are now read (fills, launch transactions); before, the RPC refused them.

## 0.1.0

First release, on candle-bot-core 0.4.0 (pinned exactly).

- One Candle launch per spec through the atomic route (payer main): build, the dev buy's expected fill checked,
  submit within 45 s; the dev buy as the bundle's first buy.
- `clientLaunchId` saved before the first build, never replaced; every state saved before its call; restarts,
  timeouts and errors reconcile from Candle's launch job (`building` saved before the build: a restart never builds).
- `RETRY_LAUNCH` builds once more under the same id only after a job read says `failed` or `JOB_NOT_FOUND`, and not
  under `PAUSE_BUYS` or `STOP`; otherwise it is ignored with why.
- Before the first build: `minDevBuyOutRaw` required (live), the dev buy within `lifetimeSol` and `maxOpen`, `wallet`
  the key's embedded wallet, and no earlier launch by the account with the same name and symbol (`launch.newLaunch`
  overrides).
- The dev bag becomes a core position from its transaction on chain (core `openFromFill`); exits, `sell`, `STOP`,
  `PAUSE_BUYS` as every bot. A missing or wrong dev-buy signature is found in the wallet's history for the mint;
  `adopt <signature>` books it by hand. `run` waits for a launch call in flight before closing on STOP or SIGTERM.
- Dry mode calls nothing. `plan` (with the API key: Candle's `dryRunAtomicLaunch` preview of the dev buy's fill),
  `run`, `status`, `sell`, `adopt`.
