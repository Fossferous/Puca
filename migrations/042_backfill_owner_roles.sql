-- 042: backfill the Owner-role bootstrap for servers created while it was broken.
--
-- create_server's Owner bootstrap silently failed in two windows:
--
--   1. Launch -> 357701a (deployed 2026-07-24): the role INSERT bound integer 0
--      to the BOOLEAN is_default column, so Postgres rejected the whole row --
--      these servers have NO Owner role at all (audit finding M13).
--   2. 357701a -> f59ee4e: the INSERT succeeded, but RETURNING id was decoded as
--      i32 against the BIGSERIAL column; the ColumnDecode error path skipped the
--      member_roles INSERT -- these servers have an Owner role nobody holds.
--
-- Ownership was never affected (handlers check servers.owner_id), so this is a
-- consistency repair. Scope verified against production 2026-07-27: 3 servers,
-- 2 in window 1, 1 in window 2, 0 healthy. Both statements are idempotent
-- no-ops on healthy servers, mirroring the @everyone backfill in 004.

-- Window 1: recreate the missing Owner role exactly as create_server does.
INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
SELECT s.id, 'Owner', '#F1C40F', 4194304, 100, false
FROM servers s
WHERE NOT EXISTS (
    SELECT 1 FROM server_roles r
    WHERE r.server_id = s.id AND r.name = 'Owner' AND r.is_default = false
);

-- Both windows: assign each owner to their server's Owner role. If a server has
-- several non-default roles named 'Owner' (user-created duplicates), take the
-- oldest -- the bootstrap role always has the smallest id. The server_members
-- guard skips owners with no membership row (none exist today; delete_account
-- refuses deletion while servers are still owned, so this is only defensive).
INSERT INTO member_roles (server_id, user_id, role_id)
SELECT s.id, s.owner_id, r.id
FROM servers s
JOIN LATERAL (
    SELECT id FROM server_roles
    WHERE server_id = s.id AND name = 'Owner' AND is_default = false
    ORDER BY id
    LIMIT 1
) r ON true
WHERE EXISTS (
    SELECT 1 FROM server_members sm
    WHERE sm.server_id = s.id AND sm.user_id = s.owner_id
)
AND NOT EXISTS (
    SELECT 1 FROM member_roles mr
    WHERE mr.server_id = s.id AND mr.user_id = s.owner_id AND mr.role_id = r.id
)
ON CONFLICT DO NOTHING;
