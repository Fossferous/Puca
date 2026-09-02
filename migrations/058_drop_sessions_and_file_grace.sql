-- 1. The `sessions` table held one raw SRP session key per successful login,
--    written by nothing since 0.9.0 (L8-DATA-2 step 1) and never read by
--    anything at all. Dropping it is the point: the rows were live secrets.
--    Sequenced one release after the write stopped, so a rollback to the
--    previous binary never meets a missing relation.
DROP TABLE IF EXISTS sessions;

-- 2. Uploaded blobs of a DELETED account: kept for a grace period, then
--    purged. Their ids live inside other people's end-to-end encrypted
--    content, so the server cannot warn anyone; the grace is the warning.
--    delete_account stamps the rows, the retention sweep removes file + row
--    once purge_after has passed.
ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ NULL;
CREATE INDEX IF NOT EXISTS idx_uploaded_files_purge ON uploaded_files(purge_after) WHERE purge_after IS NOT NULL;
