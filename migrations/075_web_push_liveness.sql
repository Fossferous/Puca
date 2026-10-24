-- Migration 075: Web Push subscriptions end when their session's token lapses,
-- and a failing push service backs off and is eventually given up on.
--
--   token_ttl_secs - the lifetime of the subscribing session's tokens (24 h,
--       or 30 days with "Stay signed in"). A session is dead once its last
--       token lapses unrenewed: token_sessions.last_seen_at is written at every
--       mint, so no token of it outlives last_seen_at + token_ttl_secs, and a
--       wake is sent only before that (src/wake/sender.rs). Without it a
--       shared computer's browser kept being told "alice sent you a message"
--       for the session's whole 30-day cap after its 24-hour sign-in lapsed.
--       The default is the SHORT lifetime: a row from before this migration
--       errs towards stopping early, and its app's next start re-registers.
--   failures, failing_since, last_failure_at - consecutive push failures. The
--       sender waits longer after each one, and deletes a row that has failed
--       for a day (a rotated VAPID key answers 403 forever).
--
-- Additive and idempotent: new columns with defaults on a table no released
-- binary reads yet; re-running changes nothing.
--
-- Reversible: ALTER TABLE web_push_subscriptions DROP COLUMN token_ttl_secs,
--   DROP COLUMN failures, DROP COLUMN failing_since, DROP COLUMN last_failure_at;
ALTER TABLE web_push_subscriptions ADD COLUMN IF NOT EXISTS token_ttl_secs INTEGER NOT NULL DEFAULT 86400;
ALTER TABLE web_push_subscriptions ADD COLUMN IF NOT EXISTS failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE web_push_subscriptions ADD COLUMN IF NOT EXISTS failing_since TIMESTAMPTZ NULL;
ALTER TABLE web_push_subscriptions ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ NULL;
