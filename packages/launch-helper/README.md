# candle-launch-helper

Fires the [Candle](https://candle.tv) launch you describe, with your dev buy in the same bundle, then manages the dev
bag with exits and controls. One launch per state dir; a run never launches twice. Built on Candle's official SDK,
[`@candledottv/agent-sdk`](https://www.npmjs.com/package/@candledottv/agent-sdk) (pinned at 0.6.14), and
[candle-bot-core](https://www.npmjs.com/package/candle-bot-core).

Built by [Bruce Jeet](https://github.com/BruceJeet).

- **The launch:** name, symbol, image, description, socials and launch mode from the config, on Solana.
- **The dev buy:** the bundle's first buy, from the same wallet, landing in the launch's own block (Candle's atomic
  route, a Jito bundle: all or nothing). Candle's expected fill for it is checked before anything is sent.
- **The bag:** once the launch lands, the dev buy is read from its transaction on chain (amount and cost) and becomes a
  position the core manages: `tpsl`, `time`, `ladder`, `preGrad`, `hold` or your own exit, `STOP`, `PAUSE_BUYS`,
  `sell`.
- **Dry mode** calls nothing: it prints the launch it would send.

## Quick start

Node 22.18 or newer. A Candle API key with the `launch:write`, `swap:write` and `launch:read` scopes, on a plan that
allows atomic launches, and the account's embedded wallet funded.

```sh
npm install -g candle-launch-helper
cp "$(npm root -g)/candle-launch-helper/examples/launch.json" launch.json    # your coin's details
candle-launch-helper plan --config launch.json      # the exact launch body; calls nothing
candle-launch-helper run  --config launch.json      # dry: logs the plan, runs the loop
export CANDLE_API_KEY=cndl_live_...
# set "mode": "live" and your wallet in launch.json, then:
candle-launch-helper run --config launch.json       # launches once, then manages the dev bag
```

## The route, and why

Candle's atomic launch (`buildAtomicLaunch`, then `submitAtomicLaunch`) from the account's main wallet:

- the dev buy is a first-buy leg of the bundle, in the launch's block: nobody buys before it;
- Candle signs the main wallet's legs itself, so nothing is signed on this machine;
- the launch has one identity, its `clientLaunchId`, which Candle uses to keep a second launch from being built.

`payer` must be `"embedded"`: Candle refuses a TEE wallet on the atomic route.

## A run never launches twice

- The `clientLaunchId` is written to the ledger **before** the first build and is never replaced, not even after a
  failure. A state dir holds one launch; a config for another coin in the same state dir is refused (alert), nothing
  is sent.
- The build is checked before the submit: the dev buy's leg carries `minAmountOut: 0` inside the bundle, so Candle's
  `expectedFill` is the check (present, above zero, and at least `launch.minDevBuyOutRaw` if set). The submit goes
  out within 45 s of the build (the legs share one blockhash), and only from the process that built it.
- Every state is saved before the call it leads to. A restart after a build that was not submitted, a submit in
  flight, a timeout or any error after a request was sent reads Candle's launch job (`getLaunchJob`) every 30 s: it
  resumes on `confirmed`, stops on `failed`, and waits otherwise. A launch unresolved for `launch.unresolvedAlertMin`
  minutes raises an alert with its `clientLaunchId`.
- A launch that failed, or that was refused before it was sent, is not built again on its own. `RETRY_LAUNCH` in the
  state dir asks for one more build under the same id.
- `PAUSE_BUYS`: no launch fires (and none is submitted after a build). Dry mode makes no call at all.

## Config

The core's sections as in every candle-bot-core bot (`mode`, `payer`, `apiKeyEnv`, `rpcUrlEnv`, `wallet`, `stateDir`,
`buy`, `sell`, `exit`, `retry`, `alerts`), plus:

```json
{
  "launch": {
    "name": "My Coin", "symbol": "MINE", "imageUrl": "https://.../logo.png",
    "description": "...", "website": "https://...", "twitter": "https://x.com/...", "telegram": "https://t.me/...",
    "mode": "open",
    "devBuySol": 0.05,
    "minDevBuyOutRaw": "1000000000000",
    "unresolvedAlertMin": 10
  }
}
```

| Key | Meaning |
|---|---|
| `launch.name`, `symbol`, `imageUrl` | required; the image is a hosted https URL |
| `launch.description`, `website`, `twitter`, `telegram` | optional |
| `launch.mode` | Candle launch mode (default `open`) |
| `launch.devBuySol` | the dev buy, SOL; at most `buy.sol`; counts against `buy.lifetimeSol` |
| `launch.minDevBuyOutRaw` | refuse to submit if Candle's expected fill is lower (raw token units, as a string) |
| `launch.unresolvedAlertMin` | alert when a sent launch stays unresolved this long (default 10) |

## State dir

| File | What |
|---|---|
| `ledger.sqlite` | the `launches` row (id, state, bundle, mint, signatures), the dev bag's position and its orders, alerts |
| `status.json` | the launch's state, mint and position; the bag's value and exits |
| `events.jsonl` | `launch_id_saved`, `launch_built`, `launch_landed`, `launch_unresolved`, `dev_bag_open`, sells |

## Known limits

- **Embedded payer only** (the atomic route). One dev-buy leg.
- **Image by URL.** The image must already be hosted.
- **The dev-buy transaction** is taken from the submit's signatures (the buy leg's index) or from Candle's launch job;
  until one is known, the bag is not managed (alert).
- **Solana only.**

## License

MIT
