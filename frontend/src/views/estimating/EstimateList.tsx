import type { RoutableProps } from "preact-router";
import { useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { useUrlTab } from "../../hooks/useUrlTab";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Button } from "../../components/ui/Button";
import { go } from "../../lib/nav";
import { truncate, useClientSort } from "../../lib/list-view";
import { formatDate, formatStatus } from "../../lib/format";

interface EstimateRow {
  id: string;
  estimate_number: number | null;
  request_id: string | null;
  client_name: string | null;
  title: string | null;
  status: string | null;
  total: number;
  sent_at: string | null;
  viewed_date: string | null;
  signed_date: string | null;
  created_at: string;
}

interface EstimateListResponse {
  as_of: string;
  total: number;
  estimates: EstimateRow[];
}

/** Active / All — same pill pattern as Clients (`filter-pill` + useUrlTab). */
const VIEW_FILTERS = [
  { key: "active", label: "Active" },
  { key: "all", label: "All" },
] as const;

/**
 * Terminal / resolved estimate statuses — hidden in the default Active view.
 * - approved = deposit paid / converted (business “Won”)
 * - won/lost = rare literals if ever written on estimates
 * - expired / revised / archived = no longer actionable
 * Active keeps: draft, sent, viewed, signed (+ any other non-terminal).
 */
const TERMINAL_STATUSES = new Set([
  "approved",
  "won",
  "lost",
  "expired",
  "revised",
  "archived",
]);

/** Stage dropdown (secondary). Empty = no stage narrowing within Active/All. */
const STAGE_OPTIONS = [
  { value: "", label: "Any stage" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "viewed", label: "Viewed" },
  { value: "signed", label: "Signed" },
  { value: "approved", label: "Approved (Won)" },
  { value: "revised", label: "Revised" },
  { value: "expired", label: "Expired" },
  { value: "lost", label: "Lost" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number): string {
  return `${Math.round(n)}%`;
}

// ─── Summary bar ─────────────────────────────────────────────────────────────

interface SummaryStats {
  draftCount: number;
  awaitingCount: number;
  approvedCount: number;
  lostCount: number;
  sentRecentCount: number;
  sentRecentValue: number;
  convertedRecentCount: number;
  convertedRecentValue: number;
  convRate: number;
  convRatePrior: number;
  hasPriorData: boolean;
}

function computeStats(estimates: EstimateRow[]): SummaryStats {
  const now = Date.now();
  const ms30 = 30 * 24 * 60 * 60 * 1000;

  const draftCount = estimates.filter(
    (e) => e.status === "draft" || e.status === "building" || e.status === "revised",
  ).length;
  const awaitingCount = estimates.filter(
    (e) => e.status === "sent" || e.status === "follow_up",
  ).length;
  const approvedCount = estimates.filter(
    (e) => e.status === "won" || e.status === "approved",
  ).length;
  const lostCount = estimates.filter((e) => e.status === "lost").length;

  // 30-day windows keyed on sent_at
  const sentRecent = estimates.filter(
    (e) => e.sent_at && now - new Date(e.sent_at).getTime() <= ms30,
  );
  const sentPrior = estimates.filter((e) => {
    if (!e.sent_at) return false;
    const age = now - new Date(e.sent_at).getTime();
    return age > ms30 && age <= 2 * ms30;
  });

  const convertedRecent = sentRecent.filter(
    (e) => e.status === "won" || e.status === "approved",
  );
  const convertedPrior = sentPrior.filter(
    (e) => e.status === "won" || e.status === "approved",
  );

  const sentRecentCount = sentRecent.length;
  const sentRecentValue = sentRecent.reduce((s, e) => s + (e.total ?? 0), 0);
  const convertedRecentCount = convertedRecent.length;
  const convertedRecentValue = convertedRecent.reduce((s, e) => s + (e.total ?? 0), 0);

  const convRate = sentRecentCount > 0 ? (convertedRecentCount / sentRecentCount) * 100 : 0;
  const convRatePrior =
    sentPrior.length > 0 ? (convertedPrior.length / sentPrior.length) * 100 : 0;

  return {
    draftCount,
    awaitingCount,
    approvedCount,
    lostCount,
    sentRecentCount,
    sentRecentValue,
    convertedRecentCount,
    convertedRecentValue,
    convRate,
    convRatePrior,
    hasPriorData: sentPrior.length > 0,
  };
}

// Dot color matching badge colors from components.css
const DOT_COLORS: Record<string, string> = {
  draft: "var(--color-text-muted)",
  awaiting: "var(--color-warning)",
  approved: "var(--color-success)",
  lost: "var(--color-error)",
};

function LegendDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        background: color,
        marginRight: "6px",
        flexShrink: 0,
      }}
    />
  );
}

