-- Per-user server-rail ordering: drag-and-drop order lives on the membership
-- row, so each member arranges their own rail without affecting anyone else.
-- NULL = never reordered (sorts after positioned entries, by join date).
ALTER TABLE server_members ADD COLUMN IF NOT EXISTS position INTEGER;
