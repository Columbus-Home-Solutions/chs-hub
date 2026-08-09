import { useCallback, useEffect, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { AddressAutocomplete } from "../../components/AddressAutocomplete";
import { useForm } from "../../hooks/useForm";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatCurrency, formatDate } from "../../lib/format";
import { go } from "../../lib/nav";
import { LEAD_SOURCES, type Client, type DuplicateMatch } from "../../types";

interface ClientFormProps {
  open: boolean;
  mode: "create" | "edit";
  initial?: Partial<Client>;
  onClose: () => void;
  onSaved: (client: Client) => void;
  /** Optional tertiary action under the form (e.g. "Search for existing instead"). */
  secondaryAction?: { label: string; onClick: () => void } | null;
}

type FormValues = {
  first_name: string;
  last_name: string;
  company_name: string;
  email: string;
  phone: string;
  phone_secondary: string;
  lead_source: string;
  mailing_address: string;
  mailing_city: string;
  mailing_state: string;
  mailing_zip: string;
  notes: string;
};

function toValues(initial?: Partial<Client>): FormValues {
  return {
    first_name: initial?.first_name ?? "",
    last_name: initial?.last_name ?? "",
    company_name: initial?.company_name ?? "",
    email: initial?.email ?? "",
    phone: initial?.phone ?? "",
    phone_secondary: initial?.phone_secondary ?? "",
    lead_source: initial?.lead_source ?? "",
    mailing_address: initial?.mailing_address ?? "",
    mailing_city: initial?.mailing_city ?? "",
    mailing_state: initial?.mailing_state ?? "",
    mailing_zip: initial?.mailing_zip ?? "",
    notes: initial?.notes ?? "",
  };
}

