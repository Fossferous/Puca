-- Optional due time on any checklist task. Plaintext metadata, deliberately:
-- completion state, position and timestamps are already server-visible, and
-- the description stays E2EE — the server learns WHEN, never WHAT. Reminders
-- fire client-side (there is no push transport); /task-reminders reads this.
ALTER TABLE channel_tasks ADD COLUMN due_at TIMESTAMPTZ;

-- Per-caller index paths for the /task-reminders UNION arms (creator-scoped
-- channel tasks; list-scoped personal tasks). A bare due_at index would let
-- the ORDER BY + LIMIT plan walk EVERY user's due rows re-checking ownership
-- row by row — cost scaling with system-wide due tasks, not the caller's own.
CREATE INDEX idx_channel_tasks_reminders_creator ON channel_tasks(created_by, due_at)
    WHERE due_at IS NOT NULL AND is_completed = FALSE;
CREATE INDEX idx_channel_tasks_reminders_list ON channel_tasks(list_id, due_at)
    WHERE due_at IS NOT NULL AND is_completed = FALSE AND list_id IS NOT NULL;
