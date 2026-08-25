-- Migration 009: Reactions and Custom Emojis
-- Adds message_reactions and server_emojis tables for PostgreSQL

-- Message Reactions (emoji reactions on messages)
CREATE TABLE IF NOT EXISTS message_reactions (
    id SERIAL PRIMARY KEY,
    message_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,              -- Unicode emoji or custom emoji ID
    is_custom BOOLEAN DEFAULT FALSE,  -- TRUE if custom server emoji
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(message_id, user_id, emoji)
);

-- Custom Server Emojis
CREATE TABLE IF NOT EXISTS server_emojis (
    id TEXT PRIMARY KEY,              -- UUID
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,               -- Emoji shortcode (e.g., "lol")
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    file_id TEXT NOT NULL REFERENCES uploaded_files(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(server_id, name)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_user ON message_reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_emojis_server ON server_emojis(server_id);
