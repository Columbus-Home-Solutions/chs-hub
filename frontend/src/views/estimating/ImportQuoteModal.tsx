/**
 * Import Quote — paste a Lowe's/etc. quote (or upload a cart screenshot),
 * AI-extract material lines, review/edit, then confirm into sub-items.
 * Also reused by Pending Imports (email) with `prefill` + hideBackToPaste.
 */
import { useEffect, useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { api, ApiError } from "../../api";
import { formatCurrency } from "../../lib/format";
import { useToast } from "../../store/toast";

interface ExtractedLine {
  description: string;
  sku: string | null;
  quantity: number | null;
  unit: string | null;
  unit_cost: number | null;
  total: number | null;
  include: boolean;
  save_to_price_book: boolean;
}

export interface QuoteExtractionPrefill {
  vendor_guess: string | null;
  lines: Array<{
    description: string;
    sku: string | null;
    quantity: number | null;
    unit: string | null;
    unit_cost: number | null;
    total: number | null;
  }>;
  quote_total: number | null;
}

interface ImportQuoteModalProps {
  open: boolean;
  lineItemId: string;
  onClose: () => void;
  onDone: (result?: { sub_item_ids: string[] }) => Promise<void>;
  /** When set, open directly on the review step with this extraction. */
  prefill?: QuoteExtractionPrefill | null;
  hideBackToPaste?: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function lineTotal(l: ExtractedLine): number {
  if (l.total != null && Number.isFinite(l.total)) return l.total;
  const q = l.quantity ?? 0;
  const u = l.unit_cost ?? 0;
  return round2(q * u);
}

function linesFromPrefill(prefill: QuoteExtractionPrefill): ExtractedLine[] {
  return (prefill.lines ?? []).map((l) => ({
    ...l,
    include: true,
    save_to_price_book: true,
  }));
}

export function ImportQuoteModal({
  open,
  lineItemId,
  onClose,
  onDone,
  prefill = null,
  hideBackToPaste = false,
}: ImportQuoteModalProps) {
  const toast = useToast();
  const [step, setStep] = useState<"paste" | "review">(prefill ? "review" : "paste");
  const [text, setText] = useState("");
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<string | null>(null);
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [vendor, setVendor] = useState(prefill?.vendor_guess ?? "");
  const [quoteTotal, setQuoteTotal] = useState<number | null>(prefill?.quote_total ?? null);
  const [lines, setLines] = useState<ExtractedLine[]>(prefill ? linesFromPrefill(prefill) : []);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (prefill) {
      setStep("review");
      setVendor(prefill.vendor_guess ?? "");
      setQuoteTotal(prefill.quote_total);
      setLines(linesFromPrefill(prefill));
    } else {
      setStep("paste");
      setVendor("");
      setQuoteTotal(null);
      setLines([]);
    }
    setText("");
    setImageBase64(null);
    setMediaType(null);
    setPdfBase64(null);
    setFileName(null);
    setBusy(false);
  }, [open, prefill]);

  const close = () => {
    onClose();
  };

  const onFile = (file: File | null) => {
    if (!file) {
      setImageBase64(null);
      setMediaType(null);
      setPdfBase64(null);
      setFileName(null);
      return;
    }
    const isPdf =
      file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const isImage = /^image\//.test(file.type);
    if (!isPdf && !isImage) {
      toast.push("error", "Use a PDF or PNG/JPEG screenshot");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      const b64 = comma >= 0 ? result.slice(comma + 1) : result;
      if (isPdf) {
        setPdfBase64(b64);
        setImageBase64(null);
        setMediaType("application/pdf");
      } else {
        setImageBase64(b64);
        setPdfBase64(null);
        setMediaType(file.type);
      }
      setFileName(file.name);
    };
    reader.readAsDataURL(file);
  };

  const extract = async () => {
    if (!text.trim() && !imageBase64 && !pdfBase64) {
      toast.push("error", "Paste quote text or attach a PDF / screenshot");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<QuoteExtractionPrefill>("/api/estimate-sub-items/import-quote", {
        text: text.trim() || undefined,
        image_base64: imageBase64 || undefined,
        media_type: mediaType || undefined,
        pdf_base64: pdfBase64 || undefined,
      });
      setVendor(res.vendor_guess ?? "");
      setQuoteTotal(res.quote_total);
      setLines(linesFromPrefill(res));
      setStep("review");
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : "Extraction failed");
    } finally {
      setBusy(false);
    }
  };

  const checked = lines.filter((l) => l.include);
  const checkedSum = round2(checked.reduce((s, l) => s + lineTotal(l), 0));
  const mismatch =
    quoteTotal != null &&
    checked.length > 0 &&
    Math.abs(checkedSum - quoteTotal) > 0.02;

  const confirm = async () => {
    if (checked.length === 0) {
      toast.push("error", "Select at least one line to import");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ sub_item_ids?: string[] }>(
        `/api/line-items/${lineItemId}/import-quote-confirm`,
        {
          vendor: vendor.trim() || null,
          lines: checked.map((l) => ({
            description: l.description,
            sku: l.sku,
            quantity: l.quantity ?? 1,
            unit: l.unit || "each",
            unit_cost: l.unit_cost ?? 0,
            save_to_price_book: !!(
              l.save_to_price_book &&
              vendor.trim() &&
              l.description.trim() &&
              (l.unit || "each")
            ),
          })),
        },
      );
      toast.push(
        "success",
        `Imported ${checked.length} material line${checked.length === 1 ? "" : "s"}`,
      );
      await onDone({ sub_item_ids: res.sub_item_ids ?? [] });
      close();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const updateLine = (idx: number, patch: Partial<ExtractedLine>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  return (
    <Modal
      open={open}
      title={step === "paste" ? "Import Quote" : "Review Imported Lines"}
      onClose={close}
      size="wide"
    >
      {step === "paste" ? (
        <div class="flex flex-col gap-md">
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
            Paste a Lowe&apos;s / Home Depot / lumber-yard order summary, or attach a quote PDF /
            cart screenshot. Nothing is saved until you confirm the review step.
          </p>
          <FormField label="Quote text">
            <textarea
              class="form-textarea"
              rows={10}
              placeholder={"Item\tQty\tPrice\n2x6x16 PT lumber\t25\t$17.68\n..."}
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            />
          </FormField>
          <FormField label="PDF or screenshot (optional)">
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp,.pdf"
              onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0] ?? null;
                onFile(f);
              }}
            />
            {fileName && (
              <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                {fileName}
              </span>
            )}
          </FormField>
          <div class="flex justify-end gap-sm">
            <Button variant="secondary" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={extract} disabled={busy}>
              {busy ? "Extracting…" : "Extract Lines"}
            </Button>
          </div>
        </div>
      ) : (
        <div class="flex flex-col gap-md">
          <FormField
            label="Vendor"
            inputProps={{
              value: vendor,
              placeholder: "Lowe's",
              onInput: (e) => setVendor((e.target as HTMLInputElement).value),
            }}
          />

          {mismatch && (
            <div class="callout callout--warning" style={{ fontSize: "var(--text-sm)" }}>
              Extracted lines total {formatCurrency(checkedSum)}, but the quote total was{" "}
              {formatCurrency(quoteTotal!)} — some items may be missing or a fee/tax line
              wasn&apos;t imported. Review before confirming.
            </div>
          )}

          {lines.length === 0 ? (
            <p class="text--muted">No lines extracted. Go back and try different text.</p>
          ) : (
            <div class="import-quote-review" style={{ overflowX: "auto" }}>
              <table class="data-table" style={{ width: "100%", fontSize: "var(--text-sm)" }}>
                <thead>
                  <tr>
                    <th>Include</th>
                    <th>Description</th>
                    <th>SKU</th>
                    <th>Qty</th>
                    <th>Unit</th>
                    <th>Unit cost</th>
                    <th>Total</th>
                    <th>Price book</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={idx}>
                      <td>
                        <input
                          type="checkbox"
                          checked={l.include}
                          onChange={(e) =>
                            updateLine(idx, { include: (e.target as HTMLInputElement).checked })
                          }
                        />
                      </td>
                      <td>
                        <input
                          class="form-input"
                          value={l.description}
                          onInput={(e) =>
                            updateLine(idx, {
                              description: (e.target as HTMLInputElement).value,
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          class="form-input"
                          value={l.sku ?? ""}
                          onInput={(e) =>
                            updateLine(idx, {
                              sku: (e.target as HTMLInputElement).value || null,
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          class="form-input"
                          type="number"
                          step="any"
                          value={l.quantity ?? ""}
                          onInput={(e) => {
                            const v = (e.target as HTMLInputElement).value;
                            updateLine(idx, { quantity: v === "" ? null : Number(v) });
                          }}
                        />
                      </td>
                      <td>
                        <input
                          class="form-input"
                          value={l.unit ?? ""}
                          onInput={(e) =>
                            updateLine(idx, {
                              unit: (e.target as HTMLInputElement).value || null,
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          class="form-input"
                          type="number"
                          step="0.01"
                          value={l.unit_cost ?? ""}
                          onInput={(e) => {
                            const v = (e.target as HTMLInputElement).value;
                            updateLine(idx, { unit_cost: v === "" ? null : Number(v) });
                          }}
                        />
                      </td>
                      <td>{formatCurrency(lineTotal(l))}</td>
                      <td>
                        <label class="flex items-center gap-xs" style={{ whiteSpace: "nowrap" }}>
                          <input
                            type="checkbox"
                            checked={l.save_to_price_book}
                            onChange={(e) =>
                              updateLine(idx, {
                                save_to_price_book: (e.target as HTMLInputElement).checked,
                              })
                            }
                          />
                          Save
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div class="flex justify-between gap-sm">
            {!hideBackToPaste ? (
              <Button variant="tertiary" onClick={() => setStep("paste")} disabled={busy}>
                ← Back
              </Button>
            ) : (
              <span />
            )}
            <div class="flex gap-sm">
              <Button variant="secondary" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" onClick={confirm} disabled={busy || checked.length === 0}>
                {busy ? "Importing…" : `Confirm ${checked.length} line${checked.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
