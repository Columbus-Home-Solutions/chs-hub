/**
 * Automated fresh-estimate BoldSign E2E:
 *   create → line item + schedule + selection → send → confirm-all →
 *   field-size proof → Playwright sign both docs → PDF evidence
 *
 *   node scripts/e2e-boldsign-estimate-sign.mjs
 *
 * Auth: scripts/.e2e-cookie.local (CF_Authorization) + .env SYNC_TRIGGER_SECRET
 * Evidence written to /tmp/chs-boldsign-e2e-<timestamp>/
 */

import { chromium } from "../frontend/node_modules/playwright/index.mjs";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let fitz = null;
try {
  fitz = require("pymupdf"); // may not resolve — use python below
} catch {
  /* use python fitz */
}

const ROOT = process.cwd();
const BASE = process.env.E2E_BASE ?? "https://dashboard.homesolutionsar.com";
const CLIENT = "7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c"; // ZZTEST-PRELAUNCH
const EMAIL = "tony@homesolutionsar.com";
const OUT = join(
  "/tmp",
  `chs-boldsign-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
mkdirSync(OUT, { recursive: true });

function loadCookie() {
  const p = join(ROOT, "scripts", ".e2e-cookie.local");
  if (!existsSync(p)) throw new Error("Missing scripts/.e2e-cookie.local");
  let c = readFileSync(p, "utf8").trim();
  if (!c.startsWith("CF_Authorization=")) {
    if (c.includes("CF_Authorization=")) {
      c = c
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("CF_Authorization="));
    } else {
      c = `CF_Authorization=${c}`;
    }
  }
  return c;
}

function loadSyncSecret() {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    if (line.startsWith("SYNC_TRIGGER_SECRET=")) {
      return line.slice("SYNC_TRIGGER_SECRET=".length).trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("SYNC_TRIGGER_SECRET missing from .env");
}

const COOKIE = loadCookie();
const SYNC = loadSyncSecret();
const log = (...a) => console.log(...a);
const evidence = { steps: [], out: OUT };

function note(step, data) {
  evidence.steps.push({ step, at: new Date().toISOString(), ...data });
  log(`✓ ${step}`, data && Object.keys(data).length ? JSON.stringify(data).slice(0, 240) : "");
}

async function api(method, path, body, { public: isPublic = false } = {}) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cf-Access-Authenticated-User-Email": EMAIL,
    Cookie: COOKIE,
  };
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: isPublic ? { Accept: "application/json", "Content-Type": "application/json" } : headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (text.includes("Cloudflare Access") && text.includes("<!DOCTYPE")) {
    throw new Error(`Access login page on ${method} ${path} — refresh E2E cookie`);
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json;
}

async function ops(pathQs) {
  const res = await fetch(`https://chs-hub.tony-bc5.workers.dev${pathQs}`, {
    method: "POST",
    headers: { "User-Agent": "chs-e2e", "x-sync-token": SYNC },
  });
  const json = await res.json();
  if (!res.ok && json.error) throw new Error(`ops ${pathQs}: ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function pollContractDoc(estimateId, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const rows = d1Json(
      `SELECT id, signature_data FROM documents
        WHERE estimate_id='${estimateId}' AND document_category='contract'
          AND COALESCE(is_active,1)=1
        ORDER BY datetime(updated_at) DESC LIMIT 1`,
    );
    if (rows[0]?.signature_data) {
      const meta = JSON.parse(rows[0].signature_data);
      if (meta.boldsign_document_id) {
        return { docId: rows[0].id, meta };
      }
    }
    await wait(2000);
  }
  throw new Error("contract BoldSign document not ready");
}

function d1Json(sql) {
  const r = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "chs-hub-db", "--remote", "--json", "--command", sql],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 10_000_000 },
  );
  if (r.status !== 0) throw new Error(`d1 failed: ${r.stderr || r.stdout}`);
  const start = r.stdout.indexOf("[");
  const data = JSON.parse(r.stdout.slice(start));
  return data[0]?.results ?? [];
}

async function probeFields(documentId, label) {
  for (let i = 0; i < 12; i++) {
    const p = await ops(
      `/api/ops/boldsign-ghost-proof?document_id=${documentId}&properties_only=1`,
    );
    if (p.formFields?.length) {
      note(`fields:${label}`, {
        status: p.boldSignStatus,
        formFields: p.formFields,
        signatureFieldOk: p.signatureFieldOk,
      });
      return p;
    }
    await wait(2500);
  }
  throw new Error(`No form fields for ${label} ${documentId}`);
}

async function signWithPlaywright(signLink, label) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const shots = [];
  try {
    await page.goto(signLink, { waitUntil: "domcontentloaded", timeout: 60000 });
    await wait(3000);
    const shot1 = join(OUT, `${label}-01-loaded.png`);
    await page.screenshot({ path: shot1, fullPage: true });
    shots.push(shot1);

    // Dismiss common consent / cookie banners if present
    for (const sel of [
      "button:has-text('Accept')",
      "button:has-text('I Agree')",
      "button:has-text('Continue')",
      "text=Got it",
    ]) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        await btn.click().catch(() => undefined);
      }
    }

    // Click the signature field — BoldSign labels vary
    const fieldSelectors = [
      "text=Sign Here",
      "[data-field-type='Signature']",
      ".signature-field",
      ".bs-field-signature",
      "div[title*='Sign']",
      "canvas",
    ];
    let clicked = false;
    for (const sel of fieldSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
        await loc.click({ force: true });
        clicked = true;
        note(`playwright:${label}:clicked`, { sel });
        break;
      }
    }
    if (!clicked) {
      // Click approximate signature area on right side of page
      await page.mouse.click(900, 500);
      note(`playwright:${label}:fallback-click`, {});
    }

    await wait(1500);
    const shot2 = join(OUT, `${label}-02-after-sign-click.png`);
    await page.screenshot({ path: shot2, fullPage: true });
    shots.push(shot2);

    // Type-to-sign if available
    const typeTab = page.locator("text=Type").first();
    if (await typeTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await typeTab.click();
    }
    const nameInput = page
      .locator(
        "input[placeholder*='name' i], input[aria-label*='name' i], input[type='text']",
      )
      .first();
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill("ZZTEST-PRELAUNCH Test Client");
    } else {
      // Draw on canvas if present
      const canvas = page.locator("canvas").last();
      if (await canvas.isVisible({ timeout: 2000 }).catch(() => false)) {
        const box = await canvas.boundingBox();
        if (box) {
          await page.mouse.move(box.x + 20, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 12 });
          await page.mouse.up();
        }
      }
    }

    for (const labelText of [
      "Adopt and Sign",
      "Adopt & Sign",
      "Finish",
      "Complete Signing",
      "Sign",
      "Done",
      "Apply",
    ]) {
      const b = page.locator(`button:has-text("${labelText}")`).first();
      if (await b.isVisible({ timeout: 1200 }).catch(() => false)) {
        await b.click();
        note(`playwright:${label}:button`, { labelText });
        await wait(1500);
      }
    }

    // Date field if separate
    const dateField = page.locator("text=Date").first();
    if (await dateField.isVisible({ timeout: 1000 }).catch(() => false)) {
      await dateField.click().catch(() => undefined);
    }

    for (const labelText of ["Finish", "Complete", "Submit", "Done"]) {
      const b = page.locator(`button:has-text("${labelText}")`).first();
      if (await b.isVisible({ timeout: 1500 }).catch(() => false)) {
        await b.click();
        note(`playwright:${label}:finish`, { labelText });
        await wait(3000);
      }
    }

    const shot3 = join(OUT, `${label}-03-after-finish.png`);
    await page.screenshot({ path: shot3, fullPage: true });
    shots.push(shot3);

    return { shots, url: page.url(), title: await page.title() };
  } finally {
    await browser.close();
  }
}

function analyzePdfPython(pdfPath, label) {
  const py = `
import fitz, json, sys
doc = fitz.open(${JSON.stringify(pdfPath)})
pages = []
all_text = []
has_drawing = False
for i, page in enumerate(doc):
    t = page.get_text("text")
    all_text.append(t)
    imgs = page.get_images()
    drawings = page.get_drawings()
    # Render page  (last page usually has signature)
    pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
    out = ${JSON.stringify(join(OUT, `${label}-page`))} + f"-{i+1}.png"
    pix.save(out)
    pages.append({"page": i+1, "images": len(imgs), "drawings": len(drawings), "png": out, "text_len": len(t)})
text = "\\n".join(all_text)
result = {
  "pages": pages,
  "has_sign_tag": "{{sign|" in text,
  "has_date_tag": "{{date|" in text,
  "has_document_id": bool(__import__("re").search(r"Document\\s*ID\\s*:", text, __import__("re").I)),
  "has_client_name": "ZZTEST" in text or "Test Client" in text,
  "text_sample": text[-1200:],
  "text_len": len(text),
}
# Heuristic: signed PDFs usually have images (signature graphic) or ink drawings
result["has_signature_graphic"] = any(p["images"] > 0 for p in pages) or any(p["drawings"] > 5 for p in pages)
print(json.dumps(result))
`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf8", maxBuffer: 20_000_000 });
  if (r.status !== 0) throw new Error(`pdf analyze failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

async function downloadBoldSignPdf(documentId, dest) {
  // Use ops full scan path — may 429; fallback to wrangler-less fetch via worker properties then...
  // Prefer a dedicated download through ghost-proof which already downloads.
  const res = await fetch(
    `https://chs-hub.tony-bc5.workers.dev/api/ops/boldsign-ghost-proof?document_id=${documentId}`,
    { method: "POST", headers: { "User-Agent": "chs-e2e", "x-sync-token": SYNC } },
  );
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  // Ops doesn't return raw PDF bytes — download via BoldSign using a tiny inline worker trick:
  // Use Python + store from R2 after webhook. Poll documents table for signed_r2_key.
  return json;
}

async function waitSignedAndFetchPdf(estimateId, category, boldId, label) {
  for (let i = 0; i < 40; i++) {
    const rows = d1Json(
      `SELECT id, r2_key, signature_data, is_signed FROM documents
        WHERE (estimate_id='${estimateId}' OR json_extract(signature_data,'$.estimate_id')='${estimateId}')
          AND document_category='${category}'
          AND COALESCE(is_active,1)=1
        ORDER BY datetime(updated_at) DESC LIMIT 3`,
    );
    for (const row of rows) {
      let meta = {};
      try {
        meta = JSON.parse(row.signature_data || "{}");
      } catch {
        /* ignore */
      }
      const status = meta.signature_status;
      const key = meta.signed_r2_key || row.r2_key;
      if (
        (status === "completed" || row.is_signed === 1) &&
        key &&
        String(key).endsWith(".pdf")
      ) {
        const dest = join(OUT, `${label}-signed.pdf`);
        const get = spawnSync(
          "npx",
          ["wrangler", "r2", "object", "get", `chs-hub-files/${key}`, "--remote", `--file=${dest}`],
          { cwd: ROOT, encoding: "utf8" },
        );
        if (get.status === 0 && existsSync(dest)) {
          note(`pdf:${label}`, { key, status, dest });
          return { dest, meta, key };
        }
      }
      // Also try BoldSign download via curl through ops — skip if quota
    }
    // Direct BoldSign download using a one-shot properties won't give PDF.
    // Use Cloudflare REST if R2 not ready yet — poll BoldSign completed status
    const props = await ops(
      `/api/ops/boldsign-ghost-proof?document_id=${boldId}&properties_only=1`,
    ).catch(() => null);
    if (props?.boldSignStatus === "Completed") {
      note(`boldsign-completed:${label}`, { boldId });
      // Try download via temporary python boldsign — need API key from worker.
      // Fall through: request worker to download by using ghost-proof (stores nothing).
    }
    await wait(3000);
  }
  throw new Error(`Signed PDF not available for ${label}`);
}

async function downloadPdfViaOpsBytes(documentId, dest) {
  // Extend: call BoldSign download using SYNC-gated endpoint that returns base64 — add quick path
  const res = await fetch(
    `https://chs-hub.tony-bc5.workers.dev/api/ops/boldsign-ghost-proof?document_id=${documentId}&return_pdf_b64=1`,
    { method: "POST", headers: { "User-Agent": "chs-e2e", "x-sync-token": SYNC } },
  );
  const json = await res.json();
  if (json.pdf_b64) {
    writeFileSync(dest, Buffer.from(json.pdf_b64, "base64"));
    return dest;
  }
  throw new Error(json.error || "no pdf_b64");
}

async function main() {
  log("OUT", OUT);

  // ── Step 0: fresh estimate ───────────────────────────────────────────────
  const created = await api("POST", "/api/estimates", {
    client_id: CLIENT,
    title: `E2E BoldSign Fresh — ${new Date().toISOString().slice(0, 16)}`,
    mode: "trade_by_trade",
    billing_model: "fixed_price",
  });
  const estimate = created.estimate;
  const estimateId = estimate.id;
  const estNum = estimate.estimate_number;
  note("create-estimate", { estimateId, estNum });

  await api("POST", `/api/estimates/${estimateId}/line-items`, {
    product_service: "E2E Demo Remodel Allowance Line",
    description: "Automated E2E line item — DELETE-ME",
    quantity: 1,
    unit_price: 2500,
  });
  note("line-item", {});

  await api("PUT", `/api/estimates/${estimateId}/payment-schedule`, {
    milestones: [
      {
        description: "Deposit",
        percentage: 30,
        is_deposit: 1,
        sort_order: 0,
      },
      {
        description: "Final",
        percentage: 70,
        is_deposit: 0,
        sort_order: 1,
      },
    ],
  });
  note("payment-schedule", {});

  const sel = await api("POST", `/api/estimates/${estimateId}/selections`, {
    title: "Flooring Allowance",
    category: "flooring",
    allowance_amount: 1000,
    required: true,
    choices: [
      { title: "LVP Standard", price: 900, description: "E2E choice A" },
      { title: "Hardwood Upgrade", price: 1400, description: "E2E choice B" },
    ],
  });
  let selId = sel.id;
  let chId = sel.choices?.[0]?.id;
  if (!selId || !chId) {
    const list = await api("GET", `/api/estimates/${estimateId}/selections`);
    const s0 = (list.selections ?? [])[0];
    if (!s0?.id || !s0.choices?.[0]?.id) throw new Error("selection create failed");
    selId = s0.id;
    chId = s0.choices[0].id;
  }
  note("selection-created", { selId, chId });

  const sent = await api("POST", `/api/estimates/${estimateId}/send`, {});
  note("estimate-sent", {
    status: sent.estimate?.status ?? sent.status,
    portal_token: sent.estimate?.portal_token ? "yes" : "no",
  });

  const portalToken =
    sent.estimate?.portal_token ||
    d1Json(`SELECT portal_token FROM estimates WHERE id='${estimateId}'`)[0]?.portal_token;
  if (!portalToken) throw new Error("no portal_token after send");
  note("portal-token", { tokenPrefix: portalToken.slice(0, 8) });

  const contract = await pollContractDoc(estimateId);
  note("contract-doc", {
    docId: contract.docId,
    boldsign: contract.meta.boldsign_document_id,
    sigStatus: contract.meta.signature_status,
  });

  // Wait for BoldSign processing then probe fields
  await wait(5000);
  const contractFields = await probeFields(contract.meta.boldsign_document_id, "contract");
  if (!contractFields.signatureFieldOk) {
    throw new Error(`Contract signature field collapsed: ${JSON.stringify(contractFields.formFields)}`);
  }

  // Choose + confirm-all (sends selection approval)
  await api(
    "POST",
    `/api/public/quote/${portalToken}/selections/${selId}/choose`,
    { choice_id: chId },
    { public: true },
  );
  note("selection-chosen", { selId, chId });

  const confirm = await api(
    "POST",
    `/api/public/quote/${portalToken}/selections/confirm-all`,
    {},
    { public: true },
  );
  const selBoldId = confirm.boldsign_document_id;
  note("selection-confirm-all", {
    boldsign: selBoldId,
    hasSignLink: Boolean(confirm.sign_link),
  });
  if (!selBoldId) throw new Error("confirm-all did not return boldsign_document_id");

  await wait(5000);
  const selFields = await probeFields(selBoldId, "selection");
  if (!selFields.signatureFieldOk) {
    throw new Error(`Selection signature field collapsed: ${JSON.stringify(selFields.formFields)}`);
  }

  // Sign links
  const contractLink = await api("GET", `/api/public/quote/${portalToken}/sign-link`, null, {
    public: true,
  });
  const selLink = await api(
    "GET",
    `/api/public/quote/${portalToken}/selections/sign-link`,
    null,
    { public: true },
  );
  note("sign-links", {
    contract: Boolean(contractLink.sign_link),
    selection: Boolean(selLink.sign_link),
  });

  const contractSign = await signWithPlaywright(contractLink.sign_link, "contract");
  note("signed-contract-widget", { title: contractSign.title, shots: contractSign.shots.length });

  const selSign = await signWithPlaywright(selLink.sign_link, "selection");
  note("signed-selection-widget", { title: selSign.title, shots: selSign.shots.length });

  // Wait for completion + PDFs
  let contractPdf;
  let selectionPdf;
  try {
    contractPdf = await waitSignedAndFetchPdf(
      estimateId,
      "contract",
      contract.meta.boldsign_document_id,
      "contract",
    );
  } catch (e) {
    note("contract-pdf-r2-miss", { error: String(e.message) });
    try {
      const dest = join(OUT, "contract-signed.pdf");
      await downloadPdfViaOpsBytes(contract.meta.boldsign_document_id, dest);
      contractPdf = { dest };
      note("contract-pdf-ops", { dest });
    } catch (e2) {
      note("contract-pdf-fail", { error: String(e2.message) });
    }
  }

  try {
    selectionPdf = await waitSignedAndFetchPdf(estimateId, "selection_approval", selBoldId, "selection");
  } catch (e) {
    note("selection-pdf-r2-miss", { error: String(e.message) });
    try {
      const dest = join(OUT, "selection-signed.pdf");
      await downloadPdfViaOpsBytes(selBoldId, dest);
      selectionPdf = { dest };
      note("selection-pdf-ops", { dest });
    } catch (e2) {
      note("selection-pdf-fail", { error: String(e2.message) });
    }
  }

  const analysis = {};
  if (contractPdf?.dest && existsSync(contractPdf.dest)) {
    analysis.contract = analyzePdfPython(contractPdf.dest, "contract");
    note("analyze-contract", {
      has_sign_tag: analysis.contract.has_sign_tag,
      has_document_id: analysis.contract.has_document_id,
      has_signature_graphic: analysis.contract.has_signature_graphic,
    });
  }
  if (selectionPdf?.dest && existsSync(selectionPdf.dest)) {
    analysis.selection = analyzePdfPython(selectionPdf.dest, "selection");
    note("analyze-selection", {
      has_sign_tag: analysis.selection.has_sign_tag,
      has_document_id: analysis.selection.has_document_id,
      has_signature_graphic: analysis.selection.has_signature_graphic,
    });
  }

  const verdict = {
    estimateId,
    estNum,
    contractFieldOk: contractFields.signatureFieldOk,
    selectionFieldOk: selFields.signatureFieldOk,
    contractFields: contractFields.formFields,
    selectionFields: selFields.formFields,
    contractPdf: contractPdf?.dest ?? null,
    selectionPdf: selectionPdf?.dest ?? null,
    analysis,
    out: OUT,
  };

  const resolved =
    verdict.contractFieldOk &&
    verdict.selectionFieldOk &&
    analysis.contract &&
    analysis.selection &&
    !analysis.contract.has_sign_tag &&
    !analysis.selection.has_sign_tag &&
    !analysis.contract.has_document_id &&
    !analysis.selection.has_document_id &&
    analysis.contract.has_signature_graphic &&
    analysis.selection.has_signature_graphic;

  verdict.resolved = Boolean(resolved);
  writeFileSync(join(OUT, "evidence.json"), JSON.stringify({ evidence, verdict }, null, 2));
  log("\n======== VERDICT ========");
  log(JSON.stringify(verdict, null, 2));
  log("Evidence dir:", OUT);
  if (!resolved) process.exitCode = 2;
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  writeFileSync(join(OUT, "error.txt"), String(e.stack || e));
  process.exit(1);
});
