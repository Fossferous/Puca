-- Add has_checklist flag to channels
ALTER TABLE channels ADD COLUMN has_checklist BOOLEAN DEFAULT FALSE;

-- Create channel_tasks table
CREATE TABLE channel_tasks (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    is_completed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by BIGINT NOT NULL -- user_id
);

-- Index for faster lookups
CREATE INDEX idx_channel_tasks_channel_id ON channel_tasks(channel_id);
