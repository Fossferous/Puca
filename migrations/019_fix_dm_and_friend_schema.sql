-- Fix DM + friend schema to match the handler code (both tables were empty —
-- these features never worked because the schema and code disagreed).
--
-- Handlers use:
--   friend_requests.sender_id / receiver_id   (schema had from_user_id / to_user_id)
--   dm_conversations.id / dm_messages.id       as TEXT UUIDs (schema had SERIAL ints)
--   dm_conversations.updated_at                (schema had no such column)
-- and bind user ids as i64, so the user-id columns are widened to BIGINT
-- (a BIGINT FK to the INTEGER users.id primary key is permitted).

-- friend_requests: rename to the code's column names + widen to BIGINT.
ALTER TABLE friend_requests RENAME COLUMN from_user_id TO sender_id;
ALTER TABLE friend_requests RENAME COLUMN to_user_id TO receiver_id;
ALTER TABLE friend_requests ALTER COLUMN id TYPE BIGINT;
ALTER TABLE friend_requests ALTER COLUMN sender_id TYPE BIGINT;
ALTER TABLE friend_requests ALTER COLUMN receiver_id TYPE BIGINT;

-- friends: widen user id columns to BIGINT.
ALTER TABLE friends ALTER COLUMN user1_id TYPE BIGINT;
ALTER TABLE friends ALTER COLUMN user2_id TYPE BIGINT;

-- DM tables: recreate with TEXT ids (UUIDs) + BIGINT user columns + updated_at.
DROP TABLE IF EXISTS dm_messages CASCADE;
DROP TABLE IF EXISTS dm_conversations CASCADE;

CREATE TABLE dm_conversations (
    id TEXT PRIMARY KEY,
    user1_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user1_id, user2_id)
);

CREATE TABLE dm_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
    sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    encrypted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
