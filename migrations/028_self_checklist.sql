-- Marks the single personal task-list that backs a user's self-DM ("Notes to
-- self") checklist, so the client can get-or-create exactly one per user.
ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS is_self BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_lists_one_self_per_owner
    ON task_lists(owner_id) WHERE is_self = TRUE;
