-- Composite index for the unread-count grouped join and message pagination:
-- filter by channel_id and range-scan created_at in one index, instead of the
-- single-column channel_id index + a heap sort/filter on created_at.
CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at);
