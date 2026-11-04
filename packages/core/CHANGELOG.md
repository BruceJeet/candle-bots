# Changelog: candle-bot-core

## 0.2.0

Speed, with the money rules unchanged. A 0.1.0 trigger works as is.

- **Fast entry lanes.** `ctx.wake()` (new) runs a lane at once between full cycles: pending candidates are decided and
  each buy is built and submitted as soon as it is booked, then queued buys are built, for at most `LANE_BUDGET_MS`
  (1 s) plus the buy in flight. Wakes are debounced (10 ms quiet, 50 ms at most). `Engine.run(loopMs)` is the new run
  loop: full cycles `loopMs` after the last one ended (as before), lanes in between, a due full cycle always first.
  `runtime.run` uses it. Lanes and cycles never overlap.
- **Bounded entries.** Every entries step decides for at most `LANE_BUDGET_MS`; what is left goes on in lanes, so an
  exit pass never waits behind a long backlog (0.1.0: up to the 20 s cycle budget).
- **One curve read per buy.** `ctx.readCurve(mint, address?)` (new) reads a Candle curve through the engine, once per
  account per entries step; the expected-fill bound reuses the engine's own read (never a trigger's).
- **Caps inside the booking transaction.** The caps are checked again in the ledger transaction that books a buy
  (event `buy_refused_at_booking` if they refuse there).
- `Trigger.start(ctx)` gets the engine's context. `Ledger.dueOrders(now, side, dry)` (new, read only).
- Exit pass: last and peak prices written in one transaction, only where they changed (was one commit per position).
  Surplus balance reads 8 at a time. `getAccounts` sends its 100-key chunks together.
- No change to the executor, fills, refusal rules, adoption, the ledger schema or its durability.

## 0.1.0

First release. Taken from candle-launch-bot 0.1.3 with the money paths unchanged:

- ledger (positions, orders, attempts, alerts; lifetime and open caps), with bot tables kept to the bot's subclass;
- executor and trade rails (linked TEE wallet, embedded wallet): fills read from chain, sell clamps, capped retries,
  refusal classification (including `not_broadcast` for main-payer buys), uncertain-order recovery and adoption;
- exit strategies `hold`, `ladder`, `preGrad`, `time`, `tpsl` and the plug-in loader;
- Candle curve and DAMM v2 market reads, impact; Solana RPC, PDA, base58 and logs-socket helpers;
- controls (`STOP`, `PAUSE_BUYS`, sell requests, the state-dir lock), `status.json`, alerts, redaction, logging;
- the engine loop with a cycle budget, driven by a bot's `Trigger` (new: `trigger.ts`), and bot config sections
  (new: `parseConfig(raw, baseDir, sections)`);
- one change in the executor: the buy-retry impact limit is a required dependency (`maxBuyImpactBps`) instead of
  the launch bot's `filters.maxImpactBps`;
- the engine holds its caps whatever a trigger does: candidates and verdicts are read once into frozen copies (mint
  must be an address, chain solana, buy reason a non-empty string, typed fields), `onVerdict` gets copies, the config
  is deep-frozen, `ctx.ledger` is a read-only view (`LedgerView`), each trigger call has a timeout
  (`triggerTimeoutMs`, default 10 s), and a buy's expected fill is bounded by the engine's own curve read;
- `runtime.ts`: the run loop, `status` and `sell` commands, rail and executor wiring for a bot's command line.
