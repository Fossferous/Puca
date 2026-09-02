# E2EE Account Recovery — Design Spec (v3 key custody)

**Status: SHIPPED.** This began as a design draft; v3 key custody has been
live since 0.6.x and is what the product runs today (`src/recovery_handlers.rs`,
`frontend/src/api/auth.ts`). Read it as the design record, not as a proposal —
the open decisions in §9 were all resolved, and how they landed is recorded
there. Two deltas from the original draft are called out inline: the password
wrap is **Argon2id**, not PBKDF2 (§4), and recovery-code rotation, which
was not reachable in the UI for a long time, shipped in 0.9.1 (§8).
**Scope:** let a user who forgot their password reset it **without losing access
to their encrypted history**, while keeping the server zero-knowledge.

---

## 1. Problem

Today the identity keypair *is* the password:

```
e2eeSalt = SHA256("sovereign-e2ee-v2" || srpSalt)
seed     = PBKDF2-SHA256(password, e2eeSalt, 210_000, 32)   // 32-byte X25519 scalar
identity = { priv: seed, pub: X25519.getPublicKey(seed) }
```

DMs derive `X25519(myPriv, theirPub)`; channel keys are AES-wrapped to each
member's identity **public** key. So the identity keypair is the root of all
decryption.

Because `seed` is a pure function of `password`, **forgetting the password
destroys the keypair**, and any reset mints a *new* keypair → all prior DMs and
channel keys (wrapped to the old public key) become permanently undecryptable
for that user. The server can't help — by design it never held the key.

## 2. Goal & non-goals

**Goal:** a user with a **recovery code** can reset their password and keep the
*same* identity keypair, so all history stays readable. Server stays
zero-knowledge (only ever holds ciphertext).

**Non-goals:**
- Recovering an account when **both** password *and* recovery code are lost.
  That is inherent to real E2EE and stays impossible (the alternative — server-
  or admin-held escrow — is explicitly rejected; it would break zero-knowledge).
- Changing DM/channel message crypto. **Unchanged.** This spec only changes key
  *custody*.
- Multi-device key sync beyond what password/recovery already give (same seed on
  any device).

## 3. Core idea: decouple the seed from the password

Make the identity **seed a stable random value**, and store it on the server as
two independently-wrapped ciphertexts:

```
seed              = random(32)                       // generated ONCE, never changes
publicKey         = X25519.getPublicKey(seed)        // published, as today

wrapSalt          = random(16)                        // public
recoverySalt      = random(16)                        // public
recoveryCode      = BIP39(128-bit)                    // 12 words, system-generated, shown ONCE

pwKEK             = PBKDF2-SHA256(password,      wrapSalt,     210_000, 32)
rcKEK             = PBKDF2-SHA256(recoveryCode,  recoverySalt, 210_000, 32)

seedWrappedPw     = AES-256-GCM(pwKEK, seed)          // base64(nonce(12) || ct || tag)
seedWrappedRc     = AES-256-GCM(rcKEK, seed)
```

Server stores `{ publicKey, wrapSalt, recoverySalt, seedWrappedPw, seedWrappedRc,
keyVersion=3 }`. It can decrypt **neither** blob (no password, no recovery code).

- **Login:** SRP as today → unwrap `seedWrappedPw` with `pwKEK`. Same seed → same
  identity → all history readable.
- **Password reset (with recovery code):** unwrap `seedWrappedRc` with `rcKEK` →
  recover the **same** seed → re-wrap under the *new* password. Identity
  unchanged → **history preserved.**

Everything below is the machinery to make that safe.

## 4. Cryptographic constructions (exact)

Reuse the existing primitives in `frontend/src/api/e2ee.ts` verbatim: `@noble`
`x25519`, `pbkdf2(sha256)`, `hkdf(sha256)`, and Web Crypto `AES-GCM`. New
domain-separation strings (never reused across contexts):

