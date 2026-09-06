-- Migration 063: a block dissolves the friendship - backfill for pairs blocked before 0.9.5.
--
-- From 0.9.5 block_user deletes the friends row and every pending friend request
-- between the two accounts in the same transaction as the blocked_users insert
-- (src/moderation_handlers.rs). Pairs blocked under earlier releases still hold
-- their friends row, and with it every friendship-derived capability the block was
-- meant to end: presence frames, the dm-keys census, the DM consent shortcut.
-- Remove those rows once. Idempotent: re-running deletes nothing.

DELETE FROM friends f
USING blocked_users b
WHERE (f.user1_id = b.blocker_id AND f.user2_id = b.blocked_id)
   OR (f.user2_id = b.blocker_id AND f.user1_id = b.blocked_id);

DELETE FROM friend_requests fr
USING blocked_users b
WHERE (fr.sender_id = b.blocker_id AND fr.receiver_id = b.blocked_id)
   OR (fr.receiver_id = b.blocker_id AND fr.sender_id = b.blocked_id);
