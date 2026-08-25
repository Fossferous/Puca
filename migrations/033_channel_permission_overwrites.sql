-- Per-channel permission overwrites (Discord-style allow/deny per role).
-- NOTE: the legacy channel_overrides table from 001_init.sql is dead (it FKs
-- the legacy `roles` table, not server_roles) — this table replaces it.
CREATE TABLE channel_permission_overwrites (
    id BIGSERIAL PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id BIGINT NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
    allow BIGINT NOT NULL DEFAULT 0,
    deny BIGINT NOT NULL DEFAULT 0,
    UNIQUE(channel_id, role_id)
);

CREATE INDEX idx_channel_permission_overwrites_channel
    ON channel_permission_overwrites(channel_id);

-- Behavior-preserving backfill: grant the new task bits to every existing role.
-- 58720256 = CREATE_TASKS(1<<23) | COMPLETE_TASKS(1<<24) | MANAGE_TASKS(1<<25).
-- Existing servers keep today's anyone-can-do-everything checklist behavior
-- until owners tighten it.
UPDATE server_roles SET permissions = permissions | 58720256;
