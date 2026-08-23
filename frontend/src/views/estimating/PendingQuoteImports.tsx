/**
 * Pending Imports — email-intake queue for supplier quotes.
 * Mirrors DocReviewQueue list pattern; reuses ImportQuoteModal for review/confirm.
 */
import type { RoutableProps } from "preact-router";
import { useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { formatCurrency, formatDateTime } from "../../lib/format";
import { ImportQuoteModal, type QuoteExtractionPrefill } from "./ImportQuoteModal";
import { go } from "../../lib/nav";

interface PendingItem {
  id: string;
  from_address: string | null;
  subject: string | null;
  received_at: string;
  vendor_guess: string | null;
  quote_total: number | null;
  line_count: number;
  extraction_error: string | null;
  extraction: QuoteExtractionPrefill;
  attachments: Array<{
    filename: string;
    mime_type: string;
    size_bytes: number;
    r2_key: string | null;
  }>;
  status: string;
  intake_address: string;
}

interface EstimateOption {
  id: string;
  estimate_number: number | null;
  title: string | null;
  client_name: string | null;
  status: string;
  updated_at: string | null;
}

interface LineItemOption {
  id: string;
  product_service: string | null;
  description: string | null;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

export function PendingQuoteImports(_props: RoutableProps) {
  const toast = useToast();
  const queue = useApi<{ items: PendingItem[]; pending_count: number; intake_address: string }>(
    "/api/pending-quote-imports?status=pending",
  );
  const [picking, setPicking] = useState<PendingItem | null>(null);
  const [reviewing, setReviewing] = useState<{
    item: PendingItem;
    estimateId: string;
    lineItemId: string;
  } | null>(null);

  const items = queue.data?.items ?? [];
  const intake = queue.data?.intake_address ?? "lowes-import@quotes.homesolutionsar.com";

  async function discard(item: PendingItem) {
    try {
      await api.post(`/api/pending-quote-imports/${item.id}/discard`, {});
      toast.push("success", "Import discarded");
      await queue.refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Discard failed");
    }
  }

  return (
    <div class="view">
      <div class="view-header">
        <div>
          <h1 class="view-title">Pending Imports</h1>
          <p class="view-subtitle">
            Supplier quotes emailed to <code>{intake}</code>. Nothing is added to an estimate until
            you assign and confirm.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void queue.refetch()}>
          Refresh
        </Button>
      </div>

      {queue.loading && <Spinner center />}
      {queue.error && <div class="empty-state">Failed to load queue: {queue.error}</div>}

      {!queue.loading && !queue.error && items.length === 0 && (
        <div class="empty-state">
          <div class="empty-state__icon">📨</div>
          <p>No pending quote emails.</p>
          <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            Share a Lowe&apos;s list to <strong>{intake}</strong> and it will show up here.
          </p>
        </div>
      )}

      {!queue.loading && items.length > 0 && (
        <div class="dash-card" style={{ padding: 0, overflow: "hidden" }}>
          <table class="data-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>From</th>
                <th>Subject</th>
                <th>Attachments</th>
                <th>Vendor</th>
                <th>Lines</th>
                <th>Total</th>
                <th>Received</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.from_address ?? "—"}</td>
                  <td>
                    {item.subject ?? "(no subject)"}
                    {item.extraction_error && (
                      <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                        Extract issue: {item.extraction_error}
                      </div>
                    )}
                    {item.line_count === 0 && (item.attachments?.length ?? 0) > 0 && (
                      <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                        0 lines extracted — check attachment type
                      </div>
                    )}
                  </td>
                  <td>
                    {(item.attachments?.length ?? 0) === 0 ? (
                      <span class="text--muted">—</span>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "var(--text-xs)" }}>
                        {item.attachments.map((a, i) => (
                          <li key={i}>
                            {a.filename}{" "}
                            <span class="text--muted">
                              ({a.mime_type}
                              {a.size_bytes ? `, ${Math.round(a.size_bytes / 1024)}KB` : ""}
                              {!a.mime_type.startsWith("image/") && a.mime_type !== "application/pdf"
                                ? ", not extracted"
                                : ""}
                              )
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>{item.vendor_guess ?? "—"}</td>
                  <td>{item.line_count}</td>
                  <td>
                    {item.quote_total != null ? formatCurrency(item.quote_total) : "—"}
                  </td>
                  <td title={formatDateTime(item.received_at)}>
                    {relativeTime(item.received_at)}
                  </td>
                  <td>
                    <div class="flex gap-sm" style={{ justifyContent: "flex-end" }}>
                      <Button size="sm" variant="primary" onClick={() => setPicking(item)}>
                        Assign
                      </Button>
                      <Button size="sm" variant="tertiary" onClick={() => void discard(item)}>
                        Discard
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {picking && (
        <AssignDestinationModal
          item={picking}
          onClose={() => setPicking(null)}
          onReady={(estimateId, lineItemId) => {
            setReviewing({ item: picking, estimateId, lineItemId });
            setPicking(null);
          }}
        />
      )}

      {reviewing && (
        <ImportQuoteModal
          open
          lineItemId={reviewing.lineItemId}
          prefill={reviewing.item.extraction}
          hideBackToPaste
          onClose={() => setReviewing(null)}
          onDone={async (result) => {
            await api.post(`/api/pending-quote-imports/${reviewing.item.id}/assign`, {
              estimate_id: reviewing.estimateId,
              line_item_id: reviewing.lineItemId,
              sub_item_ids: result?.sub_item_ids ?? [],
            });
            setReviewing(null);
            await queue.refetch();
            toast.push("success", "Import assigned");
            go(`/estimates/${reviewing.estimateId}`);
          }}
        />
      )}
    </div>
  );
}

function AssignDestinationModal({
  item,
  onClose,
  onReady,
}: {
  item: PendingItem;
  onClose: () => void;
  onReady: (estimateId: string, lineItemId: string) => void;
}) {
  const toast = useToast();
  const estimates = useApi<{ estimates: EstimateOption[] }>("/api/estimates?limit=50");
  const [estimateId, setEstimateId] = useState("");
  const [lineItemId, setLineItemId] = useState("");
  const [q, setQ] = useState("");

  const lineItems = useApi<{ line_items: LineItemOption[] }>(
    estimateId ? `/api/estimates/${estimateId}/line-items` : null,
  );

  const filtered = useMemo(() => {
    const list = estimates.data?.estimates ?? [];
    const draftFirst = [...list].sort((a, b) => {
      const ad = a.status === "draft" ? 0 : 1;
      const bd = b.status === "draft" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""));
    });
    const needle = q.trim().toLowerCase();
    if (!needle) return draftFirst;
    return draftFirst.filter((e) => {
      const hay = `${e.estimate_number ?? ""} ${e.title ?? ""} ${e.client_name ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [estimates.data, q]);

  return (
    <Modal open title="Assign to estimate" onClose={onClose} size="wide">
      <div class="flex flex-col gap-md">
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
          Pick where <strong>{item.subject ?? "this quote"}</strong> should land, then review the
          extracted lines.
        </p>
        <FormField
          label="Search estimates"
          inputProps={{
            value: q,
            placeholder: "Client, title, or EST#…",
            onInput: (e) => setQ((e.target as HTMLInputElement).value),
          }}
        />
        {estimates.loading ? (
          <Spinner />
        ) : (
          <select
            class="form-select"
            value={estimateId}
            onChange={(e) => {
              setEstimateId((e.target as HTMLSelectElement).value);
              setLineItemId("");
            }}
            size={8}
            style={{ width: "100%" }}
          >
            <option value="">Select an estimate…</option>
            {filtered.map((e) => (
              <option key={e.id} value={e.id}>
                EST-{String(e.estimate_number ?? "?").padStart(3, "0")} · {e.client_name ?? "—"} ·{" "}
                {e.title ?? "(untitled)"} · {e.status}
              </option>
            ))}
          </select>
        )}

        {estimateId && (
          <FormField label="Parent line item">
            {lineItems.loading ? (
              <Spinner />
            ) : (
              <select
                class="form-select"
                value={lineItemId}
                onChange={(e) => setLineItemId((e.target as HTMLSelectElement).value)}
              >
                <option value="">Select line item…</option>
                {(lineItems.data?.line_items ?? []).map((li) => (
                  <option key={li.id} value={li.id}>
                    {li.product_service || li.description || li.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        )}

        <div class="flex justify-end gap-sm">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!estimateId || !lineItemId}
            onClick={() => {
              if (!estimateId || !lineItemId) {
                toast.push("error", "Pick an estimate and line item");
                return;
              }
              onReady(estimateId, lineItemId);
            }}
          >
            Continue to review
          </Button>
        </div>
      </div>
    </Modal>
  );
}
