import type { RoutableProps } from "preact-router";
import { useEffect, useRef, useState } from "preact/hooks";
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

interface TemplateHead {
  id: string;
  name: string;
  template_type: string;
  is_active: number;
  version: number;
}

const TEMPLATE_TYPES = ["service_agreement", "cost_plus_agreement", "change_order", "lien_waiver", "proposal", "other"];
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

// ─── Settings → Document Templates manager (owner-only) (Sprint 15) ───────────
export function DocumentTemplates(_props: RoutableProps) {
  const toast = useToast();
  const [rows, setRows] = useState<TemplateHead[] | null>(null);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      const r = await api.get<{ templates: TemplateHead[]; merge_field_catalog: string[] }>("/api/document-templates");
      setRows(r.templates);
      setCatalog(r.merge_field_catalog ?? []);
    } catch (e) {
      toast.push("error", errMsg(e));
      setRows([]);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleActive = async (t: TemplateHead) => {
    try {
      await api.put(`/api/document-templates/${t.id}`, { is_active: !t.is_active });
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Document Templates</h1>
          <p class="view-subtitle">
            Reusable templates with merge-field auto-population. Editing creates a new version and
            preserves history. (Quote-delivery contracts stay on their own verified path.)
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          + New Template
        </Button>
      </div>

      {!rows ? (
        <Spinner center />
      ) : rows.length === 0 ? (
        <div class="empty-state">No templates yet.</div>
      ) : (
        <Card>
          <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Version</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{formatStatus(t.template_type)}</td>
                  <td>v{t.version}</td>
                  <td>
                    <Badge tone={t.is_active ? "success" : "warning"}>{t.is_active ? "Active" : "Inactive"}</Badge>
                  </td>
                  <td>
                    <div class="flex gap-sm">
                      <Button size="sm" variant="secondary" onClick={() => setEditing(t.id)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="tertiary" onClick={() => void toggleActive(t)}>
                        {t.is_active ? "Deactivate" : "Activate"}
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

      {(creating || editing) && (
        <TemplateEditor
          id={editing}
          catalog={catalog}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function TemplateEditor({
  id,
  catalog,
  onClose,
  onSaved,
}: {
  id: string | null;
  catalog: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [type, setType] = useState("other");
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(id === null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!id) return;
    api
      .get<{ template: { name: string; template_type: string; content: string } }>(`/api/document-templates/${id}`)
      .then((r) => {
        setName(r.template.name);
        setType(r.template.template_type);
        setContent(r.template.content);
      })
      .catch((e) => toast.push("error", errMsg(e)))
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const insertField = (f: string) => {
    const token = `{{${f}}}`;
    const ta = taRef.current;
    if (!ta) {
      setContent((c) => c + token);
      return;
    }
    const start = ta.selectionStart ?? content.length;
    const end = ta.selectionEnd ?? content.length;
    setContent(content.slice(0, start) + token + content.slice(end));
  };

  const save = async () => {
    setBusy(true);
    try {
      if (id) {
        await api.put(`/api/document-templates/${id}`, { content, name, template_type: type });
        toast.push("success", "New version saved");
      } else {
        await api.post("/api/document-templates", { name, template_type: type, content, merge_fields: detectFields(content) });
        toast.push("success", "Template created");
      }
      onSaved();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const doPreview = async () => {
    if (!id) {
      // Local preview for unsaved drafts isn't wired to the server endpoint.
      toast.push("info", "Save the template first to preview with sample data.");
      return;
    }
    try {
      const r = await api.post<{ preview: string }>(`/api/document-templates/${id}/preview`, {});
      setPreview(r.preview);
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  return (
    <Modal
      open
      title={id ? "Edit template (creates new version)" : "New template"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {id && (
            <Button variant="tertiary" onClick={() => void doPreview()}>
              Preview
            </Button>
          )}
          <Button variant="primary" disabled={!name || !content || busy || !loaded} onClick={save}>
            {id ? "Save version" : "Create"}
          </Button>
        </>
      }
    >
      {!loaded ? (
        <Spinner center />
      ) : (
        <>
          <div class="form-row">
            <FormField label="Name" required>
              <input class="form-input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            </FormField>
            <FormField label="Type" required>
              <Select value={type} options={TEMPLATE_TYPES.map((t) => ({ value: t, label: formatStatus(t) }))} onChange={setType} />
            </FormField>
          </div>
          <FormField label="Merge fields (click to insert)">
            <div class="flex gap-sm" style={{ flexWrap: "wrap" }}>
              {catalog.map((f) => (
                <button key={f} type="button" class="chip" onClick={() => insertField(f)}>
                  {`{{${f}}}`}
                </button>
              ))}
            </div>
          </FormField>
          <FormField label="Content" required>
            <textarea
              ref={taRef}
              class="form-textarea"
              style={{ minHeight: "240px", fontFamily: "var(--font-mono, monospace)" }}
              value={content}
              onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
            />
          </FormField>
          {preview !== null && (
            <FormField label="Preview (sample data)">
              <pre class="doc-preview" style={{ whiteSpace: "pre-wrap", background: "var(--surface-2, #f4f6f8)", padding: "var(--space-md)", borderRadius: "8px", maxHeight: "260px", overflow: "auto" }}>
                {preview}
              </pre>
            </FormField>
          )}
        </>
      )}
    </Modal>
  );
}

function detectFields(content: string): string[] {
  const out = new Set<string>();
  const re = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.add(m[1].toLowerCase());
  return [...out];
}
