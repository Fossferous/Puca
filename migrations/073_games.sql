-- Migration 073: games in a voice call (Poker, Blackjack; docs/GAMES.md).
--
-- 1. servers.games_enabled, ON by default for every server, new and existing
--    (the owner's decision of 2026-10-03: games "work similarly to Discord's
--    games" - an Activity is simply there in a call, like Discord's). ADD
--    COLUMN with a DEFAULT fills every existing row with TRUE, so no separate
--    backfill is needed. The server's owner can still switch games off in
--    Server Settings, next to Clips; switching off ends every table on that
--    server.
--
-- 2. PLAY_GAMES (1<<28 = 268435456) onto every @everyone role - Discord's
--    "Use Activities", which every member holds by default. Like CREATE_CLIPS
--    in 051 this is a genuine new grant, not a behaviour-preserving backfill:
--    nobody could play before, because the feature did not exist. With games
--    on by default it takes effect at once, which is the decision above: in a
--    call, anyone may start or join an activity. An owner who wants it
--    narrower clears the bit from @everyone (or denies it on one voice
--    channel) and grants a role instead; one who wants none switches games
--    off. Newly created servers get it through Permissions::DEFAULT_MEMBER
--    (create_server derives @everyone from it). Scoped to is_default roles
--    ONLY, like 046, 051 and 056: a non-default role is a deliberate grant an
--    admin authored.
--
-- Additive and idempotent: an older binary never reads the column and
-- ignores a permission bit it does not know (from_bits_truncate), so 0.9.832
-- boots over this unchanged; re-running it changes nothing (ADD COLUMN IF NOT
-- EXISTS; OR-ing a set bit is a no-op).
--
-- Reversible: ALTER TABLE servers DROP COLUMN games_enabled;
-- UPDATE server_roles SET permissions = permissions & ~268435456
-- WHERE is_default = true; nobody held this bit before this migration.

ALTER TABLE servers ADD COLUMN IF NOT EXISTS games_enabled BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE server_roles SET permissions = permissions | 268435456 WHERE is_default = true;
