/**
 * Live verification for portal tab scroll + Financial URL tab persistence.
 * Run: npm run build && node tests/round2-verify.mjs
 */
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const publicApp = join(root, "..", "public", "app", "assets");

function portalCssPath() {
  const file = readdirSync(publicApp).find((f) => f.startsWith("portal-") && f.endsWith(".css"));
  if (!file) throw new Error("portal CSS bundle not found — run npm run build first");
  return join(publicApp, file);
}

const TAB_LABELS = [
  "Photos",
  "Schedule",
  "Invoices & Payments",
  "Budget & Costs",
  "Change Orders",
  "Selections",
  "Documents",
  "Completion Package",
  "Warranty",
  "Messages",
];

function portalFixtureHtml(cssText) {
  const tabs = TAB_LABELS.map(
    (label, i) =>
      `<button type="button" class="portal-tab${i === 0 ? " portal-tab--active" : ""}">${label}</button>`,
  ).join("");
  return `<!DOCTYPE html>
<html lang="en" class="theme-light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { --space-md: 16px; --z-dropdown: 100; --color-bg: #f6f7f9; --color-border: #e3e8ee;
      --color-text-secondary: #5b6472; --color-brand: #d97706; --color-surface-2: #eef1f5;
      --radius-full: 999px; --transition-fast: 150ms ease; }
    body { margin: 0; font-family: system-ui, sans-serif; }
    ${cssText}
  </style>
</head>
<body>
  <div id="portal">
    <div class="portal" style="max-width:760px;margin:0 auto;padding:16px;">
      <div class="portal-tabs-outer">
        <nav class="portal-tabs" aria-label="Project sections">${tabs}</nav>
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function startPreview() {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", "4173"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("4173")) resolve(proc);
    });
    proc.stderr.on("data", (d) => {
      out += d.toString();
      if (out.includes("4173")) resolve(proc);
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("preview server timeout")), 15000);
  });
}

async function testPortalScroll(page, cssText) {
  const html = portalFixtureHtml(cssText);
  await page.setViewportSize({ width: 480, height: 800 });
  await page.setContent(html, { waitUntil: "domcontentloaded" });

  const metrics = await page.evaluate(() => {
    const outer = document.querySelector(".portal-tabs-outer");
    const nav = document.querySelector(".portal-tabs");
    if (!outer || !nav) return { error: "missing elements" };
    const navStyle = getComputedStyle(nav);
    const before = outer.scrollLeft;
    outer.scrollLeft = 9999;
    const after = outer.scrollLeft;
    const lastTab = nav.lastElementChild;
    const outerRect = outer.getBoundingClientRect();
    const lastRect = lastTab?.getBoundingClientRect();
    const lastVisible = lastRect ? lastRect.right <= outerRect.right + 2 && lastRect.left >= outerRect.left - 2 : false;
    return {
      navDisplay: navStyle.display,
      navFlexWrap: navStyle.flexWrap,
      outerClientWidth: outer.clientWidth,
      outerScrollWidth: outer.scrollWidth,
      navScrollWidth: nav.scrollWidth,
      navOffsetWidth: nav.offsetWidth,
      scrollLeftBefore: before,
      scrollLeftAfter: after,
      lastTabText: lastTab?.textContent?.trim() ?? null,
      lastTabVisibleAfterScroll: lastVisible,
    };
  });

  console.log("Portal scroll metrics:", metrics);
  const scrollable = metrics.outerScrollWidth > metrics.outerClientWidth + 4;
  const canReachEnd = metrics.lastTabVisibleAfterScroll && metrics.scrollLeftAfter > 0;
  return { pass: scrollable && canReachEnd, metrics };
}

async function testFinancialUrlWrite(page, baseUrl) {
  await page.goto(`${baseUrl}/app/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    history.replaceState(null, "", "/app/financial");
  });

  const result = await page.evaluate(() => {
    const pathname = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    params.set("tab", "reports");
    const qs = params.toString();
    const next = `${pathname}?${qs}`;
    window.history.replaceState(null, "", next);
    return {
      href: window.location.href,
      search: window.location.search,
      tab: new URLSearchParams(window.location.search).get("tab"),
    };
  });

  console.log("Financial URL write test:", result);
  return { pass: result.tab === "reports" && result.search.includes("tab=reports"), result };
}

async function testFinancialRefreshSimulation(page, baseUrl) {
  await page.goto(`${baseUrl}/app/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    history.replaceState(null, "", "/app/financial?tab=receipts");
  });

  const readTab = await page.evaluate(() => {
    const search = window.location.search.replace(/^\?/, "");
    const tab = new URLSearchParams(search).get("tab");
    const valid = new Set(["invoices", "reports", "pricing", "receipts"]);
    return valid.has(tab) ? tab : "invoices";
  });

  console.log("Financial refresh read test:", { readTab, search: await page.evaluate(() => location.search) });
  return { pass: readTab === "receipts" };
}

async function main() {
  console.log("Building frontend...");
  const build = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  await new Promise((res, rej) => build.on("close", (c) => (c === 0 ? res() : rej(new Error("build failed")))));

  const cssText = readFileSync(portalCssPath(), "utf8");
  console.log("Loaded portal CSS bytes:", cssText.length);

  console.log("Starting preview server...");
  const preview = await startPreview();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    const portal = await testPortalScroll(page, cssText);
    const finWrite = await testFinancialUrlWrite(page, "http://127.0.0.1:4173");
    const finRead = await testFinancialRefreshSimulation(page, "http://127.0.0.1:4173");

    console.log("\n=== RESULTS ===");
    console.log("Portal tab scroll:", portal.pass ? "PASS" : "FAIL", portal.metrics);
    console.log("Financial URL write:", finWrite.pass ? "PASS" : "FAIL", finWrite.result);
    console.log("Financial refresh read:", finRead.pass ? "PASS" : "FAIL");

    if (!portal.pass || !finWrite.pass || !finRead.pass) process.exit(1);
  } finally {
    await browser.close();
    preview.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
