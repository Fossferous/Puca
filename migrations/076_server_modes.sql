-- Migration 076: server modes (docs/SERVER_MODES.md).
--
-- A mode is a named set of channels that the client lists only while the mode
-- is on, with an optional look: a background picture and an accent colour.
--
-- 1. server_modes: one row per mode. background_file_id is plain TEXT holding
--    the uuid as text, with no foreign key, exactly like servers.icon_file_id:
--    the picture is a server asset stored in the clear, and every place that
--    guards a server icon guards this column too (upload_handlers: who may
--    fetch it, the in-use refusal; handlers + main: the deleted-account
--    purge). home_channel_id is the mode's main voice channel: where the start
--    notice's Join goes and where Call everyone back gathers people.
--    auto_off: turn the mode off once its voice channels have been empty for
--    30 minutes (counted only after someone has been in them).
--
-- 2. server_mode_channels: which channels belong to which mode. A channel in
--    no mode is always listed; a channel in several modes is listed while any
--    of them is on.
--
-- 3. servers.active_mode_id: the one mode that is on, NULL for none. A column
--    on the server rather than a flag on the mode, so "one mode at a time"
--    cannot be violated by two concurrent switches.
--    servers.active_mode_occupied_at: when the auto-off tick last saw someone
--    in the active mode's voice channels. NULL until it first does.
--
-- 4. SWITCH_MODES (1<<31) is NOT granted to anyone here: it is a new right,
--    held by the owner and administrators through ADMINISTRATOR until a role
--    is given it, and DEFAULT_MEMBER leaves it out.
--
-- Hiding is not access control. Nothing here touches permissions or channel
-- keys, on purpose: a VIEW flip would bump member_generation (every channel
-- on the server rotates its key) on every switch.
--
-- Additive and idempotent: an older binary never reads these and ignores a
-- permission bit it does not know (from_bits_truncate), so it boots over this
-- unchanged, and its clients simply list every channel.
--
-- Reversible: ALTER TABLE servers DROP COLUMN active_mode_id, DROP COLUMN
-- active_mode_occupied_at; DROP TABLE server_mode_channels; DROP TABLE
-- server_modes; UPDATE server_roles SET permissions = permissions &
-- ~2147483648; nobody held this bit before this migration.

CREATE TABLE IF NOT EXISTS server_modes (
    id SERIAL PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    background_file_id TEXT,
    accent_color TEXT CHECK (accent_color ~ '^#[0-9a-f]{6}$'),
    home_channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    auto_off BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_server_modes_server ON server_modes(server_id);

CREATE TABLE IF NOT EXISTS server_mode_channels (
    mode_id INTEGER NOT NULL REFERENCES server_modes(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    PRIMARY KEY (mode_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_server_mode_channels_channel ON server_mode_channels(channel_id);

ALTER TABLE servers ADD COLUMN IF NOT EXISTS active_mode_id INTEGER REFERENCES server_modes(id) ON DELETE SET NULL;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS active_mode_occupied_at TIMESTAMPTZ;
