-- Per-device identity: the primitive the "My Devices" remote-desktop feature is
-- built on, and the one thing the existing crypto cannot express.
--
-- WHY THIS EXISTS: today every device of an account holds the SAME X25519
-- private key (v3 = one random seed, Argon2id-wrapped, unwrapped identically
-- everywhere). So a pairwise handshake between two of your own devices
-- degenerates into self-DH: it LOOKS like it works (both sides derive the same
-- 32 bytes) while authenticating nothing, and there is no way to say "this
-- machine, not my other machine", to revoke one device, or to stop a single
-- compromised device impersonating the rest.
--
-- TRUST CHAIN — the server can forge neither half:
--   * `auth_record`/`auth_sig` — the ACCOUNT Ed25519 key (derived from the seed,
--     never fetched from the server) certifies "device D belongs to user U".
--     Every client verifies this locally, so a server-injected row is refused.
--   * `device_grants` — the HOST DEVICE's own key certifies "controller C may
--     drive me". That private key never leaves the host machine and is NOT
--     derivable from the password, so password compromise alone cannot add an
--     attacker to any host's allowlist. This is the load-bearing defence.
--
-- Residual, accepted: the server can HIDE a row. Clients cache the verified
-- list and surface a device that disappears rather than silently accepting the
-- shrunken set.
--
-- NOTE: unrelated to `device_tokens` (005/038), which is push-only and, per
-- 038's own comment, still read by nothing.

CREATE TABLE IF NOT EXISTS devices (
    -- DERIVED, never client-chosen:
    --   base64url(sha256("sovereign-device-v1" || device_pub || sign_pub))[0..21]
    -- so no client can squat another device's id and the server can reject a
    -- mismatch without trusting anyone.
    id            TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_pub    TEXT NOT NULL,          -- 'x25519:<base64>'
    sign_pub      TEXT NOT NULL,          -- 'ed25519:<base64>'
    name          TEXT NOT NULL,
    platform      TEXT NOT NULL CHECK (platform IN ('windows','linux','macos','android','ios','web')),
    -- Canonical JSON (sorted keys, no whitespace) stored VERBATIM: re-serialising
    -- would change the bytes and break signature verification.
    auth_record   TEXT NOT NULL,
    auth_sig      TEXT NOT NULL,
    -- Unattended hosting, off until explicitly armed on the device itself.
    host_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
    host_policy   TEXT DEFAULT NULL,      -- canonical JSON: ua_salt + UA pubkey
    host_sig      TEXT DEFAULT NULL,
    -- Wake-on-LAN details (mac / subnet / broadcast), CLIENT-ENCRYPTED under
    -- HKDF(seed,'sovereign-device-lan-v1'). The server has no business holding a
    -- map of the user's MACs and internal IPs, and this costs nothing because
    -- every device that needs it already holds the seed.
    lan_info      TEXT DEFAULT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ DEFAULT NULL,
    revoked_at    TIMESTAMPTZ DEFAULT NULL,
    UNIQUE (user_id, device_pub)
);

-- Enrolment is per-account and lists are read on every device connect.
CREATE INDEX IF NOT EXISTS idx_devices_user_live
    ON devices (user_id) WHERE revoked_at IS NULL;

-- Host-signed controller allowlist. Rows are meaningless without `grant_sig`,
-- which only the host device can produce.
CREATE TABLE IF NOT EXISTS device_grants (
    host_device       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    controller_device TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    grant_record      TEXT NOT NULL,      -- canonical JSON, verbatim
    grant_sig         TEXT NOT NULL,      -- Ed25519 by the HOST DEVICE's key
    expires_at        TIMESTAMPTZ DEFAULT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (host_device, controller_device)
);

CREATE INDEX IF NOT EXISTS idx_device_grants_controller
    ON device_grants (controller_device);
