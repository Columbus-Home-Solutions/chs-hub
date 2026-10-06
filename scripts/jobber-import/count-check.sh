#!/usr/bin/env bash
# Read-only counts to run between import chunks.
# Remote:
#   scripts/jobber-import/count-check.sh
# Local copy of an export:
#   scripts/jobber-import/count-check.sh --sqlite /tmp/chs.sqlite
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
SQLITE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sqlite)
      SQLITE="${2:-}"
      shift 2
      ;;
    *)
      echo "FAIL unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

SQL="SELECT 'clients' AS name, COUNT(*) AS n FROM clients UNION ALL SELECT 'jobs', COUNT(*) FROM jobs UNION ALL SELECT 'estimates', COUNT(*) FROM estimates UNION ALL SELECT 'estimate_requests', COUNT(*) FROM estimate_requests UNION ALL SELECT 'invoices', COUNT(*) FROM invoices UNION ALL SELECT 'payments', COUNT(*) FROM payments UNION ALL SELECT 'expenses', COUNT(*) FROM expenses"

python3 -c '
import re, sys
sql = sys.stdin.read()
if re.search(r"\b(INSERT|UPDATE|DELETE|ALTER|DROP|REPLACE|CREATE|ATTACH)\b", sql, re.I):
    sys.exit("FAIL check SQL is not read-only")
if re.search(r"\bPRAGMA\b", sql, re.I):
    sys.exit("FAIL check SQL contains a PRAGMA statement")
' <<<"$SQL"

if [[ -n "$SQLITE" ]]; then
  case "$SQLITE" in
    *".wrangler/state"*)
      echo "FAIL refusing the wrangler dev database" >&2
      exit 1
      ;;
  esac
  sqlite3 -separator ' ' "$SQLITE" "$SQL"
  exit 0
fi

tmp="$(mktemp /tmp/chs-count-check.XXXXXX.json)"
trap 'rm -f "$tmp"' EXIT
npx wrangler d1 execute chs-hub-db --remote --json --command "$SQL" > "$tmp"
python3 -c '
import json, sys
raw = open(sys.argv[1]).read()
start = raw.find("[")
if start < 0:
    start = raw.find("{")
data = json.loads(raw[start:])
blocks = data if isinstance(data, list) else [data]
rows = []
for block in blocks:
    meta = block.get("meta") or {}
    written = meta.get("rows_written", meta.get("changes", 0)) or 0
    if written:
        sys.exit(f"FAIL count check wrote {written} rows")
    rows.extend(block.get("results") or [])
order = ["clients", "jobs", "estimates", "estimate_requests", "invoices", "payments", "expenses"]
found = {row["name"]: row["n"] for row in rows}
for name in order:
    print(f"{name} {found[name]}")
' "$tmp"
