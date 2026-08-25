-- Backfill an AFK voice channel into every server that predates the
-- default-AFK bootstrap (servers created before migration 026 / the
-- text+voice+AFK default set never got one).
--
-- Mirrors the new-server INSERT in server_handlers.rs: name='AFK', type=1
-- (voice), is_afk=true. Position = one past the server's current max so it
-- sorts last; the client pins is_afk channels last regardless of position
-- (Chat.tsx sort), so the exact value is only cosmetic. NOT EXISTS guards
-- against giving a server a second AFK channel (there is no DB uniqueness on
-- (server_id, name), so the app logic is the only guard — replicated here).
INSERT INTO channels (name, type, position, is_afk, server_id)
SELECT 'AFK', 1, COALESCE(MAX(c.position), -1) + 1, TRUE, s.id
FROM servers s
LEFT JOIN channels c ON c.server_id = s.id
WHERE NOT EXISTS (
    SELECT 1 FROM channels a WHERE a.server_id = s.id AND a.is_afk = TRUE
)
GROUP BY s.id;
