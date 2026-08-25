-- End-to-End Encryption: per-channel group keys and message epoch tagging.
--
-- Channel messages are encrypted client-side with a symmetric "channel key"
-- (CK) that is rotated on membership change. Each CK belongs to an `epoch`.
-- The CK is never sent to the server in the clear: it is wrapped (encrypted)
-- for each member individually and stored here.

-- Wrapped channel keys: one row per (channel, epoch, recipient).
CREATE TABLE IF NOT EXISTS channel_keys (
    id SERIAL PRIMARY KEY,
    channel_id INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL,
    -- base64(nonce || ciphertext) of the channel key, encrypted to the recipient.
    wrapped_key TEXT NOT NULL,
    -- The distributor's public key, needed by the recipient to unwrap.
    sender_public_key TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY(recipient_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(channel_id, epoch, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_keys_lookup
    ON channel_keys(channel_id, recipient_id);

-- Tag messages with the channel-key epoch used to encrypt them.
-- NULL means the message is legacy/plaintext (pre-E2EE).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS key_epoch INTEGER DEFAULT NULL;

-- DM messages can also be encrypted; a simple flag documents intent. The
-- ciphertext itself lives in `content` as a JSON envelope, so no schema change
-- is strictly required, but the flag helps clients and audits.
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS encrypted BOOLEAN DEFAULT FALSE;
