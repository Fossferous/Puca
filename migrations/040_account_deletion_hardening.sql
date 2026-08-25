-- Tombstoned accounts must be unauthenticatable, positively.
--
-- The first cut of DELETE /account cleared the SRP salt/verifier to EMPTY
-- bytes on the assumption that "empty material can never authenticate". That
-- is false: with verifier v = 0 the SRP-6a premaster secret degenerates to 0
-- for ANY client-chosen A, and srp 0.6 computes M1 = H(A ‖ B ‖ K) over public
-- values only — so anyone who knows the (entirely predictable) tombstone
-- username can forge a valid client proof and log in as the deleted account.
-- Verified empirically against srp 0.6 before writing this migration.
--
-- The fix is defence in depth:
--   1. deleted_at — an explicit tombstone flag the login path checks, so
--      authentication is refused on identity, not on cryptographic accident.
--   2. (in code) random salt/verifier instead of empty, so even a login path
--      that forgot the flag has no algebraic shortcut to exploit.
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMP;

-- Any account already tombstoned by the earlier code is exposed right now:
-- flag it, and replace the degenerate empty verifier with non-zero material.
-- (gen_random_bytes needs pgcrypto, which this deployment does not install —
-- so derive bytes from random()/md5, which is ample here: the row is already
-- unauthenticatable via deleted_at, and this only has to not be ZERO. New
-- deletions get CSPRNG bytes from the application.)
-- 16 md5 hex blocks = 512 hex chars = the 256 bytes a 2048-bit group element
-- occupies; each block is salted differently so the value isn't a repeat.
UPDATE users
SET deleted_at = NOW(),
    salt = decode(md5(random()::text || id::text), 'hex'),
    verifier = decode(
        md5(random()::text || '1' || id::text) || md5(random()::text || '2' || id::text) ||
        md5(random()::text || '3' || id::text) || md5(random()::text || '4' || id::text) ||
        md5(random()::text || '5' || id::text) || md5(random()::text || '6' || id::text) ||
        md5(random()::text || '7' || id::text) || md5(random()::text || '8' || id::text) ||
        md5(random()::text || '9' || id::text) || md5(random()::text || 'a' || id::text) ||
        md5(random()::text || 'b' || id::text) || md5(random()::text || 'c' || id::text) ||
        md5(random()::text || 'd' || id::text) || md5(random()::text || 'e' || id::text) ||
        md5(random()::text || 'f' || id::text) || md5(random()::text || 'g' || id::text),
        'hex')
WHERE username LIKE 'deleted#%'
  AND (octet_length(verifier) = 0 OR deleted_at IS NULL);
