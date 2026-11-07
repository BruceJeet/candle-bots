# candle-bots

Trading bots for [Candle](https://candle.tv) on Solana, on one shared core. Each bot is its own npm package: install the
one you want and you get that bot and the core, nothing else.

## The bots

| Bot | What it does | Run it |
|---|---|---|
| [candle-launch-bot](packages/launch-bot/README.md) | Buys Candle launches as they appear (Candle's list and the chain), filtered by mode, age, impact and creator; exits by a strategy | `npx candle-launch-bot init`, then `npx candle-launch-bot run --config bot.json` |
| [candle-graduation-bot](packages/graduation-bot/README.md) | Buys Candle coins as their curve completes and their DAMM v2 pool opens, filtered by time since graduation, impact on the pool, room above its floor and creator; exits by a strategy | `npx candle-graduation-bot run --config bot.json` (start from `examples/dry.json`) |
| [candle-launch-helper](packages/launch-helper/README.md) | Fires the Candle launch you describe with its dev buy in the same bundle (never twice), then manages the dev bag with exits and controls | `npx candle-launch-helper plan --config launch.json`, then `run` |
| [candle-creator-bot](packages/creator-bot/README.md) | Buys the new launches of the creators you list, with a ticket and lifetime caps per creator; optional dev-buy wait; exits by a strategy | `npx candle-creator-bot run --config bot.json` (start from `examples/dry.json`) |
| [candle-exit-manager](packages/exit-manager/README.md) | Never buys: adopts bags already in the wallet (a list, or the whole wallet less other bots' coins, dust and junk mints) and exits them by a strategy, a trailing stop included; Candle coins, pump.fun curves and PumpSwap | `npx candle-exit-manager run --config bot.json` (start from `examples/dry.json`) |
| [candle-rug-watcher](packages/rug-watcher/README.md) | Never buys: watches the coins a wallet holds (adopted like the exit manager) and sells, or only alerts, on a liquidity pull, a price crash, the creator dumping or a large holder leaving; every firing alerted with its numbers | `npx candle-rug-watcher run --config bot.json` (start from `examples/dry.json`) |
| [candle-profit-sweeper](packages/profit-sweeper/README.md) | Never buys: sells the wallet's bags at your targets and asks for the realized profit to go to your home address: one sweep request at a time (wallet, amount, full home address, request id), alerted and kept until the transfer is shown on chain. It never moves funds itself | `npx candle-profit-sweeper run --config bot.json` (start from `examples/dry.json`) |
| [candle-scanner-bot](packages/scanner-bot/README.md) | Watch-only: watches pump.fun and PumpSwap coins (a list, or a Candle feed bucket) and alerts on Telegram, Discord or a webhook on a volume spike, a dip, a breakout or a hot 5 min on the feed; no wallet, no key, never trades | `npx candle-scanner-bot run --config scan.json` (start from `examples/watch.json`) |
| [candle-dip-buyer](packages/dip-buyer/README.md) | Buys pump.fun and PumpSwap coins on a dip from their recent high (optionally once they turn up), on a live price and volume series; exits by a strategy, `fade` reading the series too | `npx candle-dip-buyer scan --config bot.json` (start from `examples/dry.json`) |
| [candle-spike-rider](packages/spike-rider/README.md) | Buys pump.fun and PumpSwap coins on a volume spike with buyers behind it and the price rising; exits by a strategy, `fade` reading the series too | `npx candle-spike-rider scan --config bot.json` (start from `examples/dry.json`) |
| [candle-event-bot](packages/event-bot/README.md) | Buys coins tied to a dated event in a window before it, and exits in phases keyed to the event: ride the build-up, hedge at the event, keep a moonshot core | `npx candle-event-bot plan --config bot.json` (start from `examples/dry.json`) |
| [candle-perps-hedger](packages/perps-hedger/README.md) | Hedges a wallet's spot bags with Hyperliquid perps through Candle: a short on the coin's own perp or a proxy (SOL), by a ratio or a fitted beta, rebalanced outside a band within a max leverage and margin; reduce-only closes when a bag is sold or cannot be priced; fees and funding booked | `npx candle-perps-hedger plan --config hedge.json` (start from `examples/dry.json`) |
| [candle-spread-watcher](packages/spread-watcher/README.md) | Watch-only: a coin's price on every venue it trades on (its curve or pool, other PumpSwap and DAMM v2 pools, its Hyperliquid perp) and an alert when the gap between two holds above a threshold, with each pool's SOL depth; no wallet, no key, never trades | `npx candle-spread-watcher check --config spread.json` (start from `examples/watch.json`) |

Under them:

| Package | What it is |
|---|---|
| [candle-bot-core](packages/core/README.md) | The ledger, order executor, exit strategies, controls and engine loop every bot shares. For bot authors |
| [example-bot](packages/example-bot/README.md) | Not published. The smallest bot: buys a coin named in a file. A template for a new bot |

## Picking a bot

Each bot's README says what it buys, what it needs (a Candle API key, a wallet, an RPC) and how to start in dry mode,
which runs the whole loop with paper fills and spends nothing. Start there, read `status.json`, then go live with small
caps. Every bot has the same controls: `STOP` and `PAUSE_BUYS` files in its state folder, a `sell` command, and the
same exit strategies. The bots that only sell (candle-exit-manager, candle-rug-watcher, candle-profit-sweeper) have `PAUSE_SELLS` instead of `PAUSE_BUYS`.

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
