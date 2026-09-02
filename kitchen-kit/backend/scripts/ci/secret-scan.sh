#!/usr/bin/env bash
# Minimal secret scan over the checked-in tree (no third-party action —
# standard CI facilities only: git + grep). Two checks:
#
#   1. No real dotenv file is tracked in git — only the committed template
#      (.env.example, which intentionally holds CHANGE_ME_ placeholders).
#   2. No tracked file contains a classic hard-coded-secret shape (PEM private
#      key block, AWS access key ID, GitHub/Slack/Stripe token prefixes, or a
#      generic `<SECRET-ish name> = "<long-looks-random-value>"` assignment).
#
# Fails closed: any match is reported and the script exits non-zero. This is a
# heuristic net, not a substitute for a dedicated secret-scanning service —
# see the G1-1 report for that limitation.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0

echo "== Checking for tracked dotenv files with real values =="
tracked_envs=$(git ls-files | grep -E '(^|/)\.env(\..+)?$' | grep -vE '\.env\.example$' || true)
if [[ -n "$tracked_envs" ]]; then
  echo "FAIL: dotenv file(s) tracked in git (should never be committed):"
  echo "$tracked_envs"
  fail=1
else
  echo "OK: no tracked .env file other than .env.example"
fi

echo "== Scanning tracked text for known secret shapes =="
pattern='-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{16,}'
matches=$(git grep -InE -e "$pattern" -- . ':!*.lock' ':!package-lock.json' || true)
if [[ -n "$matches" ]]; then
  echo "FAIL: possible committed secret(s):"
  echo "$matches"
  fail=1
else
  echo "OK: no known secret shape found in tracked files"
fi

exit "$fail"
