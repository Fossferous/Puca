-- Add display_name column for nicknames
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT NULL;

-- Also ensure avatar_file_id exists
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_file_id TEXT DEFAULT NULL;
