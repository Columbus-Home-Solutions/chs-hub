# CHS Construction Management Platform — Cursor Rules

## Project Overview

You are building a custom construction management platform for Columbus Home Solutions (CHS), a residential general contractor in central Arkansas. This replaces Jobber, CompanyCam, and Metricool with a single unified platform. The codebase evolves from an existing dashboard app called chs-hub.

**Always reference the module specs, database schema, API route map, and build order plan in the project docs before writing code.** These documents are the source of truth for what to build and how.

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Backend | Cloudflare Workers (TypeScript) | Serverless, globally distributed |
| Database | Cloudflare D1 (SQLite) | Relational, transactional |
| File Storage | Cloudflare R2 | S3-compatible, zero egress fees |
| Frontend | Preact + HTM + Vite | Lightweight React-compatible framework, no JSX build step required |
| PWA | Service Worker + Web App Manifest | Offline capability |
| Native App | Capacitor (iOS + Android) | WebView wrapper — Phase 3 |
| Auth | Cloudflare Access | Zero-trust, email-based identity |

### Why Preact (Not React, Not Vanilla)

- **3KB** — barely larger than nothing. Same API as React.
- **Hooks** for state management — useState, useEffect, useContext, useReducer.
- **Component model** handles complex UI: Kanban boards, estimate builder, calendar, cost-plus engine.
- **Cursor generates better code** with React/Preact patterns than with vanilla JS SPA.
- **Vite** provides instant dev server and optimized production builds with zero config.
- **HTM** (optional) allows tagged template literals instead of JSX if you want to skip the JSX transform for simple components.

---

## Project Structure

