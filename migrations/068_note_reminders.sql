-- Púca Notes: a reminder on the note itself.
--
-- Until now the only way to be reminded about a note was to invent a
-- checklist item to hang the time on, which then showed as a to-do nobody
-- wrote. These two columns give the note its own time, with exactly the
-- privacy trade one of its items already has (048, 066).
--
-- due_at    The note's next reminder instant, plaintext, like an item's
--           (048) and like trashed_at (065): the server learns WHEN, never
--           WHAT. NULL = the note does not remind.
-- schedule  A client-SEALED EventSchedule, the same value channel_tasks
--           carries since 066 and sealed the same way (encrypt-to-self for
--           a personal list, padded to a size bucket by the client). It is
--           what makes "Keep the time private from the server" mean the
--           same thing on a note as on an item: the time lives in here and
--           due_at stays NULL, so the note still reminds on the device that
--           can open it and the server sees no instant at all. Without this
--           column the switch would degrade to "delete your reminder".
--
-- Both nullable with no default, so rows written by an older binary stay
-- valid and an older binary reading these rows never sees them (065's
-- pattern).
ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS schedule TEXT;

-- The reminder feed's new arm is per owner and ordered by due_at with a
-- LIMIT; without this a bare index (or none) lets it walk every account's
-- rows, which is why 048 added the same shape for items. Trashed notes are
-- out of the feed, so they are out of the index too.
CREATE INDEX IF NOT EXISTS idx_task_lists_reminders_owner ON task_lists(owner_id, due_at)
    WHERE due_at IS NOT NULL AND trashed_at IS NULL;

-- TWO LIVE TRIGGERS ALREADY WATCH THIS TABLE and pick these columns up with
-- no change here, which is wanted but worth stating:
--  * 066's puca_list_stamp_updated subtracts only updated_at and trashed_at,
--    so setting or clearing a note's reminder bumps its "Edited" stamp. That
--    is defensible — it IS an edit of the note — and it is what makes the
--    change visible to a client that sorts by it.
--  * 067's puca_task_events_list raises its content-free "your lists
--    changed" event, so another open device re-reads and re-arms.
-- A later list-level SNOOZE would need the carve-out puca_task_content_changed
-- has for items (a snooze is not an edit, and it moves due_at), so it cannot
-- simply be added as a third column here.
