import type { RoutableProps } from "preact-router";
import { useEffect, useRef, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatDate, formatPhone, formatStatus } from "../../lib/format";
import type { Payer } from "../../types";

declare global {
  interface Window {
    Stripe?: (key: string) => {
      elements: (opts: { clientSecret: string }) => {
        create: (type: string) => { mount: (el: HTMLElement) => void };
      };
      confirmCardSetup: (
        secret: string,
        opts: { payment_method: { card: unknown } },
      ) => Promise<{ error?: { message?: string }; setupIntent?: { payment_method?: string } }>;
    };
  }
}

interface PayerDetailResponse {
  payer: Payer;
  jobs: { id: string; title: string | null; status: string | null; created_at: string | null }[];
}

function loadStripeJs(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Stripe) return resolve();
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load Stripe.js"));
    document.head.appendChild(s);
  });
}

export function PayerDetail({ id }: RoutableProps & { id?: string }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi<PayerDetailResponse>(id ? `/api/payers/${id}` : null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Payer>>({});
  const [saving, setSaving] = useState(false);
  const [cardModal, setCardModal] = useState(false);
  const [cardBusy, setCardBusy] = useState(false);
  const cardMountRef = useRef<HTMLDivElement>(null);
  const cardElementRef = useRef<{ mount: (el: HTMLElement) => void } | null>(null);
  const setupRef = useRef<{ client_secret: string; publishable_key: string | null } | null>(null);

  useEffect(() => {
    if (data?.payer) {
      setForm(data.payer);
    }
  }, [data?.payer?.id]);

  useEffect(() => {
    if (!cardModal || !id) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await api.post<{ client_secret: string; publishable_key: string | null }>(
          `/api/payers/${id}/setup-intent`,
          {},
        );
        if (cancelled) return;
        setupRef.current = res;
        if (!res.publishable_key || !res.client_secret) {
          toast.push("error", "Stripe is not configured.");
          setCardModal(false);
          return;
        }
        await loadStripeJs();
        if (cancelled || !cardMountRef.current) return;
        const stripe = window.Stripe!(res.publishable_key);
        const elements = stripe.elements({ clientSecret: res.client_secret });
        const card = elements.create("card");
        cardElementRef.current = card;
        card.mount(cardMountRef.current);
      } catch (err) {
        if (!cancelled) {
          toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
          setCardModal(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      cardElementRef.current = null;
      setupRef.current = null;
    };
  }, [cardModal, id]);

  if (loading) return <Spinner center />;
  if (error || !data) return <div class="empty-state">Couldn't load payer: {error ?? "not found"}</div>;

  const p = data.payer;

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/payers/${p.id}`, {
        company_name: form.company_name,
        contact_name: form.contact_name,
        email: form.email,
        phone: form.phone,
        billing_address: form.billing_address,
        billing_city: form.billing_city,
        billing_state: form.billing_state,
        billing_zip: form.billing_zip,
        notes: form.notes,
      });
      toast.push("success", "Payer updated");
      setEditing(false);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveCard = async () => {
    const setup = setupRef.current;
    if (!setup?.publishable_key || !setup.client_secret || !id) return;
    setCardBusy(true);
    try {
      await loadStripeJs();
      const stripe = window.Stripe!(setup.publishable_key);
      const result = await stripe.confirmCardSetup(setup.client_secret, {
        payment_method: { card: cardElementRef.current as unknown },
      });
      if (result.error) throw new Error(result.error.message ?? "Card setup failed.");
      const pmId = result.setupIntent?.payment_method;
      if (!pmId) throw new Error("No payment method returned.");
      await api.post(`/api/payers/${id}/save-payment-method`, { payment_method_id: pmId });
      toast.push("success", "Card saved on file");
      setCardModal(false);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setCardBusy(false);
    }
  };

  const removeCard = async () => {
    if (!confirm("Remove the saved card for this payer?")) return;
    try {
      await api.del(`/api/payers/${p.id}/payment-method`);
      toast.push("success", "Card removed");
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">{p.company_name ?? p.contact_name}</h1>
          <p class="view-subtitle">
            {p.company_name ? p.contact_name : p.email}
            {p.has_card_on_file && (
              <Badge tone="success" style={{ marginLeft: "var(--space-sm)" }}>
                {p.card_brand} ····{p.card_last4}
              </Badge>
            )}
          </p>
        </div>
        <div class="view-header__right">
          <Button variant="secondary" onClick={() => go("/payers")}>
            ← Back
          </Button>
          {!editing ? (
            <Button variant="primary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          )}
        </div>
      </div>

      <div class="detail-grid">
        <Card title="Contact & billing">
          {editing ? (
            <div class="stack">
              <FormField label="Company name">
                <input class="form-input" value={form.company_name ?? ""} onInput={(e) => setForm((f) => ({ ...f, company_name: (e.target as HTMLInputElement).value }))} />
              </FormField>
              <FormField label="Contact name" required>
                <input class="form-input" value={form.contact_name ?? ""} onInput={(e) => setForm((f) => ({ ...f, contact_name: (e.target as HTMLInputElement).value }))} />
              </FormField>
              <FormField label="Email" required>
                <input class="form-input" type="email" value={form.email ?? ""} onInput={(e) => setForm((f) => ({ ...f, email: (e.target as HTMLInputElement).value }))} />
              </FormField>
              <FormField label="Phone">
                <input class="form-input" value={form.phone ?? ""} onInput={(e) => setForm((f) => ({ ...f, phone: (e.target as HTMLInputElement).value }))} />
              </FormField>
              <FormField label="Billing address">
                <input class="form-input" value={form.billing_address ?? ""} onInput={(e) => setForm((f) => ({ ...f, billing_address: (e.target as HTMLInputElement).value }))} />
              </FormField>
              <div class="form-row">
                <FormField label="City">
                  <input class="form-input" value={form.billing_city ?? ""} onInput={(e) => setForm((f) => ({ ...f, billing_city: (e.target as HTMLInputElement).value }))} />
                </FormField>
                <FormField label="State">
                  <input class="form-input" value={form.billing_state ?? ""} onInput={(e) => setForm((f) => ({ ...f, billing_state: (e.target as HTMLInputElement).value }))} />
                </FormField>
                <FormField label="ZIP">
                  <input class="form-input" value={form.billing_zip ?? ""} onInput={(e) => setForm((f) => ({ ...f, billing_zip: (e.target as HTMLInputElement).value }))} />
                </FormField>
              </div>
              <FormField label="Notes">
                <textarea class="form-input" rows={3} value={form.notes ?? ""} onInput={(e) => setForm((f) => ({ ...f, notes: (e.target as HTMLTextAreaElement).value }))} />
              </FormField>
            </div>
          ) : (
            <dl class="kv">
              <div class="kv__row"><dt>Company</dt><dd>{p.company_name ?? "—"}</dd></div>
              <div class="kv__row"><dt>Contact</dt><dd>{p.contact_name}</dd></div>
              <div class="kv__row"><dt>Email</dt><dd>{p.email}</dd></div>
              <div class="kv__row"><dt>Phone</dt><dd>{formatPhone(p.phone)}</dd></div>
              <div class="kv__row">
                <dt>Address</dt>
                <dd>
                  {[p.billing_address, p.billing_city, p.billing_state, p.billing_zip].filter(Boolean).join(", ") || "—"}
                </dd>
              </div>
              {p.notes && <div class="kv__row"><dt>Notes</dt><dd>{p.notes}</dd></div>}
            </dl>
          )}
        </Card>

        <Card title="Payment method">
          {p.has_card_on_file ? (
            <div class="stack">
              <p>
                <Badge tone="success">{p.card_brand ?? "Card"}</Badge> ending in {p.card_last4}
              </p>
              <Button variant="danger" size="sm" onClick={() => void removeCard()}>
                Remove card
              </Button>
            </div>
          ) : (
            <div class="stack">
              <p class="text--muted">No card on file</p>
              <Button variant="primary" size="sm" onClick={() => setCardModal(true)}>
                Save card on file
              </Button>
            </div>
          )}
        </Card>

        <Card title={`Linked jobs (${data.jobs.length})`}>
          {data.jobs.length === 0 ? (
            <p class="text--muted">No jobs linked to this payer.</p>
          ) : (
            <div class="stack">
              {data.jobs.map((j) => (
                <div key={j.id} class="flex items-center justify-between gap-sm" style={{ cursor: "pointer" }} onClick={() => go(`/jobs/${j.id}`)}>
                  <span>
                    <strong>{j.title ?? "Untitled job"}</strong>
                    <span class="text--muted" style={{ marginLeft: "var(--space-sm)" }}>
                      {formatStatus(j.status)}
                    </span>
                  </span>
                  <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                    {formatDate(j.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Modal
        open={cardModal}
        title="Save card on file"
        onClose={() => setCardModal(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCardModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={cardBusy} onClick={() => void saveCard()}>
              {cardBusy ? "Saving…" : "Save card"}
            </Button>
          </>
        }
      >
        <div ref={cardMountRef} style={{ padding: "var(--space-sm) 0" }} />
      </Modal>
    </div>
  );
}
