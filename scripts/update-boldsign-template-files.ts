/**
 * update-boldsign-template-files.ts
 *
 * Replaces the underlying DOCX on existing BoldSign templates.
 * BoldSign documents that file replacement is dashboard-only; this script
 * attempts multipart PUT /v1/template/edit with Files, then falls back to
 * printing manual Replace steps if the API rejects file changes.
 *
 * Usage:
 *   BOLDSIGN_API_KEY=... npx tsx scripts/update-boldsign-template-files.ts
 */

import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://api.boldsign.com";
const PREPPED_DIR = path.join(process.cwd(), "src/templates/prepped");

const TEMPLATES: { file: string; templateId: string; label: string }[] = [
  { file: "service-agreement.docx", templateId: "1578f4a8-a7af-4792-b091-6dc2520397a4", label: "Service Agreement" },
  { file: "cost-plus-agreement.docx", templateId: "6e28b9a4-af85-4c1b-a68d-ffb33af9b736", label: "Cost-Plus Agreement" },
  { file: "change-order.docx", templateId: "3fe5a120-b44e-4c60-8254-28259de7d44e", label: "Change Order" },
  { file: "lien-waiver-sub-unconditional.docx", templateId: "82223390-cff1-4f2e-9320-22dee1e4d0f7", label: "Sub Lien Waiver (Unconditional)" },
];

async function tryMultipartReplace(
  apiKey: string,
  templateId: string,
  filePath: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const blob = new Blob([fs.readFileSync(filePath)], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const form = new FormData();
  form.append("Files", blob, path.basename(filePath));

  const res = await fetch(`${API_BASE}/v1/template/edit?templateId=${encodeURIComponent(templateId)}`, {
    method: "PUT",
    headers: { "X-API-KEY": apiKey },
    body: form,
  });
  const body = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body: body.slice(0, 300) };
}

async function main() {
  const apiKey = (process.env.BOLDSIGN_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("Set BOLDSIGN_API_KEY to run automated BoldSign file updates.");
    console.error("Manual fallback: BoldSign → Templates → Edit template → Replace file");
    for (const t of TEMPLATES) {
      console.error(`  ${t.label}: ${t.templateId} ← ${path.join(PREPPED_DIR, t.file)}`);
    }
    process.exit(1);
  }

  let anyFailed = false;
  for (const t of TEMPLATES) {
    const filePath = path.join(PREPPED_DIR, t.file);
    if (!fs.existsSync(filePath)) {
      console.error(`✗ Missing ${filePath}`);
      anyFailed = true;
      continue;
    }

    console.log(`Updating ${t.label} (${t.templateId}) ...`);
    const result = await tryMultipartReplace(apiKey, t.templateId, filePath);
    if (result.ok || result.status === 204) {
      console.log(`✓ ${t.label} — API accepted (${result.status})`);
    } else {
      anyFailed = true;
      console.error(`✗ ${t.label} — API ${result.status}: ${result.body}`);
      console.error(`  Manual: Edit template ${t.templateId} → Replace → ${filePath}`);
    }
  }

  if (anyFailed) {
    console.error("\nSome templates need manual Replace in the BoldSign dashboard (API cannot swap template files).");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
