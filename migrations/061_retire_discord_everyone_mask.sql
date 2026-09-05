-- Migration 061: retire the Discord-layout @everyone mask that migration 004
-- left on every server that already existed when it ran.
--
-- 004 backfilled a default role with the literal 104324673 -- Discord's default
-- @everyone integer -- into a schema whose bit assignment is entirely different
-- (src/permissions.rs). Decoded under Puca's layout that value grants
-- MANAGE_CHANNELS, MANAGE_ROLES, KICK_MEMBERS and BAN_MEMBERS (plus
-- MUTE_MEMBERS, MOVE_MEMBERS, PRIORITY_SPEAKER, MANAGE_TASKS and CREATE_CLIPS)
-- to every member of such a server. MANAGE_CHANNELS in a member's base makes
-- the permission resolver re-insert VIEW_CHANNEL after any deny overwrite and
-- makes the key distributor wrap every epoch for them, so on those servers a
-- hidden channel was hidden from nobody, and every member could create, edit
-- and delete channels. Migrations 046 and 056 only ever OR bits in; nothing
-- ever cleared these.
--
-- Servers created through create_server were never affected (they receive
-- Permissions::DEFAULT_MEMBER), and a fresh database holds no servers when 004
-- runs, so this touches only rows still carrying the WHOLE fossil mask; an owner
-- who deliberately configured exactly that set is not a realistic case. The
-- replacement is DEFAULT_MEMBER as of this release (226527063) OR the bits 046
-- granted every pre-existing @everyone (35920) OR MANAGE_TASKS, which 033
-- granted to EVERY role of a then-existing server on purpose ("existing servers
-- keep today's anyone-can-do-everything checklist behaviour") and which this
-- reset must not take back: 260083543. Both constants are pinned by a unit
-- test in src/permissions.rs so the two cannot drift apart.
--
-- What an affected server's members lose: channel management, role
-- management, kick, ban, and the voice moderation bits (mute, move, priority
-- speaker) -- none of which a default member was ever meant to hold. Owners
-- keep everything through the Owner role (migration 042). Rows that ALSO
-- carry MANAGE_SERVER or ADMINISTRATOR (4718592) are left alone: no migration
-- ever wrote those, so they are an owner's deliberate grant, however unwise.
--
-- Rotate first: bumping member_generation makes every client mint a new epoch
-- wrapped only for the members the corrected permissions still let VIEW.
UPDATE servers
   SET member_generation = member_generation + 1
 WHERE id IN (SELECT server_id FROM server_roles
               WHERE is_default = TRUE
                 AND (permissions & 104324673) = 104324673
                 AND (permissions & 4718592) = 0);

UPDATE server_roles
   SET permissions = 260083543
 WHERE is_default = TRUE
   AND (permissions & 104324673) = 104324673
   AND (permissions & 4718592) = 0;
