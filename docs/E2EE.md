# End-to-End Encryption

Púca encrypts message content on the client so the server only ever stores
ciphertext. This document describes how it works.

## Threat model

- **Server is honest-but-curious.** It routes and stores messages but must not be
  able to read DM or channel message content. It never sees identity private
  keys, channel keys, or plaintext.

  > **Against an ACTIVELY malicious server (not merely curious), one hole is
  > closed and one limit remains — read both.**
  >
  > *Closed (audit finding H-1; the full write-up is withheld for now, see the README).* Channel-key wrappers used to be
  > trusted on first use by whatever user id the server attached to the row, and
  > nothing checked that id was a member of anything. An operator could attribute
  > a wrapped key to an id you had never seen and would never see, and your client
  > adopted it and encrypted under it — repeatable at every epoch, invisible.
  > A wrapper is now attributable only if it is you, or an id published as a
  > member of that channel under that same key; anything else is still READ but
  > never encrypted under, and the client rotates to an epoch it minted itself.
  >
  > *Remaining limit.* An operator who forges channel MEMBERSHIP — publishing a
  > fabricated account in the member list — still receives the group key, because
  > a client cannot distinguish a fabricated member from a genuine new one
  > without out-of-band verification. What changed is that this now requires a
  > stranger to be visible in the member list, rather than happening silently.
  > Comparing safety numbers is what closes it completely.
  >
  > DMs are not affected in the same way: the partner id comes from the
  > conversation you opened, not from a server-supplied key row.
- **Out of scope:** a compromised end device (malware reading localStorage), a
  malicious client shipping a backdoored build, and traffic analysis / metadata
  (the server necessarily knows who talks to whom and when).

## Identity keys

> **Read this first — there are two schemes, and v3 is the one that ships.**
> The password-derived scheme below is **v2**, kept because accounts created
> under it still open that way. New accounts are **v3**: the seed is a random
> 32 bytes generated once, stored server-side wrapped under a password-derived
> key (**Argon2id**, m=19456 KiB, t=2, p=1) and independently under a 12-word
> recovery code, so forgetting the password no longer destroys the identity.
> A v2 account migrates transparently at next login. `docs/E2EE_RECOVERY.md` is
> the full v3 spec. Everything below about **DMs, channel keys, rotation and
> the envelope formats is unchanged by v3** — it only changed key *custody*.

### v2 (legacy): password-derived

Each user has an X25519 identity keypair derived deterministically from their
password:

```
e2eeSalt = SHA-256("sovereign-e2ee-v2" || srpSalt)
seed     = PBKDF2-SHA256(password, e2eeSalt, 210_000 iterations, 32 bytes)
priv     = seed
pub      = X25519.getPublicKey(seed)
```

- The password never leaves the device (SRP already guarantees this for auth).
- The SRP salt is reused but **domain-separated**, so this derivation can never
  collide with the SRP verifier computation.
- Because keys are derived from the password, the **same password on any device
  yields the same keys** — a user can read their history anywhere, and the
  server stores nothing that can decrypt messages.
- The 32-byte seed is cached in `localStorage` so page reloads (which keep the
  auth token) don't need the password again. It is cleared on logout.

The public key is uploaded (`PATCH /keys/public`) on every login, which also
migrates users who registered before this scheme. Public keys are stored with an
`x25519:` prefix to distinguish them from the legacy P-256 keys.

## Direct messages (pairwise)

DMs use static X25519 ECDH:

```
shared = X25519(myPriv, partnerPub)      // identical for both participants
key    = HKDF-SHA256(shared, info="sovereign-dm-v2", 32 bytes)
ct     = AES-256-GCM(key, nonce, plaintext)
```

