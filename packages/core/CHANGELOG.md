# Changelog: candle-bot-core

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
