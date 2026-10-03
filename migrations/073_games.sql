-- Migration 073: games in a voice call (Poker, Blackjack; docs/GAMES.md).
--
-- 1. servers.games_enabled, OFF by default (the owner's decision): nothing
--    about games is offered or accepted on a server until its owner turns
--    them on in Server Settings, next to Clips (clips_enabled, 050, is the
--    pattern). Turning it off ends every table on that server.
--
-- 2. PLAY_GAMES (1<<28 = 268435456) onto every @everyone role. Like
--    CREATE_CLIPS in 051 this is a genuine new grant, not a behaviour-
--    preserving backfill — nobody could play before, because the feature did
--    not exist — and it is safe as a default only because games_enabled
--    defaults FALSE: the bit does nothing until an owner deliberately turns
--    games on, and at that moment "everyone in a call can sit down" is
--    precisely the setting they are choosing. An owner who wants it narrower
--    clears the bit from @everyone (or denies it on one voice channel) and
--    grants a role instead. Newly created servers get it through
--    Permissions::DEFAULT_MEMBER (create_server derives @everyone from it).
--    Scoped to is_default roles ONLY, like 046, 051 and 056: a non-default
--    role is a deliberate grant an admin authored.
--
-- Additive and idempotent: an older binary never reads the column and
-- ignores a permission bit it does not know (from_bits_truncate), so 0.9.832
-- boots over this unchanged; re-running it changes nothing (ADD COLUMN IF NOT
-- EXISTS; OR-ing a set bit is a no-op).
--
-- Reversible: ALTER TABLE servers DROP COLUMN games_enabled;
-- UPDATE server_roles SET permissions = permissions & ~268435456
-- WHERE is_default = true; nobody held this bit before today.

ALTER TABLE servers ADD COLUMN IF NOT EXISTS games_enabled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE server_roles SET permissions = permissions | 268435456 WHERE is_default = true;
