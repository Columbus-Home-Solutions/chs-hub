# Google OAuth on the CHS dashboard

The dashboard uses the **OAuth 2.0 implicit flow** (`response_type=token`) so the access token is returned in the URL **hash** and stored in `localStorage` for Calendar, Tasks, Gmail (read), Sheets, and Drive read scopes. The Worker **injects** your public config into `dashboard/index.html` at request time so the repo does not need hard-coded client IDs.

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
5. Enable any APIs you use: **Google Sheets API**, **Calendar API**, **Tasks API**, **Gmail API** (readonly), **Drive API** (readonly), as needed.

If Google shows **"Access blocked"** for sensitive scopes (e.g. Gmail), the app may need [verification](https://support.google.com/cloud/answer/9110914) for external users, or you can use **Internal** (Workspace-only) for testing.

## 2. Cloudflare Worker environment variables

In **Workers & Pages → chs-hub → Settings → Variables**, add (all are non-secret; plain text is fine for `OAUTH_CLIENT_ID` and API key in `[vars]`):

| Variable | Example / notes |
|----------|-----------------|
| `DASHBOARD_OAUTH_CLIENT_ID` | `123456789-xxxxx.apps.googleusercontent.com` |
| `DASHBOARD_GOOGLE_API_KEY` | Browser API key, **Application restrictions** = HTTP referrers, add `https://dashboard.homesolutionsar.com/*` and `https://*.homesolutionsar.com/*` if needed. **API restrictions** = limit to the APIs the dashboard uses. |
| `JOB_TRACKER_SHEET_ID` | ID of the Job Tracker / KPI spreadsheet (from the sheet URL). |
| `WC_SHEET_ID` | Wealthy Contractor / workbook sheet id if the dashboard references it. |

Redeploy after adding variables, or they apply on the next request depending on your plan (usually immediate for Workers).

**Alternative:** add the same keys under `[vars]` in `wrangler.toml` locally. Do not commit real values if the repo is shared; use the Cloudflare UI instead.

## 3. Verify

1. Open `https://dashboard.homesolutionsar.com/` and **View source** (or fetch in curl) and confirm `OAUTH_CLIENT_ID` is a real `*.apps.googleusercontent.com` value, not `%%OAUTH_CLIENT_ID%%`.
2. Click **Connect Google** — you should get the Google account chooser, then consent, then return to the dashboard with **✓ Google Connected**.

## 4. Troubleshooting

| Symptom | Check |
|--------|--------|
| `invalid_client` | Client ID string wrong or not injected — Variables missing in Worker. |
| `redirect_uri_mismatch` | Redirect URI in Google Cloud must be exactly `https://dashboard.homesolutionsar.com` (no path, no `/oauth`, unless you change the code). |
| **Empty `OAUTH_CLIENT_ID` after you set the Worker var** | The dashboard **service worker** may have **cache-first** HTML from before the var existed. **Deploy** latest `dashboard/sw.js` (documents are network-first), then hard-refresh; or **DevTools → Application → Service Workers → Unregister** and clear site data for the dashboard origin. |
| Scopes / verification | If Gmail scope is blocked, remove it from `OAUTH_SCOPES` in `dashboard/index.html` temporarily. |

## 5. Code references

- Injection: `src/lib/dashboard-inject.ts`
- OAuth redirect and hash handling: `dashboard/index.html` — `connectGoogle`, `checkOAuthRedirect`

Future improvement: switch to **authorization code + PKCE** (Google’s recommended model for new clients) for better security and to avoid implicit-flow limitations.
