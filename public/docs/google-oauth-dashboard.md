# Google OAuth on the CHS dashboard

The dashboard uses **Google Identity Services** (`accounts.google.com/gsi/client`) with the OAuth 2.0 **token client** (`initTokenClient`) so access tokens are issued in a **popup** (Google’s supported browser flow). Scopes are **Calendar (readonly)** and **Tasks** only — **not** Gmail, Sheets, or Drive, so Google is less likely to block unverified apps.

## Why it was broken

If the HTML still contained the literal string `%%OAUTH_CLIENT_ID%%`, Google receives an invalid client id and the consent screen fails. Set the variables below so the Worker can replace those placeholders.

## 1. Google Cloud Console

1. [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) for your project.
2. **Create credentials → OAuth client ID** (or open an existing **Web application** client).
3. **Authorized JavaScript origins**
   - `https://dashboard.homesolutionsar.com`
   - (Optional, for testing) `https://chs-hub.tony-bc5.workers.dev` or your `*.workers.dev` URL
4. **Authorized redirect URIs**
   - `https://dashboard.homesolutionsar.com`  
   - (Optional) `https://chs-hub.tony-bc5.workers.dev` — must list each origin you use; the app sets `redirect_uri` to `window.location.origin` (no path, no trailing slash).
5. Enable **Calendar API** and **Tasks API**. (Drive API is optional; Drive meeting import is disabled until you verify the app and add `drive.readonly` again.)

If Google shows **"Access blocked"** or **`access_denied`**: open **Google Cloud → APIs & services → OAuth consent screen**. If **Publishing status** is **Testing**, add every user who will sign in under **Test users** (including `tony@homesolutionsar.com`). External + Testing + user not listed ⇒ Google blocks. Alternatively set **User type** to **Internal** (Google Workspace only) or complete **verification** to publish. Also confirm **Authorized JavaScript origins** and **Authorized redirect URIs** include `https://dashboard.homesolutionsar.com` (exactly, no trailing path).

## 2. Cloudflare Worker environment variables

In **Workers & Pages → chs-hub → Settings → Variables**, add:

| Variable | Example / notes |
|----------|-----------------|
| `DASHBOARD_OAUTH_CLIENT_ID` | `123456789-xxxxx.apps.googleusercontent.com` (non-secret; plain text in `[vars]` is fine) |

Older deployments may still have `DASHBOARD_GOOGLE_API_KEY`, `JOB_TRACKER_SHEET_ID`, or `WC_SHEET_ID`; those are **no longer read** by the dashboard HTML injector — you can remove them from the Worker when convenient.

Redeploy after adding variables, or they apply on the next request depending on your plan (usually immediate for Workers).

**Alternative:** set `DASHBOARD_OAUTH_CLIENT_ID` under `[vars]` in `wrangler.toml` locally. Do not commit real values if the repo is shared; use the Cloudflare UI instead.

## 3. Verify

1. Open `https://dashboard.homesolutionsar.com/` and **View source** (or fetch in curl) and confirm `OAUTH_CLIENT_ID` is a real `*.apps.googleusercontent.com` value, not `%%OAUTH_CLIENT_ID%%`.
2. Click **Connect Google** — you should get the Google account chooser, then consent, then return to the dashboard with **✓ Google Connected**.

## 4. Troubleshooting

| Symptom | Check |
|--------|--------|
| `invalid_client` | Client ID string wrong or not injected — Variables missing in Worker. |
| `redirect_uri_mismatch` | Redirect URI in Google Cloud must be exactly `https://dashboard.homesolutionsar.com` (no path, no `/oauth`, unless you change the code). |
| **Empty `OAUTH_CLIENT_ID` after you set the Worker var** | The dashboard **service worker** may have **cache-first** HTML from before the var existed. **Deploy** latest `dashboard/sw.js` (documents are network-first), then hard-refresh; or **DevTools → Application → Service Workers → Unregister** and clear site data for the dashboard origin. |
| Scopes / verification | Consent screen in **Testing**? Add your account under **Test users**. **Internal** user type only allows your Google Workspace org. `redirect_uri_mismatch` → origin + redirect URI must match **`window.location.origin`** exactly. |

## 5. Code references

- Injection: `src/lib/dashboard-inject.ts`
- OAuth redirect and hash handling: `dashboard/index.html` — `connectGoogle`, `checkOAuthRedirect`

Future improvement: switch to **authorization code + PKCE** (Google’s recommended model for new clients) for better security and to avoid implicit-flow limitations.
