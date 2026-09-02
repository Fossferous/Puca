-- Per-SESSION revocation: the JWT `sid` claim.
--
-- token_version (users.token_version, migration 0xx "M1") is per USER: bumping
-- it signs the account out on every device at once, which is why in-app "Sign
-- out" was local-only and why revoking a device could not invalidate the JWT
-- that device was still holding. Every sign-in and every device token now
-- mints a session id, recorded here; revoking a device marks the sessions it
-- proved (token_sessions.device_id is set by a successful DeviceAttest, never
-- by a client claim), signing out ONE session marks that row, and the auth
-- middleware and the WebSocket upgrade refuse a token whose sid is revoked
-- while every other session of the user keeps working.
--
-- Tokens minted before this claim existed carry no sid and are accepted (no
-- row can be revoked for them); their first sliding renewal mints one, so the
-- field converges within a day. Rows are small and cascade with the user.
CREATE TABLE IF NOT EXISTS token_sessions (
    sid          TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Set only by a device that proved its signing key on this session.
    device_id    TEXT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at   TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_token_sessions_user ON token_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_token_sessions_device ON token_sessions(device_id) WHERE device_id IS NOT NULL;
