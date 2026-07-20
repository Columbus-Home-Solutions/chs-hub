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
const RESUME_SETUP = process.env.RESUME_SETUP || "";
const OUT = join(
  "/tmp",
  RESUME_SETUP
    ? `chs-boldsign-e2e-resume-${new Date().toISOString().replace(/[:.]/g, "-")}`
    : `chs-boldsign-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`,
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const shots = [];
  const shot = async (name) => {
    const p = join(OUT, `${label}-${name}.png`);
    await page.screenshot({ path: p, fullPage: true });
    shots.push(p);
  };
  const topBtn = () =>
    page.locator("#btnContinueNext, #btnDesktopNext, button:has-text('Start signing'), button:has-text('Next field'), button:has-text('Finish')").first();

  try {
    await page.goto(signLink, { waitUntil: "domcontentloaded", timeout: 90000 });
    await wait(4500);
    await shot("01-loaded");

    // Reload if BoldSign reports stale state from a prior session
    const reloadBtn = page.getByRole("button", { name: /Reload Document/i }).first();
    if (await reloadBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await reloadBtn.click({ force: true });
      note(`reload:${label}`, {});
      await wait(4000);
    }

    // Already completed
    const initialBody = await page.locator("body").innerText().catch(() => "");
    if (/you have already signed|Completed/i.test(initialBody) && !/Required fields left\s*[1-9]/i.test(initialBody)) {
      note(`already-signed:${label}`, {});
      await shot("06-done");
      return { shots, url: page.url(), title: await page.title(), bodyText: initialBody };
    }

    // 1) Disclosure — #agreeCheckbox is opacity:0; force-check then #btnContinue
    const agreeBox = await page.locator("#agreeCheckbox").boundingBox().catch(() => null);
    if (agreeBox && agreeBox.width + agreeBox.height > 0) {
      await page.locator("#agreeCheckbox").check({ force: true });
      await page.locator("#btnContinue, button.bs-btn-continue-width").first().click({ force: true });
      await page
        .getByText("Message from the sender")
        .first()
        .waitFor({ state: "hidden", timeout: 10000 })
        .catch(() => undefined);
      note(`disclosure:${label}`, { cleared: true });
      await wait(1200);
    } else {
      note(`disclosure:${label}`, { present: false });
    }
    await shot("02-after-disclosure");

    // 2) Start signing / Next field
    await topBtn().click({ force: true });
    note(`start:${label}`, {
      txt: ((await topBtn().innerText().catch(() => "")) || "").trim(),
    });
    await wait(2500);
    await shot("03-at-field");

    // 3) Open signature modal — Sign Here may sit below the viewport
    let opened = await page
      .locator("button")
      .filter({ hasText: /Save\s*&\s*use/i })
      .first()
      .isVisible()
      .catch(() => false);
    for (let attempt = 0; attempt < 4 && !opened; attempt++) {
      const sh = page.getByText(/Sign Here/i).first();
      await sh.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => undefined);
      await wait(400);
      const box = await sh.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await wait(400);
        await page.mouse.click(box.x + box.width / 2, Math.max(10, box.y - 8));
      }
      await wait(1200);
      opened = await page
        .locator("button")
        .filter({ hasText: /Save\s*&\s*use/i })
        .first()
        .isVisible()
        .catch(() => false);
      if (!opened) {
        const ins = page.getByText(/Insert Signature/i).first();
        if (await ins.isVisible().catch(() => false)) {
          const ib = await ins.boundingBox();
          if (ib) await page.mouse.click(ib.x + ib.width / 2, ib.y + ib.height / 2);
          await wait(1200);
          opened = await page
            .locator("button")
            .filter({ hasText: /Save\s*&\s*use/i })
            .first()
            .isVisible()
            .catch(() => false);
        }
      }
    }
    note(`modal:${label}`, { opened });
    await shot("04-sign-dialog");

    if (opened) {
      const typeTab = page.getByRole("tab", { name: "Type" });
      if (await typeTab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await typeTab.click({ force: true });
      }
      const nameInput = page
        .locator(".e-dlg-content input[type='text'], input[placeholder*='name' i]")
        .first();
      if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nameInput.fill("ZZTEST-PRELAUNCH Test Client");
        note(`typed-name:${label}`, {});
        await wait(1200);
      }

      const style = await page.evaluate(() => {
        const dlg = Array.from(document.querySelectorAll(".e-dialog, [role='dialog'], .e-dlg-content")).find(
          (el) => /signature/i.test(el.innerText || "") && el.getBoundingClientRect().width > 200,
        );
        const root = dlg || document;
        const candidates = Array.from(root.querySelectorAll("div, span, canvas, img, li")).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 80 && r.width < 400 && r.height > 20 && r.height < 100;
        });
        const tile =
          candidates.find((el) => /ZZTEST|Test Client/i.test(el.textContent || "")) || candidates[0];
        if (tile) {
          tile.click();
          return (tile.textContent || tile.tagName || "").trim().slice(0, 40);
        }
        return null;
      });
      note(`style:${label}`, { style });
      await wait(400);
      await page.locator(".e-dlg-content input[type=checkbox]").last().check({ force: true }).catch(() => undefined);

      const save = page.locator("button").filter({ hasText: /Save\s*&\s*use/i }).first();
      await save.click({ force: true });
      note(`btn:${label}`, { labelText: "Save & use" });
      await wait(3000);

      if (await page.getByText(/Choose your signature type/i).first().isVisible().catch(() => false)) {
        await page.evaluate(() => {
          const dlg = Array.from(document.querySelectorAll(".e-dialog, [role='dialog']")).find(
            (el) => el.getBoundingClientRect().width > 200,
          );
          if (!dlg) return;
          const tiles = Array.from(dlg.querySelectorAll("div")).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 100 && r.height > 30 && r.height < 80;
          });
          tiles[0]?.click();
        });
        await wait(300);
        await save.click({ force: true });
        await wait(2500);
      }
    }
    await shot("05-after-adopt");

    // 5) Finish in the SAME session (closing early drops uncommitted signature)
    for (let i = 0; i < 8; i++) {
      const body = await page.locator("body").innerText();
      const filled = /All required fields have been filled/i.test(body);
      const done = /thank you|successfully signed|signing is complete|you have completed|document has been signed/i.test(
        body,
      );
      const finish = page.getByRole("button", { name: "Finish", exact: true }).first();
      const finishVis = await finish.isVisible().catch(() => false);
      const nextTxt = ((await topBtn().innerText().catch(() => "")) || "").trim();
      note(`loop:${label}`, { i, filled, finishVis, nextTxt, done });
      if (done) break;

      if (finishVis || /finish/i.test(nextTxt) || filled) {
        if (finishVis) await finish.click({ force: true });
        else await topBtn().click({ force: true });
        note(`finish:${label}`, { attempt: i + 1 });
        await wait(3500);
        for (const nm of ["Yes", "Confirm", "OK"]) {
          const b = page.getByRole("button", { name: nm, exact: true });
          if (await b.isVisible({ timeout: 800 }).catch(() => false)) {
            await b.click({ force: true });
            note(`confirm:${label}`, { nm });
            await wait(1500);
          }
        }
        continue;
      }

      const date = page.getByText(/Insert Date/i).first();
      if (await date.isVisible().catch(() => false)) {
        await date.click({ force: true });
        await wait(1000);
        continue;
      }

      if (nextTxt) {
        await topBtn().click({ force: true });
        await wait(2000);
      } else {
        break;
      }
    }

    await shot("06-done");
    const bodyText = await page.locator("body").innerText().catch(() => "");
    note(`done-text:${label}`, {
      snippet: bodyText.replace(/\s+/g, " ").slice(0, 280),
      filled: /All required fields have been filled/i.test(bodyText),
      completed: /thank you|successfully signed|signing is complete|you have completed|document has been signed/i.test(
        bodyText,
      ),
    });
    return { shots, url: page.url(), title: await page.title(), bodyText };
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
visible_tags = []
for i, page in enumerate(doc):
    t = page.get_text("text")
    all_text.append(t)
    d = page.get_text("dict")
    for block in d.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                st = span.get("text", "")
                if "{{sign|" in st or "{{date|" in st:
                    color = span.get("color", 0)
                    r,g,b = (color>>16)&255, (color>>8)&255, color&255
                    invisible = r>=250 and g>=250 and b>=250
                    visible_tags.append({"page": i+1, "text": st, "rgb":[r,g,b], "invisible_white": invisible})
    pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
    out = ${JSON.stringify(join(OUT, `${label}-page`))} + f"-{i+1}.png"
    pix.save(out)
    pages.append({"page": i+1, "images": len(page.get_images()), "drawings": len(page.get_drawings()), "png": out})
