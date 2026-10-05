#!/usr/bin/env bash
# Morning drift check. Read-only against remote D1.
# Rebuilds a temp database under /tmp, applies migration 0132 there, then replays
# the data file and diffs the result against the post-import checks.
# notification_logs is reported and does not fail the run. A new notification
# fails only when it is billing-related (invoice, due, past-due, payment).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
EXPORT="$ROOT/backups/remote-d1-drift-${STAMP}.sql"
DB="/tmp/chs-drift-${STAMP}.sqlite"
SQL="$ROOT/scripts/jobber-import/out/remote-apply.sql"
MAIN_SQL="/Users/tonycolumbus/projects/chs-hub/scripts/jobber-import/out/remote-apply.sql"
MIG="$ROOT/migrations/0132_billing_hold_jobber_numbers.sql"

if [[ ! -f "$SQL" && -f "$MAIN_SQL" ]]; then
  SQL="$MAIN_SQL"
fi

case "$DB" in
  *".wrangler/state"*)
    echo "FAIL temp database must not be written under .wrangler/state" >&2
    exit 1
    ;;
esac

if [[ ! -f "$SQL" || ! -f "$MIG" ]]; then
  echo "FAIL missing $SQL or $MIG" >&2
  exit 1
fi

echo "Exporting remote D1 (read-only) to $EXPORT"
npx wrangler d1 export chs-hub-db --remote --skip-confirmation --output "$EXPORT"

rm -f "$DB"
sqlite3 "$DB" < "$EXPORT"

python3 - "$DB" "$SQL" "$MIG" << 'PY'
import sqlite3, sys
db_path, sql_path, mig_path = sys.argv[1:]
con = sqlite3.connect(db_path)

def present(table, col):
    return con.execute(
        f"SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?",
        (col,),
    ).fetchone()[0]

missing = [
    col
    for table, col in (
        ("invoices", "billing_hold"),
        ("jobs", "jobber_job_number"),
        ("invoices", "jobber_invoice_number"),
    )
    if present(table, col) == 0
]
if missing:
    con.executescript(open(mig_path).read())
sql = open(sql_path).read()
if "ALTER TABLE" in sql:
    raise SystemExit("FAIL remote-apply.sql contains ALTER TABLE")
con.executescript(sql)
PY

code=0
python3 "$ROOT/scripts/jobber-import/import_checks.py" --db "$DB" --replay-sql "$SQL" || code=$?
rm -f "$DB"
echo "Temp database removed. Export kept at $EXPORT"
exit "$code"
