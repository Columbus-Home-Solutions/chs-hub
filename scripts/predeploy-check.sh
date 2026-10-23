#!/usr/bin/env bash
# Fail the deploy if `tsc --noEmit` reports anything other than the 7 known
# errors. A new "Cannot find name" or a change in this set stops the script.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASELINE="$(cat <<'EOF'
src/routes/bid-requests.ts(384,50): error TS2358: The left-hand side of an 'instanceof' expression must be of type 'any', an object type or a type parameter.
src/routes/estimates.ts(928,46): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.
src/routes/ops.ts(1241,19): error TS2783: 'ok' is specified more than once, so this usage will be overwritten.
src/routes/pending-quote-imports.ts(278,5): error TS2322: Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'.
src/routes/portal.ts(1115,9): error TS2358: The left-hand side of an 'instanceof' expression must be of type 'any', an object type or a type parameter.
src/routes/portal.ts(1117,24): error TS2352: Conversion of type 'string & Blob' to type 'File' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
src/routes/webhooks-boldsign.ts(326,63): error TS2339: Property 'arrayBuffer' does not exist on type 'ArrayBuffer'.
EOF
)"

tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.errors" "$tmp.baseline"' EXIT

set +e
npx tsc --noEmit --pretty false --incremental false >"$tmp" 2>&1
tsc_status=$?
set -e

grep -E "error TS[0-9]+" "$tmp" | sed -E 's/\\r$//' | sort >"$tmp.errors" || true
printf '%s\n' "$BASELINE" | sort >"$tmp.baseline"

actual_count="$(grep -c . "$tmp.errors" || true)"
expected_count="$(grep -c . "$tmp.baseline" || true)"

if [[ "$actual_count" != "$expected_count" ]] || ! diff -q "$tmp.baseline" "$tmp.errors" >/dev/null; then
  echo "predeploy-check: tsc error set does not match the 7-known baseline (tsc exit ${tsc_status})." >&2
  echo "--- expected ---" >&2
  cat "$tmp.baseline" >&2
  echo "--- actual ---" >&2
  cat "$tmp.errors" >&2
  exit 1
fi

echo "predeploy-check: tsc matches the 7-known baseline."
