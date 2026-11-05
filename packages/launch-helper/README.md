# candle-launch-helper

Fires the [Candle](https://candle.tv) launch you describe, with your dev buy in the same bundle, then manages the dev
bag with exits and controls. One launch per name and symbol; a run never launches twice. Built on Candle's official SDK,
[`@candledottv/agent-sdk`](https://www.npmjs.com/package/@candledottv/agent-sdk) (pinned at 0.6.14), and
[candle-bot-core](https://www.npmjs.com/package/candle-bot-core).

Built by [Bruce Jeet](https://github.com/BruceJeet).

- **The launch:** name, symbol, image, description, socials and launch mode from the config, on Solana.
- **The dev buy:** the bundle's first buy, from the same wallet, landing in the launch's own block (Candle's atomic
  route, a Jito bundle: all or nothing). Candle's expected fill for it is checked before anything is sent.
- **The bag:** once the launch lands, the dev buy is read from its transaction on chain (amount and cost) and becomes a
  position the core manages: `tpsl`, `time`, `ladder`, `preGrad`, `hold` or your own exit, `STOP`, `PAUSE_BUYS`,
  `sell`.
- **Dry mode** calls nothing: it prints the launch it would send. `plan` with the API key set asks Candle for a dry-run
  preview of the dev buy's fill (`dryRunAtomicLaunch`: the build's checks, nothing recorded, reserved or sent).

## Quick start

Node 22.18 or newer. A Candle API key with the `launch:write`, `swap:write` and `launch:read` scopes, on a plan that
allows atomic launches, and the account's embedded wallet funded.

```sh
npm install -g candle-launch-helper
cp "$(npm root -g)/candle-launch-helper/examples/launch.json" launch.json    # your coin's details
candle-launch-helper plan --config launch.json      # the exact launch body; with CANDLE_API_KEY set, Candle's
                                                    # dry-run preview of the dev buy's fill (--offline: none)
candle-launch-helper run  --config launch.json      # dry: logs the plan, runs the loop
export CANDLE_API_KEY=cndl_live_...
# set "mode": "live", your embedded wallet and launch.minDevBuyOutRaw (from plan's preview) in launch.json, then:
candle-launch-helper run --config launch.json       # launches once, then manages the dev bag
```

## The route, and why

Candle's atomic launch (`buildAtomicLaunch`, then `submitAtomicLaunch`) from the account's main wallet:

- the dev buy is a first-buy leg of the bundle, in the launch's block: nobody buys before it;
- Candle signs the main wallet's legs itself, so nothing is signed on this machine;
- the launch has one identity, its `clientLaunchId`, which Candle uses to keep a second launch from being built.

`payer` must be `"embedded"`: Candle refuses a TEE wallet on the atomic route.

## A run never launches twice

- **Before the first build** a live run checks, and sends nothing unless all pass (an alert says which failed; a
  read that failed is tried again every 30 s):
  - `launch.minDevBuyOutRaw` is set;
  - the dev buy fits `buy.lifetimeSol` and `buy.maxOpen`;
  - `wallet` is the key's embedded (main) wallet, where the dev bag lands (Candle's portfolio);
  - the account has not launched a token with the same name and symbol (Candle's list of the account's launched
    tokens, case and spaces ignored). Another state dir with the same spec is refused. A listed token without a name
    or symbol, or a list that ends without saying it is done, is refused too (it cannot be judged).
    `launch.newLaunch: true` launches the same name and symbol again on purpose. The check relies on Candle's list
    showing a launch from minutes ago; that was not verified live.
- The `clientLaunchId` is written to the ledger **before** the first build and is never replaced. A state dir holds
  one launch; a config for another coin in the same state dir is refused (alert), nothing is sent.
- The build is checked before the submit: the dev buy's leg carries `minAmountOut: 0` inside the bundle, so Candle's
  `expectedFill` is the check (present, above zero, and at least `launch.minDevBuyOutRaw`). The submit goes out within
  45 s of the build (the legs share one blockhash), and only from the process that built it.
- Every state is saved before the call it leads to (`building` before the build). A restart during a build, after a
  build that was not submitted, or during a submit, a timeout, or any error after a request was sent reads Candle's
  launch job (`getLaunchJob`) every 30 s: it resumes on `confirmed`, stops on `failed`, and waits otherwise. A restart
  never builds. A launch unresolved for `launch.unresolvedAlertMin` minutes raises an alert with its `clientLaunchId`.
- **The bot never builds again on its own.** `RETRY_LAUNCH` in the state dir asks for one more build under the same
  id. It acts only when a job read just then says `failed` or `JOB_NOT_FOUND` (the SDK's recovery steps), and not
  while `PAUSE_BUYS` or `STOP` is set. Any other answer uses the file up (`RETRY_LAUNCH.ignored`) and logs and alerts
  why. A job that says `confirmed` is taken as landed. A 409 on the rebuild (Candle still resolving the first attempt)
  goes back to reading the job. A new `clientLaunchId` is never sent while a launch may land.
- `PAUSE_BUYS`: no launch fires (and none is submitted after a build). Dry mode makes no call at all.
- STOP, a signal and PAUSE_BUYS are read again right before every build.
- On `STOP` or SIGTERM the run waits for a launch call in flight (a submit can take about 160 s) before it closes the
  ledger. Under systemd give the unit `TimeoutStopSec=200` or more; a kill in the middle is still safe (the state was
  saved before the call, and the restart reads the job).

## The dev bag

Once the launch lands, the dev buy's transaction (the submit's buy-leg signature, else Candle's job) is booked from
the chain by the core (`openFromFill`: this wallet's tokens and SOL spent, never an API's number). When Candle names no
dev-buy transaction, or one that gave the wallet no tokens, the wallet's token-account history for the mint is read
whole (paged), oldest first. The first transaction that gave the wallet this coin is the dev buy (the bundle bought
first and opened the account): it is booked if it passes the core's checks. The scan never walks past it to a later
buy. If it cannot be read yet, the scan tries again later; if it fails the checks (no SOL spent, already booked), or
the history runs past 10,000 signatures, an alert asks for a hand booking:

```sh
candle-launch-helper adopt <signature> --config launch.json [--mint <mint>] [--force]    # with the bot stopped
```

`adopt` books the bag from that transaction through the same checks (this wallet, this mint, SOL spent, tokens
received, not booked already) and marks the launch open. On a launch whose bag is already open it refuses (a second
position would count twice in the caps and the exits); `--force` books it anyway.

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
| `launch.minDevBuyOutRaw` | required in live mode: refuse to submit if Candle's expected fill is lower (raw token units, as a string). `plan` previews the fill |
| `launch.newLaunch` | `true` to launch even though the account already launched this name and symbol (default `false`: refused) |
| `launch.unresolvedAlertMin` | alert when a sent launch stays unresolved this long (default 10) |

## State dir

| File | What |
|---|---|
| `ledger.sqlite` | the `launches` row (id, state, bundle, mint, signatures), the dev bag's position and its orders, alerts |
| `status.json` | the launch's state, mint and position; the bag's value and exits |
| `events.jsonl` | `launch_preflight_refused`, `launch_id_saved`, `launch_built`, `launch_landed`, `launch_unresolved`, `launch_retry`, `launch_retry_ignored`, `dev_buy_found_on_chain`, `dev_bag_open`, sells |
| `RETRY_LAUNCH`, `.done`, `.ignored` | the operator's retry request, and what became of it |

## Known limits

- **Embedded payer only** (the atomic route). One dev-buy leg.
- **Image by URL.** The image must already be hosted.
- **The dev-buy transaction** is taken from the submit's signatures (the buy leg's index), Candle's launch job, or the
  wallet's history for the mint; until one is booked, the bag is not managed (alert; `adopt` books it by hand).
- **The same-spec check** reads up to 20 pages (1,000 tokens) of the account's launches; an account with more is
  refused unless `launch.newLaunch` is set.
- **A launch refused at the submit check** (expected fill under the floor) leaves a built bundle Candle never got; its
  job may not answer `failed` or `JOB_NOT_FOUND`, so `RETRY_LAUNCH` may be ignored. Use a new state dir (with
  `launch.newLaunch: true` only if the first launch is known not to exist).
- **Solana only.**

## License

MIT
