-- Sprint 36 Phase A: Google Reviews Dashboard — local data model.
--
-- google_review_id is nullable (Phase A reviews entered manually have no Google
-- ID yet). Still UNIQUE when present so future sync rows can't duplicate.
-- entry_source distinguishes manual entries from real GBP sync rows so Phase B
-- can reconcile them once the sync starts producing the same reviews.

CREATE TABLE IF NOT EXISTS google_reviews (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  google_review_id TEXT UNIQUE,
  reviewer_name TEXT NOT NULL,
  reviewer_photo_url TEXT,
  star_rating INTEGER NOT NULL CHECK(star_rating BETWEEN 1 AND 5),
  comment_text TEXT,
  review_created_at TEXT NOT NULL,
  review_updated_at TEXT,
  reply_text TEXT,
  reply_sent_at TEXT,
  reply_source TEXT CHECK(reply_source IN ('cms', 'external')),
  matched_client_id TEXT REFERENCES clients(id),
  match_confidence TEXT CHECK(match_confidence IN ('confirmed', 'suggested')),
  entry_source TEXT NOT NULL DEFAULT 'manual' CHECK(entry_source IN ('manual', 'sync')),
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_google_reviews_created ON google_reviews(review_created_at);
CREATE INDEX IF NOT EXISTS idx_google_reviews_unanswered ON google_reviews(reply_text)
  WHERE reply_text IS NULL;
CREATE INDEX IF NOT EXISTS idx_google_reviews_client ON google_reviews(matched_client_id)
  WHERE matched_client_id IS NOT NULL;

-- Feature flag row — GBP_REVIEWS_LIVE defaults to false (Phase A).
-- Phase B flips this to 'true' once GBP API credentials are approved and the
-- sync + live-reply endpoints are wired.
INSERT OR IGNORE INTO system_settings (key, value, value_type, category, label, description)
  VALUES (
    'gbp_reviews_live', 'false', 'string', 'reviews',
    'GBP Reviews Live',
    'Set to true once Google Business Profile API access is approved (Phase B). Controls whether /api/google-reviews/:id/reply posts to Google and whether the sync job is active.'
  );