> **AS SHIPPED (delta from this draft).** D3 was resolved in favour of
> Argon2id for the **password** KEK: `argon2id(password, wrapSalt, m=19456 KiB,
> t=2, p=1, 32)` (`e2ee.ts`, `ARGON2_M/T/P`). Parameters are fixed on the
> CLIENT so a poisoned server value cannot weaken them — unlike the PBKDF2
> count, which is server-supplied. Legacy PBKDF2 wraps still open, and login
> transparently re-wraps them under Argon2id via `/keys/rewrap-pw`.
> The **recovery** KEK stayed PBKDF2 (`recoveryKEK`), which is sound here for a
> different reason: it keys on 128 bits of system-generated entropy, so the
> guess space — not the KDF — is what makes it infeasible.

| Purpose | Construction |
|---|---|
| Password KEK | **shipped:** `Argon2id(password, wrapSalt, m=19456, t=2, p=1, 32)` (draft said PBKDF2-210k) |
| Recovery KEK | `PBKDF2-SHA256(utf8(recoveryCode.normalizeNFKD), recoverySalt, 210_000, 32)` |
| Seed wrap | `AES-256-GCM`, 12-byte random nonce, output `base64(nonce‖ct‖tag)` — identical framing to existing `aesEncrypt` |
| Recovery proof KEK | `HKDF-SHA256(dh, salt=∅, info="sovereign-recovery-proof-v1", 32)` |
| Recovery proof | `HMAC-SHA256(proofKEK, challenge ‖ utf8(usernameLower))` |

- `seed` is a raw 32-byte X25519 scalar (X25519 clamps internally, so any random
  32 bytes is valid — same as `generateChannelKey`).
- Recovery code entropy is **128 bits, system-generated, never user-chosen** —
  this is a hard requirement (see §7). BIP39 (`@scure/bip39`, same author as
  `@noble`) gives a 12-word mnemonic; NFKD-normalize before KDF.
- PBKDF2 iterations kept at the existing `210_000` for consistency. (Open
  decision D3: consider Argon2id.)

### 4.1 Reset authorization — proof of seed possession (the subtle part)

