import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatDate, formatDateTime, formatStatus } from "../../lib/format";
import { WarrantyExpirationCallout } from "../../components/WarrantyExpirationCallout";
import { WarrantyFormModal } from "../warranty/WarrantyCalls";

interface WarrantyCall {
  id: string;
  job_id: string;
  job_number: number | null;
  title: string;
  status: string;
  assignee_name: string | null;
  scheduled_date: string | null;
}

interface WarrantyClaim {
  id: string;
  claim_date: string;
  description: string;
  status: string;
  resolution: string | null;
  submitted_by: "owner" | "client";
  viewed_by_owner: boolean;
  created_at: string;
}

interface Props {
  jobId: string;
  warrantyExpiration?: string | null;
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

export function WarrantyTab({ jobId, warrantyExpiration = null }: Props) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi<{ warranty_calls: WarrantyCall[] }>(
    `/api/jobs/${jobId}/warranty-calls`,
  );
  const { data: claimsData, refetch: refetchClaims } = useApi<{
    warranties: WarrantyClaim[];
    total: number;
  }>(`/api/jobs/${jobId}/warranties`);
  const [creating, setCreating] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveText, setResolveText] = useState("");

  if (loading) return <Spinner center />;
  if (error || !data) {
    return (
      <div class="empty-state">
        <div class="empty-state__title">Warranty calls unavailable</div>
        <div>{error ?? "Could not load warranty calls."}</div>
      </div>
    );
  }

  const calls = data.warranty_calls;
  const claims = claimsData?.warranties ?? [];
  const clientClaims = claims.filter((c) => c.submitted_by === "client");
  const unreadCount = clientClaims.filter((c) => !c.viewed_by_owner).length;

  const complete = async (id: string) => {
    try {
      await api.patch(`/api/warranty-calls/${id}`, { status: "completed" });
      toast.push("success", "Marked completed");
      void refetch();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const resolveClaimSubmit = async (claimId: string) => {
    try {
      await api.patch(`/api/warranties/${claimId}`, {
        status: "resolved",
        resolution: resolveText || null,
      });
      toast.push("success", "Claim marked resolved");
      setResolvingId(null);
      setResolveText("");
      void refetchClaims();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const statusTone = (s: string) =>
    s === "resolved" || s === "closed"
      ? "success"
      : s === "in_progress"
        ? "info"
        : "warning";

  return (
    <div class="stack">
      <WarrantyExpirationCallout expiration={warrantyExpiration} />

      {/* ── Warranty Claims (from warranties table) ───────────────────── */}
      <div class="flex items-center justify-between gap-sm">
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {claims.length} warranty claim(s)
          {unreadCount > 0 && (
            <Badge tone="warning" style={{ marginLeft: "var(--space-xs)" }}>
              {unreadCount} new from client
            </Badge>
          )}
        </span>
        <Button
          variant="primary"
          size="sm"
          onClick={async () => {
            try {
              await api.post(`/api/jobs/${jobId}/warranties`, {
                description: "Warranty issue",
              });
              toast.push("success", "Claim logged");
              void refetchClaims();
            } catch (e) {
              toast.push("error", errMsg(e));
            }
          }}
        >
          + Log Warranty Claim
        </Button>
      </div>

      <Card title="Warranty Claims">
        {claims.length === 0 ? (
          <div class="empty-state">
            <div class="empty-state__icon">🛡️</div>
            <div class="empty-state__title">No warranty claims</div>
            <div>Client-submitted and owner-logged warranty issues appear here.</div>
          </div>
        ) : (
          <div class="invoice-list">
            {claims.map((c) => (
              <div class="invoice-row" key={c.id}>
                <div class="invoice-row__main">
                  <div class="invoice-row__title">
                    {c.description.length > 80 ? `${c.description.slice(0, 80)}…` : c.description}
                    <Badge tone={statusTone(c.status)}>{formatStatus(c.status)}</Badge>
                    {c.submitted_by === "client" && (
                      <Badge tone="info">Submitted by client</Badge>
                    )}
                  </div>
                  <div class="invoice-row__meta">
                    {formatDate(c.claim_date)}
                    {c.resolution && ` · ${c.resolution}`}
                  </div>
                  {resolvingId === c.id && (
                    <div class="stack" style={{ marginTop: "var(--space-sm)" }}>
                      <input
                        class="form-input"
                        placeholder="Resolution notes (optional)"
                        value={resolveText}
                        onInput={(e) => setResolveText((e.target as HTMLInputElement).value)}
                      />
                      <div class="flex gap-sm">
                        <Button size="sm" variant="primary" onClick={() => void resolveClaimSubmit(c.id)}>
                          Save Resolution
                        </Button>
                        <Button size="sm" variant="tertiary" onClick={() => setResolvingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                {c.status !== "resolved" && c.status !== "closed" && resolvingId !== c.id && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setResolvingId(c.id);
                      setResolveText("");
                    }}
                  >
                    Resolve
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Warranty Calls (scheduling/tracking) ────────────────────── */}
      <div class="flex items-center justify-between gap-sm">
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {calls.length} warranty call(s) · no billing
        </span>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          + Log Warranty Call
        </Button>
      </div>

      <Card title="Warranty Calls">
        {calls.length === 0 ? (
          <div class="empty-state">
            <div class="empty-state__icon">📋</div>
            <div class="empty-state__title">No warranty calls</div>
            <div>Log callbacks and punch-list follow-ups here.</div>
          </div>
        ) : (
          <div class="invoice-list">
            {calls.map((c) => (
              <div class="invoice-row" key={c.id}>
                <div class="invoice-row__main" style={{ cursor: "pointer" }} onClick={() => go(`/warranty-calls/${c.id}`)}>
                  <div class="invoice-row__title">
                    {c.title}
                    <Badge tone={c.status === "completed" ? "success" : c.status === "open" ? "warning" : "info"}>
                      {formatStatus(c.status)}
                    </Badge>
                  </div>
                  <div class="invoice-row__meta">
                    {c.assignee_name ?? "Unassigned"}
                    {c.scheduled_date ? ` · ${formatDateTime(c.scheduled_date)}` : " · Not scheduled"}
                  </div>
                </div>
                {c.status !== "completed" && c.status !== "cancelled" && (
                  <Button variant="tertiary" size="sm" onClick={() => void complete(c.id)}>
                    ✓
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {creating && (
        <WarrantyFormModal
          jobs={[]}
          presetJobId={jobId}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void refetch();
          }}
        />
      )}
    </div>
  );
}
