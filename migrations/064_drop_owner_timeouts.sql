-- Migration 064: remove any member_timeouts row that names the server owner.
--
-- 0.9.811 made lifting a timeout go through the same hierarchy rule as imposing
-- one (src/moderation_handlers.rs remove_timeout -> permissions::can_moderate),
-- and that rule refuses the OWNER as a target unconditionally. timeout_member has
-- refused the owner since 0.9.4, so no new row can name them - but a row written
-- under an earlier release would now be unliftable by anyone through the API,
-- silencing the owner in their own server with no escape hatch. Clear such rows
-- once. Idempotent: re-running deletes nothing.

DELETE FROM member_timeouts mt
USING servers s
WHERE s.id = mt.server_id
  AND s.owner_id = mt.user_id;
