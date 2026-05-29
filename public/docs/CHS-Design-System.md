# Design System & Style Guide
## CHS Construction Management Platform
### Version 1.0 — May 28, 2026

---

## Overview

This document defines the visual language for the entire CHS platform. Every screen, component, and interaction follows these tokens. The goal is a dark, professional, construction-industry interface that feels like a premium tool — not a generic SaaS app.

**Design direction:** Dark mode industrial. Inspired by high-end project management tools, not consumer apps. The amber accent color (#F59E0B) ties to the existing CHS brand. Clean typography. Dense but readable data layouts. Feels like a cockpit for running a construction business.

**Client-facing pages (portal, estimates, invoices):** Light mode, clean, professional. CHS branding with the amber accent. Designed to impress homeowners and build trust.

---

## 1. CSS Design Tokens

Save as `public/css/tokens.css` — loaded before all other stylesheets.

```css
:root {
  /* ─── Brand Colors ─── */
  --color-brand: #F59E0B;
  --color-brand-light: #FBBF24;
  --color-brand-dark: #D97706;
  --color-brand-subtle: rgba(245, 158, 11, 0.08);
  --color-brand-border: rgba(245, 158, 11, 0.20);

  /* ─── Surfaces (Dark Theme — Internal App) ─── */
  --color-bg: #0B0F1A;
  --color-surface-0: #0F172A;         /* Deepest — page bg */
  --color-surface-1: #111827;         /* Cards, panels */
  --color-surface-2: #1E293B;         /* Elevated — modals, dropdowns */
  --color-surface-3: #334155;         /* Hover states, active items */

  /* ─── Text ─── */
  --color-text-primary: #F1F5F9;      /* Headings, primary content */
  --color-text-secondary: #94A3B8;    /* Descriptions, labels */
  --color-text-muted: #64748B;        /* Metadata, timestamps */
  --color-text-disabled: #475569;     /* Disabled state */
  --color-text-inverse: #0F172A;      /* Text on light bg */

  /* ─── Borders ─── */
  --color-border: #1F2937;
  --color-border-hover: #334155;
  --color-border-focus: var(--color-brand);

  /* ─── Status Colors ─── */
  --color-success: #22C55E;
  --color-success-subtle: rgba(34, 197, 94, 0.10);
  --color-success-border: rgba(34, 197, 94, 0.25);

  --color-warning: #F59E0B;
  --color-warning-subtle: rgba(245, 158, 11, 0.10);
  --color-warning-border: rgba(245, 158, 11, 0.25);

  --color-error: #EF4444;
  --color-error-subtle: rgba(239, 68, 68, 0.10);
  --color-error-border: rgba(239, 68, 68, 0.25);

  --color-info: #3B82F6;
  --color-info-subtle: rgba(59, 130, 246, 0.10);
  --color-info-border: rgba(59, 130, 246, 0.25);

  /* ─── Job Status Colors ─── */
  --status-deposit-paid: #8B5CF6;     /* Purple */
  --status-scheduled: #3B82F6;        /* Blue */
  --status-in-progress: #F59E0B;      /* Amber */
  --status-punch-list: #F97316;       /* Orange */
  --status-complete: #22C55E;         /* Green */
  --status-closed: #64748B;           /* Slate */

  /* ─── Estimate Pipeline Colors ─── */
  --pipeline-new-request: #8B5CF6;
  --pipeline-appointment-set: #3B82F6;
  --pipeline-visit-done: #0EA5E9;
  --pipeline-building: #F59E0B;
  --pipeline-sent: #F97316;
  --pipeline-follow-up: #EF4444;
  --pipeline-won: #22C55E;
  --pipeline-lost: #64748B;

  /* ─── Priority Tags ─── */
  --priority-core-bg: rgba(34, 197, 94, 0.12);
  --priority-core-text: #22C55E;
  --priority-core-border: rgba(34, 197, 94, 0.30);

  --priority-mid-bg: rgba(245, 158, 11, 0.12);
  --priority-mid-text: #F59E0B;
  --priority-mid-border: rgba(245, 158, 11, 0.30);

  --priority-future-bg: rgba(139, 92, 246, 0.12);
  --priority-future-text: #A78BFA;
  --priority-future-border: rgba(139, 92, 246, 0.30);

  /* ─── Typography ─── */
  --font-body: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
  --font-display: 'Outfit', var(--font-body);

  --text-xs: 0.6875rem;    /* 11px — metadata, timestamps */
  --text-sm: 0.8125rem;    /* 13px — secondary content */
  --text-base: 0.9375rem;  /* 15px — body text */
  --text-md: 1rem;          /* 16px — emphasized body */
  --text-lg: 1.25rem;       /* 20px — section headers */
  --text-xl: 1.5rem;        /* 24px — page titles */
  --text-2xl: 2rem;         /* 32px — hero numbers, KPIs */

  --weight-light: 300;
  --weight-normal: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  --weight-bold: 700;
  --weight-extrabold: 800;

  --leading-tight: 1.2;
  --leading-normal: 1.5;
  --leading-relaxed: 1.6;

  /* ─── Spacing ─── */
  --space-2xs: 0.125rem;   /* 2px */
  --space-xs: 0.25rem;     /* 4px */
  --space-sm: 0.5rem;      /* 8px */
  --space-md: 0.75rem;     /* 12px */
  --space-lg: 1rem;        /* 16px */
  --space-xl: 1.5rem;      /* 24px */
  --space-2xl: 2rem;       /* 32px */
  --space-3xl: 3rem;       /* 48px */

  /* ─── Radii ─── */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 20px;
  --radius-full: 9999px;

  /* ─── Shadows ─── */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
  --shadow-focus: 0 0 0 2px var(--color-brand), 0 0 0 4px rgba(245, 158, 11, 0.2);

  /* ─── Transitions ─── */
  --transition-fast: 100ms ease;
  --transition-base: 200ms ease;
  --transition-slow: 300ms ease;

  /* ─── Z-Index Scale ─── */
  --z-dropdown: 100;
  --z-modal-backdrop: 200;
  --z-modal: 300;
  --z-toast: 400;
  --z-capture-bar: 500;

  /* ─── Layout ─── */
  --content-max-width: 1200px;
  --sidebar-width: 240px;
  --nav-height: 56px;
  --capture-bar-height: 64px;
}

/* ─── Light Theme (Client Portal & Estimate Pages) ─── */
.theme-light {
  --color-bg: #FFFFFF;
  --color-surface-0: #F8FAFC;
  --color-surface-1: #FFFFFF;
  --color-surface-2: #F1F5F9;
  --color-surface-3: #E2E8F0;

  --color-text-primary: #0F172A;
  --color-text-secondary: #475569;
  --color-text-muted: #94A3B8;
  --color-text-disabled: #CBD5E1;

  --color-border: #E2E8F0;
  --color-border-hover: #CBD5E1;

  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.06);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.08);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.12);
}
```

---

## 2. Global Font Loading

Add to `public/index.html` `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

---

## 3. Component Specifications

### Buttons

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  min-height: 44px;
  padding: var(--space-sm) var(--space-lg);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all var(--transition-base);
  white-space: nowrap;
}

.btn--primary {
  background: var(--color-brand);
  color: var(--color-text-inverse);
  border-color: var(--color-brand);
}
.btn--primary:hover {
  background: var(--color-brand-light);
}

.btn--secondary {
  background: var(--color-surface-1);
  color: var(--color-text-secondary);
  border-color: var(--color-border);
}
.btn--secondary:hover {
  background: var(--color-surface-2);
  border-color: var(--color-border-hover);
  color: var(--color-text-primary);
}

.btn--ghost {
  background: transparent;
  color: var(--color-text-secondary);
}
.btn--ghost:hover {
  background: var(--color-surface-2);
  color: var(--color-text-primary);
}

.btn--danger {
  background: var(--color-error-subtle);
  color: var(--color-error);
  border-color: var(--color-error-border);
}
.btn--danger:hover {
  background: var(--color-error);
  color: white;
}

.btn--sm {
  min-height: 32px;
  padding: var(--space-xs) var(--space-md);
  font-size: var(--text-xs);
}

.btn--lg {
  min-height: 52px;
  padding: var(--space-md) var(--space-xl);
  font-size: var(--text-base);
}
```

### Cards

```css
.card {
  background: var(--color-surface-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  transition: border-color var(--transition-base);
}
.card:hover {
  border-color: var(--color-border-hover);
}

.card__header {
  padding: var(--space-md) var(--space-lg);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card__title {
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--color-text-primary);
}

.card__body {
  padding: 0 var(--space-lg) var(--space-md);
}

.card__footer {
  padding: var(--space-sm) var(--space-lg);
  border-top: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card__meta {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
```

### Badges / Status Tags

```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: var(--space-2xs) var(--space-sm);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  border-radius: var(--radius-sm);
  letter-spacing: 0.3px;
  text-transform: uppercase;
  border: 1px solid transparent;
}

.badge--deposit_paid  { color: var(--status-deposit-paid); background: rgba(139,92,246,0.10); border-color: rgba(139,92,246,0.25); }
.badge--scheduled     { color: var(--status-scheduled); background: rgba(59,130,246,0.10); border-color: rgba(59,130,246,0.25); }
.badge--in_progress   { color: var(--status-in-progress); background: var(--color-brand-subtle); border-color: var(--color-brand-border); }
.badge--punch_list    { color: var(--status-punch-list); background: rgba(249,115,22,0.10); border-color: rgba(249,115,22,0.25); }
.badge--complete      { color: var(--status-complete); background: var(--color-success-subtle); border-color: var(--color-success-border); }
.badge--closed        { color: var(--status-closed); background: rgba(100,116,139,0.10); border-color: rgba(100,116,139,0.25); }

.badge--paid          { color: var(--color-success); background: var(--color-success-subtle); border-color: var(--color-success-border); }
.badge--sent          { color: var(--color-info); background: var(--color-info-subtle); border-color: var(--color-info-border); }
.badge--past_due      { color: var(--color-error); background: var(--color-error-subtle); border-color: var(--color-error-border); }
.badge--draft         { color: var(--color-text-muted); background: rgba(100,116,139,0.08); border-color: rgba(100,116,139,0.15); }
```

### Forms

```css
.form-group {
  margin-bottom: var(--space-lg);
}

.form-label {
  display: block;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: var(--space-xs);
  font-family: var(--font-mono);
}

.form-input,
.form-select,
.form-textarea {
  width: 100%;
  min-height: 44px;
  padding: var(--space-sm) var(--space-md);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--color-text-primary);
  background: var(--color-surface-0);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color var(--transition-base), box-shadow var(--transition-base);
}

.form-input:focus,
.form-select:focus,
.form-textarea:focus {
  outline: none;
  border-color: var(--color-brand);
  box-shadow: var(--shadow-focus);
}

.form-input::placeholder {
  color: var(--color-text-disabled);
}

.form-textarea {
  min-height: 100px;
  resize: vertical;
}

.form-hint {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  margin-top: var(--space-2xs);
}

.form-error {
  font-size: var(--text-xs);
  color: var(--color-error);
  margin-top: var(--space-2xs);
}
```

### Tables

```css
.table-container {
  overflow-x: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.table th {
  text-align: left;
  padding: var(--space-sm) var(--space-md);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: var(--color-surface-0);
  border-bottom: 1px solid var(--color-border);
}

.table td {
  padding: var(--space-sm) var(--space-md);
  color: var(--color-text-primary);
  border-bottom: 1px solid var(--color-border);
}

.table tr:hover td {
  background: var(--color-surface-2);
}

.table tr:last-child td {
  border-bottom: none;
}
```

### Kanban Board

```css
.kanban {
  display: flex;
  gap: var(--space-md);
  overflow-x: auto;
  padding-bottom: var(--space-md);
  min-height: 400px;
}

.kanban__column {
  min-width: 280px;
  max-width: 320px;
  flex-shrink: 0;
  background: var(--color-surface-0);
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
}

.kanban__column-header {
  padding: var(--space-md) var(--space-lg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--color-border);
}

.kanban__column-title {
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  font-weight: var(--weight-medium);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.kanban__column-count {
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  color: var(--color-text-muted);
  background: var(--color-surface-2);
  padding: var(--space-2xs) var(--space-sm);
  border-radius: var(--radius-full);
}

.kanban__cards {
  flex: 1;
  padding: var(--space-sm);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

/* Mobile: horizontal scroll with snap */
@media (max-width: 767px) {
  .kanban {
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
  }
  .kanban__column {
    min-width: 85vw;
    scroll-snap-align: center;
  }
}
```

### Modal

```css
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: var(--z-modal-backdrop);
  opacity: 0;
  transition: opacity var(--transition-base);
}
.modal-backdrop.is-active { opacity: 1; }

.modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) scale(0.95);
  background: var(--color-surface-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  z-index: var(--z-modal);
  width: min(90vw, 560px);
  max-height: 85vh;
  overflow-y: auto;
  opacity: 0;
  transition: all var(--transition-slow);
}
.modal.is-active {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
}

.modal__header {
  padding: var(--space-lg) var(--space-xl);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal__title {
  font-size: var(--text-lg);
  font-weight: var(--weight-bold);
}

.modal__close {
  background: none;
  border: none;
  color: var(--color-text-muted);
  font-size: var(--text-lg);
  cursor: pointer;
  padding: var(--space-xs);
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal__body {
  padding: var(--space-xl);
}

.modal__footer {
  padding: var(--space-lg) var(--space-xl);
  border-top: 1px solid var(--color-border);
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
}
```

### Toast Notifications

```css
.toast-container {
  position: fixed;
  top: var(--space-xl);
  right: var(--space-xl);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  max-width: 400px;
}

.toast {
  padding: var(--space-md) var(--space-lg);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  box-shadow: var(--shadow-md);
  animation: toast-in 300ms ease forwards;
}

.toast--success { background: var(--color-success); color: white; }
.toast--error   { background: var(--color-error); color: white; }
.toast--info    { background: var(--color-info); color: white; }
.toast--warning { background: var(--color-brand); color: var(--color-text-inverse); }

@keyframes toast-in {
  from { transform: translateX(100%); opacity: 0; }
  to   { transform: translateX(0); opacity: 1; }
}

/* Mobile: full width, bottom position */
@media (max-width: 767px) {
  .toast-container {
    top: auto;
    bottom: calc(var(--capture-bar-height) + var(--space-md));
    left: var(--space-md);
    right: var(--space-md);
    max-width: none;
  }
}
```

### Quick Capture Bar (Mobile)

```css
.capture-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: var(--capture-bar-height);
  background: var(--color-surface-1);
  border-top: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding: 0 var(--space-sm);
  z-index: var(--z-capture-bar);
}

.capture-bar__btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2xs);
  background: none;
  border: none;
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
  padding: var(--space-xs);
  min-width: 56px;
  min-height: 44px;
}

.capture-bar__btn:active {
  color: var(--color-brand);
}

.capture-bar__icon {
  font-size: 1.25rem;
}

/* Only show on mobile when viewing a job */
@media (min-width: 768px) {
  .capture-bar { display: none; }
}
```

---

## 4. Layout Patterns

### App Shell

```
┌──────────────────────────────────┐
│  Top Nav (56px)  [logo] [bell]   │
├──────┬───────────────────────────┤
│ Side │                           │
│ Nav  │   Main Content Area       │
│240px │                           │
│      │                           │
│      │                           │
├──────┴───────────────────────────┤
│  Capture Bar (mobile only, 64px) │
└──────────────────────────────────┘
```

- **Desktop (1024px+):** Sidebar nav + content area
- **Tablet (768-1023px):** Collapsible sidebar, content fills width
- **Mobile (<768px):** No sidebar, bottom tab nav, capture bar on job pages

### View Header Pattern

Every page starts with a consistent header:

```html
<div class="view-header">
  <div class="view-header__left">
    <h1 class="view-title">Page Title</h1>
    <p class="view-subtitle">Description or context</p>
  </div>
  <div class="view-header__right">
    <!-- Filters, actions, buttons -->
  </div>
</div>
```

---

## 5. Utility Classes

```css
/* Text */
.text--muted    { color: var(--color-text-muted); }
.text--secondary { color: var(--color-text-secondary); }
.text--brand    { color: var(--color-brand); }
.text--success  { color: var(--color-success); }
.text--error    { color: var(--color-error); }
.text--mono     { font-family: var(--font-mono); }
.text--uppercase { text-transform: uppercase; letter-spacing: 0.5px; }
.text--right    { text-align: right; }
.text--center   { text-align: center; }
.text--truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Spacing */
.mt-sm { margin-top: var(--space-sm); }
.mt-md { margin-top: var(--space-md); }
.mt-lg { margin-top: var(--space-lg); }
.mt-xl { margin-top: var(--space-xl); }
.mb-sm { margin-bottom: var(--space-sm); }
.mb-md { margin-bottom: var(--space-md); }
.mb-lg { margin-bottom: var(--space-lg); }

/* Layout */
.flex       { display: flex; }
.flex-col   { flex-direction: column; }
.flex-wrap  { flex-wrap: wrap; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.gap-xs     { gap: var(--space-xs); }
.gap-sm     { gap: var(--space-sm); }
.gap-md     { gap: var(--space-md); }
.gap-lg     { gap: var(--space-lg); }

/* Display */
.hidden     { display: none; }
.mobile-only { display: none; }
.desktop-only { display: block; }

@media (max-width: 767px) {
  .mobile-only { display: block; }
  .desktop-only { display: none; }
}
```

---

## 6. Icon Strategy

Use emoji for quick visual indicators in the internal app (matching the project outline aesthetic). No icon library dependency.

| Context | Icon |
|---------|------|
| Camera / Photo | 📷 |
| Voice / Note | 🎤 |
| Task | ✅ |
| Expense / Money | 💵 |
| Daily Log | 📝 |
| Jobs | 🏗️ |
| Financial | 💰 |
| Clients | 👥 |
| Documents | 📄 |
| Photos | 📸 |
| Social | 📱 |
| Settings | ⚙️ |
| Notifications | 🔔 |
| Estimating | 📋 |

For the client portal (light theme, professional), use simple SVG icons instead of emoji.

---

## 7. Currency & Date Formatting

```javascript
// Use these helper functions everywhere for consistency
function formatCurrency(amount) {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

function formatStatus(status) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatPhone(phone) {
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  }
  return phone;
}
```
