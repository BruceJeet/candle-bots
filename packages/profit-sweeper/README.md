# candle-profit-sweeper

Sells the bags in a Solana wallet at your targets and asks for the profit to be sent to your home address. It never
moves funds itself. Each sweep is a **request**: the wallet, the amount, your home address in full and a request id,
written to the state folder and sent through your alerts. It is kept until you mark it done. It never buys. One config
file, one process, a local SQLite ledger. Built on Candle's official SDK,
[`@candledottv/agent-sdk`](https://www.npmjs.com/package/@candledottv/agent-sdk) (pinned at 0.6.14), and
[candle-bot-core](https://www.npmjs.com/package/candle-bot-core).

Built by [Bruce Jeet](https://github.com/BruceJeet).

- **Which bags, which venues, which exits:** the same as candle-exit-manager.
  - Bags: a list, or the whole wallet less other bots' coins, dust and junk mints.
  - Venues: Candle's curve and DAMM v2, pump.fun curves, PumpSwap.
  - Exits: `ladder`, `tpsl`, `trail`, `time`, `hold`, `preGrad`, or your own, one per coin if you like.
  - Its README covers each in detail.
- **Profit is realized profit:** what the sells brought in, less the cost of the tokens sold (or written off when they
  left the wallet some other way), less network fees. It is summed over every bag with a cost basis, so losses count
  against it. Bags adopted with no basis are left out.
- **Sweeps:**
  - When unswept profit reaches `minSweepSol`, the sweeper makes **one** request. The amount is never more than the
    wallet's SOL balance, read just before, less the `reserveSol` it keeps for fees and rent.
  - While that request is open, no new one is made, however much more profit comes in. The alert repeats on your
    alert schedule.
  - Close the request with the transfer's signature, and the next request counts only profit not yet swept.

Why requests and not transfers: Candle's agent API does not yet offer a transfer to an outside address that a bot can
make safely. The embedded wallet can only move funds between your own account's wallets, and a transfer has no request
id to check after a timeout. So the sweeper says what to send, and you send it from the wallet you control.

Solana only.

## Quick start

Node 22.18 or newer.

```sh
npm install -g candle-profit-sweeper      # or npx candle-profit-sweeper ...
cp "$(npm root -g)/candle-profit-sweeper/examples/dry.json" bot.json
# set "wallet", and "sweep.home": the full address profit should go to (the bot refuses to start until you do)
candle-profit-sweeper run    --config bot.json      # dry run: sells on paper, writes dry sweep requests
candle-profit-sweeper status --config bot.json      # bags, realized profit, sweeps
```

When the dry run looks right, use a new `stateDir` for live, set your API key and `"mode": "live"`, and run again.

## A sweep, step by step

1. Profit reaches the minimum. The sweeper writes `sweeps/sweep-<id>.json`:

   ```json
   { "requestId": "sweep-mhx3k2a1-9f02c4", "dry": false, "wallet": "<the bot's wallet>", "home": "<your home address>",
     "amountSol": 0.42, "amountLamports": "420000000", "reason": "realized profit 0.42 SOL over 3 position(s), 0 SOL swept before",
     "createdAt": "2026-11-05T18:00:00.000Z", "status": "pending" }
   ```

   It sends the same through your alerts: Telegram, a webhook, or a command. The ledger is the authority; each file is
  rewritten whenever it differs from its row (a file left by a crash is corrected on the next look).
   - While the request is open, it is checked again on every look. If the unswept profit has fallen under the amount
     asked (a later loss), or the balance less the reserve has (the wallet spent it), or `sweep.home` has changed,
     the request turns **STALE**. The file says `"stale": true` with a `doNotSend` line, and the alert says do not
     send it. Cancel it, and a new request with the right amount follows. If the balance recovers, it is announced
     again as it stands.
2. You send that amount from the wallet to your home address, however you move funds from it.
3. You close the request:

   ```sh
   candle-profit-sweeper swept sweep-mhx3k2a1-9f02c4 --config bot.json --signature <the transfer's signature>
   ```

   The sweeper reads that transaction from chain (finalized). It must have succeeded, be no older than the request,
   be paid by the bot's wallet (at least what home received), and pay your home address. What home received is
   recorded as swept.
   - A signature that is not a signature, or one that pays elsewhere, is refused.
   - One not on chain yet is kept and looked at again every `everyMs`, at most 20 times, then dropped and alerted.
   - Sent in parts: run `swept` once per transfer. The first closes the request; each later one adds to it.
   - A signature counts once, across all requests.
4. `--unverified` closes it at the requested amount without a signature. `cancel <requestId>` closes it without
   counting it, so the same profit is asked for again.

With the sweeper running, `swept` and `cancel` hand it a request file; with it stopped, they run directly.

## Config reference

`examples/dry.json` is a working start. Besides the shared keys (see candle-launch-bot's README) and `adoption` (see
candle-exit-manager's), a `buy` section is refused.

```jsonc
"targets": { "exits": { "Mint…": { "strategy": "tpsl", "takeProfit": 3 } }, "checkPrograms": true, "extraPrograms": [] },
"exit": { "strategy": "ladder", "rungs": [{ "at": 2, "sell": 0.5 }, { "at": 4, "sell": 0.5 }] },
"sweep": { "home": "<your full address>", "reserveSol": 0.05, "minSweepSol": 0.05, "everyMs": 60000 }
```

| Key | Meaning |
|---|---|
| `sweep.home` | required: the one address profit is asked to go to, written out in full (base58). Never taken from anywhere else; never the bot's own wallet; logged in full at start |
| `sweep.reserveSol` | SOL the wallet keeps: a request never asks for more than the balance less this (default 0.05) |
| `sweep.minSweepSol` | the smallest sweep asked for (default 0.05) |
| `sweep.everyMs` | how often profit is looked at, and `swept`/`cancel` requests are read (default 60000) |
| `sweep.countMarkBasis` | count bags adopted at the market price (`basis: "mark"`) as profit (default false: the mark is not what was paid, and a sale above it may be principal coming back) |
| `sweep.denyHomes` | addresses never accepted as home (look-alikes you have seen, an old address). The system program, wrapped SOL and the token programs are always refused |
| `targets.exits` | a coin's own exit, instead of `exit` |
| `targets.checkPrograms`, `extraPrograms`, `sellFloorMarginBps` | TEE wallet signing checks, as candle-exit-manager's `manager.*` |

## State dir

| File | What |
|---|---|
| `ledger.sqlite` | positions, orders, attempts, `adoptions`, trail marks, `sweep_requests` (each request: amount, home, status, the signature and amount that closed it) |
| `sweeps/<requestId>.json` | each request as above; its `status` follows the ledger (`pending`, `done`, `cancelled`) |
| `status.json` | every cycle: bags, `sweep` (home, realized and swept SOL, the pending request, the last 10) |
| `events.jsonl` | `sweep_request`, `sweep_done`, `sweep_cancelled`, `sweep_held`, `sweep_balance_unreadable`, plus the exit manager's events |

## Known limits

- **It never sends.** Someone has to move the funds and close the request.
- **Cost basis** comes from adoption: given buy signatures, a cost by hand, or the wallet's own buys found on chain
  (the last `historyPages` pages only, so an old bag's basis may be partial). A bag with no basis is not counted as
  profit, and neither is one adopted at the mark unless `sweep.countMarkBasis` is set.
- **A wallet shared with another bot:** the cap is the whole wallet's balance less the reserve. If the other bot has
  spent this bot's profit, the request turns stale rather than drawing on the other bot's capital. Even so, a wallet
  of its own is simpler.
- **Profit is the ledger's.** SOL that arrives in the wallet any other way (a deposit, an airdrop) is not profit and is
  never asked for.
- **Solana only.**

## License

MIT
