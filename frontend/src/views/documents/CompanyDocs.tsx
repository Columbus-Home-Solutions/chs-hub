import type { RoutableProps } from "preact-router";
import { useEffect, useMemo, useState } from "preact/hooks";
import { useAuth } from "../../store/auth";
import { can } from "../../lib/rbac";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatDate, formatStatus } from "../../lib/format";

interface CompanyDoc {
  id: string;
  created_at: string;
  updated_at: string;
  title: string;
  doc_type: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  effective_date: string | null;
  expires_at: string | null;
  notes: string | null;
  uploaded_by: string | null;
  drive_mirrored_at: string | null;
}

const DOC_TYPES = [
  "sop",
  "insurance",
  "license",
  "contract",
  "w9",
  "safety",
  "hr",
  "tax",
  "marketing",
  "legal",
  "other",
];

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

export function CompanyDocs(_props: RoutableProps) {
  const toast = useToast();
  const { user } = useAuth();
  const canManage = can(user, "manage_company_docs");

  const [rows, setRows] = useState<CompanyDoc[] | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<CompanyDoc | null>(null);

  const load = async () => {
    setRows(null);
    const qs = new URLSearchParams();
    if (typeFilter) qs.set("doc_type", typeFilter);
    if (search.trim()) qs.set("q", search.trim());
    try {
      const r = await api.get<{ documents: CompanyDoc[] }>(`/api/company-documents?${qs.toString()}`);
      setRows(r.documents);
    } catch (e) {
      toast.push("error", errMsg(e));
      setRows([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter]);

  const filtered = useMemo(() => {
    const all = rows ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((d) =>
      [d.title, d.filename, d.notes, d.doc_type].filter(Boolean).join(" ").toLowerCase().includes(q),
    );
  }, [rows, search]);

  const remove = async (d: CompanyDoc) => {
    if (!confirm(`Delete "${d.title}"? This cannot be undone.`)) return;
    try {
      await api.del(`/api/company-documents/${d.id}`);
      toast.push("success", "Document deleted");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const fileUrl = (id: string) => `/api/company-documents/${id}/file`;

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Company Docs</h1>
          <p class="view-subtitle">
            SOPs, HR, insurance, licenses, and internal resources. Files are stored in CHS and
            automatically backed up to Google Drive.
          </p>
        </div>
        {canManage && (
          <Button variant="primary" onClick={() => setUploading(true)}>
            + Upload
          </Button>
        )}
      </div>

      <Card>
        <div class="form-row form-row--align-end">
          <FormField label="Search">
            <input
              class="form-input"
              type="search"
              placeholder="Filter by title…"
              value={search}
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            />
          </FormField>
          <FormField label="Type">
            <Select
              value={typeFilter}
              options={[
                { value: "", label: "All types" },
                ...DOC_TYPES.map((t) => ({ value: t, label: formatStatus(t) })),
              ]}
              onChange={(v) => setTypeFilter(v)}
            />
          </FormField>
          <div class="form-row__action">
            <Button variant="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          </div>
        </div>
      </Card>

      <div class="mt-lg" />

      {!rows ? (
        <Spinner center />
      ) : filtered.length === 0 ? (
        <div class="empty-state">No company documents yet.</div>
      ) : (
        <Card>
          <div class="table-container">
            <table class="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Drive backup</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <a href={fileUrl(d.id)} target="_blank" rel="noreferrer">
                        {d.title}
                      </a>
                      {d.notes && (
                        <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                          {d.notes}
                        </div>
                      )}
                    </td>
                    <td>{formatStatus(d.doc_type)}</td>
                    <td>{fmtSize(d.size_bytes)}</td>
                    <td>
                      <Badge tone={d.drive_mirrored_at ? "success" : "neutral"}>
                        {d.drive_mirrored_at ? "Backed up" : "Pending"}
                      </Badge>
                    </td>
                    <td>{d.expires_at ? formatDate(d.expires_at) : "—"}</td>
                    <td>
                      <div class="flex gap-sm" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => window.open(fileUrl(d.id), "_blank", "noopener,noreferrer")}
                        >
                          Open
                        </Button>
                        <a
                          class="btn btn--sm btn--tertiary"
                          href={fileUrl(d.id)}
                          download={d.filename}
                          style={{ textDecoration: "none" }}
                        >
                          Download
                        </a>
                        {canManage && (
                          <>
                            <Button size="sm" variant="secondary" onClick={() => setEditing(d)}>
                              Edit
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => void remove(d)}>
                              Delete
                            </Button>
                          </>
                        )}
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
          onSaved={() => {
            setUploading(false);
            void load();
          }}
        />
      )}

      {editing && (
        <EditModal
          doc={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function UploadModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("sop");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!file) return toast.push("error", "Choose a file");
    if (!title.trim()) return toast.push("error", "Title is required");
    if (file.size > 50 * 1024 * 1024) return toast.push("error", "Files are capped at 50 MB");
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("title", title.trim());
      fd.set("doc_type", docType);
      if (effectiveDate) fd.set("effective_date", effectiveDate);
      if (expiresAt) fd.set("expires_at", expiresAt);
      if (notes.trim()) fd.set("notes", notes.trim());
      const res = await fetch("/api/company-documents", { method: "POST", body: fd });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string; details?: string }).details ?? (d as { error?: string }).error ?? `Upload failed (${res.status})`);
      }
      toast.push("success", "Document uploaded — Drive backup runs automatically");
      onSaved();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Upload company document"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!file || busy} onClick={() => void save()}>
            {busy ? "Uploading…" : "Upload"}
          </Button>
        </>
      }
    >
      <FormField label="File" required>
        <input
          class="form-input"
          type="file"
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0] ?? null;
            setFile(f);
            if (f && !title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ""));
          }}
        />
      </FormField>
      <FormField label="Title" required>
        <input class="form-input" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      </FormField>
      <FormField label="Type">
        <Select
          value={docType}
          options={DOC_TYPES.map((t) => ({ value: t, label: formatStatus(t) }))}
          onChange={setDocType}
        />
      </FormField>
      <div class="form-row">
        <FormField label="Effective date">
          <input class="form-input" type="date" value={effectiveDate} onInput={(e) => setEffectiveDate((e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="Expires">
          <input class="form-input" type="date" value={expiresAt} onInput={(e) => setExpiresAt((e.target as HTMLInputElement).value)} />
        </FormField>
      </div>
      <FormField label="Notes">
        <textarea class="form-input" rows={2} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
      </FormField>
    </Modal>
  );
}

function EditModal({
  doc,
  onClose,
  onSaved,
}: {
  doc: CompanyDoc;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(doc.title);
  const [docType, setDocType] = useState(doc.doc_type);
  const [effectiveDate, setEffectiveDate] = useState(doc.effective_date ?? "");
  const [expiresAt, setExpiresAt] = useState(doc.expires_at ?? "");
  const [notes, setNotes] = useState(doc.notes ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!title.trim()) return toast.push("error", "Title is required");
    setBusy(true);
    try {
      await api.patch(`/api/company-documents/${doc.id}`, {
        title: title.trim(),
        doc_type: docType,
        effective_date: effectiveDate || null,
        expires_at: expiresAt || null,
        notes: notes.trim() || null,
      });
      toast.push("success", "Document updated");
      onSaved();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Edit document"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <FormField label="Title" required>
        <input class="form-input" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      </FormField>
      <FormField label="Type">
        <Select
          value={docType}
          options={DOC_TYPES.map((t) => ({ value: t, label: formatStatus(t) }))}
          onChange={setDocType}
        />
      </FormField>
      <div class="form-row">
        <FormField label="Effective date">
          <input class="form-input" type="date" value={effectiveDate} onInput={(e) => setEffectiveDate((e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="Expires">
          <input class="form-input" type="date" value={expiresAt} onInput={(e) => setExpiresAt((e.target as HTMLInputElement).value)} />
        </FormField>
      </div>
      <FormField label="Notes">
        <textarea class="form-input" rows={2} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
      </FormField>
      <p class="text--muted" style={{ fontSize: "var(--text-xs)", margin: 0 }}>
        File: {doc.filename} · Drive backup is automatic (owner-managed).
      </p>
    </Modal>
  );
}
