#!/usr/bin/env bash
# SRS §28.5 — "Secret detected in diff" blocks merge. Standard CI facilities
# only (git + grep), no third-party action. Three checks:
#
#   1. No real dotenv file is tracked in git — only the committed template
#      (.env.example, which intentionally holds CHANGE_ME_ placeholders).
#   2. No tracked file contains a classic hard-coded-secret shape (PEM private
#      key block, AWS access key ID, GitHub/Slack/Stripe token prefixes, or a
#      generic `<SECRET-ish name> = "<value>"` assignment) — a whole-tree
#      safety net that also catches a secret introduced outside a PR (e.g.
#      pushed straight to main), which a diff-only check would miss.
#   3. If SECRET_SCAN_DIFF_BASE is set (the workflow sets it to the PR's merge
#      base on pull_request, and to the previous commit on push), the literal
#      "in diff" check: only lines a PR actually *adds* are scanned, so an
#      existing safe file that happens to mention a keyword near an unrelated
#      value never blocks a PR that doesn't touch it.
#
# Avoids false positives on UUIDs/hashes (the patterns require a recognisable
# secret prefix or an assignment to a secret-ish name, never bare hex/UUID
# shapes) and on intentionally fake fixture values (lines containing
# CHANGE_ME, PLACEHOLDER, EXAMPLE, FAKE_, or dummy/xxxx-style filler are
# excluded). The generic password/secret/token ASSIGNMENT_PATTERN is scoped
# to non-test source only: this repo's e2e/unit suites legitimately share a
# handful of well-known literal fixture credentials (e.g. `const password =
# 's3cure-passphrase'`, repeated verbatim across dozens of *.e2e-spec.ts
# files precisely because it is a fixture, not a secret) — applying the
# broad heuristic there produces only noise, not signal. Real application
# secrets (JWT signing keys, DB credentials, ...) live in src/config/.env,
# never in test/*.spec.ts, so this scoping does not weaken the check.
#
# Fails closed: any match is reported and the script exits non-zero. This is
# a heuristic net, not a substitute for a dedicated secret-scanning service —
# see the G1-1 report for that limitation.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0

# Prefixed/shaped secrets with a recognisable, low-false-positive signature.
PREFIX_PATTERN='-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{16,}'
# A generic secret-bearing assignment: password/secret/token/api_key/private_key
# = "<something that isn't an obvious placeholder>". Requires an actual quoted
# value of some length so `password = ""` or `token = null` never matches.
ASSIGNMENT_PATTERN='(password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token)[[:space:]]*[:=][[:space:]]*['\''"][^'\''"[:space:]]{8,}['\''"]'
FIXTURE_MARKERS='CHANGE_ME|PLACEHOLDER|_PLACEHOLDER|EXAMPLE|FAKE_|dummy|xxxxxxxx|not_a_secret|ci_ephemeral'
# Pathspecs shared by every grep/diff invocation below.
COMMON_EXCLUDES=(':!*.lock' ':!package-lock.json')
# Additionally excluded from the broader ASSIGNMENT_PATTERN only (see above).
TEST_EXCLUDES=(':!**/test/**' ':!**/*.spec.ts' ':!**/*.e2e-spec.ts' ':!**/docs/**' ':!**/seed-dev-data.ts' ':!**/*.md')

echo "== Checking for tracked dotenv files with real values =="
tracked_envs=$(git ls-files | grep -E '(^|/)\.env(\..+)?$' | grep -vE '\.env\.example$' || true)
if [[ -n "$tracked_envs" ]]; then
  echo "FAIL: dotenv file(s) tracked in git (should never be committed):"
  echo "$tracked_envs"
  fail=1
else
  echo "OK: no tracked .env file other than .env.example"
fi

echo "== Scanning tracked text for known secret shapes (whole-tree safety net) =="
tree_matches=$(
  {
    git grep -IinE -e "$PREFIX_PATTERN" -- . "${COMMON_EXCLUDES[@]}" 2>/dev/null
    git grep -IinE -e "$ASSIGNMENT_PATTERN" -- . "${COMMON_EXCLUDES[@]}" "${TEST_EXCLUDES[@]}" 2>/dev/null
  } | sort -u | grep -viE "$FIXTURE_MARKERS" || true
)
if [[ -n "$tree_matches" ]]; then
  echo "FAIL: possible committed secret(s):"
  echo "$tree_matches"
  fail=1
else
  echo "OK: no known secret shape found in tracked files"
fi

if [[ -n "${SECRET_SCAN_DIFF_BASE:-}" ]]; then
  echo "== Scanning the diff against ${SECRET_SCAN_DIFF_BASE} for added secrets =="
  if git cat-file -e "${SECRET_SCAN_DIFF_BASE}" 2>/dev/null; then
    # --unified=0: only the changed lines themselves. Only '+' additions are
    # scanned (a secret already on the base ref is the whole-tree check's job
    # above, and is unrelated to *this* diff).
    diff_matches=$(
      {
        git diff --unified=0 "${SECRET_SCAN_DIFF_BASE}"...HEAD -- . "${COMMON_EXCLUDES[@]}" \
          | grep -E '^\+[^+]' | grep -viE "$FIXTURE_MARKERS" | grep -inE -e "$PREFIX_PATTERN"
        git diff --unified=0 "${SECRET_SCAN_DIFF_BASE}"...HEAD -- . "${COMMON_EXCLUDES[@]}" "${TEST_EXCLUDES[@]}" \
          | grep -E '^\+[^+]' | grep -viE "$FIXTURE_MARKERS" | grep -inE -e "$ASSIGNMENT_PATTERN"
      } | sort -u || true
    )
    if [[ -n "$diff_matches" ]]; then
      echo "FAIL: possible secret added in this diff:"
      echo "$diff_matches"
      fail=1
    else
      echo "OK: no known secret shape added in the diff"
    fi
  else
    echo "SKIP: SECRET_SCAN_DIFF_BASE (${SECRET_SCAN_DIFF_BASE}) is not a reachable commit (e.g. shallow clone/first commit) — whole-tree check above still applies"
  fi
fi

exit "$fail"
