-- Sprint 11 follow-up: scope-item selection for cost-plus mini-budgets.
-- Stores JSON array of { line_item_id, percentage } per billing cycle.

ALTER TABLE billing_cycles ADD COLUMN scope_allocations TEXT;
