-- Allow multiple concurrent login attempts per username so a concurrent step-1
-- (phone while desktop is mid-login, or an attacker spamming step-1 with a
-- victim's username) can't clobber an in-flight attempt's (b_secret, a_pub) and
-- fail the other device's step-2 proof.
--
-- username was the PRIMARY KEY (one row per user). Replace it with a surrogate
-- id, add an opaque attempt_id the client echoes in step-2 to pick its own row,
-- and index (username, created_at) for the old-client "most-recent" fallback.
--
-- NOTE: the new backend code drops the old `ON CONFLICT (username)` upsert; ship
-- that code together with this migration (a single-process deploy does both at
-- once, so an old binary never meets the migrated schema).

ALTER TABLE login_attempts DROP CONSTRAINT login_attempts_pkey;
ALTER TABLE login_attempts ADD COLUMN id BIGSERIAL PRIMARY KEY;
ALTER TABLE login_attempts ADD COLUMN attempt_id TEXT;

-- Nullable-unique: existing/legacy rows keep NULL attempt_id (Postgres allows
-- multiple NULLs under a UNIQUE index), while each new attempt is unique.
CREATE UNIQUE INDEX login_attempts_attempt_id_key ON login_attempts (attempt_id);
CREATE INDEX login_attempts_username_created_idx ON login_attempts (username, created_at DESC);
