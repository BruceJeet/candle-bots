#!/bin/sh
# Release helper for the workspaces (plain npm, no extra tool). Each package versions on its own.
#   scripts/release.sh pack                    typecheck, build, and npm pack every published package into ./packs
#   scripts/release.sh bump <package> <ver>    set a package's version (npm version, no git tag); a core bump
#                                               prints the bots whose core range it leaves
# Publishing is not done here: `npm publish packs/<file>.tgz` by hand, core first.
set -e
cd "$(dirname "$0")/.."
PUBLISHED="packages/core packages/launch-bot"
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
    (cd "packages/$2" && npm version "$3" --no-git-tag-version)
    if [ "$2" = core ]; then
      for p in packages/*/package.json; do
        r=$(node -e 'const d=require(process.argv[1]).dependencies||{};process.stdout.write(d["candle-bot-core"]||"")' "$PWD/$p")
        [ -n "$r" ] && echo "$(dirname "$p"): candle-bot-core $r"
      done
    fi
    ;;
  *) echo "usage: release.sh pack | bump <package> <version>" >&2; exit 2 ;;
esac
