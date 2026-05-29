# Sprint 2: Frontend Foundation + Client & Subcontractor CRUD
## Cursor Prompt — CHS Construction Management Platform

---

## Context

You are continuing work on the chs-hub codebase for Columbus Home Solutions. Sprint 1 is complete and deployed: the database now has all 40 platform tables, auth middleware resolves Cloudflare Access email → user with role, the settings API and health heartbeat are live, and all existing chs-hub functionality (dashboard, Smart Notes, HL pipeline, WC sync, photos, nightly backup) still works untouched.

Sprint 2 does two big things:
1. **Stands up the new Preact frontend** — the app shell, design system, routing, and reusable components. This is the foundation every future screen builds on.
2. **Builds the Client and Subcontractor modules** — the first real screens Tony will use, plus migrating existing Jobber-imported client data into the native schema.

**Critical constraint:** The existing chs-hub dashboard at `dashboard.homesolutionsar.com` must keep working throughout. The new Preact app is built alongside it, not on top of it. Nothing existing breaks.

---

## Step 0: Explore Current State

Before writing any code, understand where Sprint 1 left things:

1. **Read `src/worker.ts`** (or `src/index.ts`) — understand the current route dispatcher, how the settings API was wired in during Sprint 1, and how auth middleware is applied. Follow this exact pattern for the new client/sub routes.

2. **Read `src/middleware/auth.ts` and `src/middleware/roles.ts`** — these were created in Sprint 1. Every new API route uses them.

3. **Read `src/routes/settings.ts`** — this is the reference pattern for a CRUD route module. New route files (`clients.ts`, `subcontractors.ts`) follow the same structure.

4. **Check how static files are currently served** — the existing dashboard is HTML served by the Worker. Understand the current static-asset handling so the new Preact build output doesn't collide with it.

5. **Run against local D1 to confirm Sprint 1 schema:**
   ```bash
   npx wrangler d1 execute chs-hub-db --local --command="PRAGMA table_info(clients);"
   npx wrangler d1 execute chs-hub-db --local --command="PRAGMA table_info(properties);"
   npx wrangler d1 execute chs-hub-db --local --command="PRAGMA table_info(communications);"
   npx wrangler d1 execute chs-hub-db --local --command="PRAGMA table_info(subcontractors);"
   ```
   Confirm the columns match the Database Schema doc. The `clients` and `subcontractors` tables were ALTERed in Sprint 1; `properties` and `communications` were created fresh.

6. **Do NOT modify existing files in Step 0.** Read and understand only.

---

## Step 1: Frontend Scaffold (Preact + Vite)

Reference: **cursorrules.md** — "Frontend Setup" section has the exact stack and config.

Set up the new frontend in the `frontend/` directory:

```bash
cd frontend
npm create vite@latest . -- --template preact-ts
npm install preact preact-router
npm install -D @preact/preset-vite
```

Create `frontend/vite.config.ts` exactly as specified in cursorrules.md:
- Preact plugin
- Build output to `../public` (where the Worker serves static files) — **but confirm this won't overwrite the existing dashboard.** If the existing dashboard lives in `public/`, output the new app to a subdirectory like `../public/app/` instead, and serve it at `/app` during Sprint 2. We can promote it to root once it fully replaces the old dashboard in a later sprint.
- Dev server proxy: `/api` → `http://localhost:8787`

**Important:** The new Preact app and the existing dashboard coexist during development. Tony's live dashboard keeps running. The new app is accessed at a dev/staging route until it's feature-complete enough to take over.

---

## Step 2: Design Tokens & Base Styles

Reference: **CHS-Design-System.md** — the full token system and component specs.

1. Create `frontend/src/styles/tokens.css` — all CSS custom properties from the Design System doc (colors, spacing, typography, sidebar width, nav height, etc.). Import this globally.

2. Create `frontend/src/styles/components.css` — base component styles (buttons, badges, cards, tables, form fields) using the BEM naming convention from the Design System.

3. Use the dark theme tokens for the internal app (matching the existing chs-hub aesthetic). The client portal uses a separate light theme later.

---

## Step 3: UI Primitives

Reference: **CHS-Design-System.md** — component specs.

Create the reusable UI primitives in `frontend/src/components/ui/`. Each is a functional Preact component with hooks (see the component pattern in cursorrules.md):

