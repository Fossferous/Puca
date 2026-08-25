-- Per-channel slowmode: minimum seconds between messages from the same user.
-- 0 disables it. Users with Manage Messages bypass it (like Discord).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS slowmode_seconds INTEGER NOT NULL DEFAULT 0;
