-- Server-admin policy: require end-to-end encryption for voice/video/screen
-- calls in this server. Compliant clients OR this into the per-user
-- "Require encryption for calls" setting, so a non-E2EE-capable participant is
-- muted rather than relayed. Advisory (defense-in-depth for honest servers), not
-- a cryptographic guarantee — see the client-side comments.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS require_media_e2ee BOOLEAN NOT NULL DEFAULT FALSE;
