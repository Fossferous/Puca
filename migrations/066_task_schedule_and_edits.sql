-- Task timing (recurring and snoozable reminders, calendar events) and
-- "edited at" for tasks and personal lists. Idempotent throughout: every
-- statement can run again against a database that already has it.
--
-- schedule: a client-SEALED EventSchedule (docs/NOTES.md, "Calendar"): all-day,
-- start/end, time zone, repeat rule, skipped dates, location, alerts. Sealed
-- exactly like `attachments` (encrypt-to-self for personal lists, the channel
-- key for checklist channels), padded by the client to a size bucket. The
-- server learns only THAT an item has one and roughly how big it is. due_at
-- keeps its meaning for plain tasks; for a scheduled item it is the NEXT
-- reminder instant, derived on the client (NULL when the item keeps its time
-- private from the server).
ALTER TABLE channel_tasks ADD COLUMN IF NOT EXISTS schedule TEXT;

-- snooze: a client-SEALED {forDue, until}. Separate from schedule because it
-- has a different edit right (COMPLETE_TASKS, like ticking the item), and a
-- snooze must never rewrite the event itself.
ALTER TABLE channel_tasks ADD COLUMN IF NOT EXISTS snooze TEXT;

-- updated_at: when the item's CONTENT last changed. NULL on rows that predate
-- this migration (readers fall back to created_at) — no backfill, so the
-- migration does not rewrite every row inside the startup transaction.
ALTER TABLE channel_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE channel_tasks ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE task_lists ALTER COLUMN updated_at SET DEFAULT NOW();

-- What counts as an edit of a task: anything but its position (a pure
-- reorder is not an edit), the snooze (snoozing a reminder is not editing the
-- item), and updated_at itself. For a SCHEDULED item due_at is derived — the
-- reminder loop advances it after an alert fires — so due_at alone changing
-- on a scheduled row is not an edit either; a schedule change still is.
-- Nor is due_at moving in the SAME update as the snooze: a snooze moves the
-- plaintext due_at to the snooze instant (and an unsnooze moves it back), so
-- the server sees the next reminder — that is the snooze, not an edit.
-- to_jsonb keeps this column-agnostic: columns added later count as content
-- unless they are listed here.
CREATE OR REPLACE FUNCTION puca_task_content_changed(old_row channel_tasks, new_row channel_tasks)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    o JSONB := to_jsonb(old_row) - 'position' - 'updated_at' - 'snooze';
    n JSONB := to_jsonb(new_row) - 'position' - 'updated_at' - 'snooze';
BEGIN
    IF (new_row.schedule IS NOT NULL AND new_row.schedule IS NOT DISTINCT FROM old_row.schedule)
       OR new_row.snooze IS DISTINCT FROM old_row.snooze THEN
        o := o - 'due_at';
        n := n - 'due_at';
    END IF;
    RETURN o IS DISTINCT FROM n;
END;
$$;

CREATE OR REPLACE FUNCTION puca_task_stamp_updated() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF puca_task_content_changed(OLD, NEW) THEN
        NEW.updated_at := NOW();
    ELSE
        -- Nothing a reader would call an edit: keep the old stamp even if a
        -- writer tried to set one.
        NEW.updated_at := OLD.updated_at;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_channel_tasks_stamp_updated ON channel_tasks;
CREATE TRIGGER trg_channel_tasks_stamp_updated
    BEFORE UPDATE ON channel_tasks
    FOR EACH ROW EXECUTE FUNCTION puca_task_stamp_updated();

-- A personal list is edited when one of its items is added, edited or
-- deleted. Channel checklists get NO equivalent column: the channels row is
-- hot (every channel read and write touches it) and a checklist edit storm
-- must not become an UPDATE storm on it — a shared note's "edited" is the
-- newest item's updated_at, computed by the client. No NOTIFY here; live
-- events belong to their own triggers.
CREATE OR REPLACE FUNCTION puca_task_touch_list() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    lid BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        lid := OLD.list_id;
    ELSIF TG_OP = 'INSERT' THEN
        lid := NEW.list_id;
    ELSE
        -- The BEFORE trigger already decided whether this was an edit.
        IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
            RETURN NULL;
        END IF;
        lid := NEW.list_id;
    END IF;
    IF lid IS NOT NULL THEN
        -- NOW() is the transaction's start time, so a statement that touches a
        -- whole subtree writes the list row once, not once per item.
        UPDATE task_lists SET updated_at = NOW()
            WHERE id = lid AND updated_at IS DISTINCT FROM NOW();
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_channel_tasks_touch_list ON channel_tasks;
CREATE TRIGGER trg_channel_tasks_touch_list
    AFTER INSERT OR UPDATE OR DELETE ON channel_tasks
    FOR EACH ROW EXECUTE FUNCTION puca_task_touch_list();

-- A list's own edit (its title, or anything added to the row later) stamps it
-- too. updated_at and a trash flag are not content; an explicit updated_at
-- from the trigger above is kept as written.
CREATE OR REPLACE FUNCTION puca_list_stamp_updated() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW) - 'updated_at' - 'trashed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'trashed_at') THEN
        NEW.updated_at := NOW();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_lists_stamp_updated ON task_lists;
CREATE TRIGGER trg_task_lists_stamp_updated
    BEFORE UPDATE ON task_lists
    FOR EACH ROW EXECUTE FUNCTION puca_list_stamp_updated();
