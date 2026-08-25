-- Allow non-mobile push transports to register a device.
--
-- `device_tokens.platform` was `CHECK (platform IN ('ios','android'))`, which
-- bakes in the assumption that push means a phone. It does not:
--
--   * 'web'         — WebPush/VAPID, which is how a desktop or browser client
--                     gets woken WITHOUT Google or Apple in the path. For a
--                     self-hosted product that is the transport that actually
--                     fits the premise.
--   * 'unifiedpush' — the Google-free Android route (ntfy et al), same reason.
--
-- Left as a CHECK rather than dropped: the column is written from a client, and
-- an open text field would let anything land in a column later used to pick a
-- delivery transport. Widening the set keeps that guard while unblocking the
-- transports worth building.
--
-- This is deliberately a schema-only change. Nothing reads device_tokens yet —
-- there is no push transport in the backend at all — but the constraint would
-- otherwise reject registrations before any of that work could be tested.
ALTER TABLE device_tokens DROP CONSTRAINT IF EXISTS device_tokens_platform_check;

ALTER TABLE device_tokens
    ADD CONSTRAINT device_tokens_platform_check
    CHECK (platform IN ('ios', 'android', 'web', 'unifiedpush'));
