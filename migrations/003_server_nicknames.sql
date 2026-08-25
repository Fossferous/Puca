-- Migration: Add server nicknames table
-- Per-server nicknames that override display_name for that server only

CREATE TABLE IF NOT EXISTS server_nicknames (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname TEXT NOT NULL,
    set_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (server_id, user_id)
);

-- Index for fast lookups by server
CREATE INDEX IF NOT EXISTS idx_server_nicknames_server ON server_nicknames(server_id);
