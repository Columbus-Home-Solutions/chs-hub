-- Sprint 37: Itemized receipt line items staging table.
-- One row per extracted line item from a receipt photo, created during
-- processReceiptMatching. expense_id is null until the user confirms.

CREATE TABLE IF NOT EXISTS expense_line_items (
  id                          TEXT    PRIMARY KEY,
  receipt_photo_id            TEXT    NOT NULL,
  description                 TEXT    NOT NULL,
  quantity                    REAL,
  unit                        TEXT,
  unit_price                  REAL,
  amount                      REAL    NOT NULL,
  -- Match A: estimate_sub_items (for bid-accuracy variance report)
  matched_estimate_sub_item_id TEXT,
  -- Match B: vendor_materials (for pricing catalog updates)
  matched_vendor_material_id  TEXT,
  match_confidence            REAL,
  -- Set when user confirms → links to the expenses row created from this line
  expense_id                  TEXT,
  created_at                  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_eli_receipt_photo_id
  ON expense_line_items(receipt_photo_id);

CREATE INDEX IF NOT EXISTS idx_eli_expense_id
  ON expense_line_items(expense_id);
