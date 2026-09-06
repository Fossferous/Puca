-- Migration 062: an invite dies with its creator's membership.
--
-- Every member holds CREATE_INVITE by default (Permissions::DEFAULT_MEMBER in
-- src/permissions.rs, backfilled onto every @everyone by 056), and until this
-- release the only statement that ever removed an invite was the
-- MANAGE_SERVER delete route. Kick, ban, leave and account deletion all purge
-- the departing member's roles, membership and wrapped keys (015's trigger),
-- but never the codes they minted: a member removed from a private server
-- kept a working door for any other account they controlled, and the invite
-- list did not say whose door it was.
--
-- A trigger rather than handler edits, because server_members rows are
-- deleted from five places in src/ (kick, ban, leave, account deletion) plus
-- the users -> server_members ON DELETE CASCADE, and a row-level trigger fires
-- for every one of them, cascades included, with no sixth site to forget
-- later. Same shape as 015's trg_server_members_generation; a SECOND trigger
-- on the same event rather than an edit to that one, because 015 is applied
-- and frozen (see README.md).
CREATE OR REPLACE FUNCTION puca_revoke_departed_member_invites() RETURNS trigger AS $$
BEGIN
    DELETE FROM server_invites
     WHERE server_id = OLD.server_id
       AND creator_id = OLD.user_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_server_members_revoke_invites ON server_members;
CREATE TRIGGER trg_server_members_revoke_invites
    AFTER DELETE ON server_members
    FOR EACH ROW EXECUTE FUNCTION puca_revoke_departed_member_invites();

-- One-off: codes whose creator had already left before the trigger existed.
-- Owners are always members (create_server inserts them), so no owner's code
-- is touched; re-running finds nothing and is a no-op.
DELETE FROM server_invites i
 WHERE NOT EXISTS (SELECT 1 FROM server_members m
                    WHERE m.server_id = i.server_id
                      AND m.user_id = i.creator_id);
