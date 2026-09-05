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
