import type { RoutableProps } from "preact-router";
import { useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatStatus, formatPhone } from "../../lib/format";
import {
  ESTIMATE_JOB_TYPES,
  ESTIMATE_LEAD_SOURCES,
  type Client,
  type EstimateRequest,
} from "../../types";

interface ClientListResponse {
  total: number;
  clients: Client[];
}

export function EstimateRequestForm(_props: RoutableProps) {
  const { data: clientData, loading: clientsLoading } = useApi<ClientListResponse>(
    "/api/clients?filter=all",
  );
  const toast = useToast();

  // Client selection / typeahead
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Client | null>(null);
  const [showNewClient, setShowNewClient] = useState(false);
  const [newClient, setNewClient] = useState({ first_name: "", last_name: "", phone: "", email: "" });

  // Request fields
  const [propertyAddress, setPropertyAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("Arkansas");
  const [zip, setZip] = useState("");
  const [jobType, setJobType] = useState("");
  const [leadSource, setLeadSource] = useState("");
  const [notes, setNotes] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const matches = useMemo(() => {
    const all = clientData?.clients ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const qDigits = q.replace(/\D/g, "");
    return all
      .filter((c) => {
        const hay = [c.name, c.email, c.phone].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q) || (qDigits && (c.phone ?? "").replace(/\D/g, "").includes(qDigits));
      })
      .slice(0, 8);
  }, [clientData, search]);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!selected && !showNewClient) e.client = "Select or create a client";
    if (showNewClient) {
      if (!newClient.first_name.trim()) e.first_name = "Required";
      if (!newClient.last_name.trim()) e.last_name = "Required";
      if (!newClient.email.trim()) e.email = "Required";
      if (!newClient.phone.trim()) e.phone = "Required";
    }
    if (!propertyAddress.trim()) e.property_address = "Required";
    if (!city.trim()) e.property_city = "Required";
    if (!zip.trim()) e.property_zip = "Required";
    if (!jobType) e.job_type = "Required";
    if (!leadSource) e.lead_source = "Required";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      let clientId = selected?.id;

      // Inline new client → create first (force=true skips the duplicate prompt
      // since the user explicitly chose "New Client").
      if (showNewClient) {
        const res = await api.post<{ client?: Client }>("/api/clients?force=true", {
          first_name: newClient.first_name,
          last_name: newClient.last_name,
          email: newClient.email,
          phone: newClient.phone,
          lead_source: leadSource,
        });
        if (!res.client) throw new Error("Could not create client");
        clientId = res.client.id;
      }

      const res = await api.post<{ request: EstimateRequest }>("/api/estimate-requests", {
        client_id: clientId,
        property_address: propertyAddress,
        property_city: city,
        property_state: state || "Arkansas",
        property_zip: zip,
        job_type: jobType,
        lead_source: leadSource,
        notes,
      });
      toast.push("success", "Estimate request created");
      go(`/estimating/${res.request.id}`);
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">New Estimate Request</h1>
          <p class="view-subtitle">Capture a new lead and start it in the pipeline.</p>
        </div>
        <div class="view-header__right">
          <Button variant="tertiary" onClick={() => go("/estimating")}>
            ← Pipeline
          </Button>
        </div>
      </div>

      <div style={{ maxWidth: "720px" }}>
        <Card title="Client">
          {!showNewClient ? (
            <div>
              {selected ? (
                <div class="flex items-center justify-between gap-sm">
                  <div>
                    <strong>{selected.name}</strong>
                    <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                      {formatPhone(selected.phone)} · {selected.email ?? "—"}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => setSelected(null)}>
                    Change
                  </Button>
                </div>
              ) : (
                <FormField label="Search clients" required error={errors.client}>
                  <input
                    class="form-input"
                    type="search"
                    placeholder="Search by name or phone…"
                    value={search}
                    onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
                  />
                  {clientsLoading && <Spinner />}
                  {search.trim() && matches.length > 0 && (
                    <div class="typeahead">
                      {matches.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          class="typeahead__item"
                          onClick={() => {
                            setSelected(c);
                            setSearch("");
                            setErrors((p) => ({ ...p, client: "" }));
                          }}
                        >
                          <strong>{c.name}</strong>
                          <span class="text--muted">
                            {formatPhone(c.phone)} {c.email ? `· ${c.email}` : ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {search.trim() && matches.length === 0 && !clientsLoading && (
                    <div class="form-hint">No matches. Create a new client instead.</div>
                  )}
                </FormField>
              )}
              {!selected && (
                <Button
                  size="sm"
                  variant="tertiary"
                  onClick={() => {
                    setShowNewClient(true);
                    setErrors((p) => ({ ...p, client: "" }));
                  }}
                >
                  + New Client
                </Button>
              )}
            </div>
          ) : (
            <div>
              <div class="form-row">
                <FormField
                  label="First name"
                  required
                  error={errors.first_name}
                  inputProps={{
                    value: newClient.first_name,
                    onInput: (e) =>
                      setNewClient((p) => ({ ...p, first_name: (e.target as HTMLInputElement).value })),
                  }}
                />
                <FormField
                  label="Last name"
                  required
                  error={errors.last_name}
                  inputProps={{
                    value: newClient.last_name,
                    onInput: (e) =>
                      setNewClient((p) => ({ ...p, last_name: (e.target as HTMLInputElement).value })),
                  }}
                />
              </div>
              <div class="form-row">
                <FormField
                  label="Phone"
                  required
                  error={errors.phone}
                  inputProps={{
                    value: newClient.phone,
                    onInput: (e) =>
                      setNewClient((p) => ({ ...p, phone: (e.target as HTMLInputElement).value })),
                  }}
                />
                <FormField
                  label="Email"
                  required
                  error={errors.email}
                  inputProps={{
                    type: "email",
                    value: newClient.email,
                    onInput: (e) =>
                      setNewClient((p) => ({ ...p, email: (e.target as HTMLInputElement).value })),
                  }}
                />
              </div>
              <Button size="sm" variant="tertiary" onClick={() => setShowNewClient(false)}>
                ← Use existing client
              </Button>
            </div>
          )}
        </Card>

        <div style={{ height: "var(--space-lg)" }} />

        <Card title="Property & Job">
          <FormField
            label="Property address"
            required
            error={errors.property_address}
            inputProps={{
              value: propertyAddress,
              onInput: (e) => setPropertyAddress((e.target as HTMLInputElement).value),
            }}
          />
          <div class="form-row">
            <FormField
              label="City"
              required
              error={errors.property_city}
              inputProps={{ value: city, onInput: (e) => setCity((e.target as HTMLInputElement).value) }}
            />
            <FormField
              label="State"
              inputProps={{ value: state, onInput: (e) => setState((e.target as HTMLInputElement).value) }}
            />
            <FormField
              label="ZIP"
              required
              error={errors.property_zip}
              inputProps={{ value: zip, onInput: (e) => setZip((e.target as HTMLInputElement).value) }}
            />
          </div>
          <div class="form-row">
            <FormField label="Job type" required error={errors.job_type}>
              <Select
                value={jobType}
                placeholder="Select…"
                options={ESTIMATE_JOB_TYPES.map((t) => ({ value: t, label: formatStatus(t) }))}
                onChange={setJobType}
              />
            </FormField>
            <FormField label="Lead source" required error={errors.lead_source}>
              <Select
                value={leadSource}
                placeholder="Select…"
                options={ESTIMATE_LEAD_SOURCES.map((s) => ({ value: s, label: formatStatus(s) }))}
                onChange={setLeadSource}
              />
            </FormField>
          </div>
          <FormField label="Notes">
            <textarea
              class="form-textarea"
              value={notes}
              onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
            />
          </FormField>
        </Card>

        <div class="flex justify-between mt-lg">
          <Button variant="secondary" onClick={() => go("/estimating")} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? "Creating…" : "Create Request"}
          </Button>
        </div>
      </div>
    </div>
  );
}
