#!/usr/bin/env python3
"""Post-import checks shared by drift-check.sh and verify-remote.sh.

notification_logs is printed and not compared to 388. A new row since the
4:55 PM CT 2026-10-04 baseline fails only when its trigger or template is
billing-related: invoice, due, past-due, or payment.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASELINE_PATH = HERE / "notification-baseline.ids"

# Printed in this order. None means report the value and do not fail on it.
EXPECTED: list[tuple[str, str | None]] = [
    ("billing_hold", "1"),
    ("jobber_job_number", "1"),
    ("jobber_invoice_number", "1"),
    ("clients", "113"),
    ("jobs", "102"),
    ("estimates", "122"),
    ("estimate_requests", "55"),
    ("invoices", "133"),
    ("payments", "177"),
    ("expenses", "407"),
    ("notification_logs", None),
    ("notification_logs_billing_new", "0"),
    ("brandon_38_paid_2880", "1"),
    ("andmark_10678.12", "0"),
    ("christi_2500", "0"),
    ("kathleen_apr29_7500", "0"),
    ("kathleen_job2", "bad_debt 20356.78"),
    ("boyd_job94", "bad_debt 0.00"),
    ("job75_600", "void"),
]

WRITE_WORDS = (
    "INSERT",
    "UPDATE",
    "DELETE",
    "ALTER",
    "DROP",
    "REPLACE",
    "CREATE",
    "ATTACH",
)


def load_baseline_ids() -> list[str]:
    if not BASELINE_PATH.is_file():
        raise SystemExit(f"FAIL missing {BASELINE_PATH}")
    ids = [line.strip() for line in BASELINE_PATH.read_text().splitlines() if line.strip()]
    if len(ids) != 388 or len(set(ids)) != 388:
        raise SystemExit(f"FAIL baseline ids count is {len(ids)}, expected 388 unique")
    for item in ids:
        if "'" in item or not item:
            raise SystemExit("FAIL baseline id is not a plain token")
    return ids


def billing_clause() -> str:
    """Invoice, due, past-due, and payment notifications. Deposit receipts are not included."""
    parts = []
    for column in ("trigger_event", "template_id"):
        for needle in ("invoice", "payment", "past_due", "past-due", "due"):
            parts.append(f"lower(COALESCE({column}, '')) LIKE '%{needle}%'")
    return "(" + " OR ".join(parts) + ")"


def new_billing_where(ids: list[str]) -> str:
    quoted = ",".join(f"'{item}'" for item in ids)
    return f"id NOT IN ({quoted}) AND {billing_clause()}"


def check_sql(ids: list[str]) -> str:
    where = new_billing_where(ids)
    pieces = [
        ("billing_hold", "SELECT COUNT(*) FROM pragma_table_info('invoices') WHERE name = 'billing_hold'"),
        ("jobber_job_number", "SELECT COUNT(*) FROM pragma_table_info('jobs') WHERE name = 'jobber_job_number'"),
        ("jobber_invoice_number", "SELECT COUNT(*) FROM pragma_table_info('invoices') WHERE name = 'jobber_invoice_number'"),
        ("clients", "SELECT COUNT(*) FROM clients"),
        ("jobs", "SELECT COUNT(*) FROM jobs"),
        ("estimates", "SELECT COUNT(*) FROM estimates"),
        ("estimate_requests", "SELECT COUNT(*) FROM estimate_requests"),
        ("invoices", "SELECT COUNT(*) FROM invoices"),
        ("payments", "SELECT COUNT(*) FROM payments"),
        ("expenses", "SELECT COUNT(*) FROM expenses"),
        ("notification_logs", "SELECT COUNT(*) FROM notification_logs"),
        ("notification_logs_billing_new", f"SELECT COUNT(*) FROM notification_logs WHERE {where}"),
        (
            "brandon_38_paid_2880",
            """
            SELECT COUNT(*) FROM invoices i
            JOIN jobs j ON j.id = i.job_id
            JOIN payments p ON p.invoice_id = i.id
            WHERE j.job_number = 34 AND i.total = 2880
              AND i.jobber_invoice_number = 38 AND i.status = 'paid'
              AND i.paid_amount = 2880 AND p.amount = 2880 AND p.payment_method = 'jobber'
              AND substr(COALESCE(p.received_date, p.collected_at), 1, 10) = '2025-01-21'
            """,
        ),
        ("andmark_10678.12", "SELECT COUNT(*) FROM payments WHERE amount = 10678.12"),
        (
            "christi_2500",
            """
            SELECT COUNT(*) FROM payments p
            JOIN jobs j ON j.id = p.job_id
            JOIN clients c ON c.id = j.client_id
            WHERE c.name LIKE 'Christi Marret%' AND p.amount = 2500
            """,
        ),
        (
            "kathleen_apr29_7500",
            """
            SELECT COUNT(*) FROM payments
            WHERE amount = 7500
              AND substr(COALESCE(received_date, collected_at), 1, 10) = '2024-04-29'
            """,
        ),
        (
            "kathleen_job2",
            """
            SELECT COALESCE((
              SELECT i.status || ' ' || printf('%.2f', ROUND(COALESCE(SUM(p.amount), 0), 2))
              FROM invoices i
              JOIN jobs j ON j.id = i.job_id
              LEFT JOIN payments p ON p.invoice_id = i.id
              WHERE j.job_number = 2 AND i.total = 21356.78
              GROUP BY i.id
              LIMIT 1
            ), 'missing')
            """,
        ),
        (
            "boyd_job94",
            """
            SELECT COALESCE((
              SELECT i.status || ' ' || printf('%.2f', ROUND(COALESCE(SUM(p.amount), 0), 2))
              FROM invoices i
              JOIN jobs j ON j.id = i.job_id
              LEFT JOIN payments p ON p.invoice_id = i.id
              WHERE j.job_number = 94 AND i.total = 1300
              GROUP BY i.id
              LIMIT 1
            ), 'missing')
            """,
        ),
        (
            "job75_600",
            """
            SELECT COALESCE((
              SELECT i.status FROM invoices i
              JOIN jobs j ON j.id = i.job_id
              WHERE j.job_number = 75 AND i.total = 600
              LIMIT 1
            ), 'missing')
            """,
        ),
        (
            "notification_logs_billing_detail",
            f"""
            SELECT COALESCE((
              SELECT group_concat(trigger_event || ' ' || id || ' ' || created_at, ' | ')
              FROM notification_logs
              WHERE {where}
            ), '')
            """,
        ),
    ]
    selects = []
    for name, query in pieces:
        selects.append(
            f"SELECT '{name}' AS name, CAST(({query}) AS TEXT) AS actual"
        )
    sql = "\nUNION ALL\n".join(selects)
    assert_read_only(sql)
    return sql


def assert_read_only(sql: str) -> None:
    upper = sql.upper()
    for word in WRITE_WORDS:
        if f" {word} " in f" {upper} " or upper.startswith(word + " "):
            raise SystemExit(f"FAIL check SQL contains {word}")
    if "PRAGMA " in upper:
        raise SystemExit("FAIL check SQL contains a PRAGMA statement")


def normalize(value) -> str:
    if value is None:
        return "missing"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return f"{value:.2f}"
    return str(value)


def render(actual: dict[str, str], *, second_apply: int | None = None) -> int:
    fails: list[str] = []
    for name, expected in EXPECTED:
        got = actual.get(name)
        if got is None:
            fails.append(f"{name} missing")
            print(f"{name} missing")
            continue
        print(f"{name} {got}")
        if expected is not None and got != expected:
            fails.append(f"{name} expected {expected} actual {got}")
    detail = actual.get("notification_logs_billing_detail") or ""
    if detail:
        fails.append(f"notification_logs_billing_new rows: {detail}")
    if second_apply is not None:
        print(f"second_apply_changes {second_apply}")
        if second_apply != 0:
            fails.append(f"second_apply_changes expected 0 actual {second_apply}")
    if fails:
        print("FAIL")
        for line in fails:
            print(line)
        return 1
    print("PASS")
    return 0


def query_local(db_path: str, replay_sql: str | None) -> int:
    ids = load_baseline_ids()
    sql = check_sql(ids)
    con = sqlite3.connect(db_path)
    rows = con.execute(sql).fetchall()
    actual = {name: normalize(value) for name, value in rows}
    second = None
    if replay_sql:
        script = Path(replay_sql).read_text()
        if "ALTER TABLE" in script:
            print("FAIL remote-apply.sql contains ALTER TABLE")
            return 1
        before = con.total_changes
        con.executescript(script)
        second = con.total_changes - before
    return render(actual, second_apply=second)


def parse_wrangler_json(raw: str) -> dict[str, str]:
    start = raw.find("[")
    if start < 0:
        start = raw.find("{")
    if start < 0:
        raise SystemExit("FAIL wrangler did not return JSON")
    data = json.loads(raw[start:])
    blocks = data if isinstance(data, list) else [data]
    actual: dict[str, str] = {}
    for block in blocks:
        if not isinstance(block, dict):
            continue
        meta = block.get("meta") or {}
        written = meta.get("rows_written", meta.get("changes", 0)) or 0
        if written:
            raise SystemExit(f"FAIL remote query wrote {written} rows")
        for row in block.get("results") or []:
            if "name" in row and "actual" in row:
                actual[str(row["name"])] = normalize(row["actual"])
    if not actual:
        raise SystemExit("FAIL remote query returned no check rows")
    return actual


def main(argv: list[str]) -> int:
    if "--emit-sql" in argv:
        sys.stdout.write(check_sql(load_baseline_ids()))
        sys.stdout.write("\n")
        return 0
    if "--json" in argv:
        raw = sys.stdin.read()
        return render(parse_wrangler_json(raw))
    if "--db" in argv:
        db_path = argv[argv.index("--db") + 1]
        replay = None
        if "--replay-sql" in argv:
            replay = argv[argv.index("--replay-sql") + 1]
        return query_local(db_path, replay)
    raise SystemExit("usage: import_checks.py --emit-sql | --db DB [--replay-sql FILE] | --json")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
