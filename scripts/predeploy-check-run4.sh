#!/usr/bin/env bash
# Gate a Run 4 deploy on three checks:
#   1. tsc --noEmit matches the 7 known errors and no others
#   2. worker check-in markers appear only in the Run 4 / 4b files
#   3. the full vitest suite passes
# Do not use this on release-keepalive. That branch uses scripts/predeploy-check.sh,
# which rejects check-in routes.
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

# Files allowed to mention the check-in markers. Anything else is a new route.
ALLOW="$(cat <<'EOF'
frontend/src/views/public/CheckInPage.tsx
frontend/src/views/subcontractors/SubcontractorDetail.tsx
public/docs/CHS-API-Route-Map.md
src/index.ts
src/routes/labor-checkin.ts
tests/labor-checkin.test.ts
tests/labor-language.test.ts
tests/text-updates-consent.test.ts
EOF
)"

tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.errors" "$tmp.baseline" "$tmp.checkin" "$tmp.allow" "$tmp.extra" "$tmp.extra.files"' EXIT

set +e
npx tsc --noEmit --pretty false --incremental false >"$tmp" 2>&1
tsc_status=$?
set -e

grep -E "error TS[0-9]+" "$tmp" | sed -E 's/\r$//' | sort >"$tmp.errors" || true
printf '%s\n' "$BASELINE" | sort >"$tmp.baseline"

actual_count="$(grep -c . "$tmp.errors" || true)"
expected_count="$(grep -c . "$tmp.baseline" || true)"

if [[ "$actual_count" != "$expected_count" ]] || ! diff -q "$tmp.baseline" "$tmp.errors" >/dev/null; then
  echo "predeploy-check-run4: tsc error set does not match the 7-known baseline (tsc exit ${tsc_status})." >&2
  echo "--- expected ---" >&2
  cat "$tmp.baseline" >&2
  echo "--- actual ---" >&2
  cat "$tmp.errors" >&2
  exit 1
fi
echo "predeploy-check-run4: tsc matches the 7-known baseline."

for required in src/routes/labor-checkin.ts migrations/0130_labor_checkin.sql migrations/0131_worker_language.sql frontend/src/lib/worker-copy.ts; do
  if [[ ! -f "$required" ]]; then
    echo "predeploy-check-run4: missing check-in file $required" >&2
    exit 1
  fi
done

rg -n \
  "labor-checkin|handleCheckin|checkin-link|worker-copy|0130_labor_checkin|0131_worker_language" \
  src frontend/src shared migrations tests public/docs >"$tmp.checkin" || true
if [[ ! -s "$tmp.checkin" ]]; then
  echo "predeploy-check-run4: check-in routes are missing." >&2
  exit 1
fi
printf '%s\n' "$ALLOW" | sort >"$tmp.allow"
cut -d: -f1 "$tmp.checkin" | sort -u >"$tmp.extra.files"
comm -23 "$tmp.extra.files" "$tmp.allow" >"$tmp.extra" || true
if [[ -s "$tmp.extra" ]]; then
  echo "predeploy-check-run4: check-in markers outside the Run 4 allowlist." >&2
  cat "$tmp.extra" >&2
  exit 1
fi
echo "predeploy-check-run4: check-in markers are only in the Run 4 files."

./node_modules/.bin/vitest run --root "$ROOT"
echo "predeploy-check-run4: full test suite passed."
