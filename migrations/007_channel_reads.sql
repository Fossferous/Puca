-- Migration: Track when users last read each channel
-- This enables unread message indicators

-- Table to track last read time per user per channel
CREATE TABLE IF NOT EXISTS channel_reads (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_message_id BIGINT,  -- Last message ID they saw
    PRIMARY KEY (user_id, channel_id)
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_channel_reads_user ON channel_reads(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_reads_channel ON channel_reads(channel_id);

-- Also track unread counts on DM conversations
ALTER TABLE dm_conversations 
ADD COLUMN IF NOT EXISTS unread_count_user1 INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS unread_count_user2 INTEGER DEFAULT 0;
