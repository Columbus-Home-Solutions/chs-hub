#!/usr/bin/env bash
# Morning drift check. Read-only against remote D1.
# Rebuilds a temp database under /tmp, applies migration 0132 there, then replays
# scripts/jobber-import/out/remote-apply.sql and diffs the result against the
# counts expected from the 4:55 PM CT 2026-10-04 production export.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
EXPORT="$ROOT/backups/remote-d1-drift-${STAMP}.sql"
DB="/tmp/chs-drift-${STAMP}.sqlite"
SQL="$ROOT/scripts/jobber-import/out/remote-apply.sql"
MIG="$ROOT/migrations/0132_billing_hold_jobber_numbers.sql"

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
con.row_factory = sqlite3.Row

def present(table, col):
    return con.execute(
        f"SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?",
        (col,),
    ).fetchone()[0]

missing = []
for table, col in (
    ("invoices", "billing_hold"),
    ("jobs", "jobber_job_number"),
    ("invoices", "jobber_invoice_number"),
):
    if present(table, col) == 0:
        missing.append(col)
if missing:
    con.executescript(open(mig_path).read())

fails = []
def check(name, actual, expected):
    if actual != expected:
        fails.append(f"{name} expected {expected} actual {actual}")
    print(f"{name} {actual}")

for table, col in (
    ("invoices", "billing_hold"),
    ("jobs", "jobber_job_number"),
    ("invoices", "jobber_invoice_number"),
):
    check(col, present(table, col), 1)

if any(present(t, c) != 1 for t, c in (
    ("invoices", "billing_hold"),
    ("jobs", "jobber_job_number"),
    ("invoices", "jobber_invoice_number"),
)):
    print("FAIL columns missing after migration 0132 on the temp copy")
    sys.exit(1)

sql = open(sql_path).read()
if "ALTER TABLE" in sql:
    print("FAIL remote-apply.sql contains ALTER TABLE")
    sys.exit(1)
con.executescript(sql)

expected = {
    "clients": 113,
    "jobs": 102,
    "estimates": 122,
    "estimate_requests": 55,
    "invoices": 133,
    "payments": 177,
    "expenses": 407,
    "notification_logs": 388,
}
for table, n in expected.items():
    check(table, con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], n)

brandon = con.execute("""
  SELECT COUNT(*) FROM invoices i
  JOIN jobs j ON j.id = i.job_id
  JOIN payments p ON p.invoice_id = i.id
  WHERE j.job_number = 34 AND i.total = 2880
    AND i.jobber_invoice_number = 38 AND i.status = 'paid'
    AND i.paid_amount = 2880 AND p.amount = 2880 AND p.payment_method = 'jobber'
    AND substr(COALESCE(p.received_date, p.collected_at), 1, 10) = '2025-01-21'
""").fetchone()[0]
check("brandon_38_paid_2880", brandon, 1)
check("andmark_10678.12", con.execute("SELECT COUNT(*) FROM payments WHERE amount = 10678.12").fetchone()[0], 0)
check("christi_2500", con.execute("""
  SELECT COUNT(*) FROM payments p
  JOIN jobs j ON j.id = p.job_id
  JOIN clients c ON c.id = j.client_id
  WHERE c.name LIKE 'Christi Marret%' AND p.amount = 2500
""").fetchone()[0], 0)
check("kathleen_apr29_7500", con.execute("""
  SELECT COUNT(*) FROM payments
  WHERE amount = 7500 AND substr(COALESCE(received_date, collected_at), 1, 10) = '2024-04-29'
""").fetchone()[0], 0)

k = con.execute("""
  SELECT i.status, ROUND(COALESCE(SUM(p.amount), 0), 2)
  FROM invoices i
  JOIN jobs j ON j.id = i.job_id
  LEFT JOIN payments p ON p.invoice_id = i.id
  WHERE j.job_number = 2 AND i.total = 21356.78
  GROUP BY i.id
""").fetchone()
check("kathleen_job2", f"{k[0]} {k[1]:.2f}" if k else "missing", "bad_debt 20356.78")

b = con.execute("""
  SELECT i.status, ROUND(COALESCE(SUM(p.amount), 0), 2)
  FROM invoices i
  JOIN jobs j ON j.id = i.job_id
  LEFT JOIN payments p ON p.invoice_id = i.id
  WHERE j.job_number = 94 AND i.total = 1300
  GROUP BY i.id
""").fetchone()
check("boyd_job94", f"{b[0]} {b[1]:.2f}" if b else "missing", "bad_debt 0.00")

j75 = con.execute("""
  SELECT i.status FROM invoices i
  JOIN jobs j ON j.id = i.job_id
  WHERE j.job_number = 75 AND i.total = 600
""").fetchone()
check("job75_600", j75[0] if j75 else "missing", "void")

before_changes = con.total_changes
con.executescript(sql)
check("second_apply_changes", con.total_changes - before_changes, 0)

if fails:
    print("FAIL")
    for line in fails:
        print(line)
    sys.exit(1)
print("PASS")
PY

rm -f "$DB"
echo "Temp database removed. Export kept at $EXPORT"
