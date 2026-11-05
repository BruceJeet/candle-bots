#!/bin/sh
# Release helper for the workspaces (plain npm, no extra tool). Each package versions on its own.
#   scripts/release.sh pack                    typecheck, build, and npm pack every published package into ./packs
#   scripts/release.sh bump <package> <ver>    set a package's version (npm version, no git tag); a core bump
#                                               also sets every bot's exact core pin to <ver> (bots pin the core
#                                               exactly, as the SDK is pinned), and prints them
# Publishing is not done here: `npm publish packs/<file>.tgz` by hand, core first.
set -e
cd "$(dirname "$0")/.."
PUBLISHED="packages/core packages/launch-bot packages/graduation-bot packages/creator-bot"
case "$1" in
  pack)
    npm run typecheck
    npm run build
    rm -rf packs && mkdir packs
    for p in $PUBLISHED; do (cd "$p" && npm pack --pack-destination ../../packs >/dev/null); done
    ls -l packs
    ;;
  bump)
    [ -n "$2" ] && [ -n "$3" ] || { echo "bump <package dir name> <version>" >&2; exit 2; }
    echo "$3" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || { echo "bump: $3 is not a version" >&2; exit 2; }
    # Edit the files directly (npm version would resolve the bots' old exact pin from the registry first).
    node -e '
      const fs = require("fs"), [dir, pkg, v] = process.argv.slice(1);
      const set = (f, fn) => { const d = JSON.parse(fs.readFileSync(f, "utf8")); fn(d); fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n"); };
      set(`${dir}/packages/${pkg}/package.json`, (d) => { d.version = v; });
      console.log(`packages/${pkg}: ${v}`);
      if (pkg === "core") for (const b of fs.readdirSync(`${dir}/packages`)) {
        const f = `${dir}/packages/${b}/package.json`;
        if (!fs.existsSync(f)) continue;
        set(f, (d) => { if (d.dependencies && d.dependencies["candle-bot-core"] !== undefined) { d.dependencies["candle-bot-core"] = v; console.log(`packages/${b}: candle-bot-core ${v}`); } });
      }' "$PWD" "$2" "$3"
    npm install --package-lock-only --ignore-scripts >/dev/null
    ;;
  *) echo "usage: release.sh pack | bump <package> <version>" >&2; exit 2 ;;
esac
