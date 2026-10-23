#!/usr/bin/env bash
# Fail the deploy if `tsc --noEmit` reports anything other than the 7 known
# errors. A known error is identified by its file, TypeScript code, and the
# source line — not by a line number — so a shift in portal.ts still matches.
# A new error, or a fix of one of these lines, stops the script.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.errors" "$tmp.baseline" "$tmp.raw"' EXIT

# file, TS code, source line with surrounding whitespace removed.
cat >"$tmp.baseline" <<'EOF'
src/routes/bid-requests.ts	TS2358	if ((key === "photo" || key === "photos") && value instanceof File && value.size > 0) {
src/routes/estimates.ts	TS2345	await advanceLeadToBuildingIfEligible(env, requestId, req.status);
src/routes/ops.ts	TS2783	return jsonOk({ ok: true, ...result });
src/routes/pending-quote-imports.ts	TS2322	raw: new TextEncoder().encode(rawMime).buffer,
src/routes/portal.ts	TS2352	photoFilename = (photoEntry as File).name ?? "photo.jpg";
src/routes/portal.ts	TS2358	if (photoEntry instanceof Blob && photoEntry.size > 0) {
src/routes/webhooks-boldsign.ts	TS2339	await env.FILES.put(signedPdfKey, await pdfBlob.arrayBuffer(), {
EOF
sort -o "$tmp.baseline" "$tmp.baseline"

set +e
npx tsc --noEmit --pretty false --incremental false >"$tmp" 2>&1
tsc_status=$?
set -e

grep -E "error TS[0-9]+" "$tmp" | sed -E 's/\r$//' >"$tmp.raw" || true
: >"$tmp.errors"
while IFS= read -r diagnostic || [[ -n "${diagnostic:-}" ]]; do
  [[ -z "${diagnostic}" ]] && continue
  pattern='^([^(]+)\(([0-9]+),[0-9]+): error (TS[0-9]+):'
  if [[ "$diagnostic" =~ $pattern ]]; then
    file="${BASH_REMATCH[1]}"
    lineno="${BASH_REMATCH[2]}"
    code="${BASH_REMATCH[3]}"
    if [[ -f "$file" ]]; then
      source_line="$(sed -n "${lineno}p" "$file")"
      source_line="${source_line#"${source_line%%[![:space:]]*}"}"
      source_line="${source_line%"${source_line##*[![:space:]]}"}"
    else
      source_line="(missing file)"
    fi
    printf '%s\t%s\t%s\n' "$file" "$code" "$source_line" >>"$tmp.errors"
  else
    printf 'UNPARSED\t\t%s\n' "$diagnostic" >>"$tmp.errors"
  fi
done <"$tmp.raw"
sort -o "$tmp.errors" "$tmp.errors"

actual_count="$(grep -c . "$tmp.errors" || true)"
expected_count="$(grep -c . "$tmp.baseline" || true)"

if [[ "$actual_count" != "$expected_count" ]] || ! diff -q "$tmp.baseline" "$tmp.errors" >/dev/null; then
  echo "predeploy-check: tsc error set does not match the 7-known baseline (tsc exit ${tsc_status})." >&2
  echo "--- expected (file, code, source line) ---" >&2
  cat "$tmp.baseline" >&2
  echo "--- actual ---" >&2
  cat "$tmp.errors" >&2
  exit 1
fi

echo "predeploy-check: tsc matches the 7-known baseline."
