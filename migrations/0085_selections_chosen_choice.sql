-- Quote-stage combined selection signature: track client picks before signing.
-- chosen_choice_id is set on pick; approved status still requires combined BoldSign completion.

ALTER TABLE selections ADD COLUMN chosen_choice_id TEXT REFERENCES selection_choices(id);
