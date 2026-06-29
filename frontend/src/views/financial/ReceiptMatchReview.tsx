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

function effectiveLineItemId(match: MatchResult): string {
  return match.confirmed_line_item_id ?? match.suggested_line_item_id ?? "";
}

function assignmentText(match: MatchResult, lineItems: LineItemForMatching[]): string {
  const id = effectiveLineItemId(match);
  if (!id) return "General expense";
  const name =
    lineItems.find((l) => l.id === id)?.description ??
    match.suggested_line_item_name ??
    "Estimate line";
  if (match.status !== "ambiguous" || match.alternatives.length === 0) {
    return name;
  }
  const altNames = match.alternatives
    .map((a) => a.line_item_name)
    .filter(Boolean)
    .slice(0, 2);
  if (altNames.length === 0) return name;
  return `${name} OR ${altNames.join(" OR ")}`;
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

          const matchData: MatchData = {
            status: "processed",
            extracted_items: data.extracted_items ?? [],
            match_results: data.match_results ?? [],
            has_unresolved: Boolean(data.has_unresolved),
          };

          setMatches(matchData);
          setLoading(false);
          setPolling(false);

          if (matchData.extracted_items.length === 0) {
            return;
          }

          if (!matchData.has_unresolved) {
            toast?.push("success", "Receipt items matched to estimate lines.");
            finish();
          }
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

  const onSelectChange = async (itemId: string, value: string) => {
    const lineItemId = value === "" ? null : value;
    setMatches((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        match_results: prev.match_results.map((r) =>
          r.item_id === itemId
            ? {
                ...r,
                confirmed_line_item_id: lineItemId,
                confirmed_by: null,
                confirmed_at: new Date().toISOString(),
              }
            : r,
        ),
      };
    });

    try {
      await api.post(`/api/receipt-photos/${receiptPhotoId}/matches/${itemId}/confirm`, {
        line_item_id: lineItemId,
      });
      setSavedRow(itemId);
      window.setTimeout(() => setSavedRow((id) => (id === itemId ? null : id)), 1500);
    } catch (err) {
      toast?.push(
        "error",
        err instanceof ApiError ? err.message : (err as Error).message,
      );
    }
  };

  const applyMatches = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const res = await api.post<{ applied: number; skipped: number }>(
        `/api/receipt-photos/${receiptPhotoId}/matches/apply`,
        {},
      );
      toast?.push(
        "success",
        `Applied — ${res.applied} item${res.applied === 1 ? "" : "s"} linked to estimate lines`,
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

  if (matches.extracted_items.length === 0) {
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

  const matchByItem = new Map(matches.match_results.map((r) => [r.item_id, r]));

  return (
    <div class="receipt-match-review">
      <div class="receipt-match-review__header">📋 Receipt Items — Match to Estimate</div>
      <p class="receipt-match-review__subheading">
        We found {matches.extracted_items.length} item
        {matches.extracted_items.length === 1 ? "" : "s"} on this receipt. Confirm the
        assignments below, then apply.
      </p>

      <div class="receipt-match-review__items">
        {matches.extracted_items.map((item) => {
          const match = matchByItem.get(item.id);
          const status = match?.status ?? "unmatched";
          return (
            <div
              class={`receipt-match-review__item receipt-match-review__item--${status}`}
              key={item.id}
            >
              <span class="receipt-match-review__item-icon" aria-hidden="true">
                {statusIcon(status)}
              </span>
              <div class="receipt-match-review__item-description">{item.description}</div>
              <div class="receipt-match-review__item-amount">{formatCurrency(item.amount)}</div>
              <div class="receipt-match-review__item-assignment">
                → {match ? assignmentText(match, lineItems) : "General expense"}
              </div>
              <select
                class="receipt-match-review__item-select"
                value={match ? effectiveLineItemId(match) : ""}
                onChange={(e) =>
                  onSelectChange(item.id, (e.target as HTMLSelectElement).value)
                }
              >
                <option value="">General expense (no line item)</option>
                {lineItems.map((li) => (
                  <option key={li.id} value={li.id}>
                    {li.description}
                  </option>
                ))}
              </select>
              {savedRow === item.id && (
                <span class="receipt-match-review__item-saved" aria-label="Saved">
                  ✓
                </span>
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
          Skip — use total only
        </Button>
        <Button
          class="receipt-match-review__apply-btn"
          variant="primary"
          size="sm"
          disabled={applying}
          onClick={() => void applyMatches()}
        >
          {applying ? "Applying…" : "Apply Matches"}
        </Button>
      </div>
    </div>
  );
}
