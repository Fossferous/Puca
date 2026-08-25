-- Clips (OBS-style replay buffer): per-server policy, the consent stamp, and
-- the upload bucket. Nothing here stores a clip. The rolling buffer and the
-- sealed clip live only in the clipper's process memory until every required
-- participant approves; the parts that follow are ordinary encrypted uploads.
-- The APPROVAL PROPOSAL is deliberately NOT persisted (in-memory, 30 min TTL,
-- src/state.rs) — a durable pending-clip table would be a durable record of
-- who was in which call, which is exactly what this product does not keep.
-- See docs/CLIPS.md.

-- OFF by default. This feature records other people; it must be an explicit
-- act by a server owner, never something that appears because they updated.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS clips_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Longest clip a member may take, in seconds. Re-checked in the handler; the
-- constraint stops a direct-SQL edit producing a value no client can render.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS clip_max_seconds INTEGER NOT NULL DEFAULT 120;
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_clip_max_seconds_range;
ALTER TABLE servers ADD CONSTRAINT servers_clip_max_seconds_range
    CHECK (clip_max_seconds BETWEEN 60 AND 600);

-- Optional pinned target text channel. NULL = the clipper picks any text
-- channel they may post in. ON DELETE SET NULL so deleting the channel
-- un-pins instead of blocking the delete.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS clip_channel_id INTEGER
    REFERENCES channels(id) ON DELETE SET NULL;

-- Which quota bucket an upload counts against: 'attachment' (the 512 MB
-- lifetime budget) or 'clip' (its own budget). NOT NULL DEFAULT so every
-- existing row is an attachment, which is what they all are.
ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'attachment';

-- The approved proposal a clip part was uploaded under, and its index within
-- the clip. NOT a foreign key: proposals are in-memory and never persisted.
-- (clip_id, clip_part_index) is UNIQUE so a retried upload after a lost
-- response is idempotent instead of creating a duplicate row.
ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS clip_id UUID;
ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS clip_part_index INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS uq_uploaded_files_clip_part
    ON uploaded_files(clip_id, clip_part_index) WHERE clip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_uploaded_files_clip_sweep
    ON uploaded_files(created_at) WHERE kind = 'clip';

-- The SERVER's own record that a posted clip went through the approval
-- protocol, stamped from its in-memory proposal at post time. NEVER written
-- from the request body: the "Approved by everyone in the call" badge is only
-- honest because the client cannot author it.
-- Shape: {"proposal_id":"…","approver_count":2,"part_file_ids":["…"],"solo":false}
-- No identities, no voice channel, no window bounds, on purpose: those would
-- make this row a permanent, operator-readable voice-presence log.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS clip_consent JSONB;
