-- Migration 072: "Show when I'm idle or away".
--
-- Presence grew two states between online and offline: idle (ten minutes with
-- no activity on any of the user's devices) and away (an hour). Both are new
-- information about a person that every member of every server they share can
-- see, so they get their own switch, next to show_online_status.
--
-- Default ON (the owner's call): off, the user reads plain "online" while
-- connected. With show_online_status off nothing about presence is shared at
-- all, this included. The idle/away state itself is never stored: it lives in
-- the server's memory and dies with the socket (src/presence.rs).
--
-- Additive and idempotent: an older binary never reads the column, so a
-- rollback boots over it unchanged.

ALTER TABLE users ADD COLUMN IF NOT EXISTS show_idle_status BOOLEAN NOT NULL DEFAULT TRUE;
