import type { RoutableProps } from "preact-router";
import { useEffect, useMemo, useState, useCallback } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { AddressAutocomplete } from "../../components/AddressAutocomplete";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { searchParam } from "../../lib/url-params";
import { formatStatus, formatPhone } from "../../lib/format";
import {
  ESTIMATE_JOB_TYPES,
  ESTIMATE_LEAD_SOURCES,
  type Client,
  type EstimateRequest,
  type Property,
} from "../../types";

interface ClientListResponse {
  total: number;
  clients: Client[];
}

interface ClientDetailResponse {
  client: Client;
  properties: Property[];
}

function applyProperty(
  p: Pick<Property, "address" | "city" | "state" | "zip">,
  setters: {
    setPropertyAddress: (v: string) => void;
    setCity: (v: string) => void;
    setState: (v: string) => void;
    setZip: (v: string) => void;
    setLat: (v: number | null) => void;
    setLon: (v: number | null) => void;
  },
) {
  setters.setPropertyAddress(p.address);
  setters.setCity(p.city);
  setters.setState(p.state || "Arkansas");
  setters.setZip(p.zip);
  setters.setLat(null);
  setters.setLon(null);
}

export function EstimateRequestForm(_props: RoutableProps) {
  const clientIdParam = searchParam("client_id");
  const propertyIdParam = searchParam("property_id");
  const autostart = searchParam("autostart") === "1";

  const { data: clientData, loading: clientsLoading } = useApi<ClientListResponse>(
    clientIdParam ? null : "/api/clients?filter=all",
  );
  const { data: prefilledClientData, loading: prefilledLoading } = useApi<ClientDetailResponse>(
    clientIdParam ? `/api/clients/${clientIdParam}` : null,
  );

  const toast = useToast();
  const fromClientProfile = !!clientIdParam;

  // Client selection / typeahead
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Client | null>(null);
  const [showNewClient, setShowNewClient] = useState(false);
  const [newClient, setNewClient] = useState({
    first_name: "",
    last_name: "",
    phone: "",
    email: "",
    company_name: "",
  });
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(propertyIdParam);

  // Request fields
  const [propertyAddress, setPropertyAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("Arkansas");
  const [zip, setZip] = useState("");
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleAddressSelect = useCallback(
    (result: {
      street: string;
      city: string;
      state: string;
      zip: string;
      lat: number | null;
      lon: number | null;
    }) => {
      setPropertyAddress(result.street);
      setCity(result.city);
      setState(result.state || "Arkansas");
      setZip(result.zip);
      setLat(result.lat);
      setLon(result.lon);
      setSelectedPropertyId(null);
      setErrors((p) => ({
        ...p,
        property_address: "",
        property_city: "",
        property_zip: "",
      }));
    },
    [],
  );

  const [jobType, setJobType] = useState("");
  const [leadSource, setLeadSource] = useState(fromClientProfile ? "repeat_client" : "");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [prefillReady, setPrefillReady] = useState(!fromClientProfile);

  const propertySetters = useMemo(
    () => ({
      setPropertyAddress,
      setCity,
      setState,
      setZip,
      setLat,
      setLon,
    }),
    [],
  );

  // Pre-fill from client profile (repeat client shortcut).
  useEffect(() => {
    if (!fromClientProfile || !prefilledClientData || prefillReady) return;

    const { client, properties } = prefilledClientData;
    setSelected(client);
    setLeadSource("repeat_client");
    setNewClient((p) => ({ ...p, company_name: client.company_name ?? "" }));

    const pick =
      (propertyIdParam && properties.find((p) => p.id === propertyIdParam)) ??
      (properties.length === 1 ? properties[0] : null);

    if (pick) {
      setSelectedPropertyId(pick.id);
      applyProperty(pick, propertySetters);
    } else if (properties.length === 0 && client.mailing_address) {
      applyProperty(
        {
          address: client.mailing_address,
          city: client.mailing_city ?? "",
          state: client.mailing_state ?? "Arkansas",
          zip: client.mailing_zip ?? "",
        },
        propertySetters,
      );
    }

    setPrefillReady(true);
  }, [fromClientProfile, prefilledClientData, prefillReady, propertyIdParam, propertySetters]);

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

  const clientProperties = prefilledClientData?.properties ?? [];

  const selectProperty = (p: Property) => {
    setSelectedPropertyId(p.id);
    applyProperty(p, propertySetters);
    setErrors((prev) => ({
      ...prev,
      property_address: "",
      property_city: "",
      property_zip: "",
    }));
  };

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
    if (fromClientProfile && clientProperties.length > 1 && !selectedPropertyId && !propertyAddress.trim()) {
      e.property = "Select a property or enter an address";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      let clientId = selected?.id;

      if (showNewClient) {
        const res = await api.post<{ client?: Client }>("/api/clients?force=true", {
          first_name: newClient.first_name,
          last_name: newClient.last_name,
          company_name: newClient.company_name || null,
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
        lat,
        lon,
        job_type: jobType,
        lead_source: leadSource,
        notes,
      });

      if (autostart) {
        const estRes = await api.post<{ estimate: { request_id: string | null } }>("/api/estimates", {
          estimate_request_id: res.request.id,
        });
        const requestId = estRes.estimate.request_id ?? res.request.id;
        toast.push("success", "Estimate opened");
        go(`/estimating/${requestId}/estimate`);
        return;
      }

      toast.push("success", "Estimate request created");
      go(`/estimating/${res.request.id}`);
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (fromClientProfile && (prefilledLoading || !prefillReady)) {
    return <Spinner center />;
  }

  const cancelTo = fromClientProfile && clientIdParam ? `/clients/${clientIdParam}` : "/estimating";

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">
            {fromClientProfile && selected ? `New Estimate — ${selected.name}` : "New Estimate Request"}
          </h1>
          <p class="view-subtitle">
            {fromClientProfile
              ? "Repeat client — property and contact are pre-filled. Pick the job type and go."
              : "Capture a new lead and start it in the pipeline."}
          </p>
        </div>
        <div class="view-header__right">
          <Button variant="tertiary" onClick={() => go(cancelTo)}>
            {fromClientProfile ? "← Client" : "← Pipeline"}
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
                    {selected.company_name && (
                      <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                        {selected.company_name}
                      </div>
                    )}
                    <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                      {formatPhone(selected.phone)} · {selected.email ?? "—"}
                    </div>
                  </div>
                  {!fromClientProfile && (
                    <Button size="sm" variant="secondary" onClick={() => setSelected(null)}>
                      Change
                    </Button>
                  )}
                  {fromClientProfile && clientIdParam && (
                    <Button size="sm" variant="tertiary" onClick={() => go(`/clients/${clientIdParam}`)}>
                      View profile
                    </Button>
                  )}
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
                            setNewClient((p) => ({ ...p, company_name: c.company_name ?? "" }));
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
              {!selected && !fromClientProfile && (
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
              <FormField
                label="Company name"
                inputProps={{
                  value: newClient.company_name,
                  placeholder: "Optional",
                  onInput: (e) =>
                    setNewClient((p) => ({ ...p, company_name: (e.target as HTMLInputElement).value })),
                }}
              />
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
          {fromClientProfile && clientProperties.length > 1 && (
            <FormField label="Saved properties" error={errors.property}>
              <div class="stack" style={{ gap: "var(--space-xs)" }}>
                {clientProperties.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    class={`typeahead__item${selectedPropertyId === p.id ? " typeahead__item--active" : ""}`}
                    style={{ textAlign: "left", width: "100%" }}
                    onClick={() => selectProperty(p)}
                  >
                    <strong>{p.address}</strong>
                    <span class="text--muted">
                      {p.city}, {p.state} {p.zip}
                    </span>
                  </button>
                ))}
              </div>
            </FormField>
          )}

          <FormField label="Property address" required error={errors.property_address}>
            <AddressAutocomplete
              initialValue={propertyAddress}
              onInputChange={(v) => {
                setPropertyAddress(v);
                if (selectedPropertyId) setSelectedPropertyId(null);
              }}
              error={!!errors.property_address}
              onSelect={handleAddressSelect}
            />
          </FormField>
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
          <Button variant="secondary" onClick={() => go(cancelTo)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={submitting}>
            {submitting
              ? "Creating…"
              : autostart
                ? "Create & Open Estimate"
                : "Create Request"}
          </Button>
        </div>
      </div>
    </div>
  );
}
