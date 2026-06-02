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
import { api, ApiError } from "../../api";
import { formatStatus } from "../../lib/format";

interface DocRow {
  id: string;
  title: string;
  file_type: string | null;
  file_size: number | null;
  context_type: string;
  job_id: string | null;
  document_category: string;
  is_signed: number | null;
  mirror_status: string | null;
  share_token: string | null;
  share_expiration: string | null;
  created_at: string;
}

const CATEGORIES = [
  "contract",
  "change_order",
  "permit",
  "plan_drawing",
  "receipt",
  "invoice",
  "lien_waiver",
  "insurance",
  "license",
  "sop",
  "photo_report",
  "completion_package",
  "other",
];

function fmtSize(n: number | null): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

// ─── Hub Files browser — cross-job document browse/search (Sprint 15) ──────────
export function HubFiles(_props: RoutableProps) {
  const toast = useToast();
  const [rows, setRows] = useState<DocRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [contextType, setContextType] = useState("");
  const [uploading, setUploading] = useState(false);

  const load = async () => {
    setRows(null);
    const qs = new URLSearchParams();
    if (search.trim()) qs.set("search", search.trim());
    if (category) qs.set("category", category);
    if (contextType) qs.set("context_type", contextType);
    try {
      const r = await api.get<{ documents: DocRow[] }>(`/api/documents?${qs.toString()}`);
      setRows(r.documents);
    } catch (e) {
      toast.push("error", errMsg(e));
      setRows([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, contextType]);

  const share = async (d: DocRow) => {
    try {
      const r = await api.post<{ share_url: string }>(`/api/documents/${d.id}/share`, {});
      await navigator.clipboard?.writeText(r.share_url).catch(() => undefined);
      toast.push("success", `Share link copied (7-day): ${r.share_url}`);
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const softDelete = async (d: DocRow) => {
    try {
      await api.del(`/api/documents/${d.id}`);
      toast.push("success", "Document removed (file retained in storage)");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Documents</h1>
          <p class="view-subtitle">
            Every file across the platform — contracts, permits, plans, waivers, packages. Tagged &amp;
            filtered (never foldered).
          </p>
        </div>
        <Button variant="primary" onClick={() => setUploading(true)}>
          + Upload
        </Button>
      </div>

      <Card>
        <div class="form-row" style={{ alignItems: "flex-end" }}>
          <FormField label="Search (title / category)">
            <input
              class="form-input"
              value={search}
              placeholder="e.g. permit, agreement…"
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === "Enter" && void load()}
            />
          </FormField>
          <FormField label="Category">
            <Select
              value={category}
              options={[{ value: "", label: "All" }, ...CATEGORIES.map((c) => ({ value: c, label: formatStatus(c) }))]}
              onChange={setCategory}
            />
          </FormField>
          <FormField label="Context">
            <Select
              value={contextType}
              options={[
                { value: "", label: "All" },
                { value: "job", label: "Job" },
                { value: "company", label: "Company" },
                { value: "client", label: "Client" },
                { value: "estimate", label: "Estimate" },
              ]}
              onChange={setContextType}
            />
          </FormField>
          <Button variant="secondary" onClick={() => void load()}>
            Search
          </Button>
        </div>
      </Card>

      <div class="mt-lg" />

      {!rows ? (
        <Spinner center />
      ) : rows.length === 0 ? (
        <div class="empty-state">No documents match these filters.</div>
      ) : (
        <Card>
          <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Category</th>
                <th>Context</th>
                <th>Size</th>
                <th>Mirror</th>
                <th>Share</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>
                    <a href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer">
                      {d.title}
                    </a>
                    {d.is_signed ? <Badge tone="success">Signed</Badge> : null}
                  </td>
                  <td>{formatStatus(d.document_category)}</td>
                  <td>{formatStatus(d.context_type)}</td>
                  <td>{fmtSize(d.file_size)}</td>
                  <td>
                    <Badge tone={d.mirror_status === "synced" ? "success" : d.mirror_status === "failed" ? "error" : "neutral"}>
                      {d.mirror_status ?? "—"}
                    </Badge>
                  </td>
                  <td>
                    {d.share_token ? (
                      <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                        active
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <div class="flex gap-sm">
                      <Button size="sm" variant="secondary" onClick={() => void share(d)}>
                        Share
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => void softDelete(d)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      )}

      {uploading && (
        <UploadModal
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function UploadModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("other");
  const [jobId, setJobId] = useState("");
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      toast.push("error", "Files are capped at 50 MB.");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      if (title.trim()) fd.set("title", title.trim());
      fd.set("document_category", category);
      if (jobId.trim()) fd.set("job_id", jobId.trim());
      const res = await fetch("/api/documents", { method: "POST", body: fd });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error ?? `Upload failed: ${res.status}`);
      }
      toast.push("success", "Document uploaded");
      onUploaded();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Upload document"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!file || busy} onClick={upload}>
            {busy ? "Uploading…" : "Upload"}
          </Button>
        </>
      }
    >
      <FormField label="File" required>
        <input
          class="form-input"
          type="file"
          onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)}
        />
      </FormField>
      <FormField label="Title (defaults to filename)">
        <input class="form-input" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      </FormField>
      <div class="form-row">
        <FormField label="Category">
          <Select value={category} options={CATEGORIES.map((c) => ({ value: c, label: formatStatus(c) }))} onChange={setCategory} />
        </FormField>
        <FormField label="Job ID (optional — leave blank for company)">
          <input class="form-input" value={jobId} onInput={(e) => setJobId((e.target as HTMLInputElement).value)} />
        </FormField>
      </div>
    </Modal>
  );
}
