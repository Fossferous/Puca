-- Password-wrap KDF algorithm tag.
-- NULL (all existing rows) = legacy PBKDF2-SHA256 at pw_kdf_iterations.
-- 'argon2id' = memory-hard Argon2id (params are fixed client-side constants;
--              pw_kdf_iterations is an ignored placeholder for those rows).
-- New registrations and login-time upgrades set this to 'argon2id'. The server
-- only stores/returns the tag; it never derives keys itself. See src/api/e2ee.ts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pw_kdf TEXT;
