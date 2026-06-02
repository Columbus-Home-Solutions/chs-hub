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

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

const CATEGORIES = [
  "contract", "change_order", "permit", "plan_drawing", "receipt", "invoice",
  "lien_waiver", "insurance", "license", "sop", "photo_report", "completion_package", "other",
];
const WAIVER_TYPES = ["conditional", "unconditional", "partial", "final"];

function fmtSize(n: number | null | undefined): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

interface DocItem {
  id: string;
  title: string;
  file_type?: string | null;
  file_size?: number | null;
  document_category: string;
  is_signed?: number | null;
  mirror_status?: string | null;
  share_token?: string | null;
  source?: string;
  created_at: string;
}

// ─── Job-profile Documents tab (Sprint 15) ─────────────────────────────────────
export function DocumentsTab({ jobId, clientId }: { jobId: string; clientId: string | null }) {
  return (
    <div class="stack">
      <JobDocuments jobId={jobId} />
      <GenerateFromTemplate jobId={jobId} clientId={clientId} />
      <LienWaivers jobId={jobId} />
      <CompletionPackage jobId={jobId} />
    </div>
  );
}

// ─── 1. Documents (grouped) + upload ───────────────────────────────────────────
function JobDocuments({ jobId }: { jobId: string }) {
  const toast = useToast();
  const [groups, setGroups] = useState<Record<string, DocItem[]> | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = async () => {
    setGroups(null);
    try {
      const r = await api.get<{ groups: Record<string, DocItem[]> }>(`/api/jobs/${jobId}/documents`);
      setGroups(r.groups ?? {});
    } catch (e) {
      toast.push("error", errMsg(e));
      setGroups({});
    }
  };
  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener("chs:docs-changed", onChanged);
    return () => window.removeEventListener("chs:docs-changed", onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const share = async (d: DocItem) => {
    try {
      const r = await api.post<{ share_url: string }>(`/api/documents/${d.id}/share`, {});
      await navigator.clipboard?.writeText(r.share_url).catch(() => undefined);
      toast.push("success", `Share link copied (7-day): ${r.share_url}`);
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };
  const remove = async (d: DocItem) => {
    try {
      await api.del(`/api/documents/${d.id}`);
      toast.push("success", "Document removed (file retained)");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const cats = groups ? Object.keys(groups).sort() : [];

  return (
    <Card
      title="Documents"
      actions={
        <Button size="sm" variant="primary" onClick={() => setUploading(true)}>
          + Upload
        </Button>
      }
    >
      {!groups ? (
        <Spinner center />
      ) : cats.length === 0 ? (
        <div class="empty-state">No documents for this job yet.</div>
      ) : (
        cats.map((cat) => (
          <div key={cat} class="mt-md">
            <div class="text--muted" style={{ fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: "var(--space-xs)" }}>
              {formatStatus(cat)} ({groups[cat].length})
            </div>
            <table class="table">
              <tbody>
                {groups[cat].map((d) => (
                  <tr key={d.id}>
                    <td>
                      {d.source === "photo" ? (
                        d.title
                      ) : (
                        <a href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer">{d.title}</a>
                      )}
                      {d.is_signed ? <Badge tone="success">Signed</Badge> : null}
                    </td>
                    <td style={{ width: "90px" }}>{fmtSize(d.file_size)}</td>
                    <td style={{ width: "110px" }}>
                      {d.mirror_status ? (
                        <Badge tone={d.mirror_status === "synced" ? "success" : d.mirror_status === "failed" ? "error" : "neutral"}>
                          {d.mirror_status}
                        </Badge>
                      ) : "—"}
                    </td>
                    <td style={{ width: "150px", textAlign: "right" }}>
                      {d.source === "photo" ? null : (
                        <div class="flex gap-sm" style={{ justifyContent: "flex-end" }}>
                          <Button size="sm" variant="secondary" onClick={() => void share(d)}>Share</Button>
                          <Button size="sm" variant="danger" onClick={() => void remove(d)}>Delete</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {uploading && (
        <JobUploadModal
          jobId={jobId}
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            void load();
          }}
        />
      )}
    </Card>
  );
}

function JobUploadModal({ jobId, onClose, onUploaded }: { jobId: string; onClose: () => void; onUploaded: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("other");
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
      fd.set("job_id", jobId);
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
      title="Upload document to this job"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!file || busy} onClick={upload}>{busy ? "Uploading…" : "Upload"}</Button>
        </>
      }
    >
      <FormField label="File" required>
        <input class="form-input" type="file" onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
      </FormField>
      <FormField label="Title (defaults to filename)">
        <input class="form-input" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      </FormField>
      <FormField label="Category">
        <Select value={category} options={CATEGORIES.map((c) => ({ value: c, label: formatStatus(c) }))} onChange={setCategory} />
      </FormField>
    </Modal>
  );
}

// ─── 2. Generate from template ─────────────────────────────────────────────────
interface TemplateHead { id: string; name: string; template_type: string; is_active: number; version: number; }

function GenerateFromTemplate({ jobId, clientId }: { jobId: string; clientId: string | null }) {
  const toast = useToast();
  const [templates, setTemplates] = useState<TemplateHead[] | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ templates: TemplateHead[] }>("/api/document-templates")
      .then((r) => {
        const active = (r.templates ?? []).filter((t) => t.is_active);
        setTemplates(active);
        if (active[0]) setSelected(active[0].id);
      })
      .catch((e) => {
        toast.push("error", errMsg(e));
        setTemplates([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generate = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await api.post<{ document_id: string; title: string; missing_fields: string[] }>(
        `/api/document-templates/${selected}/generate`,
        { job_id: jobId, client_id: clientId },
      );
      const missing = r.missing_fields?.length ? ` (unfilled: ${r.missing_fields.join(", ")})` : "";
      toast.push("success", `Generated "${r.title}"${missing}. See the Documents list above.`);
      window.dispatchEvent(new CustomEvent("chs:docs-changed"));
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const doPreview = async () => {
    if (!selected) return;
    try {
      const r = await api.post<{ preview: string }>(`/api/document-templates/${selected}/preview`, {});
      setPreview(r.preview);
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  return (
    <Card title="Generate document from template">
      {!templates ? (
        <Spinner center />
      ) : templates.length === 0 ? (
        <div class="empty-state">No active templates. Create one in Settings → Document Templates.</div>
      ) : (
        <>
          <div class="form-row" style={{ alignItems: "flex-end" }}>
            <FormField label="Template">
              <Select
                value={selected}
                options={templates.map((t) => ({ value: t.id, label: `${t.name} (${formatStatus(t.template_type)} v${t.version})` }))}
                onChange={setSelected}
              />
            </FormField>
            <Button variant="tertiary" disabled={!selected} onClick={() => void doPreview()}>Preview</Button>
            <Button variant="primary" disabled={!selected || busy} onClick={generate}>{busy ? "Generating…" : "Generate"}</Button>
          </div>
          <p class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
            Merge fields auto-populate from this job, its client, and estimate. The generated file lands in the Documents list above.
          </p>
          {preview !== null && (
            <FormField label="Preview (sample data — not stored)">
              <pre style={{ whiteSpace: "pre-wrap", background: "#ffffff", color: "#111827", padding: "var(--space-md)", borderRadius: "8px", maxHeight: "260px", overflow: "auto", fontFamily: "var(--font-mono, monospace)", fontSize: "var(--text-sm)" }}>{preview}</pre>
            </FormField>
          )}
        </>
      )}
    </Card>
  );
}

// ─── 3. Lien waivers ───────────────────────────────────────────────────────────
interface WaiverRow {
  id: string; sub_id: string; sub_name: string | null; waiver_type: string;
  payment_amount: number; status: string; document_id: string | null;
}
interface SubOption { id: string; company_name: string | null; contact_name: string | null; }

function LienWaivers({ jobId }: { jobId: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<WaiverRow[] | null>(null);
  const [subs, setSubs] = useState<SubOption[]>([]);
  const [subId, setSubId] = useState("");
  const [waiverType, setWaiverType] = useState("conditional");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api.get<{ lien_waivers: WaiverRow[] }>(`/api/jobs/${jobId}/lien-waivers`);
      setRows(r.lien_waivers ?? []);
    } catch (e) {
      toast.push("error", errMsg(e));
      setRows([]);
    }
  };
  useEffect(() => {
    void load();
    api
      .get<{ subcontractors: SubOption[] }>("/api/subcontractors?active=1")
      .then((r) => {
        setSubs(r.subcontractors ?? []);
        if (r.subcontractors?.[0]) setSubId(r.subcontractors[0].id);
      })
      .catch(() => setSubs([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const create = async () => {
    const amt = Number(amount);
    if (!subId) return toast.push("error", "Pick a subcontractor.");
    if (!Number.isFinite(amt)) return toast.push("error", "Enter a valid payment amount.");
    setBusy(true);
    try {
      await api.post(`/api/lien-waivers`, { job_id: jobId, sub_id: subId, waiver_type: waiverType, payment_amount: amt });
      toast.push("success", "Lien waiver request created");
      setAmount("");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const generate = async (w: WaiverRow) => {
    try {
      const r = await api.post<{ document_id: string }>(`/api/lien-waivers/${w.id}/generate`, {});
      toast.push("success", `Waiver document generated (${r.document_id.slice(0, 8)}). See Documents → Lien Waiver.`);
      void load();
      window.dispatchEvent(new CustomEvent("chs:docs-changed"));
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const subLabel = (s: SubOption) => s.company_name ?? s.contact_name ?? s.id.slice(0, 8);

  return (
    <Card title="Lien waivers">
      <div class="form-row" style={{ alignItems: "flex-end" }}>
        <FormField label="Subcontractor">
          <Select value={subId} options={subs.map((s) => ({ value: s.id, label: subLabel(s) }))} onChange={setSubId} />
        </FormField>
        <FormField label="Type">
          <Select value={waiverType} options={WAIVER_TYPES.map((t) => ({ value: t, label: formatStatus(t) }))} onChange={setWaiverType} />
        </FormField>
        <FormField label="Payment amount">
          <input class="form-input" type="number" step="0.01" value={amount} placeholder="0.00" onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
        </FormField>
        <Button variant="primary" disabled={busy || subs.length === 0} onClick={create}>Create request</Button>
      </div>

      {!rows ? (
        <Spinner center />
      ) : rows.length === 0 ? (
        <div class="empty-state mt-md">No lien waivers yet.</div>
      ) : (
        <table class="table mt-md">
          <thead>
            <tr><th>Subcontractor</th><th>Type</th><th>Amount</th><th>Status</th><th>Document</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id}>
                <td>{w.sub_name ?? "—"}</td>
                <td>{formatStatus(w.waiver_type)}</td>
                <td>{usd(w.payment_amount)}</td>
                <td><Badge tone={w.status === "filed" ? "success" : w.status === "received" ? "info" : "neutral"}>{formatStatus(w.status)}</Badge></td>
                <td>{w.document_id ? <a href={`/api/documents/${w.document_id}/file`} target="_blank" rel="noreferrer">View</a> : "—"}</td>
                <td style={{ textAlign: "right" }}>
                  {!w.document_id && <Button size="sm" variant="secondary" onClick={() => void generate(w)}>Generate document</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ─── 4. Completion package ─────────────────────────────────────────────────────
interface PackageState {
  state: "none" | "draft" | "sent";
  package: { document_id: string; title: string; preview_url: string; sent_at: string | null; created_at: string } | null;
}

function CompletionPackage({ jobId }: { jobId: string }) {
  const toast = useToast();
  const [pkg, setPkg] = useState<PackageState | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastCompile, setLastCompile] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.get<PackageState>(`/api/jobs/${jobId}/completion-package`);
      setPkg(r);
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const compile = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ document_count: number; before_photos: number; after_photos: number; summary?: Record<string, number> }>(
        `/api/jobs/${jobId}/completion-package`,
        {},
      );
      setLastCompile(`Compiled: ${r.document_count} docs · ${r.before_photos} before / ${r.after_photos} after photos`);
      toast.push("success", "Draft compiled — review, then send.");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ resent: boolean; notifications_enqueued: number }>(`/api/jobs/${jobId}/completion-package/send`, {});
      toast.push("success", r.resent ? "Already sent (idempotent resend)." : `Sent. Notifications enqueued: ${r.notifications_enqueued}.`);
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const state = pkg?.state ?? "none";

  return (
    <Card
      title="Completion package"
      actions={
        <div class="flex gap-sm">
          <Button size="sm" variant="secondary" disabled={busy} onClick={compile}>{state === "none" ? "Compile draft" : "Recompile"}</Button>
          {state !== "none" && <Button size="sm" variant="primary" disabled={busy || state === "sent"} onClick={send}>{state === "sent" ? "Sent" : "Send to client"}</Button>}
        </div>
      }
    >
      {pkg === null ? (
        <Spinner center />
      ) : (
        <div class="stack">
          <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
            <span>Status:</span>
            <Badge tone={state === "sent" ? "success" : state === "draft" ? "warning" : "neutral"}>
              {state === "none" ? "Not compiled" : state === "draft" ? "Draft (awaiting send)" : "Sent"}
            </Badge>
            {pkg.package?.sent_at && <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>sent {new Date(pkg.package.sent_at).toLocaleString()}</span>}
          </div>
          {lastCompile && <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>{lastCompile}</div>}
          {pkg.package && (
            <div>
              <a href={pkg.package.preview_url} target="_blank" rel="noreferrer">
                <Button size="sm" variant="tertiary">Preview package (HTML)</Button>
              </a>
            </div>
          )}
          <p class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
            Compiling never auto-sends. Sending flips draft → sent, fires the client notification (SIMULATE), and reveals the Completion tab in the client portal.
          </p>
        </div>
      )}
    </Card>
  );
}
