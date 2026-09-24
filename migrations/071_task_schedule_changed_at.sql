-- Migration 071: a stamp of its own for the freshness check on ticks.
--
-- A tick or an advance from an aware client says how current its view is
-- (`expect_schedules_as_of`), and the server refuses it when a row it decided
-- about changed since (task_timing.rs SCHEDULES_CHANGED_SINCE_SQL). Until now
-- that compared migration 066's `updated_at`, which moves on EVERY content
-- change. Two things went wrong with that:
--
--  - The server refused a tick because a dated item under it had its TEXT
--    edited on another device: nothing about the series had changed.
--  - This device's own queued or unconfirmed edits move `updated_at` as well,
--    so a tick planned behind any of them had to drop its stamp and replay
--    unchecked — and "edit an item's text offline, then tick it" ended the
--    repeat another device gave it meanwhile.
--
-- schedule_changed_at moves only for the events the check exists for:
--
--   INSERT                   — a (dated) item added under the one ticked
--   schedule changes         — made repeating, re-timed, or its repeat removed
--   is_completed changes     — reopened (or completed) elsewhere
--   parent_id changes        — a dated item moved under the one ticked
--
-- and for nothing else. WHY NOT due_at, and WHY NOT the snooze:
--  - due_at on a SCHEDULED item is derived — the next reminder instant. The
--    reminder loop advances it after every alert fires, and a snooze moves it
--    to the snooze instant; stamping those would refuse every tick made on
--    another device after any alert, which is 066's reason for not calling
--    them edits either. A due_at change never turns an item into a series or
--    ends one: the rule lives in `schedule`, and changing the rule does stamp.
--    Where due_at DOES matter — an advance computing the next occurrence from
--    the time this device showed — the advance already carries
--    `expect_due_at`, a compare-and-swap on due_at itself, so a stale advance
--    loses on that instead.
--  - due_at on a PLAIN item is a one-off time; the check ignores rows with no
--    schedule, so it never counted.
--  - The snooze is {forDue, until} for ONE occurrence. Ticking or advancing
--    past a snoozed occurrence ends that occurrence, which is what the user
--    asked for; the series is untouched.
-- Text, attachments, position and the snooze therefore leave it alone, and
-- so a client may keep its stamp across its own edits of those
-- (frontend/src/api/tasks.ts trackWrite, notesOutbox.ts touchesAny).
--
-- The server learns nothing new: the stamp is a write time it already saw
-- arrive, of the same class as updated_at (docs/SECURITY_MODEL.md). It says
-- that the item was created, its sealed schedule written, its tick changed
-- or its parent changed at that moment — each of which the write itself
-- already told the server when it arrived.
--
-- ADDITIVE. A nullable column and a trigger: an older binary neither reads
-- the column nor sets it, and the trigger keeps it right under that binary's
-- writes as well, so a rollback boots over this database without a restore
-- (migrations/README.md, "Rollbacks"). Readers COALESCE it with updated_at
-- and created_at, so a row written with triggers bypassed still has a stamp.
ALTER TABLE channel_tasks ADD COLUMN IF NOT EXISTS schedule_changed_at TIMESTAMPTZ;

-- The ELSE arm restores OLD's value, so a writer cannot set the stamp by
-- hand (the same rule as 069's content_rev): it only ever moves for one of
-- the four events above. NOW() is the transaction's start time, as for
-- updated_at, so a statement that sweeps a whole subtree stamps it once.
CREATE OR REPLACE FUNCTION puca_task_stamp_schedule_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.schedule_changed_at := NOW();
    ELSIF NEW.schedule IS DISTINCT FROM OLD.schedule
       OR NEW.is_completed IS DISTINCT FROM OLD.is_completed
       OR NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
        NEW.schedule_changed_at := NOW();
    ELSE
        NEW.schedule_changed_at := OLD.schedule_changed_at;
    END IF;
    RETURN NEW;
END;
$$;

-- Backfill: every existing row's stamp is its last edit — exactly the value
-- the check compared until now, so nothing a client already holds reads as
-- newer or older than it did. Run with this table's USER triggers off, for
-- this one statement only: 066's content diff compares whole rows with
-- to_jsonb, so the new column filling in would read as an EDIT of every row
-- (every "Edited" time jumping to the moment of this migration, and every
-- personal list with them), and 067 would raise a live event per checklist.
-- The backfill is none of those. Both statements need the table's owner,
-- which every earlier ALTER TABLE here needed as well. A row that already
-- has a stamp is left alone, so a re-run changes nothing.
ALTER TABLE channel_tasks DISABLE TRIGGER USER;
UPDATE channel_tasks SET schedule_changed_at = COALESCE(updated_at, created_at)
    WHERE schedule_changed_at IS NULL;
ALTER TABLE channel_tasks ENABLE TRIGGER USER;

-- Named to sort BEFORE trg_channel_tasks_stamp_updated (Postgres fires BEFORE
-- triggers in name order), so the stamp is settled before 066 decides
-- whether this was an edit. 066's content diff compares the whole row minus
-- position, updated_at and the snooze, so schedule_changed_at is INSIDE that
-- comparison — and changes nothing there: it only moves when schedule,
-- is_completed or parent_id moved, which that comparison already counts as
-- an edit, and otherwise the ELSE arm leaves it byte-identical. The same
-- holds for 067's live-event trigger, which compares the whole row minus
-- updated_at.
DROP TRIGGER IF EXISTS trg_channel_tasks_schedule_changed ON channel_tasks;
CREATE TRIGGER trg_channel_tasks_schedule_changed
    BEFORE INSERT OR UPDATE ON channel_tasks
    FOR EACH ROW EXECUTE FUNCTION puca_task_stamp_schedule_changed();
