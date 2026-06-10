import type { RoutableProps } from "preact-router";
import { useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Table, type Column } from "../../components/ui/Table";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { ClientForm } from "./ClientForm";
import { formatCurrency, formatDate, formatPhone } from "../../lib/format";
import { go } from "../../lib/nav";
import type { Client } from "../../types";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "past", label: "Past" },
  { key: "repeat", label: "Repeat" },
];

interface ClientListResponse {
  total: number;
  clients: Client[];
}

export function ClientList(_props: RoutableProps) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const { data, loading, error, refetch } = useApi<ClientListResponse>(
    `/api/clients?filter=${filter}`,
  );

  const rows = useMemo(() => {
    const all = data?.clients ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    const qDigits = q.replace(/\D/g, "");
    return all.filter((c) => {
      const hay = [c.name, c.company_name, c.email, c.phone, c.mailing_address, c.mailing_city]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q) || (qDigits && (c.phone ?? "").replace(/\D/g, "").includes(qDigits));
    });
  }, [data, search]);

  const columns: Column<Client>[] = [
    {
      key: "name",
      header: "Name",
      sortValue: (c) => c.name.toLowerCase(),
      render: (c) => (
        <span class="flex items-center gap-sm">
          <span>
            <strong>{c.name}</strong>
            {c.company_name && (
              <span class="text--muted" style={{ display: "block", fontSize: "var(--text-xs)" }}>
                {c.company_name}
              </span>
            )}
          </span>
          {c.is_repeat_client && <Badge tone="brand">Repeat</Badge>}
        </span>
      ),
    },
    { key: "phone", header: "Phone", render: (c) => formatPhone(c.phone) },
    { key: "email", header: "Email", render: (c) => c.email ?? "—" },
    {
      key: "total_jobs",
      header: "Jobs",
      sortValue: (c) => c.total_jobs,
      render: (c) => c.total_jobs,
    },
    {
      key: "total_revenue",
      header: "Revenue",
      sortValue: (c) => c.total_revenue,
      render: (c) => formatCurrency(c.total_revenue),
    },
    {
      key: "last_interaction_date",
      header: "Last Interaction",
      sortValue: (c) => c.last_interaction_date ?? "",
      render: (c) => formatDate(c.last_interaction_date),
    },
  ];

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Clients</h1>
          <p class="view-subtitle">{data ? `${data.total} clients` : "Client database"}</p>
        </div>
        <div class="view-header__right">
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            + New Client
          </Button>
        </div>
      </div>

      <div class="filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            class={`filter-pill${filter === f.key ? " filter-pill--active" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div class="toolbar">
        <input
          class="form-input toolbar__search"
          type="search"
          placeholder="Search name, phone, email, address…"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
      </div>

      {loading && <Spinner center />}
      {error && <div class="empty-state">Couldn't load clients: {error}</div>}
      {!loading && !error && rows.length === 0 && (
        <div class="empty-state">
          <div class="empty-state__icon">👥</div>
          <div class="empty-state__title">No clients yet</div>
          <div>Create your first client to get started.</div>
        </div>
      )}
      {!loading && !error && rows.length > 0 && (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(c) => c.id}
          onRowClick={(c) => go(`/clients/${c.id}`)}
          initialSort="name"
        />
      )}

      <ClientForm
        open={showCreate}
        mode="create"
        onClose={() => setShowCreate(false)}
        onSaved={(c) => {
          setShowCreate(false);
          refetch();
          go(`/clients/${c.id}`);
        }}
      />
    </div>
  );
}
