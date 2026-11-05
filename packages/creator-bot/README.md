# candle-creator-bot

Buys the new [Candle](https://candle.tv) launches of the creators you list, with a ticket and caps per creator, and
exits them by a strategy you pick. One config file, one process, a local SQLite ledger. Built on Candle's official SDK,
[`@candledottv/agent-sdk`](https://www.npmjs.com/package/@candledottv/agent-sdk) (pinned at 0.6.14), and
[candle-bot-core](https://www.npmjs.com/package/candle-bot-core), the engine
[candle-launch-bot](https://www.npmjs.com/package/candle-launch-bot) runs on.

Built by [Bruce Jeet](https://github.com/BruceJeet).

**How it differs from candle-launch-bot with `creatorAllow`:** the list of creators is the main input, not a filter
on top of every launch: each creator has its own label, ticket and lifetime caps (entries and SOL), and `status.json`
shows what each creator has used.

- **What it buys:** a new Candle launch whose creator (from Candle's token list) or signer (the launch transaction's
  fee payer) is on your list. A launch whose creator is not known yet waits, until Candle's list names it or the launch
  ages out. Never a launch by your own wallet.
- **Per creator:** `sol` (the ticket, at most `buy.sol`), `maxEntries` and `maxSol` over the bot's lifetime, on top of
  the core's caps (`buy.maxOpen`, `buy.lifetimeSol`, `buy.maxPerCoin`). A creator's caps can only tighten them.
- **Global filters**, as candle-launch-bot's: launch modes, max age, max impact of the ticket on the curve. Optional:
  wait for the creator's own dev buy.
- **Detection, execution, exits and dry mode** as candle-launch-bot: Candle's token list and the curve program on
  chain; Candle's trade API from the embedded wallet or a TEE wallet; fills from the transaction; `hold`, `tpsl`,
  `time`, `ladder`, `preGrad` or your own file.

Solana only.

## Quick start

Node 22.18 or newer.

```sh
npm install -g candle-creator-bot          # or npx candle-creator-bot ...
cp "$(npm root -g)/candle-creator-bot/examples/dry.json" bot.json   # put your creators in follow.creators
candle-creator-bot run --config bot.json   # dry run: the whole loop with paper fills
```

For live: export the API key (`apiKeyEnv`), fund the wallet, set `"mode": "live"` and your `wallet`, run again.

## What it needs

- A **Candle API key** with the `swap:write` scope, in an environment variable (`apiKeyEnv`).
- A **payer**: `embedded` (the account's embedded wallet; Candle signs) or `linked` (a TEE wallet signed on this
  machine). Setup is the same as candle-launch-bot's; its README walks through it.
- An **RPC** (`rpcUrlEnv`); the public one works for a dry run.
- The **creators**: Candle wallet addresses. A launch matches when Candle's token list names the address as creator,
  or when the address signed (paid for) the launch transaction.

## Config reference

The core's sections (`mode`, `payer`, `apiKeyEnv`, `rpcUrlEnv`, `wallet`, `signer`, `stateDir`, `buy`, `sell`, `exit`,
`retry`, `alerts`) are the same as candle-launch-bot's. This bot adds:

```json
{
  "follow": {
    "creators": [
      { "address": "<creator address>", "label": "dev one", "sol": 0.01, "maxEntries": 5, "maxSol": 0.05 },
      { "address": "<another>" }
    ],
    "launchModes": ["open", "exclusive", "exp-a", "exp-b", "exp-c", "exp-custom"],
    "maxAgeSec": 60,
    "maxImpactBps": 300,
    "inferModeFromCurve": true,
    "requireDevBuy": false
  },
  "detect": { "api": true, "chain": true, "apiPollMs": 3000, "chainPollMs": 15000, "apiLimit": 20 }
}
```

| Key | Meaning |
|---|---|
| `follow.creators[].address` | the creator (token list) or launch signer to follow; each listed once |
| `follow.creators[].label` | a name for logs, the `follows` table and `status.json` (optional) |
| `follow.creators[].sol` | this creator's ticket (default `buy.sol`, never above it) |
| `follow.creators[].maxEntries` / `maxSol` | lifetime caps for this creator (optional). Counted from the ledger's positions for the creator, as the core counts `lifetimeSol`: a buy Candle refused before anything was signed, or one that reverted, does not count |
| `follow.launchModes` | modes to buy (default every production mode) |
| `follow.maxAgeSec` | buy only this soon after the launch (default 60); no order is built after it |
| `follow.maxImpactBps` | impact of the creator's ticket on the curve (default 300); also the buy-retry limit |
| `follow.inferModeFromCurve` | decide a chain-first launch's mode from its curve (only the full `open` preset) instead of waiting for Candle's list |
| `follow.requireDevBuy` | buy only once the creator's wallet (or the launch's signer) holds the coin |
| `detect.*` | the launch source, as candle-launch-bot's |

## Controls

`STOP` and `PAUSE_BUYS` files in the state dir; `candle-creator-bot sell <mint> [--fraction f]`. A restart picks up from
the ledger, the creators' caps included.

## State dir

| File | What |
|---|---|
| `ledger.sqlite` | positions (each with the creator it followed in its entry context), orders, attempts, `follows` (every launch of a listed creator with the decision), alerts |
| `status.json` | equity, open positions, caps used, `follow.creators` (entries and SOL used per creator), pending launches, recent decisions |
| `events.jsonl` | one JSON line per event: `follow_buy`, `follow_skip`, `follow_wait`, `buy_order`, fills, exits |

## Not here yet

- **Selling when the creator sells.** Exits are the strategy's. A creator-sell exit needs a wallet watcher (the
  creator's token account changes, from the chain); it would plug in as an exit source that marks the position for a
  sell, the way a strategy's `sell` decision does.

## Known limits

- **Creator unknown waits.** A launch seen on chain first carries only its signer; if the signer is not on the list,
  the bot waits for Candle's token list to name the creator, up to `follow.maxAgeSec`.
- **Dev buy check.** `requireDevBuy` reads the creator's (and signer's) token balance in the coin, at most every 2 s:
  it sees a dev buy in the launch transaction and one in the same block after it, and it cannot tell a dev buy from a
  later buy by the same wallet.
- **One entry per coin.** `buy.maxPerCoin` is 1.
- **Solana only.**

## License

MIT
