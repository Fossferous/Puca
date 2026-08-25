-- Privacy toggles that must live server-side: a client-side-only privacy
-- control is trivially bypassed (the same reasoning as the blocked_users
-- enforcement in dm_handlers). Both existed as Settings checkboxes that
-- wrote localStorage and were read by nothing.
--
--   allow_dms_from_server_members: when FALSE, only accepted friends can
--   start conversations with / send DMs to this user.
--
--   show_online_status: when FALSE, presence broadcasts and member/friend
--   list snapshots report this user as offline to everyone.
ALTER TABLE users ADD COLUMN allow_dms_from_server_members BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN show_online_status BOOLEAN NOT NULL DEFAULT TRUE;