- `Button.tsx` — variants: primary, secondary, tertiary, danger
- `Badge.tsx` — status badges (color-coded)
- `Card.tsx` — content container
- `Modal.tsx` — overlay dialog
- `Toast.tsx` — transient notifications
- `Table.tsx` — sortable data table
- `FormField.tsx` — labeled input wrapper with validation display
- `Select.tsx` — dropdown
- `Spinner.tsx` — loading indicator

Keep these generic and reusable. They have no business logic — just presentation and interaction.

---

## Step 4: App Shell, Routing & State

Reference: **CHS-Design-System.md** "App Shell" + **Module-Spec-Dashboard-Home-Screen.md** (sidebar nav structure).

1. **Layout components** in `frontend/src/components/layout/`:
   - `AppShell.tsx` — sidebar + top nav + content area (responsive per Design System breakpoints)
   - `Sidebar.tsx` — primary navigation. Use the nav structure from the Dashboard spec: Dashboard, Jobs, Estimates, Financial, Clients, Photos, Documents, Social, Settings. For Sprint 2, only Clients and Settings route to real pages; the rest are placeholders ("Coming soon").
   - `TopNav.tsx` — logo, notification bell (placeholder count for now), user dropdown
   - On mobile: bottom tab bar instead of sidebar

2. **Routing** in `frontend/src/router.tsx` using `preact-router`:
   - `/` → Dashboard (placeholder for now — full build is a later sprint)
   - `/clients` → ClientList
   - `/clients/:id` → ClientDetail
   - `/subcontractors` → SubcontractorList
   - `/settings` → Settings (minimal — just confirms the settings API works)

