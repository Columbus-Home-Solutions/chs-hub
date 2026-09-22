import { useEffect, useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { useToast } from "../../store/toast";
import { useAuth } from "../../store/auth";
import { isOwner } from "../../lib/rbac";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatDate } from "../../lib/format";
import { isJobberAcceptedImport } from "@chs/shared/jobber-accepted-import";
import type { Estimate } from "../../types";

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

export function JobberImportActions({
  estimate,
  onReload,
}: {
  estimate: Estimate;
  onReload: () => Promise<void>;
}) {
  const { user } = useAuth();
  if (!isOwner(user)) return null;
  if (estimate.linked_job_id) return null;

  const imported = isJobberAcceptedImport(estimate.data_source);
  if (imported) {
    return (
      <>
        <ExternalDepositButton estimate={estimate} onReload={onReload} />
        <ImportedContractAttach estimate={estimate} onReload={onReload} />
      </>
    );
  }
  if (["approved", "revised", "lost"].includes(estimate.status)) return null;
  return <MarkImportedSignedButton estimate={estimate} onReload={onReload} />;
}

function MarkImportedSignedButton({
  estimate,
  onReload,
}: {
  estimate: Estimate;
  onReload: () => Promise<void>;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [signedDate, setSignedDate] = useState("");
  const [address, setAddress] = useState(estimate.property_address ?? "");
  const [city, setCity] = useState(estimate.property_city ?? "");
  const [zip, setZip] = useState(estimate.property_zip ?? "");
  const [saving, setSaving] = useState(false);
  const needsProperty = !estimate.request_id && !(estimate.property_address && estimate.property_city && estimate.property_zip);

  const submit = async () => {
    if (!note.trim() || saving) return;
    setSaving(true);
    try {
      await api.post(`/api/estimates/${estimate.id}/mark-imported-signed`, {
        note: note.trim(),
        signed_date: signedDate || null,
        property_address: address.trim() || null,
        property_city: city.trim() || null,
        property_zip: zip.trim() || null,
      });
      toast.push("success", "Marked as signed via Jobber — no CHS e-signature created");
      setOpen(false);
      await onReload();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Mark as Imported — Signed via Jobber
      </Button>
      <Modal
        open={open}
        title="Imported — Signed via Jobber"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!note.trim() || saving} onClick={() => void submit()}>
              {saving ? "Saving…" : "Confirm import"}
            </Button>
          </>
        }
      >
        <p class="text--muted" style={{ marginBottom: "var(--space-sm)" }}>
          Use this only when the customer already signed the quote in Jobber. This does{" "}
          <strong>not</strong> create a BoldSign envelope and does not mark the estimate as
          signed through CHS.
        </p>
        <FormField label="Paper trail (required)">
          <textarea
            class="form-input"
            rows={3}
            placeholder="Signed via Jobber quote #1234 on Aug 20, 2026 by Jane Doe"
            value={note}
            onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
          />
        </FormField>
        <FormField label="Date signed in Jobber (optional)">
          <input
            class="form-input"
            type="date"
            value={signedDate}
            onInput={(e) => setSignedDate((e.target as HTMLInputElement).value)}
          />
        </FormField>
        {needsProperty && (
          <>
            <p class="text--muted" style={{ margin: "var(--space-sm) 0" }}>
              This standalone estimate has no property yet. Conversion needs an address for the job.
            </p>
            <FormField label="Property address">
              <input
                class="form-input"
                value={address}
                onInput={(e) => setAddress((e.target as HTMLInputElement).value)}
              />
            </FormField>
            <FormField label="City">
              <input
                class="form-input"
                value={city}
                onInput={(e) => setCity((e.target as HTMLInputElement).value)}
              />
            </FormField>
            <FormField label="ZIP">
              <input
                class="form-input"
                value={zip}
                onInput={(e) => setZip((e.target as HTMLInputElement).value)}
              />
            </FormField>
          </>
        )}
      </Modal>
    </>
  );
}

function ExternalDepositButton({
  estimate,
  onReload,
}: {
  estimate: Estimate;
  onReload: () => Promise<void>;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(
    estimate.deposit_amount != null ? String(estimate.deposit_amount) : "",
  );
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;

  const submit = async () => {
    if (!amountValid || !date || saving) return;
    setSaving(true);
    try {
      const res = await api.post<{ job_id?: string; job_number?: number }>(
        `/api/estimates/${estimate.id}/mark-external-deposit`,
        {
          deposit_amount: amountNum,
          received_date: date,
          reference: "Deposit received via Jobber (external — not charged in CHS)",
        },
      );
      toast.push("success", "External deposit recorded — job created. No Stripe charge.");
      setOpen(false);
      if (res.job_id) {
        go(`/jobs/${res.job_id}`);
        return;
      }
      await onReload();
    } catch (e) {
      toast.push("error", errMsg(e));
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Mark Deposit Received (External)
      </Button>
      <Modal
        open={open}
        title="Mark Deposit Received (External)"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!amountValid || !date || saving}
              onClick={() => void submit()}
            >
              {saving ? "Converting…" : "Record deposit & convert"}
            </Button>
          </>
        }
      >
        <p class="text--muted" style={{ marginBottom: "var(--space-sm)" }}>
          Records a deposit already collected in Jobber. CHS will <strong>not</strong> charge
          Stripe. The existing quote-to-job conversion then creates the job.
        </p>
        <FormField label="Amount received" required>
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
          />
        </FormField>
        <FormField label="Date received" required>
          <input
            class="form-input"
            type="date"
            value={date}
            onInput={(e) => setDate((e.target as HTMLInputElement).value)}
          />
        </FormField>
      </Modal>
    </>
  );
}

function ImportedContractAttach({
  estimate,
  onReload,
}: {
  estimate: Estimate;
  onReload: () => Promise<void>;
}) {
  const toast = useToast();
  const [docs, setDocs] = useState<Array<{ id: string; title: string; created_at: string }>>([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api.get<{ documents: Array<{ id: string; title: string; created_at: string }> }>(
        `/api/documents?estimate_id=${encodeURIComponent(estimate.id)}&context_type=estimate`,
      );
      setDocs(r.documents ?? []);
    } catch {
      setDocs([]);
    }
  };
  useEffect(() => {
    void load();
  }, [estimate.id]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("title", file.name.replace(/\.[^.]+$/, "") || "Jobber signed contract (reference)");
      fd.set("document_category", "contract");
      fd.set("context_type", "estimate");
      fd.set("estimate_id", estimate.id);
      if (estimate.client_id) fd.set("client_id", estimate.client_id);
      fd.set("is_signed", "1");
      fd.set("signature_source", "jobber_import");
      const res = await fetch("/api/documents", { method: "POST", body: fd });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { details?: string; error?: string }).details || (d as { error?: string }).error || `Upload failed: ${res.status}`);
      }
      toast.push("success", "Signed Jobber contract attached as reference");
      await load();
      await onReload();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <label class="btn btn--tertiary" style={{ cursor: busy ? "wait" : "pointer" }}>
      {busy ? "Uploading…" : "Attach signed Jobber PDF"}
      <input
        type="file"
        accept="application/pdf"
        hidden
        disabled={busy}
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          void onFile(input.files?.[0]);
          input.value = "";
        }}
      />
      {docs.length > 0 ? (
        <span class="text--muted" style={{ marginLeft: "0.4rem", fontSize: "var(--text-xs)" }}>
          {docs.map((d) => `${d.title} (${formatDate(d.created_at)})`).join(" · ")}
        </span>
      ) : null}
    </label>
  );
}
