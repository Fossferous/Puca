-- A file id is stored the way the server issued it: every guard on these columns (the in-use
-- check, an account deletion's stamp and purge) compares text. A write in another spelling of the
-- uuid used to be stored as it came. Real clients echo the id they were given, so this is
-- expected to touch nothing. Selected by pattern, so a value that is no uuid is left alone.
UPDATE users SET avatar_file_id = avatar_file_id::uuid::text
 WHERE avatar_file_id ~* '^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$'
   AND avatar_file_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
UPDATE users SET join_sound_file_id = join_sound_file_id::uuid::text
 WHERE join_sound_file_id ~* '^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$'
   AND join_sound_file_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
UPDATE users SET leave_sound_file_id = leave_sound_file_id::uuid::text
 WHERE leave_sound_file_id ~* '^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$'
   AND leave_sound_file_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
UPDATE servers SET icon_file_id = icon_file_id::uuid::text
 WHERE icon_file_id ~* '^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$'
   AND icon_file_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
UPDATE server_emojis SET file_id = file_id::uuid::text
 WHERE file_id ~* '^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$'
   AND file_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
UPDATE custom_emojis SET file_id = file_id::uuid::text
 WHERE file_id ~* '^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$'
   AND file_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
