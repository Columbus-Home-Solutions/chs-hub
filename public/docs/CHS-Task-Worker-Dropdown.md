# Cursor Task: Worker Dropdown on Clock-In Form
## CHS Construction Management Platform — Sprint 10 follow-up

---

## What and why

The time-entry clock-in form currently has a free-text `worker` field. Replace it with a `<Select>` dropdown populated from active users so worker names are always consistent, correctly attributed, and linked back to real user records — no typos, no ambiguity in the costing history.

This is a small, self-contained change. No schema migration needed — `time_entries.worker` stays `TEXT NOT NULL` and stores `"First Last"` (the same it does now, just reliably populated from the users list rather than typed).

---

## Step 0 — Read before touching anything

```bash
# Confirm GET /api/users/me already exists and returns first_name + last_name
curl http://localhost:8787/api/users/me

# Confirm GET /api/users (O-only) exists and its response shape
# (clockable endpoint is net-new — don't confuse the two)

# Check the time-entry clock-in form component for the current worker field
# (likely frontend/src/views/financial/ or the FinancialTab component)
```

---

## Backend — one new endpoint

### `GET /api/users/clockable` — ALL roles

Add to `src/routes/users.ts` (or wherever `/api/users/me` lives):

```
GET /api/users/clockable
```

- **Auth:** all authenticated users (same as `/api/users/me` — no Owner-only gate; FC needs this to populate their own clock-in form).
- **Query:** `SELECT id, first_name, last_name, role FROM users WHERE is_active = 1 AND role IN ('owner', 'project_manager', 'field_crew') ORDER BY first_name, last_name`
- **Response:**
```json
[
  { "id": "uuid", "full_name": "Tony Columbus", "role": "owner" },
  { "id": "uuid", "full_name": "Jane Smith",    "role": "field_crew" }
]
```
- **Why not reuse `GET /api/users`?** That endpoint is Owner-only (user management). This endpoint is intentionally narrow — active clockable users only, minimal fields, no PII beyond name, accessible to all roles.
- **Why `office_admin` excluded?** OA manages the office side; they don't clock labor time on jobs. If that changes, add `'office_admin'` to the IN list — no other change needed.

Wire the route in `worker.ts` / the main dispatcher, same pattern as every other route.

---

## Frontend — update the clock-in form

In the time-tracker clock-in form (the component that calls `POST /api/time-entries`):

1. **On mount**, call `GET /api/users/clockable` and store the result.
2. **Replace** the `worker` text input with a `<Select>` (reuse the existing `Select` primitive from `src/components/ui/Select.tsx`).
3. **Default selection:** the currently logged-in user (available from the auth context — `useAuth()` / the auth store that holds the `/api/users/me` result). Match by `full_name` or add `id` to the selection if auth context exposes it.
4. **Options:** one option per user — display `full_name`, value `full_name` (the string stored to `time_entries.worker`).
5. **Stored value:** `full_name` string (e.g. `"Tony Columbus"`). No schema change — the `worker TEXT NOT NULL` column already holds this.
6. **Loading state:** while the clockable users list is fetching, show the `<Select>` as disabled with a placeholder ("Loading…"). On error, fall back to a plain text input so clock-in still works (graceful degradation).
7. **Mobile-first:** the `<Select>` must be 44×44 touch target minimum, same as every other control in the time tracker. Reuse the existing Select primitive's styles — don't invent a new one.

---

## Business rules (unchanged — just enforced more reliably now)

- One active clock-in per worker+job at a time (existing guard on `POST /api/time-entries`).
- `hourly_rate` snapshot from `system_settings` at clock-in based on the **role selector** (General / PM-Skilled), not the user's system role. These are independent: an owner can clock in as "General" labor; a field crew member can be clocked as "PM-Skilled" if they're doing that work.
- Historical entries retain their stored `worker` name string even if the user's name is later changed — this is correct (it's a point-in-time record). No retroactive updates needed or wanted.

---

## Tests

```bash
# New endpoint returns correct shape, all roles accessible
curl http://localhost:8787/api/users/clockable
# Expect: array of {id, full_name, role} for active O/PM/FC users only; OA excluded

# Clock-in still works — worker field now comes from dropdown selection, not free text
curl -X POST http://localhost:8787/api/time-entries -H "Content-Type: application/json" \
  -d '{"job_id":"<id>","worker":"Tony Columbus","role":"pm_skilled"}'
# Expect: hourly_rate=105 snapshotted, clock_out null — same as before
```

Browser (local, `localhost:5173/app/`):
- [ ] Clock-in form shows a `<Select>` dropdown, not a text input, for the worker field
- [ ] Dropdown options match active O/PM/FC users from `GET /api/users/clockable`
- [ ] Logged-in user is pre-selected by default
- [ ] Selecting a different user → that name is stored in `time_entries.worker`
- [ ] Loading state disables the select while fetching; error state falls back gracefully
- [ ] Mobile: dropdown is tappable at 44px minimum touch target
- [ ] Role selector (General / PM-Skilled) is unaffected — still independent of the worker selection
- [ ] No console errors; rest of time tracker (clock out, history, running timer) unchanged

---

## Done criteria

- [ ] `GET /api/users/clockable` returns `[{id, full_name, role}]` for active O/PM/FC users; accessible to all roles
- [ ] Clock-in form `worker` field is a `<Select>` populated from the endpoint, defaulting to the logged-in user
- [ ] `time_entries.worker` stores `"First Last"` string consistently (no free text)
- [ ] No schema migration (worker column unchanged)
- [ ] Graceful degradation to text input if the endpoint fails
- [ ] Existing clock-out, history, active-timer, and costing flows unaffected

---

## What NOT to do

- **Do not store `user_id` as the FK in `time_entries.worker`** — the column is `TEXT` and changing it would require a migration + join everywhere worker is displayed. Store `full_name` string as today, just reliably populated.
- **Do not reuse `GET /api/users`** — that's Owner-only user management. The clockable endpoint is intentionally separate, narrow, and all-roles.
- **Do not include `office_admin`** in the clockable list — they don't log job labor time.
- **Do not rebuild the time tracker** — this is a one-field swap on the clock-in form.
- **Do not add this endpoint to the Owner-only user management UI** — it's a utility endpoint for the time tracker only.

---

## Reference docs

- `CHS-API-Route-Map.md` — `GET /api/users/clockable` (newly added)
- `Module-Spec-Financial-Management.md` — §4 Time Entry Record (worker field note updated), §5.6 (clock-in flow updated), §10.5 (Time Tracker screen updated)
- `CHS-Design-System.md` — `Select` primitive
- `cursorrules.md` — route conventions, `src/middleware/roles.ts`, auth context pattern
