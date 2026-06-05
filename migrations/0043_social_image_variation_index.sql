-- Track Imagen subject-angle rotation per post (regenerate increments; reset on publish).
ALTER TABLE social_posts ADD COLUMN image_variation_index INTEGER NOT NULL DEFAULT 0;
