-- Explicit ordering for checklist tasks (move up/down in the UI).
-- Backfill with id so existing rows keep their creation order.
ALTER TABLE channel_tasks ADD COLUMN position BIGINT;
UPDATE channel_tasks SET position = id;
ALTER TABLE channel_tasks ALTER COLUMN position SET NOT NULL;
