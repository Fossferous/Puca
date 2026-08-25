-- E2EE key rotation on membership change.
--
-- The server cannot generate channel keys itself (it never sees them), so
-- rotation is client-driven. To tell clients *when* to rotate, we track a
-- monotonic `member_generation` per server that changes on every join/leave,
-- and stamp each published key epoch with the generation it was minted for.
-- When a client sees the server's current generation differ from the epoch's,
-- it rotates to a new epoch wrapped only for the current member set.

ALTER TABLE servers ADD COLUMN IF NOT EXISTS member_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_keys ADD COLUMN IF NOT EXISTS member_generation INTEGER NOT NULL DEFAULT 0;

-- Trigger: on any membership change, bump the server generation. On removal,
-- also delete the departed member's wrapped keys so they cannot fetch keys
-- again (forward secrecy is completed by the remaining members rotating).
CREATE OR REPLACE FUNCTION sovereign_bump_member_generation() RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        UPDATE servers SET member_generation = member_generation + 1 WHERE id = OLD.server_id;
        DELETE FROM channel_keys ck
            USING channels c
            WHERE ck.channel_id = c.id
              AND c.server_id = OLD.server_id
              AND ck.recipient_id = OLD.user_id;
        RETURN OLD;
    ELSE
        UPDATE servers SET member_generation = member_generation + 1 WHERE id = NEW.server_id;
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_server_members_generation ON server_members;
CREATE TRIGGER trg_server_members_generation
    AFTER INSERT OR DELETE ON server_members
    FOR EACH ROW EXECUTE FUNCTION sovereign_bump_member_generation();
