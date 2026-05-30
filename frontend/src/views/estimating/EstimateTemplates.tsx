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
import { go } from "../../lib/nav";
import { formatStatus } from "../../lib/format";
import { BILLING_MODELS, ESTIMATE_JOB_TYPES, type EstimateTemplate } from "../../types";

export function EstimateTemplates(_props: RoutableProps) {
  const toast = useToast();
  const [templates, setTemplates] = useState<EstimateTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EstimateTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ templates: EstimateTemplate[] }>("/api/estimate-templates?active=all");
      setTemplates(r.templates);
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const toggleActive = async (t: EstimateTemplate) => {
    try {
      await api.put(`/api/estimate-templates/${t.id}`, { is_active: !t.is_active });
      toast.push("success", t.is_active ? "Template deactivated" : "Template activated");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const active = templates.filter((t) => t.is_active);
  const inactive = templates.filter((t) => !t.is_active);

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Estimate Templates</h1>
          <p class="view-subtitle">Reusable line-item sets for common job types.</p>
        </div>
        <div class="view-header__right">
          <Button variant="tertiary" onClick={() => go("/estimating")}>
            ← Pipeline
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            + New Template
          </Button>
        </div>
      </div>

      {loading && <Spinner center />}

      {!loading && (
        <div class="stack">
          <Card title={`Active (${active.length})`}>
            {active.length === 0 ? (
              <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                No active templates. Create one, or save an estimate as a template from the builder.
              </div>
            ) : (
              <div class="tpl-list">
                {active.map((t) => (
                  <TemplateRow key={t.id} t={t} onEdit={() => setEditing(t)} onToggle={() => toggleActive(t)} />
                ))}
              </div>
            )}
          </Card>

          {inactive.length > 0 && (
            <Card title={`Inactive (${inactive.length})`}>
              <div class="tpl-list">
                {inactive.map((t) => (
                  <TemplateRow key={t.id} t={t} onEdit={() => setEditing(t)} onToggle={() => toggleActive(t)} />
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {(creating || editing) && (
        <TemplateModal
          template={editing}
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

function TemplateRow({
  t,
  onEdit,
  onToggle,
}: {
  t: EstimateTemplate;
  onEdit: () => void;
  onToggle: () => void;
}) {
  return (
    <div class="tpl-row">
      <div>
        <div class="tpl-row__name">{t.name}</div>
        <div class="tpl-row__meta">
          <Badge tone="neutral">{formatStatus(t.job_type)}</Badge>
          {t.default_billing_model && <Badge tone="brand">{formatStatus(t.default_billing_model)}</Badge>}
          {!t.is_active && <Badge tone="warning">Inactive</Badge>}
        </div>
        {t.description && <div class="tpl-row__desc">{t.description}</div>}
      </div>
      <div class="flex gap-sm">
        <Button size="sm" variant="secondary" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant={t.is_active ? "danger" : "primary"} onClick={onToggle}>
          {t.is_active ? "Deactivate" : "Activate"}
        </Button>
      </div>
    </div>
  );
}

function TemplateModal({
  template,
  onClose,
  onSaved,
}: {
  template: EstimateTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(template?.name ?? "");
  const [jobType, setJobType] = useState(template?.job_type ?? "remodel_other");
  const [billing, setBilling] = useState(template?.default_billing_model ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      if (template) {
        await api.put(`/api/estimate-templates/${template.id}`, {
          name,
          job_type: jobType,
          default_billing_model: billing || null,
          description: description || null,
        });
        toast.push("success", "Template updated");
      } else {
        await api.post("/api/estimate-templates", {
          name,
          job_type: jobType,
          default_billing_model: billing || null,
          description: description || null,
          line_items: [],
        });
        toast.push("success", "Template created");
      }
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={template ? "Edit template" : "New template"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name || busy} onClick={save}>
            {template ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <FormField label="Name" required>
        <input class="form-input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </FormField>
      <FormField label="Job type" required>
        <Select
          value={jobType}
          options={ESTIMATE_JOB_TYPES.map((j) => ({ value: j, label: formatStatus(j) }))}
          onChange={setJobType}
        />
      </FormField>
      <FormField label="Default billing model">
        <Select
          value={billing}
          placeholder="None"
          options={BILLING_MODELS}
          onChange={setBilling}
        />
      </FormField>
      <FormField label="Description">
        <textarea
          class="form-textarea"
          value={description}
          onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
      {!template && (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          To capture line items, build an estimate and use "Save as Template" in the builder.
        </p>
      )}
    </Modal>
  );
}
