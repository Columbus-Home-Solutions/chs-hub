#!/usr/bin/env bash
# Apply Jobber import chunks one at a time. Stops on the first error.
# Every chunk is idempotent, so re-running the whole chain after a
# partial failure is safe.
#
# Remote (this is the command Tony runs):
#   scripts/jobber-import/apply-remote-chunks.sh
#   scripts/jobber-import/apply-remote-chunks.sh --from 06
#
# Local sqlite, for a copy of an export. Never the wrangler dev database:
#   scripts/jobber-import/apply-remote-chunks.sh --sqlite /tmp/chs.sqlite
#
# Migration 0132 must already be applied. These chunks do not add columns.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHUNK_DIR="$ROOT/scripts/jobber-import/out/chunks"
SQLITE=""
FROM=""
THROUGH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sqlite)
      SQLITE="${2:-}"
      shift 2
      ;;
    --from)
      FROM="$(printf '%02d' "$((10#${2:-0}))")"
      shift 2
      ;;
    --through)
      THROUGH="$(printf '%02d' "$((10#${2:-0}))")"
      shift 2
      ;;
    *)
      echo "FAIL unknown argument: $1" >&2
      echo "usage: apply-remote-chunks.sh [--sqlite DB] [--from NN] [--through NN]" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$SQLITE" ]]; then
  case "$SQLITE" in
    *".wrangler/state"*)
      echo "FAIL refusing to write the wrangler dev database" >&2
      exit 1
      ;;
  esac
  if [[ "$SQLITE" != /* ]]; then
    SQLITE="$(cd "$(dirname "$SQLITE")" && pwd)/$(basename "$SQLITE")"
  fi
  if [[ ! -f "$SQLITE" ]]; then
    echo "FAIL missing sqlite database: $SQLITE" >&2
    exit 1
  fi
fi

cd "$ROOT"

shopt -s nullglob
files=("$CHUNK_DIR"/[0-9][0-9]-*.sql)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "FAIL no chunks in $CHUNK_DIR" >&2
  echo "Run: python3 scripts/jobber-import/split-remote-apply.py" >&2
  exit 1
fi
IFS=$'\n' files=($(printf '%s\n' "${files[@]}" | sort))
unset IFS

selected=()
for file in "${files[@]}"; do
  base="$(basename "$file")"
  num="${base%%-*}"
  if [[ -n "$FROM" && "$num" < "$FROM" ]]; then
    continue
  fi
  if [[ -n "$THROUGH" && "$num" > "$THROUGH" ]]; then
    continue
  fi
  selected+=("$file")
done

if [[ ${#selected[@]} -eq 0 ]]; then
  echo "FAIL no chunks selected" >&2
  exit 1
fi

total="${#selected[@]}"
index=0
for file in "${selected[@]}"; do
  index=$((index + 1))
  base="$(basename "$file")"
  num="${base%%-*}"
  bytes="$(wc -c < "$file" | tr -d ' ')"
  echo "chunk ${num} (${index}/${total}) ${base} ${bytes} bytes"

  if [[ -n "$SQLITE" ]]; then
    if ! result="$(sqlite3 "$SQLITE" <<EOF
.bail on
PRAGMA foreign_keys = ON;
SELECT total_changes();
.read '$file'
SELECT total_changes();
EOF
)"; then
      echo "FAIL stopped on chunk ${num} ${base}" >&2
      exit 1
    fi
    before="$(printf '%s\n' "$result" | head -n 1)"
    after="$(printf '%s\n' "$result" | tail -n 1)"
    echo "changes $((after - before))"
  else
    if ! npx wrangler d1 execute chs-hub-db --remote --yes --file "$file"; then
      echo "FAIL stopped on chunk ${num} ${base}" >&2
      exit 1
    fi
  fi
done

echo "applied ${total} chunks"