function EstimateSummaryBar({ estimates }: { estimates: EstimateRow[] }) {
  const s = useMemo(() => computeStats(estimates), [estimates]);

  const convDelta = s.convRate - s.convRatePrior;
  const convDir = convDelta > 0 ? "up" : convDelta < 0 ? "down" : null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: "var(--space-md)",
        marginBottom: "var(--space-lg)",
      }}
    >
      {/* Overview */}
      <div class="kpi-tile" style={{ cursor: "default" }}>
        <span class="kpi-tile__label">Overview</span>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" }}>
          <span style={{ display: "flex", alignItems: "center", fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>
            <LegendDot color={DOT_COLORS.draft} />
            Draft / Building: <strong style={{ marginLeft: "4px" }}>{s.draftCount}</strong>
          </span>
          <span style={{ display: "flex", alignItems: "center", fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>
            <LegendDot color={DOT_COLORS.awaiting} />
            Awaiting Response: <strong style={{ marginLeft: "4px" }}>{s.awaitingCount}</strong>
          </span>
          <span style={{ display: "flex", alignItems: "center", fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>
            <LegendDot color={DOT_COLORS.approved} />
            Approved / Won: <strong style={{ marginLeft: "4px" }}>{s.approvedCount}</strong>
          </span>
          <span style={{ display: "flex", alignItems: "center", fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>
            <LegendDot color={DOT_COLORS.lost} />
            Lost: <strong style={{ marginLeft: "4px" }}>{s.lostCount}</strong>
          </span>
        </div>
      </div>

      {/* Conversion Rate */}
      <div class="kpi-tile" style={{ cursor: "default" }}>
        <span class="kpi-tile__label">Conversion Rate</span>
        <span class="kpi-tile__value">
          {fmtPct(s.convRate)}
          {s.hasPriorData && convDir === "up" && (
            <span class="kpi-tile__delta kpi-tile__delta--up"> ↑{fmtPct(Math.abs(convDelta))}</span>
          )}
          {s.hasPriorData && convDir === "down" && (
            <span class="kpi-tile__delta kpi-tile__delta--down"> ↓{fmtPct(Math.abs(convDelta))}</span>
          )}
        </span>
        <span class="kpi-tile__subtitle">
          {s.sentRecentCount > 0
            ? `${s.convertedRecentCount} of ${s.sentRecentCount} sent · last 30 days`
            : "No estimates sent in 30 days"}
        </span>
      </div>

      {/* Sent */}
      <div class="kpi-tile" style={{ cursor: "default" }}>
        <span class="kpi-tile__label">Sent (30 days)</span>
        <span class="kpi-tile__value">{s.sentRecentCount}</span>
        <span class="kpi-tile__subtitle">{fmtK(s.sentRecentValue)} total value</span>
      </div>

      {/* Converted */}
      <div class="kpi-tile" style={{ cursor: "default" }}>
        <span class="kpi-tile__label">Converted (30 days)</span>
        <span class="kpi-tile__value">{s.convertedRecentCount}</span>
        <span class="kpi-tile__subtitle">{fmtK(s.convertedRecentValue)} total value</span>
      </div>
    </div>
  );
}

// ─── Sort header ─────────────────────────────────────────────────────────────

function SortTh({
  label,
  col,
  active,
  dir,
  onSort,
}: {
  label: string;
  col: string;
  active: string;
  dir: "asc" | "desc";
  onSort: (col: string) => void;
}) {
  return (
    <th>
      <button type="button" class="data-table__sort" onClick={() => onSort(col)}>
        {label}
        {active === col ? (dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
}

// ─── Main view ───────────────────────────────────────────────────────────────

export function EstimateList(_props: RoutableProps) {
  const [viewFilter, setViewFilter] = useUrlTab(
    VIEW_FILTERS.map((f) => f.key),
    "active",
    "filter",
  );
  const [stageFilter, setStageFilter] = useState("");
  const [search, setSearch] = useState("");

  // Always fetch all estimates unfiltered — summary bar needs the full set,
  // and Active/All + stage + search filtering is applied client-side.
  const { data, loading, error } = useApi<EstimateListResponse>("/api/estimates");

  const allEstimates = useMemo(() => data?.estimates ?? [], [data]);

  const filtered = useMemo(() => {
    let rows = allEstimates;
    if (viewFilter === "active") {
      rows = rows.filter((e) => !TERMINAL_STATUSES.has(e.status ?? ""));
    }
    if (stageFilter) rows = rows.filter((e) => e.status === stageFilter);
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((e) => {
      const hay = [
        e.estimate_number != null ? `est-${e.estimate_number}` : "",
        e.client_name ?? "",
        e.title ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [allEstimates, viewFilter, stageFilter, search]);

  const { sorted, sortKey, sortDir, toggle } = useClientSort(filtered, "created_at", "desc");

  function navToEstimate(row: EstimateRow) {
    if (row.request_id) {
      go(`/estimating/${row.request_id}/estimate`);
    } else {
      go(`/estimates/${row.id}`);
    }
  }

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Estimates</h1>
          <p class="view-subtitle">
            {data
              ? `${filtered.length} estimate${filtered.length !== 1 ? "s" : ""}${
                  viewFilter === "active" ? " · active" : ""
                }`
              : "All estimates"}
          </p>
        </div>
      </div>

      {/* Summary bar — always computed from full unfiltered set */}
      {!loading && !error && <EstimateSummaryBar estimates={allEstimates} />}

      <div class="filters">
        {VIEW_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            class={`filter-pill${viewFilter === f.key ? " filter-pill--active" : ""}`}
            onClick={() => setViewFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Search + stage filter */}
      <div
        style={{
          display: "flex",
          gap: "var(--space-md)",
          marginBottom: "var(--space-md)",
          flexWrap: "wrap",
        }}
      >
        <input
          class="form-input"
          type="search"
          placeholder="Search by estimate #, client, or description…"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          style={{ maxWidth: "320px" }}
        />
        <select
          class="form-select"
          value={stageFilter}
          onChange={(e) => setStageFilter((e.target as HTMLSelectElement).value)}
          style={{ maxWidth: "180px" }}
        >
          {STAGE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {loading && <Spinner center />}
      {error && <div class="empty-state">Couldn't load estimates: {error}</div>}

      {!loading && !error && (
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <SortTh
                  label="Est #"
                  col="estimate_number"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggle}
                />
                <SortTh
                  label="Client"
                  col="client_name"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggle}
                />
                <SortTh
                  label="Description"
                  col="title"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggle}
                />
                <SortTh
                  label="Total"
                  col="total"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggle}
                />
                <SortTh
                  label="Status"
                  col="status"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggle}
                />
                <SortTh
                  label="Created"
                  col="created_at"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggle}
                />
                <SortTh
                  label="Sent"
                  col="sent_at"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggle}
                />
                <SortTh
                  label="Viewed"
                  col="viewed_date"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggle}
                />
                <SortTh
                  label="Accepted"
                  col="signed_date"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggle}
                />
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={10} class="text--muted">
                    No estimates match this filter.
                  </td>
                </tr>
              )}
              {sorted.map((e) => (
                <tr key={e.id}>
                  <td>
                    <button
                      type="button"
                      class="link-btn"
                      onClick={() => navToEstimate(e)}
                    >
                      {e.estimate_number != null
                        ? `EST-${String(e.estimate_number).padStart(3, "0")}`
                        : "—"}
                    </button>
                  </td>
                  <td>{e.client_name ?? "—"}</td>
                  <td>{truncate(e.title)}</td>
                  <td>{e.total != null ? `$${e.total.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : "—"}</td>
                  <td>
                    <Badge status={e.status ?? ""}>{formatStatus(e.status)}</Badge>
                  </td>
                  <td>{formatDate(e.created_at)}</td>
                  <td>{e.sent_at ? formatDate(e.sent_at) : "—"}</td>
                  <td>{e.viewed_date ? formatDate(e.viewed_date) : "—"}</td>
                  <td>{e.signed_date ? formatDate(e.signed_date) : "—"}</td>
                  <td>
                    <Button size="sm" variant="tertiary" onClick={() => navToEstimate(e)}>
                      View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