export function ClientForm({
  open,
  mode,
  initial,
  onClose,
  onSaved,
  secondaryAction,
}: ClientFormProps) {
  const { values, errors, submitting, setValue, setValues, setErrors, handleSubmit } =
    useForm<FormValues>(toValues(initial));
  const toast = useToast();
  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null);

  // Remount-friendly: when the modal opens, re-apply initial (pre-fill from parent).
  useEffect(() => {
    if (!open) return;
    setValues(toValues(initial));
    setErrors({});
    setDuplicates(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- only on open transition

  const handleMailingAddressSelect = useCallback(
    (result: { street: string; city: string; state: string; zip: string }) => {
      setValue("mailing_address", result.street);
      setValue("mailing_city", result.city);
      setValue("mailing_state", result.state);
      setValue("mailing_zip", result.zip);
    },
    [setValue],
  );

  const validate = (): boolean => {
    const e: Partial<Record<keyof FormValues, string>> = {};
    if (!values.first_name.trim()) e.first_name = "Required";
    if (!values.last_name.trim()) e.last_name = "Required";
    if (!values.email.trim()) e.email = "Required";
    if (!values.phone.trim()) e.phone = "Required";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async (force: boolean) => {
    if (!validate()) return;
    await handleSubmit(async (v) => {
      try {
        const payload = { ...v, address: v.mailing_address };
        if (mode === "create") {
          const res = await api.post<{ client?: Client; possible_duplicate?: boolean; matches?: DuplicateMatch[] }>(
            force ? "/api/clients?force=true" : "/api/clients",
            payload,
          );
          if (res.possible_duplicate && res.matches) {
            setDuplicates(res.matches);
            return;
          }
          if (res.client) {
            toast.push("success", "Client created");
            onSaved(res.client);
          }
        } else {
          const res = await api.put<{ client: Client }>(`/api/clients/${initial!.id}`, payload);
          toast.push("success", "Client updated");
          onSaved(res.client);
        }
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : (err as Error).message;
        toast.push("error", msg);
      }
    });
  };

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose} disabled={submitting}>
        Cancel
      </Button>
      <Button variant="primary" onClick={() => save(false)} disabled={submitting}>
        {submitting ? "Saving…" : mode === "create" ? "Create client" : "Save changes"}
      </Button>
    </>
  );

  return (
    <Modal
      open={open}
      title={mode === "create" ? "New Client" : "Edit Client"}
      onClose={onClose}
      footer={duplicates ? undefined : footer}
    >
      {duplicates ? (
        <div>
          <p style={{ marginTop: 0 }}>
            <strong>Possible existing client.</strong> We found {duplicates.length} record
            {duplicates.length === 1 ? "" : "s"} that may match.
          </p>
          {duplicates.map((m) => (
            <div key={m.id} class="dup-match">
              <div class="flex justify-between items-center">
                <strong>{m.name}</strong>
                <span class="text--mono text--muted" style={{ fontSize: "var(--text-xs)" }}>
                  match: {m.match_reason}
                </span>
              </div>
              <div class="text--secondary" style={{ fontSize: "var(--text-sm)" }}>
                {m.total_jobs} jobs · {formatCurrency(m.total_revenue)} · last{" "}
                {formatDate(m.last_interaction_date)}
              </div>
              <div class="mt-sm">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    onClose();
                    go(`/clients/${m.id}`);
                  }}
                >
                  Use existing client
                </Button>
              </div>
            </div>
          ))}
          <div class="flex justify-between mt-md">
            <Button variant="tertiary" onClick={() => setDuplicates(null)}>
              Back
            </Button>
            <Button variant="primary" onClick={() => { setDuplicates(null); void save(true); }}>
              Create new anyway
            </Button>
          </div>
        </div>
      ) : (
        <div>
          {secondaryAction && (
            <p style={{ marginTop: 0, marginBottom: "var(--space-md)" }}>
              <button
                type="button"
                class="link-btn"
                style={{ fontSize: "var(--text-sm)" }}
                onClick={secondaryAction.onClick}
              >
                {secondaryAction.label}
              </button>
            </p>
          )}
          <div class="form-row">
            <FormField
              label="First name"
              required
              error={errors.first_name}
              inputProps={{
                value: values.first_name,
                onInput: (e) => setValue("first_name", (e.target as HTMLInputElement).value),
              }}
            />
            <FormField
              label="Last name"
              required
              error={errors.last_name}
              inputProps={{
                value: values.last_name,
                onInput: (e) => setValue("last_name", (e.target as HTMLInputElement).value),
              }}
            />
          </div>
          <FormField
            label="Company name"
            inputProps={{
              value: values.company_name,
              placeholder: "Optional",
              onInput: (e) => setValue("company_name", (e.target as HTMLInputElement).value),
            }}
          />
          <div class="form-row">
            <FormField
              label="Email"
              required
              error={errors.email}
              inputProps={{
                type: "email",
                value: values.email,
                onInput: (e) => setValue("email", (e.target as HTMLInputElement).value),
              }}
            />
            <FormField
              label="Phone"
              required
              error={errors.phone}
              inputProps={{
                value: values.phone,
                onInput: (e) => setValue("phone", (e.target as HTMLInputElement).value),
              }}
            />
          </div>
          <div class="form-row">
            <FormField
              label="Secondary phone"
              inputProps={{
                value: values.phone_secondary,
                onInput: (e) => setValue("phone_secondary", (e.target as HTMLInputElement).value),
              }}
            />
            <FormField label="Lead source">
              <Select
                value={values.lead_source}
                placeholder="—"
                onChange={(v) => setValue("lead_source", v)}
                options={LEAD_SOURCES.map((s) => ({ value: s, label: s.replace(/_/g, " ") }))}
              />
            </FormField>
          </div>
          <FormField label="Mailing address">
            {open && (
              <AddressAutocomplete
                initialValue={values.mailing_address}
                onInputChange={(street) => setValue("mailing_address", street)}
                onSelect={handleMailingAddressSelect}
              />
            )}
          </FormField>
          <div class="form-row">
            <FormField
              label="City"
              inputProps={{
                value: values.mailing_city,
                onInput: (e) => setValue("mailing_city", (e.target as HTMLInputElement).value),
              }}
            />
            <FormField
              label="State"
              inputProps={{
                value: values.mailing_state,
                onInput: (e) => setValue("mailing_state", (e.target as HTMLInputElement).value),
              }}
            />
            <FormField
              label="ZIP"
              inputProps={{
                value: values.mailing_zip,
                onInput: (e) => setValue("mailing_zip", (e.target as HTMLInputElement).value),
              }}
            />
          </div>
          <FormField label="Notes">
            <textarea
              class="form-textarea"
              value={values.notes}
              onInput={(e) => setValue("notes", (e.target as HTMLTextAreaElement).value)}
            />
          </FormField>
        </div>
      )}
    </Modal>
  );
}
