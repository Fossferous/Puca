-- Migration: Add missing tables for roles, emojis, and invites
-- The backend expects server_roles, server_emojis, and server_invites tables

-- Create server_roles table (backend expects this name and is_default column)
CREATE TABLE IF NOT EXISTS server_roles (
    id BIGSERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#99aab5',
    permissions BIGINT NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
);

-- Create member_roles table (for role assignments)
CREATE TABLE IF NOT EXISTS member_roles (
    id SERIAL PRIMARY KEY,
    server_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role_id BIGINT NOT NULL,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(role_id) REFERENCES server_roles(id) ON DELETE CASCADE,
    UNIQUE(server_id, user_id, role_id)
);

-- Create server_emojis table
CREATE TABLE IF NOT EXISTS server_emojis (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    uploader_id INTEGER NOT NULL,
    file_id TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(uploader_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(server_id, name)
);

-- Create server_invites table (backend expects this name)
CREATE TABLE IF NOT EXISTS server_invites (
    code TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    creator_id INTEGER NOT NULL,
    max_uses INTEGER DEFAULT NULL,
    uses INTEGER DEFAULT 0,
    expires_at TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::TEXT,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(creator_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create default @everyone role for all existing servers that don't have one
INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
SELECT id, '@everyone', '#99aab5', 104324673, 0, TRUE FROM servers
WHERE id NOT IN (SELECT server_id FROM server_roles WHERE is_default = TRUE);