3. **State** in `frontend/src/store/`:
   - `auth.tsx` — auth context holding the current user + role (fetched from a `/api/me` endpoint — add this endpoint if it doesn't exist; it returns the authenticated user from the auth middleware)
   - `toast.tsx` — toast notification state

4. **API client** in `frontend/src/api.ts` — a fetch wrapper that handles JSON, errors, and the consistent error response format `{ error, details? }`.

5. **`useApi` hook** in `frontend/src/hooks/useApi.ts` — data fetching with loading/error/refetch (see the pattern in cursorrules.md).

6. **`useForm` hook** in `frontend/src/hooks/useForm.ts` — form state management for the client/property/sub forms.

---

## Step 5: Add `/api/me` Endpoint

If it doesn't already exist, add a simple endpoint that returns the current authenticated user (resolved by the auth middleware):

```typescript
// GET /api/me → returns { id, email, first_name, last_name, role }
```

The frontend auth context calls this on load to know who's logged in and what role they have.

---

## Step 6: Client CRUD API

Reference: **CHS-API-Route-Map.md** Section 2 + **CHS-Database-Schema.md** `clients` table + **Module-Spec-Client-Management-Portal.md**.

Create `src/routes/clients.ts` following the settings.ts pattern. Wire it into the Worker route dispatcher.

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/clients` | O/PM/OA | List clients. Filters: `?search=name_or_phone&lead_source=xxx&is_repeat=1` |
| GET | `/api/clients/:id` | O/PM/OA | Client detail with computed totals |
| POST | `/api/clients` | O/PM/OA | Create client. Runs repeat client detection |
| PUT | `/api/clients/:id` | O/PM/OA | Update client |
| GET | `/api/clients/:id/summary` | O/PM | Summary: total jobs, total revenue, last interaction |

Notes:
- Roles: O = Owner, PM = Project Manager, OA = Office Admin, FC = Field Crew. Apply `requireRole` per the route map.
- `GET /api/clients/:id/summary` can use the `v_client_summary` view created in Sprint 1.
- Computed totals (total_jobs, total_revenue) come from the view or aggregate queries — clients don't store these directly.
- All write actions (POST/PUT) log to the audit trail via the audit middleware.
- Generate UUIDs with `crypto.randomUUID()` (see `src/lib/uuid.ts`).

---

## Step 7: Properties API

Reference: **CHS-API-Route-Map.md** Section 2 (Properties) + **CHS-Database-Schema.md** `properties` table.

Add to `src/routes/clients.ts` (properties are nested under clients):

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/clients/:id/properties` | O/PM/OA | List properties for a client |
| POST | `/api/clients/:id/properties` | O/PM/OA | Add property |
| PUT | `/api/properties/:id` | O/PM/OA | Update property |

Notes:
- A client can have multiple properties (repeat clients with different job sites).
- `state` defaults to "Arkansas".
- The `notes` field holds gate codes, dog warnings, access instructions, etc.

---

## Step 8: Communications API (Read-Only for Now)

Reference: **CHS-API-Route-Map.md** Section 2 (Communications) + **CHS-Database-Schema.md** `communications` table.

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/clients/:id/communications` | O/PM/OA | Communication timeline. Filters: `?channel=xxx&job_id=xxx&from=date&to=date` |
| POST | `/api/communications` | O/PM/OA | Log a manual communication (phone call, in-person) |

Notes:
- The timeline will be mostly empty in Sprint 2 (no jobs or notifications generating comms yet). Build the endpoint and the display component, but expect empty results.
- The `POST` endpoint lets Tony manually log a phone call or in-person conversation. This is the only comms source until the notification engine (Sprint 7) and Twilio (later) come online.
- Inbound Twilio webhook is NOT part of Sprint 2 — skip it.

---

## Step 9: Repeat Client Detection

Reference: **Module-Spec-Client-Management-Portal.md** Section 11.

When `POST /api/clients` is called, before inserting, search existing clients for matches:

1. Phone number (exact match)
2. Email (exact match)
3. Last name + property address (match against all properties)

**Behavior:**
- If a match is found, return a response indicating a potential duplicate with the matched client's info (name, total jobs, total revenue, last interaction date) instead of immediately creating.
- The frontend shows a "Possible existing client" prompt with two choices: "Use existing client" (links to the existing record) or "Create new anyway" (proceeds with creation, optionally passing a `force=true` flag).
- When a client genuinely matches an existing one and they have a second job, set `is_repeat_client = 1` on the existing record.

Implement this as a helper in the route or a small service. Keep the matching logic clear and well-commented.

---

## Step 10: Subcontractor CRUD API

Reference: **CHS-API-Route-Map.md** Section 12 + **CHS-Database-Schema.md** `subcontractors` table.

The `subcontractors` table carries forward from chs-hub and was ALTERed in Sprint 1. Create `src/routes/subcontractors.ts`:

| Method | Route | Role | Description |
|--------|-------|------|-------------|
| GET | `/api/subcontractors` | O/PM | List subs. Filters: `?trade=xxx&search=xxx&active=1` |
| GET | `/api/subcontractors/:id` | O/PM | Sub detail |
| POST | `/api/subcontractors` | O/PM | Create sub |
| PUT | `/api/subcontractors/:id` | O/PM | Update sub |

Notes:
- **Preserve existing sub data.** chs-hub already has subcontractor records. The API reads and writes the existing table — don't recreate or wipe it.
- Trade values: electrical, plumbing, hvac, concrete, roofing, drywall, painting, flooring, cabinetry, tile, stone, insulation, framing, general.
- `is_active` defaults to 1. The `?active=1` filter shows only active subs.

---

## Step 11: Client List Page

Reference: **Module-Spec-Client-Management-Portal.md** Section 12.1 + **CHS-Design-System.md**.

Create `frontend/src/views/clients/ClientList.tsx`:

- Searchable, sortable list of all clients (search by name, phone, email, address).
- Columns: Name, Phone, Email, Total Jobs, Total Revenue, Last Interaction.
- Click a row → navigate to client detail (`/clients/:id`).
- Quick filters: All, Active, Past, Repeat.
- "New Client" button → opens the create-client form (modal or dedicated page).
- Uses the `Table`, `Button`, `Badge`, and `FormField` primitives.
- Loading state shows `Spinner`; empty state shows a friendly "No clients yet" message.

---

## Step 12: Client Detail Page

Reference: **Module-Spec-Client-Management-Portal.md** Section 12.2.

Create `frontend/src/views/clients/ClientDetail.tsx`:

- **Header:** Client name, phone, email, address, with an Edit button.
- **Jobs section:** All jobs for this client (empty in Sprint 2 — show "No jobs yet"). Build the section structure so it populates once jobs exist.
- **Communication timeline:** Chronological list from the communications API (mostly empty now). Include the "Log Communication" button that opens a form posting to `/api/communications`.
- **Financial summary:** Total revenue, total paid, outstanding balance (zero/empty until jobs and invoices exist).
- **Properties:** List of property addresses with add/edit. This is fully functional in Sprint 2.
- **Notes:** Editable general notes about the client.

Use the `Timeline` component for the communication history and `Card` for each section.

---

## Step 13: Subcontractor List Page

Reference: **Module-Spec-Client-Management-Portal.md** (sub management) + Design System.

Create `frontend/src/views/subcontractors/SubcontractorList.tsx`:

- List of all subcontractors with trade filter and search.
- Columns: Company Name, Contact, Trade, Phone, Insurance on File, W9 on File, Active.
- "New Sub" button → create form.
- Click a row → sub detail/edit (can be a modal in Sprint 2).
- Trade filter dropdown using the trade enum values.

---

## Step 14: Migrate Existing Jobber Client Data

Reference: **CHS-Schema-Bridge.md**.

The production database has ~80 clients imported from Jobber (confirmed in the Sprint 1 remote verification). These records exist in the `clients` table but may be missing values for the columns added in Sprint 1 (mailing fields, lead_source, is_repeat_client, etc.).

1. Write a one-time data backfill (a migration file `0023_client_data_backfill.sql` or a small admin script):
   - Populate sensible defaults for newly added columns where null (e.g., `is_repeat_client = 0`, `review_requested = 0`).
   - Do NOT overwrite existing data — only fill nulls.
2. Run repeat-client detection across the existing dataset to flag any clients who already have multiple jobs as `is_repeat_client = 1`.
3. Verify against local first, then remote.
4. Confirm the client count is unchanged after backfill (still ~80 clients — no records lost or duplicated).

---

## Step 15: Verify Nothing is Broken

1. The existing chs-hub dashboard at `dashboard.homesolutionsar.com` still loads and works.
2. Smart Notes, HL pipeline, WC sync, photo capture, nightly backup all still function.
3. The settings API and heartbeat from Sprint 1 still respond.
4. The new Preact app loads at its dev/staging route.
5. Client list shows the ~80 migrated clients.
6. Creating a new client works; repeat detection fires on a duplicate phone.
7. Adding a property to a client works.
8. Subcontractor list shows existing subs; creating a new sub works.

**If anything existing breaks, it's a Sprint 2 bug — fix before moving on.**

---

## Done Criteria

- [ ] Preact + Vite frontend scaffolded and building successfully
- [ ] Design tokens and base component styles in place
- [ ] All 9 UI primitives created
- [ ] App shell with responsive sidebar/top-nav/content + mobile bottom tabs
- [ ] Routing works; `/clients`, `/clients/:id`, `/subcontractors`, `/settings` resolve
- [ ] Auth context loads current user via `/api/me`
- [ ] Client CRUD API live (list, detail, create, update, summary)
- [ ] Properties API live (list, add, update)
- [ ] Communications API live (timeline read + manual log)
- [ ] Repeat client detection fires on create
- [ ] Subcontractor CRUD API live, existing subs preserved
- [ ] Client list page functional with search and filters
- [ ] Client detail page functional with properties management
- [ ] Subcontractor list page functional with trade filter
- [ ] Existing ~80 Jobber clients migrated/backfilled, count unchanged
- [ ] ALL existing chs-hub functionality still works
- [ ] New Preact app coexists with the old dashboard without breaking it

---

## Reference Documents

Read these from the project knowledge before writing code:

1. **cursorrules.md** — coding conventions, full file structure, frontend setup, component patterns
2. **CHS-Design-System.md** — CSS tokens, app shell layout, component specs
3. **CHS-Database-Schema.md** — `clients`, `properties`, `communications`, `subcontractors` table definitions
4. **CHS-API-Route-Map.md** — Sections 2 (Clients) and 12 (Subcontractors)
5. **Module-Spec-Client-Management-Portal.md** — client database, repeat detection, screen descriptions
6. **Module-Spec-Dashboard-Home-Screen.md** — sidebar nav structure (for the app shell)
7. **CHS-Schema-Bridge.md** — existing data migration guidance
8. **CHS-Build-Order-Plan.md** — Sprint 2 scope (you are here)

---

## Notes for the Build

- **The frontend is the big new surface this sprint.** Take time on the app shell and primitives — every future sprint reuses them. Getting Button, Table, FormField, Modal, and the AppShell right now saves rework later.
- **Don't gold-plate the empty sections.** Jobs, financial summary, and communications will be empty until later sprints. Build the structure, show clean empty states, move on.
- **Keep the existing dashboard alive.** Until the new app fully replaces it, both run in parallel. This protects Tony's daily operations during the build.
- **Match the existing Worker patterns.** The settings route from Sprint 1 is your template for new API routes. Consistency matters more than cleverness.
