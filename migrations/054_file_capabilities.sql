-- Per-object capabilities for GET /files/:id, WITHOUT telling the server which
-- channel a file belongs to.
--
-- An attachment's channel/DM mapping lives INSIDE E2EE ciphertext (the ref in
-- the message body), so the server cannot scope access by membership unless it
-- is told the mapping — which would promote a probabilistic inference (an
-- upload next to a message in time) into a durable, certain fact. This design
-- keeps the mapping private: at upload, when the client asks, the server mints
-- a random 256-bit capability, returns it ONCE, and stores only its SHA-256.
-- The uploader carries the capability inside the encrypted message beside the
-- file key, so exactly the people who can read the message can fetch the blob,
-- and the server learns nothing about where the file went.
--
-- NULL = no capability: every row from before this migration, and every upload
-- that never asked for one (avatars, server icons, sounds, custom emoji, clip
-- parts — fetched by <img>-style consumers that hold no secret). NULL rows keep
-- the rule they always had: authenticated plus an unguessable UUID.
--
-- A row WITH a hash is CHECKED whenever a capability is presented (a wrong one
-- is a 404, never a 403 — no existence oracle), and REQUIRED only once the
-- operator sets FILES_ENFORCE_CAP=1 — phase 2, after every client in the field
-- sends the capability it holds. Client-before-server, as always.
ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS cap_hash BYTEA;

-- Exactly 32 bytes (SHA-256): a truncated or oversized digest can never be stored
-- and later compared against something short.
ALTER TABLE uploaded_files DROP CONSTRAINT IF EXISTS uploaded_files_cap_hash_len;
ALTER TABLE uploaded_files ADD CONSTRAINT uploaded_files_cap_hash_len
    CHECK (cap_hash IS NULL OR octet_length(cap_hash) = 32);
