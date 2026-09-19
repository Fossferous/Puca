-- Migration 067: sealed-to-self account blobs, and content-free task events.
--
-- TWO THINGS, both for Púca Notes (docs/NOTES.md), both additive.
--
-- 1. user_sealed_blobs: one client-encrypted document per (user, name). The
--    first name is 'notes-prefs' (a note's colour, labels and archive flag),
--    which until now lived only in one browser's localStorage and died with a
--    sign-out. The server stores ciphertext it cannot open and a revision
--    number it uses for compare-and-swap (src/sealed_blob_handlers.rs); it
--    learns the blob's size and when it was written, nothing else. Which names
--    are accepted is decided by the handler's whitelist; the CHECK here only
--    keeps the column a short identifier, so a later name needs no DDL.
--
-- 2. pg_notify triggers on the task tables, feeding GET /events/tasks
--    (src/task_events.rs). Payloads are IDS THE SERVER ALREADY HOLDS — a
--    channel id, a list id and its owner, a user id — never a title, an item,
--    a label or a time. Postgres folds identical payloads raised inside one
--    transaction into one notification, which bounds a cascade (a list
--    delete, a subtree completion, a tab-prefs full replace) to one event.
--
--    An UPDATE that changes nothing but `updated_at` raises NOTHING. Another
--    change (task timing) keeps an edited-at stamp that a trigger bumps on
--    every task write; without this rule every item toggle would also fire a
--    list-level event and make every open device re-read every list. The
--    comparison is on the whole row minus that one key, so it holds whether or
--    not the column exists yet on this database.
--
--    The listener that consumes these must never stop draining (a listening
--    connection that stops reading lets the notification queue fill, and a
--    full queue fails every NOTIFY at commit — i.e. every task write). That is
--    the receive loop's job in task_events.rs; nothing here can block.

CREATE TABLE IF NOT EXISTS user_sealed_blobs (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,31}$'),
    rev BIGINT NOT NULL CHECK (rev > 0),
    blob TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, name)
);

-- channel_tasks: a channel checklist's id, or a personal list's id and owner.
CREATE OR REPLACE FUNCTION puca_task_events_task() RETURNS trigger AS $$
DECLARE
    r RECORD;
    owner BIGINT;
BEGIN
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
    IF r.channel_id IS NOT NULL THEN
        PERFORM pg_notify('puca_task_events', json_build_object('c', r.channel_id)::text);
    ELSIF r.list_id IS NOT NULL THEN
        -- Gone when the list itself is being deleted (the cascade runs after
        -- the parent row): the list's own trigger has already said so.
        SELECT owner_id INTO owner FROM task_lists WHERE id = r.list_id;
        IF owner IS NOT NULL THEN
            PERFORM pg_notify('puca_task_events', json_build_object('l', r.list_id, 'u', owner)::text);
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_channel_tasks_events ON channel_tasks;
CREATE TRIGGER trg_channel_tasks_events
    AFTER INSERT OR UPDATE OR DELETE ON channel_tasks
    FOR EACH ROW EXECUTE FUNCTION puca_task_events_task();

-- task_lists: "your set of lists changed" (create, rename, delete, and any
-- column a later migration adds — except updated_at alone).
CREATE OR REPLACE FUNCTION puca_task_events_list() RETURNS trigger AS $$
DECLARE
    r RECORD;
BEGIN
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
    PERFORM pg_notify('puca_task_events', json_build_object('L', 1, 'u', r.owner_id)::text);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_task_lists_events ON task_lists;
CREATE TRIGGER trg_task_lists_events
    AFTER INSERT OR UPDATE OR DELETE ON task_lists
    FOR EACH ROW EXECUTE FUNCTION puca_task_events_list();

-- task_tab_prefs: pins and order (a PUT replaces the whole set; the identical
-- payloads fold into one).
CREATE OR REPLACE FUNCTION puca_task_events_prefs() RETURNS trigger AS $$
DECLARE
    r RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
    PERFORM pg_notify('puca_task_events', json_build_object('p', 1, 'u', r.user_id)::text);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_task_tab_prefs_events ON task_tab_prefs;
CREATE TRIGGER trg_task_tab_prefs_events
    AFTER INSERT OR UPDATE OR DELETE ON task_tab_prefs
    FOR EACH ROW EXECUTE FUNCTION puca_task_events_prefs();

-- user_sealed_blobs: "your sealed blob changed" — the name is a fixed
-- identifier, never content.
CREATE OR REPLACE FUNCTION puca_task_events_blob() RETURNS trigger AS $$
DECLARE
    r RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
    PERFORM pg_notify('puca_task_events', json_build_object('s', r.name, 'u', r.user_id)::text);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_sealed_blobs_events ON user_sealed_blobs;
CREATE TRIGGER trg_user_sealed_blobs_events
    AFTER INSERT OR UPDATE OR DELETE ON user_sealed_blobs
    FOR EACH ROW EXECUTE FUNCTION puca_task_events_blob();
