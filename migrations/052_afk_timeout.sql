-- Server-configurable AFK timeout, copying Discord's rule set: an idle user
-- in a voice channel is moved to the server's AFK channel after this many
-- minutes, and the owner picks the window from the same five options Discord
-- offers (1, 5, 15, 30, 60). 15 was the previously hardcoded client value, so
-- existing servers keep exactly the behaviour they had.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS afk_timeout_minutes INTEGER NOT NULL DEFAULT 15;
ALTER TABLE servers ADD CONSTRAINT servers_afk_timeout_minutes_check
    CHECK (afk_timeout_minutes IN (1, 5, 15, 30, 60));
