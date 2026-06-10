import type { RoutableProps } from "preact-router";
import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { api, ApiError } from "../../api";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { Timeline } from "../../components/Timeline";
import { ClientForm } from "./ClientForm";
import { useToast } from "../../store/toast";
import { formatCurrency, formatDate, formatPhone } from "../../lib/format";
import { go } from "../../lib/nav";
import { COMM_CHANNELS, type Client, type Communication, type JobLite, type Property } from "../../types";

interface DetailResponse {
  client: Client;
  properties: Property[];
  jobs: JobLite[];
}
interface CommsResponse {
  communications: Communication[];
}

function DeleteClientCard({ client }: { client: Client }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/api/clients/${client.id}`);
      toast.push("success", "Client deleted");
      go("/clients");
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <>
      <Card title="Danger zone">
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "0 0 var(--space-sm)" }}>
          Permanently remove this client, their estimates, and closed job history.
        </p>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete Client
        </Button>
      </Card>
      <Modal
        open={open}
        title="Delete client"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              Yes, delete
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Permanently delete {client.name}? All estimates and closed job history for this client will
          be deleted. This cannot be undone.
        </p>
      </Modal>
    </>
  );
}

export function ClientDetail({ id }: RoutableProps & { id?: string }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi<DetailResponse>(id ? `/api/clients/${id}` : null);
  const comms = useApi<CommsResponse>(id ? `/api/clients/${id}/communications` : null);

  const [editing, setEditing] = useState(false);
  const [propModal, setPropModal] = useState<{ mode: "create" | "edit"; property?: Property } | null>(null);
  const [commModal, setCommModal] = useState(false);

  if (loading) return <Spinner center />;
  if (error || !data) return <div class="empty-state">Couldn't load client: {error ?? "not found"}</div>;

  const c = data.client;

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">
            {c.name}
            {c.company_name && <span class="text--muted"> — {c.company_name}</span>}
            {c.is_repeat_client && <Badge tone="brand">Repeat</Badge>}
          </h1>
          <p class="view-subtitle">
            {formatPhone(c.phone)} · {c.email ?? "—"}
            {c.mailing_city ? ` · ${c.mailing_city}, ${c.mailing_state ?? ""}` : ""}
          </p>
        </div>
        <div class="view-header__right flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
          <Button variant="primary" onClick={() => go(`/estimating/new?client_id=${c.id}&autostart=1`)}>
            + New Estimate
          </Button>
          <Button variant="tertiary" onClick={() => go("/clients")}>
            ← Back
          </Button>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </div>
      </div>

      <div class="detail-grid">
        <div class="stack">
          <Card title="Jobs">
            {data.jobs.length === 0 ? (
              <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
                No jobs yet.
              </p>
            ) : (
              <div class="kv">
                {data.jobs.map((j) => (
                  <div key={j.id} class="kv__row">
                    <span>{j.title ?? `Job #${j.job_number ?? "—"}`}</span>
                    <span class="kv__value">
                      <Badge status={j.status ?? "draft"}>{j.status ?? "—"}</Badge>{" "}
                      {formatCurrency(j.contract_total)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Communication timeline"
            actions={
              <Button size="sm" variant="secondary" onClick={() => setCommModal(true)}>
                + Log
              </Button>
            }
          >
            {comms.loading ? (
              <Spinner />
            ) : (
              <Timeline entries={comms.data?.communications ?? []} />
            )}
          </Card>

          <Card
            title="Properties"
            actions={
              <Button size="sm" variant="secondary" onClick={() => setPropModal({ mode: "create" })}>
                + Add
              </Button>
            }
          >
            {data.properties.length === 0 ? (
              <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
                No properties on file.
              </p>
            ) : (
              <div class="stack">
                {data.properties.map((p) => (
                  <div key={p.id} class="flex justify-between items-center">
                    <div>
                      <div>{p.address}</div>
                      <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                        {p.city}, {p.state} {p.zip}
                        {p.property_type ? ` · ${p.property_type}` : ""}
                      </div>
                      {p.notes && (
                        <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                          {p.notes}
                        </div>
                      )}
                    </div>
                    <div class="flex items-center gap-sm">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          go(`/estimating/new?client_id=${c.id}&property_id=${p.id}&autostart=1`)
                        }
                      >
                        Estimate
                      </Button>
                      <Button
                        size="sm"
                        variant="tertiary"
                        onClick={() => setPropModal({ mode: "edit", property: p })}
                      >
                        Edit
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {c.notes && (
            <Card title="Notes">
              <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>{c.notes}</p>
            </Card>
          )}

          {c.can_delete && <DeleteClientCard client={c} />}
        </div>

        <div class="stack">
          <Card title="Financial summary">
            <div class="kv">
              <div class="kv__row">
                <span class="kv__label">Total revenue</span>
                <span class="kv__value metric metric--positive" style={{ fontSize: "var(--text-lg)" }}>
                  {formatCurrency(c.total_revenue)}
                </span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Total jobs</span>
                <span class="kv__value">{c.total_jobs}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Outstanding</span>
                <span class="kv__value">{formatCurrency(0)}</span>
              </div>
            </div>
          </Card>

          <Card title="Details">
            <div class="kv">
              <div class="kv__row">
                <span class="kv__label">Lead source</span>
                <span class="kv__value">{c.lead_source ?? "—"}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Secondary phone</span>
                <span class="kv__value">{formatPhone(c.phone_secondary)}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Last interaction</span>
                <span class="kv__value">{formatDate(c.last_interaction_date)}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Created</span>
                <span class="kv__value">{formatDate(c.created_at)}</span>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {editing && (
        <ClientForm
          open={editing}
          mode="edit"
          initial={c}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refetch();
          }}
        />
      )}

      {propModal && id && (
        <PropertyModal
          clientId={id}
          mode={propModal.mode}
          property={propModal.property}
          onClose={() => setPropModal(null)}
          onSaved={() => {
            setPropModal(null);
            refetch();
            toast.push("success", "Property saved");
          }}
        />
      )}

      {commModal && id && (
        <CommunicationModal
          clientId={id}
          onClose={() => setCommModal(false)}
          onSaved={() => {
            setCommModal(false);
            comms.refetch();
            refetch();
            toast.push("success", "Communication logged");
          }}
        />
      )}
    </div>
  );
}

// ─── Property add/edit modal ──────────────────────────────────────────────────

function PropertyModal({
  clientId,
  mode,
  property,
  onClose,
  onSaved,
}: {
  clientId: string;
  mode: "create" | "edit";
  property?: Property;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [address, setAddress] = useState(property?.address ?? "");
  const [city, setCity] = useState(property?.city ?? "");
  const [state, setState] = useState(property?.state ?? "Arkansas");
  const [zip, setZip] = useState(property?.zip ?? "");
  const [propertyType, setPropertyType] = useState(property?.property_type ?? "");
  const [notes, setNotes] = useState(property?.notes ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!address.trim() || !city.trim() || !zip.trim()) {
      toast.push("error", "Address, city and ZIP are required");
      return;
    }
    setBusy(true);
    try {
      const body = { address, city, state, zip, property_type: propertyType, notes };
      if (mode === "create") await api.post(`/api/clients/${clientId}/properties`, body);
      else await api.put(`/api/properties/${property!.id}`, body);
      onSaved();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={mode === "create" ? "Add Property" : "Edit Property"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <FormField
        label="Address"
        required
        inputProps={{ value: address, onInput: (e) => setAddress((e.target as HTMLInputElement).value) }}
      />
      <div class="form-row">
        <FormField
          label="City"
          required
          inputProps={{ value: city, onInput: (e) => setCity((e.target as HTMLInputElement).value) }}
        />
        <FormField
          label="State"
          inputProps={{ value: state, onInput: (e) => setState((e.target as HTMLInputElement).value) }}
        />
        <FormField
          label="ZIP"
          required
          inputProps={{ value: zip, onInput: (e) => setZip((e.target as HTMLInputElement).value) }}
        />
      </div>
      <FormField label="Property type">
        <Select
          value={propertyType}
          placeholder="—"
          onChange={setPropertyType}
          options={["residential", "commercial", "rental"].map((v) => ({ value: v, label: v }))}
        />
      </FormField>
      <FormField label="Notes" hint="Gate codes, dog warnings, access instructions…">
        <textarea
          class="form-textarea"
          value={notes}
          onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
    </Modal>
  );
}

// ─── Communication log modal ──────────────────────────────────────────────────

export function CommunicationModal({
  clientId,
  jobId,
  onClose,
  onSaved,
}: {
  clientId: string;
  jobId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [channel, setChannel] = useState("phone_call");
  const [direction, setDirection] = useState("outbound");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!summary.trim()) {
      toast.push("error", "Summary is required");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/communications", {
        client_id: clientId,
        job_id: jobId,
        channel,
        direction,
        summary,
        body,
      });
      onSaved();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Log Communication"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Log"}
          </Button>
        </>
      }
    >
      <div class="form-row">
        <FormField label="Channel">
          <Select
            value={channel}
            onChange={setChannel}
            options={COMM_CHANNELS.map((v) => ({ value: v, label: v.replace(/_/g, " ") }))}
          />
        </FormField>
        <FormField label="Direction">
          <Select
            value={direction}
            onChange={setDirection}
            options={[
              { value: "outbound", label: "outbound" },
              { value: "inbound", label: "inbound" },
            ]}
          />
        </FormField>
      </div>
      <FormField
        label="Summary"
        required
        inputProps={{ value: summary, onInput: (e) => setSummary((e.target as HTMLInputElement).value) }}
      />
      <FormField label="Notes">
        <textarea
          class="form-textarea"
          value={body}
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
    </Modal>
  );
}
