-- Migration 070: idempotent creates. A note or item whose create the server
-- COMMITTED but whose answer never arrived is replayed by the client (the
-- offline outbox retries 5xx and network failures) and, until now, existed
-- twice. A create may carry a client op key; the server claims the key in the
-- same transaction as the insert, and a replay is answered with the row it
-- already made.
--
-- WHAT THE KEY IS. A RANDOM id the client makes once, when the user acts, and
-- keeps across every retry and page reload. It is NEVER derived from anything
-- the user typed: a digest of a title or an item would be a stable content
-- fingerprint the server could correlate across notes and accounts, and could
-- brute-force for short texts. The CHECK below constrains the SHAPE only — it
-- cannot tell a random id from a hash — so the rule is enforced on the client
-- and pinned by its tests. docs/SECURITY_MODEL.md lists what this table
-- stores: that one create happened, which row it made, and when.
--
-- WHY A SIDE TABLE and not a column on task_lists / channel_tasks: migration
-- 066's content-diff triggers and 067's pg_notify triggers compare whole rows
-- with to_jsonb, so a new column on either table would join every "did this
-- change?" comparison. A side table leaves both untouched.
--
-- ROWS ARE FORGOTTEN after NOTES_OP_KEY_RETENTION_HOURS (default 24; 0 keeps
-- them), swept by the 6-hourly loop in src/main.rs. The window bounds how long
-- a create id exists at all, and a retry that arrives after it is a duplicate
-- again — a day is far longer than any retry chain.
CREATE TABLE IF NOT EXISTS task_create_keys (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    op_key     TEXT   NOT NULL CHECK (op_key ~ '^[A-Za-z0-9_-]{16,64}$'),
    -- Which create it was: 'list' = a note, 'task' = an item.
    scope      TEXT   NOT NULL CHECK (scope IN ('list', 'task')),
    created_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Per USER: one account's key can never match another's.
    PRIMARY KEY (user_id, op_key)
);

-- The sweep's only access path.
CREATE INDEX IF NOT EXISTS idx_task_create_keys_sweep ON task_create_keys (created_at);
