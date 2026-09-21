-- Migration 069: a content revision on a personal note, so two devices
-- editing the SAME note's text cannot silently overwrite one another.
--
-- content_rev counts writes of a note's OWN CONTENT and nothing else: its
-- title, its sealed body and its sealed attachments sidecar. A client names
-- the revision it is editing (`expect_rev` on PATCH /task-lists/:id); a
-- mismatch is refused with 409 and the current copy, and the user chooses.
-- The server learns a write counter per note, the same class of metadata as
-- `updated_at` (migration 066) and derivable from it — no content, and
-- docs/SECURITY_MODEL.md lists it.
--
-- WHY NOT updated_at. Migration 066's `puca_task_touch_list` bumps a LIST's
-- updated_at whenever one of its ITEMS is added, edited or deleted. A note is
-- one card holding both its text and its items, so an `expect_updated_at`
-- would refuse a text save because a checkbox was ticked in the same note.
-- Only these three columns are the note's own content.
--
-- WHY THE COLUMNS ARE NAMED, not `to_jsonb(NEW) - ...`. This trigger must be
-- correct whatever columns a later migration adds to task_lists (a note-level
-- due_at and schedule are landing beside this one). A reminder time or a
-- trash/restore is NOT the note's content: moving it must not invalidate the
-- base revision every other device is holding.
--
-- A writer cannot set content_rev by hand: the ELSE arm restores OLD's value,
-- so the counter only ever moves for a real content write.
ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS content_rev BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION puca_list_bump_content_rev() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.body IS DISTINCT FROM OLD.body
       OR NEW.attachments IS DISTINCT FROM OLD.attachments THEN
        NEW.content_rev := OLD.content_rev + 1;
    ELSE
        NEW.content_rev := OLD.content_rev;
    END IF;
    RETURN NEW;
END;
$$;

-- Named to sort BEFORE trg_task_lists_stamp_updated: Postgres fires BEFORE
-- triggers in name order, so content_rev is settled before migration 066's
-- stamp decides on updated_at.
--
-- HOW 066's puca_list_stamp_updated TREATS content_rev: it compares the whole
-- row minus updated_at and trashed_at, so content_rev is INSIDE that
-- comparison, deliberately. It changes nothing: content_rev only moves when
-- title, body or attachments moved, which that comparison already sees, and
-- when they did not the ELSE arm above leaves the column byte-identical. The
-- same reasoning covers migration 067's puca_task_events_list, which decides
-- whether to raise a live event from the same kind of whole-row comparison.
DROP TRIGGER IF EXISTS trg_task_lists_content_rev ON task_lists;
CREATE TRIGGER trg_task_lists_content_rev
    BEFORE UPDATE ON task_lists
    FOR EACH ROW EXECUTE FUNCTION puca_list_bump_content_rev();
