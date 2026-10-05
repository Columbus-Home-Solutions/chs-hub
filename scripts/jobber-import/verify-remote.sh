#!/usr/bin/env bash
# Read-only checks against remote D1. Prints the same lines as drift-check.sh
# except second_apply_changes, which only exists on the local replay.
# Uses wrangler's query API (--command), not --file. --file is the D1 import
# path and does not return SELECT rows.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SQL="$(python3 "$ROOT/scripts/jobber-import/import_checks.py" --emit-sql)"
python3 -c '
import re, sys
sql = sys.stdin.read()
if re.search(r"\b(INSERT|UPDATE|DELETE|ALTER|DROP|REPLACE|CREATE|ATTACH)\b", sql, re.I):
    sys.exit("FAIL check SQL is not read-only")
if re.search(r"\bPRAGMA\b", sql, re.I):
    sys.exit("FAIL check SQL contains a PRAGMA statement")
' <<<"$SQL"

tmp="$(mktemp /tmp/chs-verify-remote.XXXXXX.json)"
trap 'rm -f "$tmp"' EXIT

# stdout is JSON. Warnings stay on stderr. Do not use --file.
npx wrangler d1 execute chs-hub-db --remote --json --command "$SQL" > "$tmp"

python3 "$ROOT/scripts/jobber-import/import_checks.py" --json < "$tmp"
