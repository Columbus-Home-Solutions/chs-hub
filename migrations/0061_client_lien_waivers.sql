-- Sprint 32: client lien waivers (BoldSign) + completion package sent timestamp

CREATE TABLE IF NOT EXISTS client_lien_waivers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  waiver_type TEXT NOT NULL DEFAULT 'conditional'
    CHECK(waiver_type IN ('conditional', 'final')),
  payment_amount REAL NOT NULL,
  invoice_id TEXT REFERENCES invoices(id),
  boldsign_document_id TEXT,
  boldsign_template_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','sent','signed','declined','failed')),
  sent_at TEXT,
  signed_at TEXT,
  r2_key TEXT,
  document_id TEXT REFERENCES documents(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_client_lien_waivers_job_id
  ON client_lien_waivers(job_id);
CREATE INDEX IF NOT EXISTS idx_client_lien_waivers_status
  ON client_lien_waivers(status);
CREATE INDEX IF NOT EXISTS idx_client_lien_waivers_boldsign_document_id
  ON client_lien_waivers(boldsign_document_id);

ALTER TABLE jobs ADD COLUMN completion_package_sent_at TEXT;
