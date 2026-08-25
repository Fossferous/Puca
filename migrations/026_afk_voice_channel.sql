-- AFK voice channels: a parking channel where members can't transmit audio.
-- Clients force-mute on join and auto-move idle users here after inactivity.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_afk BOOLEAN NOT NULL DEFAULT FALSE;