```
chs-hub/
├── src/
│   ├── worker.ts                  # Main Worker entry — route dispatcher
│   ├── routes/                    # API route handlers by module
│   │   ├── clients.ts
│   │   ├── estimates.ts
│   │   ├── jobs.ts
│   │   ├── invoices.ts
│   │   ├── photos.ts
│   │   ├── documents.ts
│   │   ├── notifications.ts
│   │   ├── social.ts
│   │   ├── settings.ts
│   │   ├── portal.ts             # Public portal routes (token auth)
│   │   └── webhooks.ts           # Stripe, Twilio, etc.
│   ├── middleware/
│   │   ├── auth.ts               # Cloudflare Access → user resolution
│   │   ├── roles.ts              # Role-based access control checks
│   │   └── audit.ts              # Audit log middleware
│   ├── services/                  # Business logic (not route-specific)
│   │   ├── quote-to-job.ts       # Estimate → Job conversion engine
│   │   ├── billing-engine.ts     # Cost-plus cycle management
│   │   ├── notification-engine.ts # Template → render → send
│   │   ├── receipt-ai.ts         # Claude API receipt processing
│   │   ├── smart-notes.ts        # Claude API note processing
│   │   ├── wc-spreadsheet.ts     # Google Sheets sync
│   │   └── drive-mirror.ts       # Google Drive file mirroring
│   ├── lib/
│   │   ├── db.ts                 # D1 query helpers
│   │   ├── r2.ts                 # R2 storage helpers
│   │   ├── stripe.ts             # Stripe API wrapper
│   │   ├── twilio.ts             # Twilio SMS wrapper
│   │   ├── resend.ts             # Email sending
│   │   ├── claude.ts             # Anthropic API wrapper
│   │   └── uuid.ts               # crypto.randomUUID() helper
│   └── types/
│       └── index.ts              # TypeScript interfaces for all entities
├── frontend/                      # Preact SPA — built by Vite
│   ├── index.html                # App shell entry point
│   ├── vite.config.ts            # Vite config with Preact plugin
│   ├── src/
│   │   ├── main.tsx              # App entry — mounts root component
│   │   ├── app.tsx               # Root component with router
│   │   ├── router.tsx            # Client-side routing
│   │   ├── api.ts                # API client (fetch wrapper)
│   │   ├── store/                # Global state management
│   │   │   ├── auth.tsx          # Auth context (current user + role)
│   │   │   ├── notifications.tsx # In-app notification state
│   │   │   └── toast.tsx         # Toast notification state
│   │   ├── hooks/                # Custom hooks
│   │   │   ├── useApi.ts         # Data fetching hook with loading/error
│   │   │   ├── useForm.ts        # Form state management
│   │   │   ├── useDragDrop.ts    # Kanban drag-and-drop
│   │   │   └── useOffline.ts     # Offline detection + sync queue
│   │   ├── components/           # Reusable UI components
│   │   │   ├── ui/               # Primitives
│   │   │   │   ├── Button.tsx
│   │   │   │   ├── Badge.tsx
│   │   │   │   ├── Card.tsx
│   │   │   │   ├── Modal.tsx
│   │   │   │   ├── Toast.tsx
│   │   │   │   ├── Table.tsx
│   │   │   │   ├── FormField.tsx
│   │   │   │   ├── Select.tsx
│   │   │   │   └── Spinner.tsx
│   │   │   ├── layout/           # Layout components
│   │   │   │   ├── AppShell.tsx  # Sidebar + nav + content
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── TopNav.tsx
│   │   │   │   └── CaptureBar.tsx # Mobile quick-capture
│   │   │   ├── Kanban.tsx        # Reusable Kanban board
│   │   │   ├── Calendar.tsx      # Schedule calendar
│   │   │   ├── Timeline.tsx      # Communication / photo timeline
│   │   │   └── CurrencyInput.tsx # Money input with formatting
│   │   ├── views/                # Page-level view components
│   │   │   ├── Dashboard.tsx
│   │   │   ├── clients/
│   │   │   │   ├── ClientList.tsx
│   │   │   │   └── ClientDetail.tsx
│   │   │   ├── estimates/
│   │   │   │   ├── EstimatePipeline.tsx
│   │   │   │   ├── EstimateBuilder.tsx
│   │   │   │   └── EstimateDetail.tsx
│   │   │   ├── jobs/
│   │   │   │   ├── JobPipeline.tsx
│   │   │   │   ├── JobDetail.tsx
│   │   │   │   └── JobSchedule.tsx
│   │   │   ├── financial/
│   │   │   │   ├── InvoiceList.tsx
│   │   │   │   ├── ExpenseList.tsx
│   │   │   │   └── BillingCycle.tsx
│   │   │   ├── photos/
│   │   │   │   └── PhotoTimeline.tsx
│   │   │   ├── social/
│   │   │   │   ├── ContentCalendar.tsx
│   │   │   │   └── ApprovalQueue.tsx
│   │   │   └── settings/
│   │   │       └── Settings.tsx
│   │   └── styles/
│   │       ├── tokens.css        # Design tokens (imported globally)
│   │       ├── components.css    # Base component styles
│   │       └── views/            # Per-view styles (CSS modules or plain)
│   ├── public/
│   │   ├── manifest.json         # PWA manifest
│   │   └── sw.js                 # Service Worker (offline sync)
│   └── package.json
├── portal/                        # Client portal — separate Preact app (lightweight)
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── PortalApp.tsx
│       └── components/
├── migrations/                    # D1 SQL migration files
│   ├── 0001_initial.sql          # (existing chs-hub migrations)
│   ├── ...
│   ├── 0012_schema_bridge.sql    # Bridge: ALTER existing tables + CREATE new tables
│   └── ...
├── wrangler.toml                  # Cloudflare Workers config
├── package.json                   # Root workspace package.json
└── .cursorrules                   # This file
```

---

## Frontend Setup (Preact + Vite)

### Installation

```bash
cd frontend
npm create vite@latest . -- --template preact-ts
npm install preact preact-router
npm install -D @preact/preset-vite
```

### Vite Config

```typescript
// frontend/vite.config.ts
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: '../public',       // Build output goes where Workers serves static files
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',   // Proxy API calls to local Workers dev
    },
  },
});
```

### Component Patterns

**Functional components with hooks — this is the standard for every component:**

