-- Migration 074: Web Push subscriptions for the web app (src/wake/webpush.rs).
--
-- One row per BROWSER that turned on "Notifications on this device" in the web
-- app: the iPhone/iPad Home Screen app, Android Chrome, desktop Chrome, Edge
-- and Firefox. The push service (Apple, Google, Mozilla, Microsoft) is only
-- ever sent the constant {"w":"1"}; this table is what lets the server know
-- WHERE to send it and whether it still may.
--
--   endpoint, p256dh, auth  - the browser's PushSubscription. endpoint is
--       UNIQUE: one browser profile is one subscription, and a browser that
--       signs into another account moves the row (as device_tokens does).
--   sid, token_version, expires_at - the session that subscribed. A wake is
--       sent only while that session is live (not signed out, its device not
--       revoked, the account's token_version unchanged, before the session's
--       absolute cap), so every way of signing a device out also stops its
--       pushes. Rows for dead sessions are deleted when next looked at; the
--       FK removes them with the session row itself.
--   fetch_secret_sha256 - the hash of a random secret only that browser's
--       service worker holds. It lets the worker ask POST /push/web/pending
--       what knocked, and nothing else: it is not a session.
--   muted_servers, muted_channels, blocked_ids - this device's own mutes and
--       blocks, mirrored by the client, so a wake is never sent for a muted
--       conversation. They must be applied BEFORE sending: iOS revokes a
--       subscription whose pushes show no notification, so the worker cannot
--       stay silent itself. The Android app mirrors the same three into its
--       native PushPrefs for the same reason.
--
-- Additive and idempotent: a new table nothing older reads, so an older
-- binary boots over it unchanged (migrator::app_migrator), and re-running it
-- changes nothing.
--
-- Reversible: DROP TABLE web_push_subscriptions;
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    id                   BIGSERIAL PRIMARY KEY,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sid                  TEXT NOT NULL REFERENCES token_sessions(sid) ON DELETE CASCADE,
    token_version        INTEGER NOT NULL,
    expires_at           TIMESTAMPTZ NOT NULL,
    endpoint             TEXT NOT NULL UNIQUE,
    p256dh               TEXT NOT NULL,
    auth                 TEXT NOT NULL,
    fetch_secret_sha256  TEXT NOT NULL,
    muted_servers        TEXT[] NOT NULL DEFAULT '{}',
    muted_channels       BIGINT[] NOT NULL DEFAULT '{}',
    blocked_ids          BIGINT[] NOT NULL DEFAULT '{}',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_push_at         TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user ON web_push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_sid ON web_push_subscriptions(sid);
