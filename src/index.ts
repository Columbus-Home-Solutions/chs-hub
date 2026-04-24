/**
 * chs-hub Worker — operational hub backend.
 *
 * Routing strategy:
 *   Static assets (index.html, docs/*.md, etc.) are served directly by the
 *   Workers runtime before this Worker code runs. Anything that doesn't match
 *   a static asset falls through to this fetch handler, which either handles
 *   the request as an API route or delegates back to the static assets service
 *   (so SPA-style deep links still resolve to index.html).
 *
 * Bindings (see wrangler.toml):
 *   env.DB      — D1 database (chs-hub-db)
 *   env.FILES   — R2 bucket   (chs-hub-files)
 *   env.ASSETS  — static assets fetcher
 */

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return handleHealth(env);
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse(
        { error: "not_implemented", path: url.pathname },
        { status: 404 },
      );
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * Smoke test endpoint. Returns 200 only if D1 and R2 are both reachable.
 * Used for post-deploy verification and future uptime monitoring.
 */
async function handleHealth(env: Env): Promise<Response> {
  const startedAt = Date.now();
  const checks: {
    ok: boolean;
    timestamp: string;
    d1: { status: "connected" | "error"; latency_ms?: number; error?: string };
    r2: { status: "connected" | "error"; latency_ms?: number; error?: string };
    version: string;
  } = {
    ok: true,
    timestamp: new Date().toISOString(),
    d1: { status: "error" },
    r2: { status: "error" },
    version: "0.1.0",
  };

  try {
    const t0 = Date.now();
    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (row?.ok !== 1) throw new Error("unexpected D1 response");
    checks.d1 = { status: "connected", latency_ms: Date.now() - t0 };
  } catch (err) {
    checks.ok = false;
    checks.d1 = { status: "error", error: (err as Error).message };
  }

  try {
    const t0 = Date.now();
    await env.FILES.head("__healthcheck__");
    checks.r2 = { status: "connected", latency_ms: Date.now() - t0 };
  } catch (err) {
    checks.ok = false;
    checks.r2 = { status: "error", error: (err as Error).message };
  }

  return jsonResponse(checks, {
    status: checks.ok ? 200 : 503,
    headers: { "x-total-ms": String(Date.now() - startedAt) },
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}
