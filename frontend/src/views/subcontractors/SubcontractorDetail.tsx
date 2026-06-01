import type { RoutableProps } from "preact-router";
import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { go } from "../../lib/nav";
import { formatCurrency, formatDate, formatPhone, formatStatus } from "../../lib/format";
import type { Subcontractor } from "../../types";
import { SubForm } from "./SubcontractorList";

interface PaymentLine {
  id: string;
  amount: number;
  date: string | null;
  description: string | null;
  expense_type: string | null;
  is_1099_reportable: boolean;
  job_id: string | null;
  job_number: number | null;
  job_title: string | null;
}
interface YearTotal {
  year: string;
  total: number;
  total_1099: number;
  count: number;
}
interface SubPayments {
  year: number;
  ytd: number;
  ytd_1099: number;
  lifetime: number;
  count: number;
  by_year: YearTotal[];
  history: PaymentLine[];
}
interface SubDetailResponse {
  subcontractor: Subcontractor;
  payments: SubPayments;
}

export function SubcontractorDetail({ id }: RoutableProps & { id?: string }) {
  const { data, loading, error, refetch } = useApi<SubDetailResponse>(
    id ? `/api/subcontractors/${id}` : null,
  );
  const [editing, setEditing] = useState(false);

  if (loading) return <Spinner center />;
  if (error || !data) {
    return <div class="empty-state">Couldn't load subcontractor: {error ?? "not found"}</div>;
  }

  const s = data.subcontractor;
  const p = data.payments;

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">
            {s.company_name ?? "—"}{" "}
            {s.trade && <Badge tone="info">{s.trade}</Badge>}
            {!s.is_active && <Badge>Inactive</Badge>}
          </h1>
          <p class="view-subtitle">
            {s.contact_name ?? "—"} · {formatPhone(s.phone)} · {s.email ?? "—"}
          </p>
        </div>
        <div class="view-header__right">
          <Button variant="tertiary" onClick={() => go("/subcontractors")}>
            ← Back
          </Button>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </div>
      </div>

      <div class="detail-grid">
        <div class="stack">
          <Card title="Payments">
            <div class="fin-summary">
              <div class="fin-stat fin-stat--success">
                <div class="fin-stat__label">Paid in {p.year}</div>
                <div class="fin-stat__value">{formatCurrency(p.ytd)}</div>
              </div>
              <div class="fin-stat">
                <div class="fin-stat__label">1099-reportable ({p.year})</div>
                <div class="fin-stat__value">{formatCurrency(p.ytd_1099)}</div>
              </div>
              <div class="fin-stat">
                <div class="fin-stat__label">Lifetime paid</div>
                <div class="fin-stat__value">{formatCurrency(p.lifetime)}</div>
              </div>
              <div class="fin-stat">
                <div class="fin-stat__label">Payments</div>
                <div class="fin-stat__value">{p.count}</div>
              </div>
            </div>

            {p.by_year.length > 0 && (
              <div style={{ marginTop: "var(--space-md)" }}>
                <table class="table">
                  <thead>
                    <tr>
                      <th>Year</th>
                      <th class="num">Paid</th>
                      <th class="num">1099</th>
                      <th class="num">Payments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.by_year.map((y) => (
                      <tr key={y.year}>
                        <td>{y.year}</td>
                        <td class="num">{formatCurrency(y.total)}</td>
                        <td class="num text--muted">{formatCurrency(y.total_1099)}</td>
                        <td class="num text--muted">{y.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Payment history">
            {p.history.length === 0 ? (
              <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
                No payments recorded. Sub payments come from expenses tagged to this sub.
              </p>
            ) : (
              <div class="stack">
                {p.history.map((h) => (
                  <div key={h.id} class="invoice-row">
                    <div class="invoice-row__main">
                      <div class="invoice-row__title">
                        {h.description ?? (h.expense_type ? formatStatus(h.expense_type) : "Payment")}
                        {h.is_1099_reportable && <Badge tone="info">1099</Badge>}
                      </div>
                      <div class="invoice-row__meta">
                        {h.date ? formatDate(h.date) : "—"}
                        {h.job_id
                          ? ` · ${h.job_title ?? `Job #${h.job_number ?? "—"}`}`
                          : " · no job"}
                      </div>
                    </div>
                    <div class="invoice-row__amount">{formatCurrency(h.amount)}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div class="stack">
          <Card title="Details">
            <div class="kv">
              <div class="kv__row">
                <span class="kv__label">Trade</span>
                <span class="kv__value">{s.trade ?? "—"}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Contact</span>
                <span class="kv__value">{s.contact_name ?? "—"}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Phone</span>
                <span class="kv__value">{formatPhone(s.phone)}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Email</span>
                <span class="kv__value">{s.email ?? "—"}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">License</span>
                <span class="kv__value">{s.license_number ?? "—"}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Hourly rate</span>
                <span class="kv__value">
                  {s.hourly_rate == null ? "—" : `${formatCurrency(s.hourly_rate)}/hr`}
                </span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Rating</span>
                <span class="kv__value">{s.rating == null ? "—" : `${s.rating}/5`}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Insurance</span>
                <span class="kv__value">
                  {s.insurance_on_file ? <Badge tone="success">On file</Badge> : <Badge>No</Badge>}
                </span>
              </div>
              <div class="kv__row">
                <span class="kv__label">W-9</span>
                <span class="kv__value">
                  {s.w9_on_file ? <Badge tone="success">On file</Badge> : <Badge>No</Badge>}
                </span>
              </div>
            </div>
          </Card>

          {s.flat_rate_notes && (
            <Card title="Rate notes">
              <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>{s.flat_rate_notes}</p>
            </Card>
          )}

          {s.notes && (
            <Card title="Notes">
              <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>{s.notes}</p>
            </Card>
          )}
        </div>
      </div>

      {editing && (
        <SubForm
          mode="edit"
          sub={s}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refetch();
          }}
        />
      )}
    </div>
  );
}
