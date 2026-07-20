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
  // Strip the `/api/hl` prefix to get the HL path. Normalize trailing slash
  // so `/opportunities/search/` matches the whitelist + location inject.
  let hlPath = url.pathname.replace(/^\/api\/hl/, "");
  if (!hlPath.startsWith("/")) return json(400, { error: "bad_path" });
  if (hlPath.length > 1 && hlPath.endsWith("/")) hlPath = hlPath.slice(0, -1);

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

  // HL requires a location on pipelines/search. The Preact Lead Pipeline omits
  // it (legacy dashboard hardcoded HL_LOC). Inject server-side so callers
  // don't need the location id in the browser.
  const locationId = (env.HL_LOCATION_ID ?? "").trim();
  const needsLocation =
    hlPath === "/opportunities/pipelines" || hlPath === "/opportunities/search";
  if (needsLocation && !locationId) {
    return json(500, { error: "hl_location_not_configured" });
  }
  const search = ensureLocationQuery(hlPath, url.search, locationId);
  const target = HL_BASE + hlPath + search;

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

/**
 * Ensure HL gets the location param it requires. Pipelines uses camelCase
 * `locationId`; search uses snake_case `location_id`. Preserve any caller-
 * supplied value (legacy dashboard already sends these).
 */
function ensureLocationQuery(
  hlPath: string,
  search: string,
  locationId: string,
): string {
  if (!locationId) return search || "";
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  if (hlPath === "/opportunities/pipelines") {
    if (!params.has("locationId") && !params.has("location_id")) {
      params.set("locationId", locationId);
    }
  } else if (hlPath === "/opportunities/search") {
    if (!params.has("location_id") && !params.has("locationId")) {
      params.set("location_id", locationId);
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
