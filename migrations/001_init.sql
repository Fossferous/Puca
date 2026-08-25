-- Sovereign Database Schema for PostgreSQL
-- This is a consolidated migration with all tables

-- Users table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    salt BYTEA NOT NULL,
    verifier BYTEA NOT NULL,
    public_key TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Servers (guilds)
CREATE TABLE servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    icon_file_id TEXT DEFAULT NULL,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Server members
CREATE TABLE server_members (
    id SERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(server_id, user_id)
);

-- Roles
CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color INTEGER NOT NULL DEFAULT 0,
    permissions BIGINT NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
);

-- User roles
CREATE TABLE user_roles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    server_id TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    UNIQUE(user_id, role_id, server_id)
);

-- Channel categories
CREATE TABLE channel_categories (
    id SERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
);

-- Channels
CREATE TABLE channels (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    type INTEGER NOT NULL DEFAULT 0,
    server_id TEXT,
    category_id INTEGER DEFAULT NULL,
    description TEXT DEFAULT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(category_id) REFERENCES channel_categories(id) ON DELETE SET NULL
);

-- Channel permission overrides
CREATE TABLE channel_overrides (
    id SERIAL PRIMARY KEY,
    channel_id INTEGER NOT NULL,
    role_id INTEGER,
    user_id INTEGER,
    allow BIGINT NOT NULL DEFAULT 0,
    deny BIGINT NOT NULL DEFAULT 0,
    FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK (role_id IS NOT NULL OR user_id IS NOT NULL)
);

-- Messages
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    reply_to_id TEXT DEFAULT NULL,
    is_pinned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    edited_at TIMESTAMP DEFAULT NULL,
    FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Message edits history
CREATE TABLE message_edits (
    id SERIAL PRIMARY KEY,
    message_id TEXT NOT NULL,
    old_content TEXT NOT NULL,
    edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- Sessions for auth
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    session_key BYTEA NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Login attempts for SRP
CREATE TABLE login_attempts (
    username TEXT PRIMARY KEY,
    b_secret BYTEA NOT NULL,
    a_pub BYTEA NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Invites
CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    creator_id INTEGER NOT NULL,
    max_uses INTEGER DEFAULT NULL,
    uses INTEGER DEFAULT 0,
    expires_at TIMESTAMP DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(creator_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Bans
CREATE TABLE bans (
    id SERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    banned_by INTEGER NOT NULL,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(banned_by) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(server_id, user_id)
);

-- Timeouts
CREATE TABLE member_timeouts (
    id SERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    reason TEXT,
    timed_out_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(timed_out_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(server_id, user_id)
);

-- Direct message conversations
CREATE TABLE dm_conversations (
    id SERIAL PRIMARY KEY,
    user1_id INTEGER NOT NULL,
    user2_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user1_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(user2_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user1_id, user2_id)
);

-- Direct messages
CREATE TABLE dm_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES dm_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Friend requests
CREATE TABLE friend_requests (
    id SERIAL PRIMARY KEY,
    from_user_id INTEGER NOT NULL,
    to_user_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(to_user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(from_user_id, to_user_id)
);

-- Friends
CREATE TABLE friends (
    id SERIAL PRIMARY KEY,
    user1_id INTEGER NOT NULL,
    user2_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user1_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(user2_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user1_id, user2_id)
);

-- File uploads
CREATE TABLE file_uploads (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    uploader_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(uploader_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Reactions
CREATE TABLE reactions (
    id SERIAL PRIMARY KEY,
    message_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(message_id, user_id, emoji)
);

-- Custom emojis
CREATE TABLE custom_emojis (
    id SERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    file_id TEXT NOT NULL,
    creator_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(creator_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(server_id, name)
);

-- Channel read state (for unread counts)
CREATE TABLE channel_read_state (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    last_read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    UNIQUE(user_id, channel_id)
);

-- Audit log
CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    actor_id INTEGER NOT NULL,
    target_id INTEGER,
    target_type TEXT,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Reports
CREATE TABLE reports (
    id SERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    reporter_id INTEGER NOT NULL,
    reported_user_id INTEGER,
    reported_message_id TEXT,
    report_type TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    resolved_by INTEGER,
    resolution_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(reporter_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(reported_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(resolved_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Indexes
CREATE INDEX idx_messages_channel ON messages(channel_id);
CREATE INDEX idx_messages_user ON messages(user_id);
CREATE INDEX idx_server_members_server ON server_members(server_id);
CREATE INDEX idx_server_members_user ON server_members(user_id);
CREATE INDEX idx_channels_server ON channels(server_id);
CREATE INDEX idx_roles_server ON roles(server_id);
CREATE INDEX idx_bans_server ON bans(server_id);
CREATE INDEX idx_timeouts_server ON member_timeouts(server_id);
CREATE INDEX idx_audit_server ON audit_log(server_id);
CREATE INDEX idx_reports_server ON reports(server_id);
CREATE INDEX idx_reports_status ON reports(status);