text = "\\n".join(all_text)
print(json.dumps({
  "pages": pages,
  "text_layer_has_tags": ("{{sign|" in text) or ("{{date|" in text),
  "visible_ghost_tags": any(not v["invisible_white"] for v in visible_tags),
  "tag_spans": visible_tags,
  "has_document_id": bool(re.search(r"Document\\s*ID\\s*:", text, re.I)),
  "has_client_name": ("ZZTEST" in text) or ("Test Client" in text),
  "has_signature_graphic": any(p["images"] > 0 for p in pages) or any(p["drawings"] > 5 for p in pages),
  "date_present": ("07/19/2026" in text) or ("7/19/2026" in text),
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
  // BoldSign sandbox: 50 API calls/hour — poll sparsely.
  for (let i = 0; i < 12; i++) {
    let p;
    try {
      p = await ops(
        `/api/ops/boldsign-ghost-proof?document_id=${documentId}&properties_only=1`,
      );
    } catch (e) {
      const msg = String(e.message || e);
      note(`status:${label}`, { error: msg.slice(0, 160), attempt: i + 1 });
      if (/429|quota/i.test(msg)) {
        await wait(60_000);
        continue;
      }
      throw e;
    }
    note(`status:${label}`, { status: p.boldSignStatus, attempt: i + 1 });
    if (String(p.boldSignStatus || "").toLowerCase() === "completed") return p;
    const signerDone = (p.signerDetails || []).some((s) =>
      /completed|signed/i.test(String(s.status || "")),
    );
    if (signerDone && /completed|signed/i.test(String(p.boldSignStatus || ""))) return p;
    await wait(15_000);
  }
  return null;
}

async function main() {
  log("OUT", OUT);
  note("setup-start", { resume: Boolean(RESUME_SETUP) });

  let setup;
  if (RESUME_SETUP) {
    setup = JSON.parse(readFileSync(RESUME_SETUP, "utf8"));
    note("setup-resumed", {
      from: RESUME_SETUP,
      estimateId: setup.estimateId,
      estimateNumber: setup.estimateNumber,
    });
  } else {
    setup = await ops("/api/ops/e2e-fresh-estimate-setup");
    if (!setup.ok) throw new Error(`setup failed: ${JSON.stringify(setup).slice(0, 600)}`);
  }

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

  const signOnly = process.env.SIGN_ONLY === "1";
  const verifyOnly = process.env.VERIFY_ONLY === "1";

  if (!verifyOnly) {
    const cSign = await signWithPlaywright(setup.contract.signLink, "contract");
    note("playwright-contract", { title: cSign.title, shots: cSign.shots });

    const sSign = await signWithPlaywright(setup.selection.signLink, "selection");
    note("playwright-selection", { title: sSign.title, shots: sSign.shots });
  }

  if (signOnly) {
    writeFileSync(join(OUT, "evidence.json"), JSON.stringify({ evidence, setup, mode: "sign-only" }, null, 2));
    log("\n======== SIGN-ONLY COMPLETE ========");
    log(JSON.stringify({ out: OUT, estimateNumber: setup.estimateNumber }, null, 2));
    return;
  }

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
      visible_ghost_tags: analysis.contract.visible_ghost_tags,
      has_document_id: analysis.contract.has_document_id,
      has_signature_graphic: analysis.contract.has_signature_graphic,
    },
    selection: {
      visible_ghost_tags: analysis.selection.visible_ghost_tags,
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
    !analysis.contract.visible_ghost_tags &&
    !analysis.selection.visible_ghost_tags &&
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