The reset endpoint is **unauthenticated** (the user forgot the password, so SRP
can't run). Naively accepting "new SRP verifier + new wrapped seed for
`username`" would let anyone **take over** any account. So the reset must prove
the caller actually recovered the seed. We prove it with a DH challenge against
the account's already-published X25519 public key `P` (no new key material):

```
Server (challenge):  e = random scalar; E = X25519.getPublicKey(e)
                     challenge = random(32); store {username, e, challenge, exp=+2min}
                     return { E, challenge, recoverySalt, seedWrappedRc, keyVersion }

Client:              seed  = AES-GCM_dec(rcKEK, seedWrappedRc)   // fails (bad tag) if wrong code
                     dh    = X25519(seed, E)
                     proof = HMAC(HKDF(dh, "sovereign-recovery-proof-v1"), challenge ‖ usernameLower)

Server (verify):     dh'   = X25519(e, P)          // == X25519(seed, E) by DH symmetry
                     proof' = HMAC(HKDF(dh', …), challenge ‖ usernameLower)
                     constant-time compare; consume challenge (one-shot); apply reset iff equal
```

Only a caller holding `seed` (i.e. who unwrapped `seedWrappedRc` with the correct
128-bit recovery code) can produce a valid `proof`. A DB thief has `P`,
`seedWrappedRc`, `recoverySalt` but **not** `seed` (128-bit code ⇒ offline brute
force infeasible), so cannot forge the proof → **no takeover.** The ephemeral `E`
+ one-shot challenge prevent replay.

> Alternative considered: derive an Ed25519 signing key from `seed`, publish its
> public half at registration, sign the reset. Equivalent security but needs an
> extra stored public key; the DH-challenge reuses the existing `public_key`.
> Recommend DH-challenge.

## 5. Data model (backend)

Add to `users` (all nullable; absence ⇒ legacy v2):

```sql
ALTER TABLE users ADD COLUMN key_version    INT   NOT NULL DEFAULT 2;
ALTER TABLE users ADD COLUMN wrap_salt       BYTEA;
ALTER TABLE users ADD COLUMN recovery_salt   BYTEA;
ALTER TABLE users ADD COLUMN seed_wrapped_pw BYTEA;   -- nonce‖ct‖tag
ALTER TABLE users ADD COLUMN seed_wrapped_rc BYTEA;
-- public_key already exists (x25519 identity pubkey)
```

Ephemeral recovery challenges (short-lived; could also be an in-memory
`DashMap` with TTL instead of a table):

```sql
CREATE TABLE recovery_challenges (
    username     TEXT PRIMARY KEY,      -- lowercased
    server_eph   BYTEA NOT NULL,        -- e (server ephemeral private)
    challenge    BYTEA NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL
);
```

## 6. API

| Method | Path | Auth | Body → Result |
|---|---|---|---|
| POST | `/auth/register` | none | *existing* + `wrap_salt`, `recovery_salt`, `seed_wrapped_pw`, `seed_wrapped_rc`, `key_version=3` |
| GET | `/keys/wrap` | JWT | → `{ wrap_salt, seed_wrapped_pw, key_version }` (login unwrap) |
| POST | `/keys/migrate-v3` | JWT | `{ wrap_salt, recovery_salt, seed_wrapped_pw, seed_wrapped_rc }` — one-time v2→v3 upgrade |
| POST | `/keys/rewrap` | JWT | rotate recovery code / change password while logged in |
| POST | `/auth/recovery/challenge` | none (rate-limited) | `{ username }` → `{ E, challenge, recovery_salt, seed_wrapped_rc, key_version }` or generic 404 |
| POST | `/auth/recovery/reset` | none (proof) | `{ username, proof, new_salt_hex, new_verifier_hex, new_wrap_salt, new_seed_wrapped_pw }` (+ optional `new_recovery_salt`, `new_seed_wrapped_rc`) |

The old `/auth/reset-password-migration` (force-reset-only, identity-destroying)
is retained for genuinely-lost-code accounts but demoted to a clearly-labelled
"reset & lose history" path.

## 7. Security analysis

| Threat | Outcome |
|---|---|
| **User forgets password, has recovery code** | Recovers seed via `seedWrappedRc`, re-wraps under new password. History intact. ✅ (the goal) |
| **Attacker hits reset endpoint without the code** | Cannot forge the DH proof (no seed) → reset rejected. No takeover. ✅ |
| **DB theft** | Gets `seedWrappedPw` (crackable only as far as the password is weak — *no worse than today's SRP verifier, which is already offline-brute-forceable*) and `seedWrappedRc` (128-bit code ⇒ 2¹²⁸ ⇒ infeasible). Server still can't read messages. ✅ |
| **Recovery blob served to anonymous caller** | Safe **only because** the code is 128-bit system-generated. This is why user-chosen recovery codes are forbidden. Rate-limit `/recovery/challenge` to blunt username enumeration. |
| **Replay of a captured proof** | Bound to a one-shot ephemeral `E` + random challenge with 2-min TTL. ✅ |
| **Lost password AND lost code** | Unrecoverable by design. Only lossy `/reset-password-migration` remains (mints a new identity). Documented, not hidden. |
| **Malicious server** | Sees only ciphertext + salts + public key + DH ephemerals. Cannot derive seed or read messages. Same trust boundary as today. ✅ |

## 8. Flows (step by step)

**Register (v3):** generate `seed`, salts, `recoveryCode`; wrap twice; POST
register with wrap material + `public_key`. **Show the recovery code once**,
gated behind an "I've saved this" confirmation. Persist seed to localStorage as
today.

**Login (v3):** SRP → JWT → `GET /keys/wrap` → `pwKEK = PBKDF2(password, wrap_salt)`
→ `seed = dec(seedWrappedPw)` → `setActiveIdentity`. Sanity: `X25519.getPublicKey(seed)`
must equal the stored `public_key`.

**Migration (v2 → v3), transparent:** on login, if `key_version < 3`, the client
already holds the plaintext seed (derived the old way) **and** the password — the
only moment both are available. It generates salts + recovery code, wraps the
*same* seed, `POST /keys/migrate-v3`, and shows the recovery code. Seed unchanged
⇒ zero history impact. Users who never log in stay v2 until they do.

**Password reset (recovery):** user enters username + recovery code + new
password → `POST /recovery/challenge` → unwrap `seedWrappedRc` (wrong code =
GCM tag failure, surfaced as "invalid recovery code") → build proof → compute
new SRP `salt/verifier` (reuse `generateVerifierForReset`) + new `wrapSalt` +
`seedWrappedPw'` → `POST /recovery/reset`. Server verifies proof, updates SRP +
wrap columns. **Same seed, same public key, history preserved.**

**Rotate recovery code / change password (logged in):** `POST /keys/rewrap` with
freshly-wrapped blobs; lets users regenerate a lost-but-not-yet-needed code or
change password losslessly.

> **AS SHIPPED: recovery-code rotation reached the UI in 0.9.1.** Settings ›
> My Account › Recovery code proves the current password (seed unwrap locally,
> then the SRP re-proof with the bearer, as `changePassword` does), mints a new
> 12-word code, re-wraps the SAME seed under it and POSTs the custody row to the
> proof-gated `/keys/rewrap` (`regenerateRecoveryCode`, `frontend/src/api/auth.ts`).
> The old code stops working the instant the write lands. Between 0.6.x and
> 0.9.0 the endpoint was live with no caller, so a user who believed their
> twelve words had leaked had no way to replace them; that gap is closed.

## 9. Open decisions (need your call before implementation)

- **D1 — Recovery code format:** 12-word BIP39 (recommended; friendly, 128-bit)
  vs a grouped base32 string like `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`.
- **D2 — Require proof-of-possession (§4.1)?** Recommended **yes** (prevents
  account takeover). Skipping it is simpler but lets anyone reset anyone's SRP
  password (they still can't read history, but they can lock people out /
  hijack the login). For a friends server you *might* accept the simpler
  version; I'd advise against.
- **D3 — KDF:** keep PBKDF2-210k (consistent) vs upgrade wrap + identity KDFs to
  Argon2id (stronger vs DB-theft brute force; adds a dependency).
- **D4 — Challenge store:** Postgres table vs in-memory `DashMap` w/ TTL
  (simpler, fine for single-node).
- **D5 — Force migration:** prompt-and-require the recovery code at next login,
  or make it skippable (skippable = some users stay unprotected).

## 10. Test plan (before ship)

- Unit (vitest): wrap→unwrap round-trip (pw + rc); wrong-code fails closed;
  seed identical across a simulated password change; DH proof symmetry
  (`X25519(seed,E) == X25519(e,P)`) and HMAC match; tamper on any field ⇒
  reject.
- Integration (mint JWTs, real backend): register-v3, login-unwrap, migrate-v3,
  full recovery-reset, then **decrypt a pre-reset channel + DM message with the
  post-reset identity** (the acceptance test — proves history survives).
- Negative: reset without proof rejected; expired/replayed challenge rejected;
  rate-limit on `/recovery/challenge`.

## 11. Rollout

1. Migration adds nullable columns (safe; v2 users untouched).
2. Ship client that (a) registers v3, (b) transparently migrates on login,
   (c) exposes recovery-reset UI. Backwards compatible: v2 login still works
   until migrated.
3. Existing users migrate + receive a recovery code on next login. One early
   account had already lost its pre-reset history to a password reset before
   this scheme existed (a separate, already-accepted event); that history stays
   lost, and from the next login on the account is protected.
