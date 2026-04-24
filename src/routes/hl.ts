/**
 * HighLevel API proxy.
 *
 * The browser talks to `/api/hl/*` on our own worker; we forward the request
 * to `services.leadconnectorhq.com/*` with the Private Integration Token
 * attached server-side. This gets us three things for free:
 *   1. The PIT never touches client-side code (previously hardcoded in
 *      `dashboard/index.html` as a `%%HL_TOKEN%%` placeholder that never
 *      got filled in).
 *   2. Browser CORS issues disappear — the browser only sees our origin.
 *   3. We can observe/log/transform HL responses in one place later.
 *
 * Paths are whitelisted (explicit is better than implicit); adding new HL
 * endpoints means adding them here.
 */

import type { Env } from "../env.js";

const HL_BASE = "https://services.leadconnectorhq.com";

// Paths we're willing to proxy. Each entry: { prefix, methods }.
// The `*` in a prefix matches any single path segment.
const ALLOWED: { prefix: string; methods: string[] }[] = [
  { prefix: "/opportunities/pipelines", methods: ["GET"] },
  { prefix: "/opportunities/search",    methods: ["GET"] },
  { prefix: "/opportunities/",          methods: ["POST"] },
  { prefix: "/opportunities/*",         methods: ["GET", "PUT", "PATCH", "DELETE"] },
  { prefix: "/contacts/",               methods: ["POST"] },
  { prefix: "/contacts/*",              methods: ["GET", "PUT", "PATCH", "DELETE"] },
];

function pathAllowed(path: string, method: string): boolean {
  for (const rule of ALLOWED) {
    if (!rule.methods.includes(method)) continue;
    if (rule.prefix.endsWith("/*")) {
      // Match "/opportunities/<something>" but not deeper
      const base = rule.prefix.slice(0, -2); // "/opportunities"
      if (path.startsWith(base + "/")) {
        const rest = path.slice(base.length + 1);
        if (rest.length > 0 && !rest.includes("/")) return true;
      }
    } else if (path === rule.prefix || path.startsWith(rule.prefix)) {
      return true;
    }
  }
  return false;
}

export async function handleHLProxy(
  env: Env,
  request: Request,
  url: URL,
): Promise<Response> {
  // Strip the `/api/hl` prefix to get the HL path.
  const hlPath = url.pathname.replace(/^\/api\/hl/, "");
  if (!hlPath.startsWith("/")) return json(400, { error: "bad_path" });

  if (!pathAllowed(hlPath, request.method)) {
    return json(403, {
      error: "path_not_allowed",
      path: hlPath,
      method: request.method,
    });
  }

  if (!env.HL_PRIVATE_TOKEN) {
    return json(500, { error: "hl_not_configured" });
  }

  const target = HL_BASE + hlPath + (url.search || "");

  // Forward body as-is for write methods. Read the request body once so we
  // can also log failures usefully if needed.
  let body: BodyInit | undefined;
  if (request.method !== "GET" && request.method !== "DELETE") {
    body = await request.text();
  }

  const hlResp = await fetch(target, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${env.HL_PRIVATE_TOKEN}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
  });

  // Pass the response straight through. Preserve status + content-type so the
  // frontend can inspect errors exactly as if it had called HL directly.
  const text = await hlResp.text();
  return new Response(text, {
    status: hlResp.status,
    headers: {
      "content-type":
        hlResp.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
