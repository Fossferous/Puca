-- Blocked users: a user (blocker) can block another user (blocked).
-- The block_user / unblock_user / list_blocked_users handlers reference this
-- table, but it was never created — so blocking silently failed and the
-- blocked list always came back empty. Column types match users.id (INT4).

CREATE TABLE IF NOT EXISTS blocked_users (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocked_users_blocker ON blocked_users(blocker_id);
