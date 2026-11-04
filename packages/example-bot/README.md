# candle-example-bot (not published)

The smallest bot on [candle-bot-core](../core/README.md): it shows that a new bot is a new package with a trigger and
a config section, and no change to the core.

- **Trigger** (`src/trigger.ts`): buys a coin you name by writing `{"mint": "<address>"}` (optional `"sol"`, a smaller
  ticket than `buy.sol`) to `<stateDir>/buy/<name>.json`. Each file is read once and deleted. The coin must be on its
  Candle curve, SOL-quoted, with a buy impact within `manual.maxImpactBps`; a curve that cannot be read yet waits up to
  `manual.maxWaitSec`, which is also the buy's deadline.
- **Config section** `manual`: `maxImpactBps` (default 300), `maxWaitSec` (default 60). Everything else is the core's.
- **The rest** (`src/bot.ts`): the engine, `run`, `status` and `sell`, all from the core.

```sh
NODE_OPTIONS=--conditions=source node packages/example-bot/bin/candle-example-bot run --config bot.json
```

`examples/dry.json` is a dry-mode config to start from.
