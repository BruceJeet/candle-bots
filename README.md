# candle-bots

Trading bots for [Candle](https://candle.tv) on Solana, on one shared core. Each bot is its own npm package: install the
one you want and you get that bot and the core, nothing else.

## The bots

| Bot | What it does | Run it |
|---|---|---|
| [candle-launch-bot](packages/launch-bot/README.md) | Buys Candle launches as they appear (Candle's list and the chain), filtered by mode, age, impact and creator; exits by a strategy | `npx candle-launch-bot init`, then `npx candle-launch-bot run --config bot.json` |

Under them:

| Package | What it is |
|---|---|
| [candle-bot-core](packages/core/README.md) | The ledger, order executor, exit strategies, controls and engine loop every bot shares. For bot authors |
| [example-bot](packages/example-bot/README.md) | Not published. The smallest bot: buys a coin named in a file. A template for a new bot |

## Picking a bot

Each bot's README says what it buys, what it needs (a Candle API key, a wallet, an RPC) and how to start in dry mode,
which runs the whole loop with paper fills and spends nothing. Start there, read `status.json`, then go live with small
caps. Every bot has the same controls: `STOP` and `PAUSE_BUYS` files in its state folder, a `sell` command, and the
same exit strategies.

## Adding a bot

1. Copy `packages/example-bot` to `packages/<your-bot>`, rename it in its `package.json`, and add it to the root
   `workspaces`.
2. Write its trigger (which coins, when) and its config section. The [core README](packages/core/README.md) has the
   trigger interface and the money rules. A bot needs no change to the core; if it seems to, open an issue first.
3. Pin the core exactly (`"candle-bot-core": "0.1.0"`, as the SDK is pinned) and version the bot on its own;
   `scripts/release.sh bump core <version>` moves every bot's pin with the core (bump each bot's own version too
   before publishing it).

## Working in the repo

```sh
npm ci
npm run typecheck        # every package
npm run build            # core, then the published bots (dist/)
npm run check            # neutral-copy gate (scripts/check-neutral.sh)
sh scripts/release.sh pack   # build and npm pack every published package into ./packs (no publish)
```

In a checkout, `NODE_OPTIONS=--conditions=source` makes every package import the core's TypeScript sources, so a bot
runs and tests without a build.

## License

MIT
