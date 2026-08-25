-- Uploaded files table for avatars, attachments, etc.
CREATE TABLE IF NOT EXISTS uploaded_files (
    id UUID PRIMARY KEY,
    uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uploaded_files_uploader ON uploaded_files(uploader_id);
