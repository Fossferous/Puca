-- Add task functionality to messages for Keep Notes style task items
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_task BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_completed BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE;

-- Index for faster lookups of tasks and sub-tasks
CREATE INDEX IF NOT EXISTS idx_messages_is_task ON messages(is_task) WHERE is_task = true;
CREATE INDEX IF NOT EXISTS idx_messages_parent_message_id ON messages(parent_message_id) WHERE parent_message_id IS NOT NULL;
