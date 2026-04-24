# chs-hub

The operational hub for **Columbus Home Solutions** — one place for jobs, leads, files, estimates, and social media.

> **Status:** Planning phase (Phase 6). Architecture and build plan are complete. Implementation begins Session 6a.

---

## What this is

A Cloudflare-native operational platform replacing a patchwork of Google Sheets + GitHub Actions + Apps Script + Claude Cowork automations. The goal: one codebase, one database, one deploy, one audit trail — with room to add employees.

## Stack

- **Edge compute:** Cloudflare Workers
- **Database:** Cloudflare D1 (SQLite on the edge)
- **File storage:** Cloudflare R2 (unlimited, zero egress)
- **Frontend:** Cloudflare Pages (vanilla HTML + Tailwind, installable PWA)
- **Scheduler:** Workers cron + Queues
- **Secrets:** Workers Secrets + KV

## Retires

- GitHub Actions for syncs (Workers cron replaces)
- Google Apps Script (D1 replaces)
- Google Drive for job photos (R2 + PWA camera replace)
- iPhone Shortcut for photo uploads (PWA camera replaces)
- Claude Cowork nightly photo sort (Workers cron replaces)

## Keeps

- Jobber as the system of record for jobs/clients/quotes/invoices
- HighLevel for lead capture (integrated, not replaced)
- Metricool as the social scheduler (manual paste stays — no API integration)
- `chs-estimator-seeder` as a separate repo for the quarterly Jobber pricebook sync
- WC KBPI Google Sheet as a downstream export (read-only target)

---

## Docs

Read in order — they build on each other.

1. **[00-architecture.md](docs/00-architecture.md)** — master architecture, D1 schema, session roadmap
2. **[01-file-system.md](docs/01-file-system.md)** — R2 + PWA decisions, Drive migration plan
3. **[02-estimating-app.md](docs/02-estimating-app.md)** — blueprint/photo → Jobber quote workflow, 9 milestones
4. **[03-social-media.md](docs/03-social-media.md)** — automation of Tony's existing social system

Live rendered version: **https://docs.homesolutionsar.com** (once Cloudflare Pages is connected)

---

## Repo structure (future — not built yet)

```
chs-hub/
├── docs/                  — planning docs (this directory)
├── worker/                — Cloudflare Worker: API, cron, integrations (Session 6a+)
│   ├── src/
│   ├── wrangler.toml
│   └── package.json
├── frontend/              — PWA dashboard (Session 6b+)
│   ├── public/
│   └── src/
├── schema/                — D1 migrations (Session 6a)
│   └── migrations/
└── scripts/               — ops scripts (migration, seed, etc.)
```

## Related repos

- [`chs-dashboard`](https://github.com/Columbus-Home-Solutions/chs-dashboard) — current dashboard, will be archived after Phase 6 cutover
- [`chs-estimator-seeder`](https://github.com/Columbus-Home-Solutions/chs-estimator-seeder) — quarterly Jobber pricebook sync, stays independent

## License

Private, internal tooling. Not for distribution.
