/**
 * Injects public dashboard config into `dashboard/index.html` at the edge.
 *
 * The HTML on disk still contains `%%PLACEHOLDER%%` strings so the repo never
 * needs to commit OAuth client IDs or sheet IDs. At deploy time, set
 * DASHBOARD_OAUTH_CLIENT_ID, DASHBOARD_GOOGLE_API_KEY, JOB_TRACKER_SHEET_ID,
 * and WC_SHEET_ID in wrangler [vars] (or the Cloudflare dashboard).
 */

import type { Env } from "../env.js";

function isDashboardIndexRequest(url: URL): boolean {
  const p = url.pathname;
  if (p === "/dashboard/index.html") return true;
  if (p === "/dashboard" || p === "/dashboard/") return true;
  const h = url.hostname;
  if (
    (h === "dashboard.homesolutionsar.com" || h === "dash.homesolutionsar.com") &&
    (p === "/" || p === "")
  ) {
    return true;
  }
  return false;
}

export async function maybeInjectDashboardHtml(
  env: Env,
  requestUrl: URL,
  request: Request,
  response: Response,
): Promise<Response> {
  if (request.method === "HEAD") {
    return response;
  }
  if (request.method !== "GET") {
    return response;
  }
  if (!isDashboardIndexRequest(requestUrl)) {
    return response;
  }

  const text = await response.text();
  if (!text.includes("%%")) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const ocid = env.DASHBOARD_OAUTH_CLIENT_ID ?? "";
  const gak = env.DASHBOARD_GOOGLE_API_KEY ?? "";
  const jt = env.JOB_TRACKER_SHEET_ID ?? "";
  const wc = env.WC_SHEET_ID ?? "";

  const out = text
    .split("%%OAUTH_CLIENT_ID%%").join(ocid)
    .split("%%GOOGLE_API_KEY%%").join(gak)
    .split("%%JOB_TRACKER_SHEET_ID%%").join(jt)
    .split("%%WC_SHEET_ID%%").join(wc);

  const headers = new Headers(response.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.delete("content-length");
  return new Response(out, { status: response.status, headers });
}
