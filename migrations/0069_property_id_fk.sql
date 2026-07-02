-- Sprint 34: Link estimate_requests and jobs to a canonical properties record.
-- property_id is nullable so all existing rows remain valid; every new
-- estimate request going forward will have a property_id set either by
-- selecting an existing property or by auto-creating one on submit.

ALTER TABLE estimate_requests ADD COLUMN property_id TEXT REFERENCES properties(id);
ALTER TABLE jobs ADD COLUMN property_id TEXT REFERENCES properties(id);
