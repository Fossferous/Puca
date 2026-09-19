-- Púca Notes: free-text notes, note-level attachments, and a trash.
--
-- body        A note's paragraph text, sealed to the owner exactly like the
--             list title (an encrypt-to-self envelope). NULL = no body.
-- attachments The note's own photos and drawings: the same sealed sidecar
--             channel_tasks.attachments carries for one item (032), sealed
--             to self. NULL = none.
-- trashed_at  When the owner moved the list to the trash. NULL = live. The
--             default listing, the reminder feed and every write path treat
--             a trashed list as gone; the six-hourly sweep deletes it for
--             good after NOTES_TRASH_RETENTION_DAYS. Plaintext timing
--             metadata, the same kind as due_at (048).
--
-- All three are nullable with no default, so rows written by an older binary
-- stay valid and an older binary reading these rows never sees them.
ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS body TEXT;
ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS attachments TEXT;
ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ;

-- The sweep scans by age across every owner; live lists are the vast
-- majority and never enter this index.
CREATE INDEX IF NOT EXISTS idx_task_lists_trashed_at ON task_lists(trashed_at) WHERE trashed_at IS NOT NULL;
