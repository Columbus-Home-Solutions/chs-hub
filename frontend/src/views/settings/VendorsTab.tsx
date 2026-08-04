/**
 * Vendors & Subscriptions — Owner Settings tab.
 * Cost/renewal tracker seeded from the Platform Operations Guide.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { api, ApiError } from "../../api";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { FormField } from "../../components/ui/FormField";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { Spinner } from "../../components/ui/Spinner";
import { formatCurrency, formatDate } from "../../lib/format";
import { useToast } from "../../store/toast";
import { daysUntilExpiration } from "../subcontractors/SubcontractorList";

interface VendorSubscription {
  id: string;
  service_name: string;
  category: string;
  cost_amount: number | null;
  cost_period: string | null;
  currency: string;
  renewal_date: string | null;
  auto_renews: boolean;
  account_email: string | null;
  account_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  support_notes: string | null;
  is_active: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  infrastructure: "Infrastructure",
  communications: "Communications",
  documents: "Documents",
  payments: "Payments",
  accounting: "Accounting",
  ai_cloud: "AI / Cloud",
  marketing_crm: "Marketing / CRM",
  development: "Development",
};

const PERIOD_LABELS: Record<string, string> = {
  monthly: "/mo",
  annual: "/yr",
  usage_based: "usage",
  one_time: "one-time",
};

function formatCost(s: VendorSubscription): string {
  if (s.cost_period === "usage_based") return "Usage-based";
  if (s.cost_amount == null) return "—";
  const money = formatCurrency(s.cost_amount);
  const suffix = s.cost_period ? PERIOD_LABELS[s.cost_period] ?? "" : "";
  return suffix ? `${money}${suffix}` : money;
}

function RenewalCell({ date }: { date: string | null }) {
  if (!date) return <span class="text--muted">—</span>;
  const days = daysUntilExpiration(date);
  if (days === null) return <span>{formatDate(date)}</span>;
  if (days < 0) {
    return (
      <span class="flex items-center gap-xs">
        {formatDate(date)} <Badge tone="error">Past due</Badge>
      </span>
    );
  }
  if (days <= 30) {
    return (
      <span class="flex items-center gap-xs">
        {formatDate(date)} <Badge tone="warning">{days}d</Badge>
      </span>
    );
  }
  return <span>{formatDate(date)}</span>;
}

function contactLabel(s: VendorSubscription): string {
  if (s.contact_name) return s.contact_name;
  if (s.account_email) return s.account_email;
  return "—";
}

type FormState = {
  service_name: string;
  category: string;
  cost_amount: string;
  cost_period: string;
  renewal_date: string;
  auto_renews: boolean;
  account_email: string;
  account_id: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  support_notes: string;
};

function emptyForm(categories: string[]): FormState {
  return {
    service_name: "",
    category: categories[0] ?? "infrastructure",
    cost_amount: "",
    cost_period: "monthly",
    renewal_date: "",
    auto_renews: true,
    account_email: "tony@homesolutionsar.com",
    account_id: "",
    contact_name: "",
    contact_email: "",
    contact_phone: "",
    support_notes: "",
  };
}

function fromSub(s: VendorSubscription): FormState {
  return {
    service_name: s.service_name,
    category: s.category,
    cost_amount: s.cost_amount == null ? "" : String(s.cost_amount),
    cost_period: s.cost_period ?? "",
    renewal_date: s.renewal_date?.slice(0, 10) ?? "",
    auto_renews: s.auto_renews,
    account_email: s.account_email ?? "",
    account_id: s.account_id ?? "",
    contact_name: s.contact_name ?? "",
    contact_email: s.contact_email ?? "",
    contact_phone: s.contact_phone ?? "",
    support_notes: s.support_notes ?? "",
  };
}

export function VendorsTab() {
  const toast = useToast();
  const [rows, setRows] = useState<VendorSubscription[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCat, setFilterCat] = useState("all");
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [editing, setEditing] = useState<VendorSubscription | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm([]));
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{
        subscriptions: VendorSubscription[];
        categories: string[];
      }>("/api/vendor-subscriptions");
      setRows(r.subscriptions);
      setCategories(r.categories);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Failed to load vendors");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    if (filterCat === "all") return rows;
    return rows.filter((r) => r.category === filterCat);
  }, [rows, filterCat]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm(categories));
    setModal("create");
  };

  const openEdit = (s: VendorSubscription) => {
    setEditing(s);
    setForm(fromSub(s));
    setModal("edit");
  };

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    if (!form.service_name.trim()) {
      toast.push("error", "Service name is required");
      return;
    }
    setSaving(true);
    const payload = {
      service_name: form.service_name.trim(),
      category: form.category,
      cost_amount: form.cost_amount === "" ? null : Number(form.cost_amount),
      cost_period: form.cost_period || null,
      renewal_date: form.renewal_date || null,
      auto_renews: form.auto_renews,
      account_email: form.account_email || null,
      account_id: form.account_id || null,
      contact_name: form.contact_name || null,
      contact_email: form.contact_email || null,
      contact_phone: form.contact_phone || null,
      support_notes: form.support_notes || null,
    };
    try {
      if (modal === "create") {
        await api.post("/api/vendor-subscriptions", payload);
        toast.push("success", "Service added");
      } else if (editing) {
        await api.put(`/api/vendor-subscriptions/${editing.id}`, payload);
        toast.push("success", "Service updated");
      }
      setModal(null);
      await load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (s: VendorSubscription) => {
    if (!confirm(`Deactivate ${s.service_name}? It will be hidden from the list.`)) return;
    try {
      await api.del(`/api/vendor-subscriptions/${s.id}`);
      toast.push("success", "Service deactivated");
      await load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Deactivate failed");
    }
  };

  if (loading) return <Spinner center />;

  return (
    <Card
      title="Vendors & Subscriptions"
      actions={
        <Button variant="primary" size="sm" onClick={openCreate}>
          + Add Service
        </Button>
      }
    >
      <p class="text--muted mb-md" style={{ fontSize: "var(--text-sm)" }}>
        Manual cost and renewal tracker — not connected to billing APIs. Renewals also appear on the
        calendar iCal feed.
      </p>

      <div class="flex gap-sm items-center mb-md">
        <Select
          value={filterCat}
          onChange={setFilterCat}
          options={[
            { value: "all", label: "All categories" },
            ...categories.map((c) => ({
              value: c,
              label: CATEGORY_LABELS[c] ?? c,
            })),
          ]}
        />
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {filtered.length} service{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Category</th>
              <th>Cost</th>
              <th>Renewal</th>
              <th>Auto-renew</th>
              <th>Contact</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} class="text--muted">
                  No services yet.
                </td>
              </tr>
            ) : (
              filtered.map((s) => (
                <tr
                  key={s.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => openEdit(s)}
                >
                  <td>
                    <strong>{s.service_name}</strong>
                  </td>
                  <td>{CATEGORY_LABELS[s.category] ?? s.category}</td>
                  <td>{formatCost(s)}</td>
                  <td>
                    <RenewalCell date={s.renewal_date} />
                  </td>
                  <td>{s.auto_renews ? "Yes" : "No"}</td>
                  <td>{contactLabel(s)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={modal != null}
        title={modal === "create" ? "Add Service" : `Edit ${editing?.service_name ?? ""}`}
        onClose={() => setModal(null)}
        footer={
          <>
            {modal === "edit" && editing && (
              <Button variant="danger" onClick={() => void deactivate(editing)} disabled={saving}>
                Deactivate
              </Button>
            )}
            <Button variant="secondary" onClick={() => setModal(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div class="form-grid">
          <FormField label="Service name" required>
            <input
              class="form-input"
              value={form.service_name}
              onInput={(e) => setField("service_name", (e.target as HTMLInputElement).value)}
            />
          </FormField>
          <FormField label="Category" required>
            <Select
              value={form.category}
              onChange={(v) => setField("category", v)}
              options={categories.map((c) => ({
                value: c,
                label: CATEGORY_LABELS[c] ?? c,
              }))}
            />
          </FormField>
          <FormField label="Cost amount">
            <input
              class="form-input"
              type="number"
              step="0.01"
              min="0"
              value={form.cost_amount}
              onInput={(e) => setField("cost_amount", (e.target as HTMLInputElement).value)}
              placeholder="Leave blank if usage-based"
            />
          </FormField>
          <FormField label="Cost period">
            <Select
              value={form.cost_period}
              onChange={(v) => setField("cost_period", v)}
              options={[
                { value: "", label: "—" },
                { value: "monthly", label: "Monthly" },
                { value: "annual", label: "Annual" },
                { value: "usage_based", label: "Usage-based" },
                { value: "one_time", label: "One-time" },
              ]}
            />
          </FormField>
          <FormField label="Renewal date">
            <input
              class="form-input"
              type="date"
              value={form.renewal_date}
              onInput={(e) => setField("renewal_date", (e.target as HTMLInputElement).value)}
            />
          </FormField>
          <FormField label="Auto-renews">
            <label class="flex items-center gap-sm">
              <input
                type="checkbox"
                checked={form.auto_renews}
                onChange={(e) => setField("auto_renews", (e.target as HTMLInputElement).checked)}
              />
              Renews automatically
            </label>
          </FormField>
          <FormField label="Account email">
            <input
              class="form-input"
              type="email"
              value={form.account_email}
              onInput={(e) => setField("account_email", (e.target as HTMLInputElement).value)}
            />
          </FormField>
          <FormField label="Account ID">
            <input
              class="form-input"
              value={form.account_id}
              onInput={(e) => setField("account_id", (e.target as HTMLInputElement).value)}
            />
          </FormField>
          <FormField label="Contact name">
            <input
              class="form-input"
              value={form.contact_name}
              onInput={(e) => setField("contact_name", (e.target as HTMLInputElement).value)}
            />
          </FormField>
          <FormField label="Contact email">
            <input
              class="form-input"
              type="email"
              value={form.contact_email}
              onInput={(e) => setField("contact_email", (e.target as HTMLInputElement).value)}
            />
          </FormField>
          <FormField label="Contact phone">
            <input
              class="form-input"
              value={form.contact_phone}
              onInput={(e) => setField("contact_phone", (e.target as HTMLInputElement).value)}
            />
          </FormField>
          <FormField label="Support notes">
            <textarea
              class="form-input"
              rows={3}
              value={form.support_notes}
              onInput={(e) => setField("support_notes", (e.target as HTMLTextAreaElement).value)}
            />
          </FormField>
        </div>
      </Modal>
    </Card>
  );
}
