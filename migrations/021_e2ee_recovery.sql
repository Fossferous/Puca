-- v3 recoverable E2EE key custody.
--
-- The identity seed is decoupled from the password: it becomes a random value
-- stored server-side as two independently-encrypted copies (one unlockable by
-- the password, one by a recovery code), so a password reset can preserve the
-- identity — and therefore access to encrypted history. See docs/E2EE_RECOVERY.md.
--
-- All new columns are nullable; a NULL wrap_salt means the account is still on
-- the legacy v2 (password-derived) scheme and will migrate transparently on its
-- next login. Blobs are stored as base64 TEXT (matching how public_key is
-- stored and how the client transmits them).

ALTER TABLE users ADD COLUMN IF NOT EXISTS key_version     INT  NOT NULL DEFAULT 2;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wrap_salt        TEXT;  -- base64(16)
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_salt    TEXT;  -- base64(16)
ALTER TABLE users ADD COLUMN IF NOT EXISTS seed_wrapped_pw  TEXT;  -- base64(nonce||ct)
ALTER TABLE users ADD COLUMN IF NOT EXISTS seed_wrapped_rc  TEXT;  -- base64(nonce||ct)
