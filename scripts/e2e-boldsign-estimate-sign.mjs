/**
 * Automated fresh-estimate BoldSign E2E (no Access cookie required for setup).
 *
 *   node scripts/e2e-boldsign-estimate-sign.mjs
 *
 * 1) POST /api/ops/e2e-fresh-estimate-setup → new estimate + both BoldSign sends
 * 2) Confirm signature field dimensions (not collapsed)
 * 3) Playwright signs both embed links
 * 4) Download signed PDFs + PyMuPDF evidence
 */

import { chromium } from "../frontend/node_modules/playwright/index.mjs";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const OUT = join(
  "/tmp",
  `chs-boldsign-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
mkdirSync(OUT, { recursive: true });

function loadSyncSecret() {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    if (line.startsWith("SYNC_TRIGGER_SECRET=")) {
      return line.slice("SYNC_TRIGGER_SECRET=".length).trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("SYNC_TRIGGER_SECRET missing from .env");
}

const SYNC = loadSyncSecret();
const log = (...a) => console.log(...a);
const evidence = { steps: [], out: OUT };

function note(step, data = {}) {
  evidence.steps.push({ step, at: new Date().toISOString(), ...data });
  log(`✓ ${step}`, Object.keys(data).length ? JSON.stringify(data).slice(0, 280) : "");
}

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function ops(pathQs) {
  const res = await fetch(`https://chs-hub.tony-bc5.workers.dev${pathQs}`, {
    method: "POST",
    headers: { "User-Agent": "chs-e2e", "x-sync-token": SYNC },
  });
  const json = await res.json();
  if (!res.ok && !json.ok) {
    throw new Error(`ops ${pathQs} → ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

function d1Json(sql) {
  const r = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "chs-hub-db", "--remote", "--json", "--command", sql],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 10_000_000 },
  );
  if (r.status !== 0) throw new Error(`d1 failed: ${r.stderr || r.stdout}`);
  const start = r.stdout.indexOf("[");
  return JSON.parse(r.stdout.slice(start))[0]?.results ?? [];
}

async function signWithPlaywright(signLink, label) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const shots = [];
  try {
    await page.goto(signLink, { waitUntil: "networkidle", timeout: 90000 }).catch(async () => {
      await page.goto(signLink, { waitUntil: "domcontentloaded", timeout: 60000 });
    });
    await wait(4000);
    shots.push(join(OUT, `${label}-01-loaded.png`));
    await page.screenshot({ path: shots[0], fullPage: true });

    for (const sel of [
      "button:has-text('Accept')",
      "button:has-text('I Agree')",
      "button:has-text('Agree')",
      "button:has-text('Continue')",
    ]) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click().catch(() => undefined);
        await wait(800);
      }
    }

    // Prefer frame if BoldSign uses iframe
    const frames = page.frames();
    const ctx = frames.length > 1 ? frames[frames.length - 1] : page;

    const fieldSelectors = [
      "text=Sign Here",
      "text=Sign here",
      "[data-field-type='Signature']",
      ".signature-field",
      "div[class*='signature' i]",
    ];
    let clicked = false;
    for (const sel of fieldSelectors) {
      const loc = ctx.locator(sel).first();
      if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
        await loc.click({ force: true });
        clicked = true;
        note(`click:${label}`, { sel });
        break;
      }
    }
    if (!clicked) {
      await page.mouse.click(1000, 420);
      note(`click:${label}`, { sel: "fallback-coords" });
    }

    await wait(2000);
    shots.push(join(OUT, `${label}-02-dialog.png`));
    await page.screenshot({ path: shots[1], fullPage: true });

    const typeTab = page.locator("text=Type").first();
    if (await typeTab.isVisible({ timeout: 2500 }).catch(() => false)) {
      await typeTab.click();
      await wait(500);
    }

    const nameInput = page
      .locator("input[placeholder*='name' i], input[aria-label*='signature' i], input[type='text']")
      .first();
    if (await nameInput.isVisible({ timeout: 2500 }).catch(() => false)) {
      await nameInput.fill("ZZTEST-PRELAUNCH Test Client");
      note(`typed-name:${label}`, {});
    } else {
      const canvas = page.locator("canvas").last();
      if (await canvas.isVisible({ timeout: 2000 }).catch(() => false)) {
        const box = await canvas.boundingBox();
        if (box) {
          await page.mouse.move(box.x + 30, box.y + box.height / 2);
          await page.mouse.down();
          for (let i = 1; i <= 10; i++) {
            await page.mouse.move(box.x + 30 + i * ((box.width - 60) / 10), box.y + box.height / 2 + Math.sin(i) * 8);
          }
          await page.mouse.up();
          note(`drew:${label}`, {});
        }
      }
    }

    for (const labelText of [
      "Adopt and Sign",
      "Adopt & Sign",
      "Adopt",
      "Apply",
      "Sign",
      "OK",
      "Save",
    ]) {
      const b = page.locator(`button:has-text("${labelText}")`).first();
      if (await b.isVisible({ timeout: 1200 }).catch(() => false)) {
        await b.click();
        note(`btn:${label}`, { labelText });
        await wait(2000);
      }
    }

    // Date field auto-fill often happens; click Finish
    for (const labelText of ["Finish", "Complete Signing", "Complete", "Submit", "Done"]) {
      const b = page.locator(`button:has-text("${labelText}")`).first();
      if (await b.isVisible({ timeout: 2000 }).catch(() => false)) {
        await b.click();
        note(`finish:${label}`, { labelText });
        await wait(4000);
      }
    }

    shots.push(join(OUT, `${label}-03-done.png`));
    await page.screenshot({ path: shots[2], fullPage: true });
    return { shots, url: page.url(), title: await page.title() };
  } finally {
    await browser.close();
  }
}

function analyzePdfPython(pdfPath, label) {
  const py = `
import fitz, json, re
doc = fitz.open(${JSON.stringify(pdfPath)})
pages = []
all_text = []
for i, page in enumerate(doc):
    t = page.get_text("text")
    all_text.append(t)
    pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
    out = ${JSON.stringify(join(OUT, `${label}-page`))} + f"-{i+1}.png"
    pix.save(out)
    pages.append({"page": i+1, "images": len(page.get_images()), "drawings": len(page.get_drawings()), "png": out})
text = "\\n".join(all_text)
print(json.dumps({
  "pages": pages,
  "has_sign_tag": "{{sign|" in text,
  "has_date_tag": "{{date|" in text,
  "has_document_id": bool(re.search(r"Document\\s*ID\\s*:", text, re.I)),
  "has_client_name": ("ZZTEST" in text) or ("Test Client" in text),
  "has_signature_graphic": any(p["images"] > 0 for p in pages) or any(p["drawings"] > 5 for p in pages),
  "text_sample_tail": text[-1500:],
  "text_len": len(text),
}))
`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf8", maxBuffer: 20_000_000 });
  if (r.status !== 0) throw new Error(`pdf analyze: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

async function downloadPdfB64(documentId, dest) {
  const json = await ops(
    `/api/ops/boldsign-ghost-proof?document_id=${documentId}&return_pdf_b64=1`,
  );
  if (!json.pdf_b64) throw new Error(json.error || "no pdf_b64");
  writeFileSync(dest, Buffer.from(json.pdf_b64, "base64"));
  return dest;
}

async function waitCompleted(documentId, label) {
  for (let i = 0; i < 30; i++) {
    const p = await ops(
      `/api/ops/boldsign-ghost-proof?document_id=${documentId}&properties_only=1`,
    );
    note(`status:${label}`, { status: p.boldSignStatus, attempt: i + 1 });
    if (String(p.boldSignStatus || "").toLowerCase() === "completed") return p;
    // Also accept signer completed
    const signerDone = (p.signerDetails || []).some((s) =>
      /completed|signed/i.test(String(s.status || "")),
    );
    if (signerDone && /completed|signed/i.test(String(p.boldSignStatus || ""))) return p;
    await wait(4000);
  }
  return null;
}

async function main() {
  log("OUT", OUT);
  note("setup-start", {});

  const setup = await ops("/api/ops/e2e-fresh-estimate-setup");
  if (!setup.ok) throw new Error(`setup failed: ${JSON.stringify(setup).slice(0, 600)}`);

  note("setup-done", {
    estimateId: setup.estimateId,
    estimateNumber: setup.estimateNumber,
    contractBold: setup.contract?.boldsignDocumentId,
    selectionBold: setup.selection?.boldsignDocumentId,
    contractFieldOk: setup.contract?.signatureFieldOk,
    selectionFieldOk: setup.selection?.signatureFieldOk,
    contractFields: setup.contract?.formFields,
    selectionFields: setup.selection?.formFields,
  });

  writeFileSync(join(OUT, "setup.json"), JSON.stringify(setup, null, 2));

  if (!setup.contract?.signatureFieldOk) {
    throw new Error(`Contract field collapsed: ${JSON.stringify(setup.contract?.formFields)}`);
  }
  if (!setup.selection?.signatureFieldOk) {
    throw new Error(`Selection field collapsed: ${JSON.stringify(setup.selection?.formFields)}`);
  }
  if (!setup.contract?.signLink || !setup.selection?.signLink) {
    throw new Error("Missing embed sign links from setup");
  }

  const cSign = await signWithPlaywright(setup.contract.signLink, "contract");
  note("playwright-contract", { title: cSign.title, shots: cSign.shots });

  const sSign = await signWithPlaywright(setup.selection.signLink, "selection");
  note("playwright-selection", { title: sSign.title, shots: sSign.shots });

  await waitCompleted(setup.contract.boldsignDocumentId, "contract");
  await waitCompleted(setup.selection.boldsignDocumentId, "selection");

  const contractPdf = join(OUT, "contract-final.pdf");
  const selectionPdf = join(OUT, "selection-final.pdf");
  await downloadPdfB64(setup.contract.boldsignDocumentId, contractPdf);
  await downloadPdfB64(setup.selection.boldsignDocumentId, selectionPdf);
  note("pdfs-downloaded", { contractPdf, selectionPdf });

  const analysis = {
    contract: analyzePdfPython(contractPdf, "contract"),
    selection: analyzePdfPython(selectionPdf, "selection"),
  };
  note("analysis", {
    contract: {
      has_sign_tag: analysis.contract.has_sign_tag,
      has_document_id: analysis.contract.has_document_id,
      has_signature_graphic: analysis.contract.has_signature_graphic,
    },
    selection: {
      has_sign_tag: analysis.selection.has_sign_tag,
      has_document_id: analysis.selection.has_document_id,
      has_signature_graphic: analysis.selection.has_signature_graphic,
    },
  });

  // Also check D1 webhook landed
  const d1rows = d1Json(
    `SELECT document_category,
            json_extract(signature_data,'$.signature_status') AS st,
            json_extract(signature_data,'$.boldsign_document_id') AS bid,
            is_signed
       FROM documents
      WHERE estimate_id='${setup.estimateId}'
         OR json_extract(signature_data,'$.estimate_id')='${setup.estimateId}'`,
  );
  note("d1-docs", { rows: d1rows });

  const resolved =
    setup.contract.signatureFieldOk &&
    setup.selection.signatureFieldOk &&
    !analysis.contract.has_sign_tag &&
    !analysis.selection.has_sign_tag &&
    !analysis.contract.has_document_id &&
    !analysis.selection.has_document_id &&
    analysis.contract.has_signature_graphic &&
    analysis.selection.has_signature_graphic;

  const verdict = {
    resolved,
    estimateId: setup.estimateId,
    estimateNumber: setup.estimateNumber,
    contractFields: setup.contract.formFields,
    selectionFields: setup.selection.formFields,
    analysis,
    out: OUT,
  };
  writeFileSync(join(OUT, "evidence.json"), JSON.stringify({ evidence, verdict }, null, 2));
  log("\n======== VERDICT ========");
  log(JSON.stringify(verdict, null, 2));
  if (!resolved) process.exitCode = 2;
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  writeFileSync(join(OUT, "error.txt"), String(e.stack || e));
  process.exit(1);
});
