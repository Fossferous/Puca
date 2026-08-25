-- Cross-user device sharing: a device owner grants a FRIEND standing access
-- to one device, with explicit grantee consent and instant revocation.
--
-- Trust chain, extending 044's:
--   * The invite row records intent and consent (owner created it, grantee
--     accepted it) — server-enforced state, like friend_requests.
--   * `grant_record`/`grant_sig` — the HOST DEVICE's own Ed25519 key certifies
--     "this user, from any of their enrolled devices, may reach me with these
--     capabilities". Only the host machine can produce it (the key never
--     leaves that device and is not derivable from the password), so neither
--     the server nor a password thief can mint one. The server verifies the
--     signature on upload as hygiene; the HOST re-verifies it at connect time
--     as the real gate.
--   * The grantee's devices are verified by the host against the grantee's
--     published account signing key (users.account_sign_pub below), which
--     clients TOFU-pin exactly like the X25519 DM identity key.
--
-- One row per (host_device, grantee): re-inviting after a reject/revoke
-- resets the same row to 'pending' — capability changes always re-consent.
-- Connection authorization requires status = 'accepted' AND revoked_at IS
-- NULL AND grant_sig IS NOT NULL, re-read fresh on EVERY connect, so a
-- revoked grant cannot be replayed back to life.

CREATE TABLE IF NOT EXISTS device_share_invites (
    id            BIGSERIAL PRIMARY KEY,
    host_device   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    owner_user    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    grantee_user  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Subset of {'control','view_only','files'}; control and view_only are
    -- mutually exclusive. Validated in the handler — a CHECK on array
    -- membership would silently drift from the handler's rule set.
    capabilities  TEXT[] NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','accepted','rejected','revoked')),
    -- Canonical JSON (sorted keys, no whitespace) stored VERBATIM, signed by
    -- the host device's signing key. NULL until the host device produces it.
    grant_record  TEXT DEFAULT NULL,
    grant_sig     TEXT DEFAULT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at  TIMESTAMPTZ DEFAULT NULL,
    revoked_at    TIMESTAMPTZ DEFAULT NULL,
    UNIQUE (host_device, grantee_user)
);

-- The connect-time gate reads by (host_device, grantee, accepted); the
-- grantee's "shared with me" list reads by grantee alone.
CREATE INDEX IF NOT EXISTS idx_device_share_invites_grantee
    ON device_share_invites (grantee_user);
CREATE INDEX IF NOT EXISTS idx_device_share_invites_owner
    ON device_share_invites (owner_user);

-- The account's Ed25519 SIGNING public key (ed25519:<base64>), published so
-- OTHER users' clients can verify this account's device enrolment records.
-- Distinct from users.public_key (the X25519 DM identity key). Same trust
-- posture as that key: the server could substitute it on first contact, so
-- clients TOFU-pin it and surface any later change loudly (and can compare
-- safety numbers out of band). Populated lazily by clients on login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_sign_pub TEXT DEFAULT NULL;
