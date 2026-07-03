import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { api, ApiError } from "../../api";
import { formatCurrency } from "../../lib/format";
import type {
  LineItemForMatching,
  MatchData,
  MatchResult,
  ReceiptMatchResponse,
} from "../../types";
import "./ReceiptMatchReview.css";

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 10;

export interface ReceiptMatchReviewProps {
  receiptPhotoId: string;
  jobId: string;
  onComplete: () => void;
  toast?: { push: (tone: "success" | "error" | "info", msg: string) => void };
}

/** Resolve receipt_photos.id from the linked photos.id on an expense row. */
export async function resolveReceiptPhotoId(photoId: string): Promise<string | null> {
  try {
    const meta = await api.get<{ photo: { receipt: { id: string } | null } }>(
      `/api/photos/${photoId}/meta`,
    );
    return meta.photo?.receipt?.id ?? null;
  } catch {
    return null;
  }
}

/** Fetch match data; returns HTTP status so callers can poll on 202. */
export async function fetchReceiptMatches(
  receiptPhotoId: string,
): Promise<{ status: number; data: ReceiptMatchResponse }> {
  const res = await fetch(`/api/receipt-photos/${receiptPhotoId}/matches`, {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as ReceiptMatchResponse;
  return { status: res.status, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function statusIcon(status: MatchResult["status"]): string {
  if (status === "matched") return "✓";
  if (status === "ambiguous") return "?";
  return "—";
}

/** Per-item catalog decision state managed by the confirm UI. */
interface CatalogDecision {
  catalog_update: boolean;
  add_to_catalog: boolean;
}

export function ReceiptMatchReview({
  receiptPhotoId,
  jobId,
  onComplete,
  toast,
}: ReceiptMatchReviewProps) {
  const [matches, setMatches] = useState<MatchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [pollMessage, setPollMessage] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [lineItems, setLineItems] = useState<LineItemForMatching[]>([]);
  const [savedRow, setSavedRow] = useState<string | null>(null);
  // Sub-item assignment overrides keyed by expense_line_item.id
  const [subItemOverrides, setSubItemOverrides] = useState<Record<string, string | null>>({});
  // Catalog decisions keyed by expense_line_item.id
  const [catalogDecisions, setCatalogDecisions] = useState<Record<string, CatalogDecision>>({});
  const completedRef = useRef(false);

  const finish = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    onComplete();
  }, [onComplete]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const costing = await api.get<{
          costing: { lines: { line_item_id: string; name: string }[] };
        }>(`/api/jobs/${jobId}/costing`);
        if (!cancelled) {
          setLineItems(
            (costing.costing?.lines ?? []).map((l) => ({
              id: l.line_item_id,
              description: l.name,
            })),
          );
        }
      } catch {
        if (!cancelled) setLineItems([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      for (let attempt = 0; attempt < MAX_POLLS && !cancelled; attempt++) {
        try {
          const { status, data } = await fetchReceiptMatches(receiptPhotoId);
          if (status === 202) {
            setPolling(true);
            setPollMessage(
              attempt >= MAX_POLLS - 1
                ? "Taking longer than expected — try refreshing"
                : attempt >= 4
                  ? "Still processing…"
                  : null,
            );
            if (attempt < MAX_POLLS - 1) {
              await sleep(POLL_INTERVAL_MS);
              continue;
            }
            setLoading(false);
            return;
          }

          if (status !== 200 || data.status === "failed") {
            setLoading(false);
            setPolling(false);
            return;
          }

          const expenseLineItems = data.expense_line_items ?? [];

          const matchData: MatchData = {
            status: "processed",
            extracted_items: data.extracted_items ?? [],
            match_results: data.match_results ?? [],
            has_unresolved: Boolean(data.has_unresolved),
            expense_line_items: expenseLineItems,
          };

          setMatches(matchData);
          setLoading(false);
          setPolling(false);

          // Seed catalog decisions: update checked by default for confident
          // matches; add_to_catalog unchecked by default (skippable).
          const initialDecisions: Record<string, CatalogDecision> = {};
          for (const eli of expenseLineItems) {
            initialDecisions[eli.id] = {
              catalog_update: Boolean(eli.vendor_material && eli.unit_price !== null),
              add_to_catalog: false,
            };
          }
          setCatalogDecisions(initialDecisions);

          return;
        } catch {
          setLoading(false);
          setPolling(false);
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [receiptPhotoId, finish, toast]);

  const onSelectChange = async (eliId: string, value: string) => {
    const lineItemId = value === "" ? null : value;
    setSubItemOverrides((prev) => ({ ...prev, [eliId]: lineItemId }));
    setSavedRow(eliId);
    window.setTimeout(() => setSavedRow((id) => (id === eliId ? null : id)), 1500);
  };

  const toggleCatalogUpdate = (eliId: string, field: keyof CatalogDecision) => {
    setCatalogDecisions((prev) => ({
      ...prev,
      [eliId]: { ...prev[eliId], [field]: !prev[eliId]?.[field] },
    }));
  };

  const confirmAllItems = async () => {
    if (!matches) return;
    setApplying(true);
    setApplyError(null);
    try {
      const items = matches.expense_line_items.map((eli) => {
        const subItemId =
          eli.id in subItemOverrides
            ? subItemOverrides[eli.id]
            : eli.matched_estimate_sub_item_id;
        const decision = catalogDecisions[eli.id] ?? { catalog_update: false, add_to_catalog: false };
        return {
          id: eli.id,
          matched_estimate_sub_item_id: subItemId ?? null,
          catalog_update: decision.catalog_update,
          add_to_catalog: decision.add_to_catalog,
        };
      });

      const res = await api.post<{ expense_ids: string[]; receipt_id: string }>(
        `/api/receipt-photos/${receiptPhotoId}/confirm-items`,
        { items },
      );
      const count = res.expense_ids?.length ?? 0;
      toast?.push(
        "success",
        `${count} expense${count === 1 ? "" : "s"} created from receipt`,
      );
      finish();
    } catch (err) {
      setApplyError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  if (loading || polling) {
    return (
      <div class="receipt-match-review">
        <div class="receipt-match-review__polling">
          <Spinner />
          <p>{pollMessage ?? "Matching receipt items to estimate lines…"}</p>
        </div>
      </div>
    );
  }

  if (!matches) {
    return null;
  }

  const eliList = matches.expense_line_items;

  if (eliList.length === 0) {
    return (
      <div class="receipt-match-review">
        <p class="receipt-match-review__empty">
          No individual items were found on this receipt. The total amount has been recorded.
        </p>
        <div class="receipt-match-review__footer">
          <Button variant="primary" size="sm" onClick={finish}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  const matchByItemId = new Map(matches.match_results.map((r) => [r.item_id, r]));

  return (
    <div class="receipt-match-review">
      <div class="receipt-match-review__header">📋 Receipt Items — Review & Confirm</div>
      <p class="receipt-match-review__subheading">
        {eliList.length} item{eliList.length === 1 ? "" : "s"} found. Confirm assignments
        and catalog updates below, then click Confirm All.
      </p>

      <div class="receipt-match-review__items">
        {eliList.map((eli) => {
          // Match A: estimate sub-item assignment
          const currentSubItemId =
            eli.id in subItemOverrides
              ? subItemOverrides[eli.id]
              : eli.matched_estimate_sub_item_id;

          // Match B: vendor material
          const vm = eli.vendor_material;
          const isNewCandidate = eli.is_new_material_candidate;
          const decision = catalogDecisions[eli.id] ?? { catalog_update: false, add_to_catalog: false };

          // For display: find the raw match result (by matching description to extracted item)
          const extractedMatch = matches.extracted_items.find(
            (ex) => ex.description === eli.description,
          );
          const matchResult = extractedMatch ? matchByItemId.get(extractedMatch.id) : null;
          const matchStatus = matchResult?.status ?? "unmatched";

          return (
            <div
              class={`receipt-match-review__item receipt-match-review__item--${matchStatus}`}
              key={eli.id}
            >
              {/* Item header */}
              <div class="receipt-match-review__item-row">
                <span class="receipt-match-review__item-icon" aria-hidden="true">
                  {statusIcon(matchStatus)}
                </span>
                <div class="receipt-match-review__item-description">{eli.description}</div>
                <div class="receipt-match-review__item-amount">{formatCurrency(eli.amount)}</div>
                {savedRow === eli.id && (
                  <span class="receipt-match-review__item-saved" aria-label="Saved">✓</span>
                )}
              </div>

              {/* Match A: estimate sub-item dropdown */}
              <div class="receipt-match-review__item-row receipt-match-review__item-row--indent">
                <label class="receipt-match-review__label">Estimate line item:</label>
                <select
                  class="receipt-match-review__item-select"
                  value={currentSubItemId ?? ""}
                  onChange={(e) =>
                    void onSelectChange(eli.id, (e.target as HTMLSelectElement).value)
                  }
                >
                  <option value="">General expense (no line item)</option>
                  {lineItems.map((li) => (
                    <option key={li.id} value={li.id}>
                      {li.description}
                    </option>
                  ))}
                </select>
              </div>

              {/* Match B: catalog update (existing material) */}
              {vm && eli.unit_price !== null && (
                <div class="receipt-match-review__catalog-row">
                  <label class="receipt-match-review__catalog-label">
                    <input
                      type="checkbox"
                      checked={decision.catalog_update}
                      onChange={() => toggleCatalogUpdate(eli.id, "catalog_update")}
                    />
                    {" "}Update catalog price for{" "}
                    <strong>{vm.vendor_name} — {vm.material_name}</strong>:{" "}
                    {vm.last_price !== null ? `${formatCurrency(vm.last_price)} → ` : ""}
                    {formatCurrency(eli.unit_price)}/{vm.unit ?? "unit"}
                  </label>
                </div>
              )}

              {/* Match B: new catalog entry candidate */}
              {isNewCandidate && !vm && eli.unit_price !== null && (
                <div class="receipt-match-review__catalog-row">
                  <label class="receipt-match-review__catalog-label">
                    <input
                      type="checkbox"
                      checked={decision.add_to_catalog}
                      onChange={() => toggleCatalogUpdate(eli.id, "add_to_catalog")}
                    />
                    {" "}Add to catalog: <strong>{eli.description}</strong> @{" "}
                    {formatCurrency(eli.unit_price)}/unit
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {applyError && <p class="receipt-match-review__error">{applyError}</p>}

      <div class="receipt-match-review__footer">
        <Button
          class="receipt-match-review__skip-btn"
          variant="secondary"
          size="sm"
          disabled={applying}
          onClick={finish}
        >
          Skip
        </Button>
        <Button
          class="receipt-match-review__apply-btn"
          variant="primary"
          size="sm"
          disabled={applying}
          onClick={() => void confirmAllItems()}
        >
          {applying ? "Confirming…" : "Confirm All"}
        </Button>
      </div>
    </div>
  );
}
