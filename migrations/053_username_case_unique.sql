-- Case-insensitive uniqueness for usernames.
--
-- Every credential path resolves an account with `LOWER(username) = $1`, but the
-- only constraint on the column is a case-SENSITIVE UNIQUE (001_init.sql). So
-- `alice` and `Alice` are two legal rows that every login, recovery and reset
-- query treats as one account. Registration pre-checks with a LOWER() SELECT,
-- but that is check-then-insert across two pool connections with no transaction,
-- so a race can still land both.
--
-- `recovery_reset` is now scoped to the specific id whose identity key
-- authorised the reset, which closes the security consequence directly. This
-- index removes the ambiguous state itself.
--
-- Written defensively because migrations run automatically at startup: if a
-- deployment already HAS case-duplicate rows, a bare CREATE UNIQUE INDEX would
-- fail and crash-loop the backend on boot. Instead we skip and warn, leaving the
-- operator a healthy server and a log line rather than an outage.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM users GROUP BY LOWER(username) HAVING COUNT(*) > 1
    ) THEN
        RAISE WARNING 'users contains case-duplicate usernames; skipping users_username_lower_key. Resolve the duplicates and re-run this index by hand.';
    ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key ON users (LOWER(username));
    END IF;
END
$$;
