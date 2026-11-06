# candle-event-bot

Buys coins tied to a dated event (a launch, a keynote, a listing) in a window before it, and exits them in phases
keyed to the event: ride the build-up, hedge at the event, keep a moonshot core. A Solana bot built on
[candle-bot-core](../core) and `@candledottv/agent-sdk`.

```sh
npm install -g candle-event-bot
candle-event-bot plan --config examples/dry.json   # each event's buy window and exit phases; never trades
candle-event-bot run  --config examples/dry.json   # dry run: decides and logs, never trades
```

## Events

```json
"events": [{ "mint": "<the coin>", "at": "2026-12-01T17:00:00Z", "label": "the keynote" }]
```

One event per coin. `at` is an ISO 8601 time **with its offset**; a time without one is refused, so it can never be
read in the machine's local time by mistake. Check the date yourself. A wrong day is the costliest mistake this bot
can make, and `plan` prints every phase in clock time to catch it.

## When it buys

`entry`:

| key | default | meaning |
|---|---|---|
| `fromHours` | 72 | the buy window opens this long before the event |
| `untilMin` | 60 | and closes this long before it (no attempt is built after) |
| `maxImpactBps` | 300 | the ticket's impact on the venue (also the retry limit) |
| `buyWithinSec` | 60 | no attempt is built later than this after the decision |
| `retryMin` | 10 | a coin skipped in its window is looked at again after this long |
| `checkPrograms` / `extraPrograms` | true / [] | linked payer: only builds calling known programs are signed. With payer `main` none of these three checks applies (Candle signs inside the build) |
| `sellFloorMarginBps` | 200 | linked payer: a sell is never signed below the venue's expected out less `sell.maxSlippageBps` and this. pump.fun venues only: on a Candle curve or DAMM v2 coin, or when the read fails, only Candle's own floor applies |
| `buyFloorMarginBps` | 200 | linked payer: a buy is never signed with a floor under the decision fill less `buy.maxSlippageBps` and this (the first attempt too) |

Each coin is bought once (`buy.maxPerCoin`, default 1) with a ticket of `buy.sol`. The coin's venue is read fresh at
the decision: the Candle curve, its DAMM v2 pool, the pump.fun curve or the canonical PumpSwap pool. The buy must be
quoted by that venue's own math. These are skipped before any attempt:
- a venue the math refuses (mayhem-mode, cashback, another quote mint, a buy past the curve's tokens);
- a coin on a venue it does not know (e.g. a Raydium or Orca pool);
- an impact over the limit.

The engine keeps the smaller of the bot's expected fill and its own read. A retry is rechecked on the venue: the
ticket's impact, and the drift against the decision fill (`retry.maxPriceDriftBps`, else `maxImpactBps`). The core's
caps, `PAUSE_BUYS` and `STOP` apply as in every bot.

## Exits

Any core strategy, or `event` (the phased exit; the bot gives it each coin's event time):

```json
{ "strategy": "event", "rungs": [{ "at": 3, "sell": 0.2 }], "stopLoss": 0.3,
  "hedgeAtMin": 0, "hedgeKeep": 0.5, "afterMin": 60, "coreKeep": 0.2,
  "coreTakeProfit": 20, "coreMaxHoldHours": 168 }
```

| phase | when | what |
|---|---|---|
| build-up | until `hedgeAtMin` after the event | only `rungs` (the ladder's: at a multiple, sell that share of the original, in all) and `stopLoss` (a multiple: everything goes), each optional |
| hedge | from `hedgeAtMin` (default 0; negative is before the event) | keep at most `hedgeKeep` (default 0.5) of the original |
| core | from `afterMin` (default 60) | keep at most `coreKeep` (default 0.2): the moonshot core |
| core exit | any time after `afterMin` | `coreTakeProfit` (a multiple) or `coreMaxHoldHours` after the event: the core goes; without them it is held |

Every phase is a target for the share of the original position kept, so a restart, a failed sell or a late tick
never sells twice. Without `rungs` and `stopLoss` nothing sells before the hedge. `stopLoss` acts only in the build-up:
from the hedge on there is no stop loss, and what is kept rides the event down as well as up, until `coreTakeProfit`
or `coreMaxHoldHours`.

- **The buy window must close before the hedge:** a config whose window (`entry.untilMin`) reaches the hedge time
  (`hedgeAtMin`) is refused at load, and a decision at or past the hedge is skipped. A buy then would be sold down at
  once.
- **The phases follow the event time in the config as it is now.** An event moved while a coin is held moves its
  phases. Moved into the past, the phases already due sell at the next tick. Edit an event's time only while flat in
  that coin, unless moving its phases is what you want.
- **A coin held with no event in the list** (removed or changed in the config) gets no phase at all. The bot alerts
  on it while it lasts. List it again, or `sell` it by hand.
- Event times are checked as real dates: Feb 30 or 24:00 are refused, not rolled over.

## Known limits

- The venues are the four above. A coin that trades elsewhere is skipped, not guessed.
- The bot buys at the first look inside the window that passes its checks. It does not time the entry within the
  window.
- Spend: `buy.lifetimeSol` counts tickets only. Candle's platform fee (0.25 % a side), network fees and about
  0.002 SOL of token-account rent per new coin come on top.

## License

MIT
