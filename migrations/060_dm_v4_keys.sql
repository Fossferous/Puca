-- Migration 060: the keys behind DM envelope v4.
--
-- v4 seals each direct message under a fresh random message key, and wraps
-- that key ONLY to keys the password cannot reach:
--
--   token_sessions.dm_pubkey    an X25519 key a signed-in client mints for
--                               its session and keeps private on that device.
--                               A new sign-in mints a new one; revoking the
--                               session retires it. A message wrapped to it is
--                               readable live on that device and nowhere else.
--   token_sessions.reads_up_to  the highest envelope version that client can
--                               open, so a sender never emits v4 to a user
--                               who still has a client that cannot read it.
--   users.history_pubkey        the account's history key. Every v4 message
--                               is also wrapped to it, so a device that later
--                               holds the private half can read history.
--   users.history_wrapped_rc    that private half, wrapped under the 12-word
--                               recovery code -- and under nothing else. The
--                               password unwraps the identity seed; it does
--                               NOT unwrap this. That is the whole point.
--
-- All nullable: an account without a history key, or a session without a
-- dm_pubkey, is one that still speaks v3, and senders fall back to v3 for it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS history_pubkey TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS history_wrapped_rc TEXT NULL;
ALTER TABLE token_sessions ADD COLUMN IF NOT EXISTS dm_pubkey TEXT NULL;
ALTER TABLE token_sessions ADD COLUMN IF NOT EXISTS reads_up_to SMALLINT NULL;

-- Every published key carries a signature by the account's Ed25519 signing key
-- (users.account_sign_pub), over a record naming the key's role and value
-- (dmKeys.ts dmKeyRecord). A sender wraps a message key only to keys that
-- verify, so a server that lists an extra "session" of its own gets nothing:
-- the list is the server's, the vouching is the account's.
ALTER TABLE token_sessions ADD COLUMN IF NOT EXISTS dm_pubkey_sig TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS history_pubkey_sig TEXT NULL;

-- The headless host service (puca-service) mints its own sessions (device
-- tokens). They never read a DM and never publish a key, so the v4 rollout
-- gate must not count them: marked at mint, and excluded by /users/:id/dm-keys.
-- Rows minted before this migration carry the default and age out of the
-- two-week window on their own once the service's hourly re-mint replaces them.
ALTER TABLE token_sessions ADD COLUMN IF NOT EXISTS headless BOOLEAN NOT NULL DEFAULT FALSE;

-- And the signing key itself is vouched for PER CONVERSATION, under the two
-- identity keys the pair already pins: each side stores an HMAC over its own
-- account_sign_pub keyed by the pairwise X25519 secret (dmKeys.ts
-- ensureSignAttestation). The server cannot compute it, so it cannot
-- substitute a signing key of its own at first sight either; without a
-- matching attestation the sender stays on v3.
ALTER TABLE dm_conversations ADD COLUMN IF NOT EXISTS user1_sign_attest TEXT NULL;
ALTER TABLE dm_conversations ADD COLUMN IF NOT EXISTS user2_sign_attest TEXT NULL;
