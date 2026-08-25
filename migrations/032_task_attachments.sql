-- Task/subtask picture+video attachments (subtasks are the same rows, so one
-- column covers both). Client-side-encrypted JSON sealed under the SAME key
-- path as the task's description (channel group key / encrypt-to-self); the
-- server never sees plaintext. NULL = no attachments.
ALTER TABLE channel_tasks ADD COLUMN IF NOT EXISTS attachments TEXT;
