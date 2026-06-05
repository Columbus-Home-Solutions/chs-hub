/**
 * Social connection status + Graph API test (Pre-Launch live flip).
 *
 *   GET /api/social/status           — connected + publish mode (no secrets)
 *   GET /api/social/test-connection  — live Graph API probe (owner only)
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import {
  getSetting,
  json,
  SETTING_FB_PAGE_ID,
  SETTING_FB_TOKEN,
  SETTING_IG_ACCOUNT_ID,
  SETTING_PUBLISH_MODE,
} from "../lib/social.js";
import { normalizePublishMode, resolvePublishMode } from "../lib/social-publish.js";

const OWNER_ONLY = ["owner"] as const;
const GRAPH_BASE = "https://graph.facebook.com/v21.0";

/** GET /api/social/status — owner only; never returns tokens. */
export async function handleSocialStatus(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;

  const modeSetting = await getSetting(env, SETTING_PUBLISH_MODE);
  const [token, pageId, igId] = await Promise.all([
    getSetting(env, SETTING_FB_TOKEN),
    getSetting(env, SETTING_FB_PAGE_ID),
    getSetting(env, SETTING_IG_ACCOUNT_ID),
  ]);

  return json({
    connected: !!(token?.trim() && pageId?.trim()),
    facebook_page_id_set: !!pageId?.trim(),
    instagram_account_id_set: !!igId?.trim(),
    instagram_account_id: igId?.trim() || null,
    /** From system_settings at request time (UI badge). */
    publish_mode: normalizePublishMode(modeSetting),
    /** Env secret overrides settings when set (actual publisher behavior). */
    effective_publish_mode: await resolvePublishMode(env),
    page_label: "Columbus Home Solutions",
  });
}

/** GET /api/social/test-connection — owner only; probes Graph API with stored token. */
export async function handleSocialTestConnection(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;

  const token = await getSetting(env, SETTING_FB_TOKEN);
  const pageId = await getSetting(env, SETTING_FB_PAGE_ID);
  if (!token?.trim() || !pageId?.trim()) {
    return json({ ok: false, error: "Credentials not configured" });
  }

  try {
    const url = new URL(`${GRAPH_BASE}/${pageId}`);
    url.searchParams.set("fields", "name,instagram_business_account");
    url.searchParams.set("access_token", token);
    const res = await fetch(url.toString());
    const data = (await res.json()) as {
      name?: string;
      instagram_business_account?: { id?: string };
      error?: { message?: string };
    };
    if (!res.ok || data.error) {
      return json({ ok: false, error: data.error?.message ?? `http_${res.status}` });
    }
    const configuredIg = (await getSetting(env, SETTING_IG_ACCOUNT_ID))?.trim() || null;
    const graphIg = data.instagram_business_account?.id ?? null;
    return json({
      ok: true,
      page_name: data.name ?? null,
      ig_account: graphIg,
      ig_account_configured: configuredIg,
      ig_match: configuredIg ? configuredIg === graphIg : null,
    });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message || "Network error" });
  }
}
