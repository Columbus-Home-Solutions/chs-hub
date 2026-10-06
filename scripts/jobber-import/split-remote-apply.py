#!/usr/bin/env python3
"""Split scripts/jobber-import/out/remote-apply.sql into idempotent chunks.

Inserts come first, in foreign-key order. Updates and deletes come after the
rows they point at exist. The source file does the opposite, and it opens
with PRAGMA defer_foreign_keys. Remote `wrangler d1 execute --file` does not
honor that pragma the way local SQLite does, so a foreign-key failure inside
the one import transaction is reported as D1_RESET_DO and the whole file
rolls back. Chunks omit the pragma. Each statement keeps its own guard.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts/jobber-import/out/remote-apply.sql"
DEST = ROOT / "scripts/jobber-import/out/chunks"

# Body budget. The chunk header is added afterward, and the written file
# stays under 80 KB. D1's per-statement limit is 100 KB; no statement here
# is close to that.
MAX_CHUNK_BYTES = 79_000

# Inserts first so each chunk can commit with foreign keys on.
# Updates and deletes last: two payment updates point at an invoice this
# file inserts, and that invoice must exist before those updates run.
GROUP_ORDER = [
    ("INSERT", "clients", "insert clients"),
    ("INSERT", "client_contacts", "insert client_contacts"),
    ("INSERT", "properties", "insert properties"),
    ("INSERT", "estimate_requests", "insert estimate_requests"),
    ("INSERT", "estimates", "insert estimates"),
    ("INSERT", "estimate_line_items", "insert estimate_line_items"),
    ("INSERT", "jobs", "insert jobs"),
    ("INSERT", "invoices", "insert invoices"),
    ("INSERT", "payments", "insert payments"),
    ("UPDATE", "clients", "update clients"),
    ("UPDATE", "estimates", "update estimates"),
    ("UPDATE", "jobs", "update jobs"),
    ("UPDATE", "invoices", "update invoices"),
    ("UPDATE", "payments", "update payments"),
    ("DELETE", "payments", "delete payments"),
]


def split_statements(text: str) -> list[str]:
    """Split on semicolons that are outside single-quoted strings."""
    statements: list[str] = []
    buf: list[str] = []
    in_string = False
    i = 0
    while i < len(text):
        char = text[i]
        if in_string:
            buf.append(char)
            if char == "'":
                if i + 1 < len(text) and text[i + 1] == "'":
                    buf.append("'")
                    i += 2
                    continue
                in_string = False
            i += 1
            continue
        if char == "'":
            in_string = True
            buf.append(char)
            i += 1
            continue
        if char == ";":
            statement = "".join(buf).strip()
            if statement:
                statements.append(statement)
            buf = []
            i += 1
            continue
        buf.append(char)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    if in_string:
        raise SystemExit("FAIL unclosed string in remote-apply.sql")
    return statements


def classify(statement: str) -> tuple[str, str]:
    for line in statement.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("--"):
            continue
        if stripped.upper().startswith("PRAGMA"):
            return "PRAGMA", "defer_foreign_keys"
        parts = stripped.split()
        verb = parts[0].upper()
        if verb == "INSERT" and len(parts) >= 3 and parts[1].upper() == "INTO":
            return "INSERT", parts[2].strip('"')
        if verb == "UPDATE" and len(parts) >= 2:
            return "UPDATE", parts[1].strip('"')
        if verb == "DELETE" and len(parts) >= 3 and parts[1].upper() == "FROM":
            return "DELETE", parts[2].strip('"')
        raise SystemExit(f"FAIL unrecognized statement: {stripped[:120]}")
    raise SystemExit("FAIL empty statement")


def assert_guarded(kind: str, statement: str) -> None:
    upper = statement.upper()
    if re.search(r"\b(ALTER|DROP)\b", upper) or "D1_MIGRATIONS" in upper:
        raise SystemExit(f"FAIL {kind} statement is not data-only")
    if kind == "INSERT" and "WHERE NOT EXISTS" not in upper:
        raise SystemExit("FAIL INSERT is missing WHERE NOT EXISTS")
    if kind in ("UPDATE", "DELETE") and not re.search(r"\bWHERE\b", upper):
        raise SystemExit(f"FAIL {kind} is missing WHERE")


def slug(label: str) -> str:
    return label.replace(" ", "-").replace("_", "-")


def pack(statements: list[str]) -> list[list[str]]:
    chunks: list[list[str]] = []
    current: list[str] = []
    size = 0
    for statement in statements:
        body = statement.strip() + ";\n\n"
        body_bytes = len(body.encode())
        if body_bytes > MAX_CHUNK_BYTES:
            raise SystemExit(f"FAIL one statement is {body_bytes} bytes")
        if current and size + body_bytes > MAX_CHUNK_BYTES:
            chunks.append(current)
            current = []
            size = 0
        current.append(statement)
        size += body_bytes
    if current:
        chunks.append(current)
    return chunks


def header(number: int, total: int, label: str, count: int, part: int, parts: int) -> str:
    part_note = f", part {part} of {parts}" if parts > 1 else ""
    return (
        f"-- Chunk {number:02d} of {total:02d} — {label}{part_note} ({count} statements).\n"
        "-- Idempotent on its own. Safe to re-run after a partial failure.\n"
        "-- Inserts use WHERE NOT EXISTS. Updates and deletes match pre-import values.\n"
        "-- No ALTER, no d1_migrations insert, no defer_foreign_keys pragma.\n"
        "\n"
    )


def main() -> int:
    if not SOURCE.is_file():
        raise SystemExit(f"FAIL missing {SOURCE}")
    statements = split_statements(SOURCE.read_text())
    groups: dict[tuple[str, str], list[str]] = {key[:2]: [] for key in GROUP_ORDER}
    for statement in statements:
        kind, table = classify(statement)
        if kind == "PRAGMA":
            continue
        assert_guarded(kind, statement)
        key = (kind, table)
        if key not in groups:
            raise SystemExit(f"FAIL unexpected {kind} {table}")
        groups[key].append(statement)

    packed: list[tuple[str, list[str]]] = []
    for kind, table, label in GROUP_ORDER:
        chunks = pack(groups[(kind, table)])
        for chunk in chunks:
            packed.append((label, chunk))
    if not packed:
        raise SystemExit("FAIL no chunks")

    DEST.mkdir(parents=True, exist_ok=True)
    for old in DEST.glob("*.sql"):
        old.unlink()

    total = len(packed)
    written: list[Path] = []
    sequence = 0
    # part numbers within a repeated label
    label_counts: dict[str, int] = {}
    label_seen: dict[str, int] = {}
    for label, _chunk in packed:
        label_counts[label] = label_counts.get(label, 0) + 1

    for label, chunk in packed:
        sequence += 1
        label_seen[label] = label_seen.get(label, 0) + 1
        part = label_seen[label]
        parts = label_counts[label]
        suffix = ""
        if parts > 1:
            suffix = f"-{part}"
        path = DEST / f"{sequence:02d}-{slug(label)}{suffix}.sql"
        text = header(sequence, total, label, len(chunk), part, parts)
        text += "\n".join(statement.strip() + ";" for statement in chunk)
        text += "\n"
        encoded = text.encode()
        if len(encoded) > 80_000:
            raise SystemExit(f"FAIL {path.name} is {len(encoded)} bytes")
        path.write_bytes(encoded)
        written.append(path)

    kept = sum(len(chunk) for _label, chunk in packed)
    source_data = [s for s in statements if classify(s)[0] != "PRAGMA"]
    if kept != len(source_data):
        raise SystemExit(f"FAIL kept {kept} statements, source has {len(source_data)}")
    print(f"wrote {len(written)} chunks, {kept} statements")
    for path in written:
        print(f"{path.name}\t{path.stat().st_size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
