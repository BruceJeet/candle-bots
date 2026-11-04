#!/bin/sh
# Keeps private details out of the tree. Run by `npm run check` at the repo root (this file skips itself).
#  - always: no absolute home paths, no email addresses (other than the project's noreply), no private keys, no
#    real-looking Candle API keys
#  - with a word list (one extended regex per line) in $CHECK_WORDS_FILE or $HOME/oss/.check-words next to the checkout: none
#    of those words either. The list stays outside the repo, so it never names what it guards against. Lines matching
#    an allow list ($CHECK_ALLOW_FILE or $HOME/oss/.check-allow, same format) are skipped.
cd "${1:-.}" || exit 2
fail=0
scan() {
  hits=$(grep -rIniE "$1" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=package-lock.json --exclude=check-neutral.sh . | grep -viE "$2" || true)
  if [ -n "$hits" ]; then
    echo "check-neutral: $3" >&2
    echo "$hits" >&2
    fail=1
  fi
}
scan '/(home|Users)/[a-z]' '^$' "absolute home paths"
scan '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' 'candle-launch-bot@users\.noreply\.github\.com|@candledottv/|@types/' "email addresses"
scan 'MIG[A-Za-z0-9+/]AgEAMBMG|MII[A-Za-z0-9+/]{2}QIBADANBg|MC4CAQAwBQYDK2Vw' '^$' "private key material (PKCS#8 bodies)"
scan 'cndl_live_[A-Za-z0-9]{16,}' 'cndl_live_(SuperSecret|Fake|Test)' "Candle API keys"
words="${CHECK_WORDS_FILE:-$HOME/oss/.check-words}"
if [ -f "$words" ]; then
  pattern=$(grep -v '^#' "$words" | grep -v '^$' | paste -sd'|' -)
  allowf="${CHECK_ALLOW_FILE:-$HOME/oss/.check-allow}"
  allow='^$'
  [ -f "$allowf" ] && allow=$(grep -v '^#' "$allowf" | grep -v '^$' | paste -sd'|' -)
  [ -n "$pattern" ] && scan "$pattern" "${allow:-^\$}" "words from $words"
fi
[ "$fail" = 0 ] && echo "check-neutral: clean"
exit "$fail"