```tsx
// frontend/src/components/ui/Badge.tsx
interface BadgeProps {
  status: string;
  children: string;
}

export function Badge({ status, children }: BadgeProps) {
  return (
    <span class={`badge badge--${status}`}>
      {children}
    </span>
  );
}
```

**View components with data fetching:**

```tsx
// frontend/src/views/jobs/JobPipeline.tsx
import { useState, useEffect } from 'preact/hooks';
import { useApi } from '../../hooks/useApi';
import { Kanban } from '../../components/Kanban';
import { Badge } from '../../components/ui/Badge';

const STATUSES = ['deposit_paid', 'scheduled', 'in_progress', 'punch_list', 'complete', 'closed'];

export function JobPipeline() {
  const { data: jobs, loading, error, refetch } = useApi('/api/jobs/pipeline');
  const [filterType, setFilterType] = useState('all');

  if (loading) return <Spinner />;
  if (error) return <ErrorMessage error={error} />;

  const filtered = filterType === 'all'
    ? jobs
    : jobs.filter(j => j.job_type === filterType);

  return (
    <div class="view">
      <div class="view-header">
        <h1 class="view-title">Job Pipeline</h1>
        <Select value={filterType} onChange={setFilterType} options={jobTypes} />
      </div>
      <Kanban
        columns={STATUSES}
        items={filtered}
        renderCard={(job) => <JobCard job={job} />}
        onDragEnd={handleStatusChange}
      />
    </div>
  );
}
```

**Custom hooks for data fetching:**

```tsx
// frontend/src/hooks/useApi.ts
import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api';

export function useApi<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<T>(url);
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => { fetch(); }, [fetch]);

  return { data, loading, error, refetch: fetch };
}
```

**API client:**

```typescript
// frontend/src/api.ts
class ApiClient {
  async get<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  async post<T>(url: string, body: any): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  async put<T>(url: string, body: any): Promise<T> {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return res.json();
  }
}

export const api = new ApiClient();
```

**Routing with preact-router:**

```tsx
// frontend/src/app.tsx
import Router from 'preact-router';
import { AppShell } from './components/layout/AppShell';
import { Dashboard } from './views/Dashboard';
import { ClientList } from './views/clients/ClientList';
import { ClientDetail } from './views/clients/ClientDetail';
import { EstimatePipeline } from './views/estimates/EstimatePipeline';
import { JobPipeline } from './views/jobs/JobPipeline';
import { JobDetail } from './views/jobs/JobDetail';
// ... other views

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <AppShell>
          <Router>
            <Dashboard path="/" />
            <ClientList path="/clients" />
            <ClientDetail path="/clients/:id" />
            <EstimatePipeline path="/estimates" />
            <JobPipeline path="/jobs" />
            <JobDetail path="/jobs/:id" />
            {/* ... */}
          </Router>
        </AppShell>
      </ToastProvider>
    </AuthProvider>
  );
}
```

**Global state with Preact Context:**

```tsx
// frontend/src/store/auth.tsx
import { createContext } from 'preact';
import { useState, useEffect, useContext } from 'preact/hooks';
import { api } from '../api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/api/users/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

// Usage in any component:
// const { user } = useAuth();
// if (user.role !== 'owner') return <AccessDenied />;
```

### Form Handling Pattern

```tsx
// frontend/src/hooks/useForm.ts
import { useState, useCallback } from 'preact/hooks';

export function useForm<T>(initialValues: T) {
  const [values, setValues] = useState<T>(initialValues);
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({});
  const [submitting, setSubmitting] = useState(false);

  const setValue = useCallback((field: keyof T, value: any) => {
    setValues(prev => ({ ...prev, [field]: value }));
    // Clear error when field is edited
    setErrors(prev => ({ ...prev, [field]: undefined }));
  }, []);

  const handleSubmit = useCallback(async (submitFn: (values: T) => Promise<void>) => {
    setSubmitting(true);
    try {
      await submitFn(values);
    } catch (err) {
      // If server returns field-level errors, set them
      if (err.fieldErrors) setErrors(err.fieldErrors);
      throw err;
    } finally {
      setSubmitting(false);
    }
  }, [values]);

  return { values, errors, submitting, setValue, setErrors, handleSubmit, setValues };
}
```