The key is symmetric between the two participants, so the recipient — and the
sender themselves, on reload — decrypt using the **conversation partner's**
public key (not the message sender's). Ciphertext is stored/relayed as a JSON
envelope in the message `content` field: `{"v":2,"t":"dm","ct":"<base64>"}`.

## Channel messages (group)

Group channels can't use pairwise ECDH, so each channel has a symmetric
**channel key (CK)** identified by an integer **epoch**:

1. **Bootstrap.** The first sender generates a random 32-byte CK, fetches every
   member's public key (`GET /channels/:id/member-keys`), wraps the CK for each
   member, and publishes the wrapped copies (`POST /channels/:id/keys`) as epoch 1.
2. **Wrapping.** For each member the distributor derives
   `kek = HKDF(X25519(distributorPriv, memberPub), info="sovereign-wrap-v2")`
   and AES-256-GCM encrypts the CK. The stored row is
   `(channel, epoch, recipient, wrapped_key, sender_public_key)`.
3. **Sending.** `ct = AES-256-GCM(CK, nonce, plaintext)`; the message is stored
   with its `key_epoch`. Envelope: `{"v":2,"t":"ch","epoch":N,"ct":"<base64>"}`.
4. **Receiving.** A member fetches the keys wrapped for them
   (`GET /channels/:id/keys`), unwraps each with their identity key, and decrypts
   messages by looking up the CK for the message's epoch.

The server only stores opaque wrapped-key blobs and ciphertext.

### Envelope versions and context binding (v3)

`v` is the envelope version. **v2** is the format above: the AES-GCM tag covers
the ciphertext only. **v3** (reader shipped in 0.8.135) keeps the same JSON
shape and additionally binds the message's *context* into the tag as AES-GCM
associated data, recomputed by the reader from the row's own metadata:

```
channel message        puca/v3/chan-msg/<channelId>/<epoch>/<user_id>
channel checklist item puca/v3/chan-task/<channelId>/<epoch>/<created_by>
task attachment sidecar puca/v3/chan-taskatt/<channelId>/<epoch>/<created_by>
DM                     puca/v3/dm/<sender_id>/<recipient_id>      (directional)
```

Every field is a token from a closed set or a non-negative integer, so the
grammar needs no escaping. What it buys: a v3 body re-attributed to another
user, moved to another channel, relabelled to another epoch, moved between the
message stream and a checklist, or (for a DM) flipped in direction fails the
tag and shows `[Encrypted — does not belong here]`. There is no retry under
another context (that would make the tag an oracle). v2 bodies keep opening
forever. Self envelopes, channel key wraps, seed wraps and control frames stay
v2 for now.

An envelope-shaped body with any *other* `v` is `[Encrypted — unsupported
version, update the app]`, never plaintext.

**Rollout was two releases.** 0.8.135 shipped the reader alone
(`EMIT_ENVELOPE_V3 = false`); 0.8.136 turned emission on. A client that
predates 0.8.135 has no notion of v3: its parser returns null, so it renders a
v3 body as the raw envelope JSON with the "Not encrypted" badge until it
updates. It cannot damage it: from 0.8.136 the server refuses an edit that
would replace a body with an older envelope version or with non-envelope
content (`src/envelope_version.rs`, 409), so a stale client re-sealing the
JSON it displayed is turned away instead of overwriting the ciphertext. That
guard is permanent and applies to every future version bump. Nothing in the
codebase can *prove* every client has updated (no client-version signal
reaches the server); the call was made on the size of the field.
`frontend/e2e/puca.spec.ts` pins the version the app writes.

### Key rotation & membership

Rotation is client-driven (the server never holds a channel key), coordinated by
a per-server **member generation**:

- A Postgres trigger (`migrations/015`) increments `servers.member_generation`
  on every `server_members` insert/delete, and on removal deletes the departed
  member's wrapped `channel_keys` rows.
- Each published epoch is stamped with the generation it was minted for.
  `GET /channels/:id/keys` returns both the server's `current_generation` and the
  current epoch's `epoch_generation`.
- When a member holding the current key sends a message and sees
  `current_generation != epoch_generation`, the client **rotates**: it generates
  a fresh channel key, wraps it only for the *current* member set, and publishes
  it as `epoch + 1`. A removed member — whose keys were deleted and who is not in
  the new wrap set — cannot read anything from the new epoch (forward secrecy).
  Continuing members keep the old epoch keys, so history stays readable.

Remaining limitations:

- A new member can only read messages from the epoch they were wrapped a key for
  onward; historical epochs are not back-wrapped to them (by design — they
  weren't present). Sharing history to new joiners is future work.
- Bootstrap/rotation has a benign race if two holders act simultaneously;
  last-writer-wins per recipient for that epoch. Server-assigned epochs would
  remove the race.

## Cryptographic primitives

| Purpose            | Primitive                                   |
|--------------------|---------------------------------------------|
| Key agreement      | X25519 (`@noble/curves`)                    |
| Identity KDF       | PBKDF2-SHA256, 210k iterations              |
| Key derivation     | HKDF-SHA256 (`@noble/hashes`)               |
| Symmetric cipher   | AES-256-GCM (Web Crypto)                     |

Round-trip and negative tests live in `frontend/src/tests/e2ee.test.ts`.
