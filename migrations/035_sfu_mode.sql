-- Tier-2 SFU: per-voice-channel opt-in. When true, clients joining this voice
-- channel use the LiveKit SFU path (concurrent multi-streaming) instead of the
-- P2P mesh. Mode is read at join time; a live call keeps the transport it
-- started with (no mid-call migration).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS sfu_mode BOOLEAN NOT NULL DEFAULT FALSE;
