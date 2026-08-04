-- Vendor & Service Subscriptions Tracker (Aug 4, 2026)
-- Informational cost/renewal tracking — distinct from integration_connections.

CREATE TABLE IF NOT EXISTS vendor_subscriptions (
  id TEXT PRIMARY KEY,
  service_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN (
    'infrastructure', 'communications', 'documents', 'payments',
    'accounting', 'ai_cloud', 'marketing_crm', 'development'
  )),
  cost_amount REAL,
  cost_period TEXT CHECK(
    cost_period IS NULL OR cost_period IN ('monthly', 'annual', 'usage_based', 'one_time')
  ),
  currency TEXT NOT NULL DEFAULT 'USD',
  renewal_date TEXT,
  auto_renews INTEGER NOT NULL DEFAULT 1,
  account_email TEXT,
  account_id TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  support_notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_active_renewal
  ON vendor_subscriptions(is_active, renewal_date);

CREATE INDEX IF NOT EXISTS idx_vendor_subscriptions_category
  ON vendor_subscriptions(category);

-- Seed from Platform Operations Guide (real values, not placeholders).
INSERT OR IGNORE INTO vendor_subscriptions (
  id, service_name, category, cost_amount, cost_period, currency, renewal_date,
  auto_renews, account_email, account_id, contact_name, contact_email, contact_phone,
  support_notes, is_active, created_at, updated_at
) VALUES
(
  'vs-cloudflare',
  'Cloudflare',
  'infrastructure',
  0,
  'monthly',
  'USD',
  '2026-08-24',
  1,
  'tony@homesolutionsar.com',
  'bc587f76f54b2726518943f0941dda1b',
  NULL, NULL, NULL,
  'Free plan + R2 usage-based overage',
  1, datetime('now'), datetime('now')
),
(
  'vs-domain-homesolutionsar',
  'Domain (homesolutionsar.com)',
  'infrastructure',
  NULL,
  'annual',
  'USD',
  '2027-12-11',
  1,
  'tony@homesolutionsar.com',
  NULL, NULL, NULL, NULL,
  'Registrar: Cloudflare',
  1, datetime('now'), datetime('now')
),
(
  'vs-twilio',
  'Twilio',
  'communications',
  NULL,
  'usage_based',
  'USD',
  NULL,
  1,
  'tony@homesolutionsar.com',
  NULL, NULL, NULL, NULL,
  'Pay-as-you-go, auto-recharge enabled',
  1, datetime('now'), datetime('now')
),
(
  'vs-resend',
  'Resend',
  'communications',
  0,
  'monthly',
  'USD',
  NULL,
  1,
  'tony@homesolutionsar.com',
  NULL, NULL, NULL, NULL,
  'Free tier',
  1, datetime('now'), datetime('now')
),
(
  'vs-boldsign',
  'BoldSign',
  'documents',
  30.00,
  'monthly',
  'USD',
  '2026-08-09',
  1,
  'tony@homesolutionsar.com',
  NULL, NULL, NULL, NULL,
  'Enterprise API, recurs on the 9th',
  1, datetime('now'), datetime('now')
),
(
  'vs-stripe',
  'Stripe',
  'payments',
  NULL,
  'usage_based',
  'USD',
  NULL,
  1,
  'tony@homesolutionsar.com',
  NULL, NULL, NULL, NULL,
  '2.9% + 30¢ per charge',
  1, datetime('now'), datetime('now')
),
(
  'vs-wisetack',
  'Wisetack',
  'payments',
  NULL,
  'usage_based',
  'USD',
  NULL,
  1,
  'tony@homesolutionsar.com',
  NULL, NULL, NULL, NULL,
  '3.9% processing rate',
  1, datetime('now'), datetime('now')
),
(
  'vs-qbo',
  'QuickBooks Online',
  'accounting',
  75.00,
  'monthly',
  'USD',
  '2026-09-01',
  1,
  'tony@homesolutionsar.com',
  NULL, NULL, NULL, NULL,
  'Essentials',
  1, datetime('now'), datetime('now')
),
(
  'vs-anthropic',
  'Anthropic Claude API',
  'ai_cloud',
  NULL,
  'usage_based',
  'USD',
  NULL,
  1,
  'tony@homesolutionsar.com',
  NULL, NULL, NULL, NULL,
  NULL,
  1, datetime('now'), datetime('now')
),
(
  'vs-google-vertex',
  'Google Cloud (Vertex AI)',
  'ai_cloud',
  NULL,
  'usage_based',
  'USD',
  NULL,
  1,
  'tony@homesolutionsar.com',
  NULL, NULL, NULL, NULL,
  NULL,
  1, datetime('now'), datetime('now')
),
(
  'vs-google-places',
  'Google Places API',
  'ai_cloud',
  NULL,
  'usage_based',
  'USD',
  NULL,
  1,
  'tony@homesolutionsar.com',
  NULL, NULL, NULL, NULL,
  NULL,
  1, datetime('now'), datetime('now')
),
(
  'vs-highlevel',
  'HighLevel',
  'marketing_crm',
  0,
  'monthly',
  'USD',
  NULL,
  1,
  'tony@homesolutionsar.com',
  NULL, NULL, NULL, NULL,
  'Bundled into Redmond Growth',
  1, datetime('now'), datetime('now')
),
(
  'vs-redmond-growth',
  'Redmond Growth',
  'marketing_crm',
  1650.00,
  'monthly',
  'USD',
  NULL,
  1,
  'tony@homesolutionsar.com',
  NULL,
  'Travis Davis',
  'travisd@redmondgrowth.com',
  '(918) 986-7933',
  'Multi-month discount plan possible later',
  1, datetime('now'), datetime('now')
),
(
  'vs-github',
  'GitHub',
  'development',
  0,
  'monthly',
  'USD',
  NULL,
  1,
  'tony@homesolutionsar.com',
  NULL, NULL, NULL, NULL,
  'Free tier',
  1, datetime('now'), datetime('now')
);