---

## Backend Conventions

### API Route Pattern

Every route handler follows this structure:

```typescript
// src/routes/clients.ts
import { Env, AuthenticatedRequest } from '../types';
import { requireRole } from '../middleware/roles';

export async function handleClients(request: AuthenticatedRequest, env: Env): Promise<Response> {
  const { method, url } = request;
  const path = new URL(url).pathname;

  if (method === 'GET' && path === '/api/clients') {
    return listClients(request, env);
  }

  const clientMatch = path.match(/^\/api\/clients\/([a-f0-9-]+)$/);
  if (method === 'GET' && clientMatch) {
    return getClient(request, env, clientMatch[1]);
  }

  if (method === 'POST' && path === '/api/clients') {
    requireRole(request, ['owner', 'project_manager', 'office_admin']);
    return createClient(request, env);
  }

  return jsonResponse({ error: 'Not found' }, 404);
}
```

### D1 Query Patterns

```typescript
// ALWAYS use parameterized queries — never interpolate values
const result = await env.DB.prepare(
  'SELECT * FROM clients WHERE id = ?'
).bind(clientId).first();

// For inserts, always generate UUID in code
const id = crypto.randomUUID();
await env.DB.prepare(
  'INSERT INTO clients (id, first_name, last_name, email, phone, created_at) VALUES (?, ?, ?, ?, ?, datetime("now"))'
).bind(id, firstName, lastName, email, phone).run();

// Pagination
const { limit = 25, offset = 0 } = queryParams;
const results = await env.DB.prepare(
  'SELECT * FROM clients ORDER BY created_at DESC LIMIT ? OFFSET ?'
).bind(Math.min(limit, 100), offset).all();
```

### Response Helpers

```typescript
function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(error: string, status = 400, details?: string): Response {
  return jsonResponse({ error, details }, status);
}
```

### Auth Middleware

```typescript
export async function authenticateRequest(request: Request, env: Env): Promise<AuthenticatedRequest> {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (!email) throw new AuthError('No authenticated user');

  const user = await env.DB.prepare(
    'SELECT * FROM users WHERE email = ? AND is_active = 1'
  ).bind(email).first();

  if (!user) throw new AuthError('User not found or inactive');
  (request as AuthenticatedRequest).user = user;
  return request as AuthenticatedRequest;
}
```

### Audit Logging

```typescript
await env.DB.prepare(
  'INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))'
).bind(
  crypto.randomUUID(),
  request.user.email,
  'job_status_changed',
  'job',
  jobId,
  JSON.stringify({ old: 'scheduled', new: 'in_progress' })
).run();
```

---

## URL & Domain Structure

Everything runs through a single Cloudflare Workers route:

```
app.homesolutionsar.com                 # The CHS platform
app.homesolutionsar.com/api/*           # API routes (Workers)
app.homesolutionsar.com/portal/*        # Client portal (public, token auth)
app.homesolutionsar.com/estimate/*      # Estimate delivery pages (public, token auth)
app.homesolutionsar.com/share/*         # Shared document links (public, token auth)
```

Portal and estimate URLs sent to clients:
- Portal: `https://app.homesolutionsar.com/portal/{portal_token}`
- Estimate: `https://app.homesolutionsar.com/estimate/{estimate_token}`

---

## D1 Migration Rules

1. Continue the existing migration sequence (current highest: check d1_migrations table).
2. One migration file per logical change. Name format: `NNNN_description.sql`
3. Use `CREATE TABLE IF NOT EXISTS` for new tables.
4. Use `ALTER TABLE ... ADD COLUMN` for extending existing tables.
5. **Never DROP existing tables or columns.** SQLite doesn't support DROP COLUMN. All changes are additive.
6. Existing chs-hub tables that overlap with new schema: ALTER to add missing columns. See Schema Bridge doc for details.
7. Test locally first: `npx wrangler d1 execute <db-name> --local --file=migrations/NNNN_file.sql`
8. Deploy: `npx wrangler d1 execute <db-name> --remote --file=migrations/NNNN_file.sql`

