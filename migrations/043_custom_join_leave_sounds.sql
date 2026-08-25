-- Custom per-user join/leave sounds, heard by OTHERS in voice.
-- users.*_sound_file_id: plain TEXT ids into uploaded_files (no FK — same
-- convention as avatar_file_id from 002; the reference guard lives in
-- delete_file). server_members.custom_sounds_disabled: per-server moderation
-- switch (the "per-member scalar on the membership row" shape 036 set) —
-- suppression is applied SERVER-side in members-with-roles so clients never
-- even learn a silenced member's sound ids.
ALTER TABLE users ADD COLUMN IF NOT EXISTS join_sound_file_id TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS leave_sound_file_id TEXT DEFAULT NULL;
ALTER TABLE server_members ADD COLUMN IF NOT EXISTS custom_sounds_disabled BOOLEAN NOT NULL DEFAULT FALSE;
