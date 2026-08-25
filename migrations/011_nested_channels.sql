-- Add parent_id to channels for nesting
ALTER TABLE channels ADD COLUMN parent_id INTEGER DEFAULT NULL;
ALTER TABLE channels ADD CONSTRAINT fk_channels_parent FOREIGN KEY (parent_id) REFERENCES channels(id) ON DELETE CASCADE;

-- Index for performance when fetching children
CREATE INDEX idx_channels_parent ON channels(parent_id);

-- Documenting type 2 as 'collection'
-- No constraint change needed as type is just an INTEGER