---

## Existing chs-hub Tables (DO NOT DROP)

These tables exist in the live D1 and contain production data:

```
ai_generations, audit_log, clients, company_documents, d1_migrations,
drive_mirror_folders, estimates, expenses, file_shares, file_tags, files,
integrations, invoices, job_files, jobs, kv_cache, leads, line_items,
notes, payments, photos, quotes, subcontractors, sync_dead_letters,
sync_log, users
```

See the Schema Bridge Migration doc for the full mapping of existing → new schema.

---

## Naming Conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| D1 tables | snake_case, plural | `estimate_requests` |
| D1 columns | snake_case | `client_id`, `created_at` |
| API routes | kebab-case | `/api/estimate-requests` |
| TypeScript files (backend) | kebab-case | `billing-engine.ts` |
| TypeScript interfaces | PascalCase | `EstimateRequest`, `JobRecord` |
| TypeScript functions | camelCase | `createClient`, `getJobById` |
| Preact components | PascalCase files + exports | `JobCard.tsx` → `export function JobCard()` |
| Preact hooks | camelCase, prefixed `use` | `useApi.ts` → `export function useApi()` |
| CSS classes | BEM (block__element--modifier) | `.card__header--active` |
| CSS files | Component-matched or tokens | `tokens.css`, `components.css` |
| Environment variables | SCREAMING_SNAKE | `STRIPE_SECRET_KEY` |

---

## Testing Strategy

### Critical Path Tests (Required)

1. **Quote-to-job conversion** — Estimate approved → deposit paid → job created with correct tasks, budget, portal token.
2. **Stripe payment flow** — Invoice → payment link → webhook → payment recorded → invoice updated → notification fired.
3. **Cost-plus reconciliation** — Mini-budget → expenses → reconcile → credit/overage correct.
4. **Convenience fee** — 3.5% on electronic, $0 on check/cash.
5. **Late fee** — $50/day after 7-day grace period.
6. **RBAC** — Non-owner roles denied restricted endpoints.

### Manual Testing (Per Sprint)

Test on desktop Chrome, iPhone Safari, Android Chrome.

---

## Business Rules (Quick Reference)

- Jobs ONLY created via quote-to-job conversion. No manual creation.
- Billing model locked after first invoice.
- 3.5% convenience fee on ALL electronic payments (CC + ACH). No fee for check/cash.
- Late fee: $50/day after 7-day grace period.
- Labor: $90/hr general, $105/hr PM/skilled. From system_settings.
- Cost-plus: 10% PM fee + 20% contractor fee on top of costs.
- Portal type auto-set from billing model.
- High Level NOT replaced — stays as CRM, data pulled via API proxy.
- WC Spreadsheet syncs every 30 min. Never modify formulas.
- Photos soft-delete only (is_active = 0). R2 objects permanent.
- Every outbound notification auto-logs to communication timeline.

---

## What NOT to Do

- **Don't use React.** Use Preact — same API, 3KB instead of 40KB.
- **Don't use Next.js, Remix, or any meta-framework.** Preact + Vite + preact-router is the stack.
- **Don't use Tailwind.** Use the design token system in tokens.css with BEM classes.
- **Don't use an ORM.** Write D1 queries directly with parameterized binds.
- **Don't create jobs directly.** Always go through quote-to-job conversion.
- **Don't modify WC Spreadsheet formulas.** Only write to specific cell ranges.
- **Don't store secrets in code.** Use Cloudflare Workers secrets.
- **Don't skip audit logging.** Every CUD operation gets logged.
- **Don't DROP existing tables.** Use ALTER TABLE ADD COLUMN for existing tables.
