import type { RoutableProps } from "preact-router";
import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { useAuth } from "../../store/auth";
import { api, ApiError } from "../../api";

interface QboStatus {
  connected: boolean;
  status: string;
  environment: string | null;
  realm_id: string | null;
  company_name: string | null;
  last_sync: string | null;
  last_error: string | null;
  counts: {
    invoices: { synced: number; pending: number };
    payments: { synced: number; pending: number };
    expenses: { synced: number; pending: number };
    dlq_open: number;
  };
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

export function Integrations(_props: RoutableProps) {
  const { user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<QboStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [paymentSyncEnabled, setPaymentSyncEnabled] = useState(false);
  const [paymentSyncBusy, setPaymentSyncBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [qbo, settings] = await Promise.all([
        api.get<QboStatus>("/api/quickbooks/status"),
        api.get<{ settings: Array<{ key: string; value: string }> }>("/api/settings"),
      ]);
      setStatus(qbo);
      const flag = settings.settings?.find((s) => s.key === "qbo_payment_sync_enabled");
      setPaymentSyncEnabled((flag?.value ?? "false").toLowerCase() === "true");
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const togglePaymentSync = async () => {
    const next = !paymentSyncEnabled;
    if (
      next &&
      !confirm(
        "Enable pushing payments to QuickBooks?\n\nOnly turn this on once real CHS jobs (not Jobber history) are flowing. Historical imports must stay out of QBO.",
      )
    ) {
      return;
    }
    setPaymentSyncBusy(true);
    try {
      await api.put(`/api/settings/${encodeURIComponent("qbo_payment_sync_enabled")}`, {
        value: next,
      });
      setPaymentSyncEnabled(next);
      toast.push("success", next ? "Payment push enabled" : "Payment push disabled");
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setPaymentSyncBusy(false);
    }
  };

  if (user && user.role !== "owner") {
    return <div class="empty-state">Integrations are owner-only.</div>;
  }

  const connect = async () => {
    setBusy("connect");
    try {
      const { authorize_url } = await api.post<{ authorize_url: string }>(
        "/api/integrations/quickbooks/connect",
      );
      window.location.href = authorize_url;
    } catch (e) {
      toast.push("error", errMsg(e));
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    try {
      await api.post("/api/integrations/quickbooks/disconnect");
      toast.push("success", "QuickBooks disconnected");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const r = await api.post<{
        ok: boolean;
        company_name?: string;
        error?: string;
        api_host?: string;
        realm_id?: string;
        intuit_tid?: string | null;
        refreshed?: boolean;
        jwt_realmid?: string | null;
        realm_matches_jwt?: boolean | null;
        alternate_host?: { host: string; http_status: number; ok: boolean } | null;
      }>("/api/integrations/quickbooks/test");
      toast.push("success", `Connection OK${r.company_name ? ` — ${r.company_name}` : ""}`);
      void load();
    } catch (e) {
      const body =
        e instanceof ApiError && e.body && typeof e.body === "object"
          ? (e.body as Record<string, unknown>)
          : null;
      if (body) {
        const alt = body.alternate_host as
          | { host?: string; http_status?: number; ok?: boolean }
          | null
          | undefined;
        const bits = [
          String(body.error ?? (e instanceof ApiError ? e.message : "Test failed")),
          body.api_host ? `host=${body.api_host}` : null,
          body.realm_id ? `realm=${body.realm_id}` : null,
          body.intuit_tid ? `tid=${body.intuit_tid}` : null,
          body.jwt_realmid != null ? `jwt_realm=${body.jwt_realmid}` : null,
          body.realm_matches_jwt === false ? "REALM MISMATCH vs JWT" : null,
          body.refreshed === true ? "refreshed=yes" : body.refreshed === false ? "refreshed=no" : null,
          alt?.host ? `alt=${alt.host}:${alt.http_status}` : null,
        ].filter(Boolean);
        toast.push("error", bits.join(" · "));
        console.error("[qbo test probe]", body);
      } else {
        toast.push("error", errMsg(e));
      }
      void load();
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setBusy("sync");
    try {
      const r = await api.post<{ ran: boolean; reason?: string }>("/api/quickbooks/sync");
      if (r.ran) toast.push("success", "QBO sync sweep complete");
      else toast.push("warning", `Sweep skipped: ${r.reason ?? "not connected"}`);
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const statusTone = (s: string): "success" | "warning" | "error" | "neutral" => {
    if (s === "connected") return "success";
    if (s === "error") return "error";
    if (s === "disconnected") return "neutral";
    return "warning";
  };

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Integrations</h1>
          <p class="view-subtitle">Connect external systems. QuickBooks is sandbox-only this release.</p>
        </div>
      </div>

      {loading && <Spinner center />}

      {!loading && status && (
        <Card
          title="QuickBooks Online"
          actions={<Badge tone={statusTone(status.status)}>{status.status}</Badge>}
        >
          {status.status === "error" && (
            <div class="alert alert--error" style={{ marginBottom: "var(--space-md)" }}>
              <strong>Reconnect required.</strong> {status.last_error ?? "The QuickBooks connection needs re-authorization."}
              <div class="mt-sm">
                <Button size="sm" variant="primary" disabled={busy !== null} onClick={connect}>
                  Reconnect QuickBooks
                </Button>
              </div>
            </div>
          )}

          {status.connected && (
            <div class="kv" style={{ marginBottom: "var(--space-md)" }}>
              <div class="kv__row">
                <span class="kv__label">Company</span>
                <span class="kv__value">{status.company_name ?? "—"}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Environment</span>
                <span class="kv__value">{status.environment ?? "sandbox"}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Realm ID</span>
                <span class="kv__value text--mono">{status.realm_id ?? "—"}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Last sweep</span>
                <span class="kv__value">{status.last_sync ?? "never"}</span>
              </div>
            </div>
          )}

          <div class="flex gap-sm">
            {!status.connected && status.status !== "error" && (
              <Button variant="primary" disabled={busy !== null} onClick={connect}>
                {busy === "connect" ? "Redirecting…" : "Connect QuickBooks"}
              </Button>
            )}
            {status.connected && (
              <>
                <Button variant="secondary" disabled={busy !== null} onClick={test}>
                  Test Connection
                </Button>
                <Button variant="secondary" disabled={busy !== null} onClick={() => setMappingOpen(true)}>
                  Category Mapping
                </Button>
                <Button variant="primary" disabled={busy !== null} onClick={syncNow}>
                  {busy === "sync" ? "Syncing…" : "Sync now"}
                </Button>
                <Button variant="danger" disabled={busy !== null} onClick={disconnect}>
                  Disconnect
                </Button>
              </>
            )}
          </div>

          <div
            class="mt-md"
            style={{
              marginTop: "var(--space-md)",
              paddingTop: "var(--space-md)",
              borderTop: "1px solid var(--border-color, #e5e5e5)",
            }}
          >
            <label class="flex items-center gap-sm" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={paymentSyncEnabled}
                disabled={paymentSyncBusy}
                onChange={() => void togglePaymentSync()}
              />
              <span>
                <strong>Push payments to QuickBooks</strong>
                <span class="text--muted" style={{ display: "block", fontSize: "var(--text-sm)" }}>
                  Keep off until real jobs are running through CHS. Prevents historical Jobber
                  imports from inflating QBO income.
                </span>
              </span>
            </label>
          </div>
        </Card>
      )}

      {!loading && status?.connected && (
        <>
          <div class="mt-lg" />
          <Card title="Sync status">
            <div class="kv">
              <SyncRow label="Invoices" c={status.counts.invoices} />
              <SyncRow label="Payments" c={status.counts.payments} />
              <SyncRow label="Expenses" c={status.counts.expenses} />
              <div class="kv__row">
                <span class="kv__label">Failed (DLQ open)</span>
                <span class="kv__value">
                  {status.counts.dlq_open > 0 ? (
                    <Badge tone="error">{status.counts.dlq_open}</Badge>
                  ) : (
                    <Badge tone="success">0</Badge>
                  )}
                </span>
              </div>
            </div>
          </Card>
        </>
      )}

      {mappingOpen && status?.connected && (
        <MappingModal onClose={() => setMappingOpen(false)} onSaved={() => { setMappingOpen(false); void load(); }} />
      )}
    </div>
  );
}

function SyncRow({ label, c }: { label: string; c: { synced: number; pending: number } }) {
  return (
    <div class="kv__row">
      <span class="kv__label">{label}</span>
      <span class="kv__value">
        <Badge tone="success">{c.synced} synced</Badge>{" "}
        <Badge tone={c.pending > 0 ? "warning" : "neutral"}>{c.pending} pending</Badge>
      </span>
    </div>
  );
}

// ─── Reference mapping modal ───────────────────────────────────────────────

interface QboRef {
  id: string;
  name: string;
  type?: string;
}
interface MatchSuggestion {
  chs_id: string;
  chs_name: string;
  qbo_id: string | null;
  qbo_name: string | null;
  matched: boolean;
}
interface ReferenceResponse {
  accounts: QboRef[];
  all_customers: QboRef[];
  all_vendors: QboRef[];
  clients: MatchSuggestion[];
  vendors: MatchSuggestion[];
  expense_types: string[];
  account_map: Record<string, string>;
  payment_account_ref: string | null;
  subcontractor_payment_account_ref?: string | null;
  default_customer_id?: string | null;
  default_customer_name?: string | null;
}

function MappingModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [ref, setRef] = useState<ReferenceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [clients, setClients] = useState<Record<string, string>>({});
  const [vendors, setVendors] = useState<Record<string, string>>({});
  const [accountMap, setAccountMap] = useState<Record<string, string>>({});
  const [paymentAccount, setPaymentAccount] = useState("");
  const [subPaymentAccount, setSubPaymentAccount] = useState("");
  const [expenseTypes, setExpenseTypes] = useState<string[]>([]);
  const [defaultCustomerId, setDefaultCustomerId] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.get<ReferenceResponse>("/api/integrations/quickbooks/reference");
        setRef(r);
        setAccountMap(r.account_map ?? {});
        setPaymentAccount(r.payment_account_ref ?? "");
        setSubPaymentAccount(r.subcontractor_payment_account_ref ?? "");
        setDefaultCustomerId(r.default_customer_id ?? "");
        const cm: Record<string, string> = {};
        for (const c of r.clients) if (c.qbo_id) cm[c.chs_id] = c.qbo_id;
        setClients(cm);
        const vm: Record<string, string> = {};
        for (const v of r.vendors) if (v.qbo_id) vm[v.chs_id] = v.qbo_id;
        setVendors(vm);
        setExpenseTypes(r.expense_types ?? []);
      } catch (e) {
        toast.push("error", errMsg(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const selected = (ref?.all_customers ?? []).find((c) => c.id === defaultCustomerId);
      await api.put("/api/integrations/quickbooks/default-customer", {
        qbo_customer_id: defaultCustomerId || null,
        qbo_customer_name: selected?.name ?? null,
      });
      await api.post("/api/integrations/quickbooks/mapping", {
        clients,
        vendors,
        account_map: accountMap,
        payment_account_ref: paymentAccount || null,
        subcontractor_payment_account_ref: subPaymentAccount || null,
      });
      toast.push("success", "Mapping saved");
      onSaved();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const accountOpts = (ref?.accounts ?? []).map((a) => ({ value: a.id, label: a.name }));
  const customerList = (ref?.all_customers ?? []).map((c) => ({ value: c.id, label: c.name }));
  const vendorList = (ref?.all_vendors ?? []).map((v) => ({ value: v.id, label: v.name }));

  return (
    <Modal
      open
      title="QuickBooks mapping"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={save}>Save mapping</Button>
        </>
      }
    >
      {loading ? (
        <Spinner center />
      ) : (
        <div class="stack-md">
          <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            A push never fires for a record whose required reference isn't mapped — it surfaces "needs
            mapping" instead of creating a duplicate in QuickBooks.
          </p>

          <h3 class="section-heading">Payment account (for expenses)</h3>
          <FormField label="QBO account expenses are paid from">
            <Select
              value={paymentAccount}
              options={[{ value: "", label: "— select —" }, ...accountOpts]}
              onChange={setPaymentAccount}
            />
          </FormField>
          <FormField label="Payment account for subcontractor payments (optional)">
            <Select
              value={subPaymentAccount}
              options={[
                { value: "", label: "— same as above —" },
                ...accountOpts,
              ]}
              onChange={setSubPaymentAccount}
            />
          </FormField>
          <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            Leave blank to use the same payment account for subcontractor labor. This is the bank
            account money leaves from — separate from expense-type category mapping below.
          </p>

          <h3 class="section-heading">Expense type → QBO Account</h3>
          {expenseTypes.length === 0 && (
            <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>No expense types found to map.</p>
          )}
          {expenseTypes.map((et) => (
            <FormField key={et} label={et}>
              <Select
                value={accountMap[et] ?? ""}
                options={[{ value: "", label: "— not mapped —" }, ...accountOpts]}
                onChange={(v) => setAccountMap({ ...accountMap, [et]: v })}
              />
            </FormField>
          ))}

          <h3 class="section-heading">Clients → QBO Customers</h3>
          <FormField label="Default QBO Customer (for clients without an individual mapping)">
            <Select
              value={defaultCustomerId}
              options={[{ value: "", label: "— no default —" }, ...customerList]}
              onChange={setDefaultCustomerId}
            />
          </FormField>
          <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            Clients left as "— not mapped —" below will automatically use the default customer above
            when synced to QuickBooks.
          </p>
          {(ref?.clients ?? []).map((c) => (
            <FormField key={c.chs_id} label={c.chs_name}>
              <Select
                value={clients[c.chs_id] ?? ""}
                options={[{ value: "", label: "— not mapped —" }, ...customerList]}
                onChange={(v) => setClients({ ...clients, [c.chs_id]: v })}
              />
            </FormField>
          ))}

          <h3 class="section-heading">Subcontractors → QBO Vendors</h3>
          {(ref?.vendors ?? []).map((v) => (
            <FormField key={v.chs_id} label={v.chs_name}>
              <Select
                value={vendors[v.chs_id] ?? ""}
                options={[{ value: "", label: "— not mapped —" }, ...vendorList]}
                onChange={(val) => setVendors({ ...vendors, [v.chs_id]: val })}
              />
            </FormField>
          ))}
        </div>
      )}
    </Modal>
  );
}
