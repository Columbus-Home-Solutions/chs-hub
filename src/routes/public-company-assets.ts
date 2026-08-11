/**
 * Public (no auth) serving of static company marketing PDFs from R2.
 * Allowlisted slugs only — used by estimate email/quote-page links and the
 * client quote page links.
 */
import type { Env } from "../env.js";
import { COMPANY_ASSET_SLUGS, type CompanyAssetSlug } from "../lib/company-assets.js";

export async function handlePublicCompanyAsset(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "GET, HEAD" },
    });
  }

  const meta = COMPANY_ASSET_SLUGS[slug as CompanyAssetSlug];
  if (!meta) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const obj = await env.FILES.get(meta.r2Key);
  if (!obj) {
    return new Response(JSON.stringify({ error: "not_found", detail: "asset_missing_in_r2" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const headers = new Headers({
    "Content-Type": meta.contentType,
    "Content-Disposition": `inline; filename="${meta.filename}"`,
    "Cache-Control": "public, max-age=86400",
  });
  if (obj.size != null) headers.set("Content-Length", String(obj.size));

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}
