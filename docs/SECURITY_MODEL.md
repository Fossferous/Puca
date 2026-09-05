# Púca security model: what it protects, and what it does not

You have read access to this repository. This document exists so you can use it.

Every claim below carries a `file:line` reference and, where possible, a command you can
run yourself. Where the answer is unflattering, it is written down as plainly as the
answers that aren't — because you can check, and anything omitted here would read as
concealment when you found it.

Two things this document will not do: it will not tell you the software is safe, and it
will not tell you a closed-source competitor is bad. Both would be easy to write and neither would survive
you reading the code.

Verified against the tree you are reading. Pinning a version number here would go stale
the next time anything ships — as it already did once — so the commands below are the
claim, not the numbers beside them. Re-run them; they are cheap.

**Why the history starts at a single commit.** The published history begins with one root
commit, on purpose — anything after it is ordinary development you can review normally.
What preceded that root commit was the private development of one person's own deployment, and
it named their servers, containers and home network throughout. Publishing a redacted
history would ask you to trust that every redaction pass caught everything. So the tree is
published and the history is not. That costs you the ability to review the change history —
which is a real loss, and is exactly the kind of thing this document exists to state
plainly rather than let you discover. Every claim below is about code you can read now.

---

## 1. What you are actually being asked to trust

Not one thing. Three, and they fail independently:

| # | You are trusting | What it means if it's wrong |
|---|---|---|
| 1 | **The person running the server** | They see all metadata, can impersonate any account, and can serve you a malicious *web* client. They cannot read properly-encrypted content, and cannot take over your machine. |
| 2 | **The binary you install** | The desktop app is built on one person's Windows machine, is not reproducible, and is not code-signed. If that build is bad, nothing else in this document matters. |
| 3 | **This code** | One author, no second reviewer, and no external audit. |

Most of the reassuring facts in this document are about **#1**. They are cryptographic and
they hold. Almost none of them help with **#2** or **#3**, which are trust decisions about
a person and a process, not about mathematics.

Self-hosting **relocates** trust. It does not remove it. With a hosted closed-source tool you
trust a vendor's PKI, which you cannot inspect. Here you trust whoever runs the server and builds
the installer — and you *can* inspect that. That is the actual trade, stated honestly.

---

## 2. What the server operator can see

### Cannot read

Message and DM bodies, attachments, and voice/screen media, **provided they were encrypted
by a real client** (see §3 and §4 for what that proviso is doing).

### Can see, unavoidably

- Who talks to whom, and when
- Message sizes and timing; channel membership; epoch numbers
- Presence/online state, voice-channel join and leave events
- IP addresses and device tokens

  This used to say the session token lands in every proxy access log too, because
  the WebSocket carried it in the query string. It no longer does: every client —
  browser, desktop, mobile, and both background services — now sends it in
  `Sec-WebSocket-Protocol` as `bearer, <jwt>`, which no proxy on this path logs
  by default (`bearer_from_subprotocol`, [`src/ws.rs`](../src/ws.rs)). Since
  0.9.1 the server REFUSES a token in the query string outright (an install
  older than 0.9.0 must update), so nothing new can land in a log this way.
  Existing log files, of course, still contain what they already captured.

### Can do

**Mint a valid session token for any user, at any time.** The JWT is a symmetric HMAC; the
party that verifies is the party that can sign, and the operator holds the secret
([`src/ws.rs:50`](../src/ws.rs#L50), secret loaded at `src/main.rs:184`). The only
additional check is `token_version`, a plain integer in their own database
([`src/auth.rs:157`](../src/auth.rs#L157)).

This does not give them your keys — the identity seed is stored only wrapped
(§7) — but it does mean **any username you see could have been chosen by the operator**.
That matters most in §5.

---

## 3. Is chat encrypted?

Yes, and the send path fails closed rather than falling back to plaintext.

- **DMs:** X25519 ECDH → HKDF-SHA256 (`sovereign-dm-v2`) → AES-256-GCM with a fresh
  12-byte random nonce ([`e2ee.ts:265`](../frontend/src/api/e2ee.ts#L265)).
- **Channels:** a random 32-byte group key per epoch, wrapped per member client-side. The
  server stores only wrapped blobs and never holds an unwrapped channel key
  (`migrations/014_e2ee_channel_keys.sql`, `src/key_handlers.rs`).
- **Attachments:** separately AES-256-GCM encrypted under a per-file key carried inside the
  already-encrypted message.
- **Fail-closed:** if the key isn't available the client throws rather than sending
  ([`servers.ts:420`](../frontend/src/api/servers.ts#L420),
  [`dms.ts:150`](../frontend/src/api/dms.ts#L150)). Edits go through the same path.

Cryptographic primitives come from `@noble/curves`, `@noble/hashes`, `@scure/bip39` and the
browser's WebCrypto — not home-made.

### The honest limit

**The server does not enforce this; the client is what tells you.**

All three write paths bind the client's string verbatim (`src/message_handlers.rs:200`,
`src/dm_handlers.rs:493`, `src/ws.rs:2612`) with no envelope validation, and `key_epoch`
is a client-supplied nullable integer documented as "None = plaintext". That is not a gap
the server could close: the attacker in this section *is* the server, and a server
validating its own writes proves nothing to you.

So: **confidentiality of real ciphertext is structural** — the operator genuinely cannot
read it, because they never hold an unwrapped key. But **the guarantee that what you are
reading was ever encrypted is client-side only.** Content that is not a recognised
envelope is returned as ordinary text, and the client marks it: every such row — in
channels and DMs, live and from history — carries a visible **"Not encrypted"** tag
(`NotEncryptedBadge` in `frontend/src/components/Chat.tsx`, driven by `messageEncState`),
so a plaintext message an operator injected is distinguishable from a decrypted one.
What the client does not do is refuse to show it: pre-E2EE history consists of exactly
such rows, and hiding them would hide real messages. An injected plaintext message is
therefore *labelled*, not *blocked*, and the label is only as trustworthy as the client
you are running.

> **And "they never hold an unwrapped key" was not always true.** The 2026-08-20 audit
> found that the client accepted a wrapped channel key from any user id the server put on
> the row, pinning it on the spot — so an operator could attribute a key of their own
> choosing to an invented account and the client would encrypt every later message under
> it. No member's private key required, effective against desktop users, repeatable
> forever, and visible to nobody. It is fixed: a wrapper now has to be you, or an id the
> server also publishes as a member of that channel under the same key. What is NOT fixed,
> because it cannot be without out-of-band verification, is an operator who forges the
> membership list itself — that still yields the group key, but it now requires putting a
> stranger in the member list where you can see them. Compare safety numbers if that
> matters to you. This is the kind of thing this document exists to tell you about.

---

## 4. Is voice (and screen share) encrypted?

Yes — and this is the one place where **you should change a setting**.

Voice and screen share are mesh peer-to-peer WebRTC by default, with frames encrypted
AES-256-GCM over Insertable Streams
([`mediaCrypto.ts`](../frontend/src/api/rtc/mediaCrypto.ts)). The server and any TURN relay
see ciphertext they have no key for. The LiveKit SFU is opt-in per channel (`sfu_mode`
defaults `false`) and is fail-closed when used — no Insertable Streams support means no
call, never a plaintext one ([`sfuManager.ts:192`](../frontend/src/api/rtc/sfuManager.ts#L192)).

### The gap

**Enforcement is ON by default** since 0.8.130 — `requireMediaE2ee = true`
([`settingsStore.ts:120`](../frontend/src/components/settingsStore.ts#L120)), and a
one-time migration armed it for existing installs
([`settingsStore.ts` `migrateRequireMediaE2ee`](../frontend/src/components/settingsStore.ts)).
Read that migration before quoting the default at anyone: it deliberately does NOT arm
the setting on an engine that cannot satisfy it (Firefox, Safari, iOS, the WebKit desktop
shells), because doing so would have taken working calls away from those users for a
setting they never touched. So on those engines an upgraded profile keeps whatever it
had, while a fresh install gets the fail-closed default and is told before it joins.

The capability is advertised as a line in the SDP, which the server relays. If someone who
can terminate TLS *substitutes* that line, the tag check catches it and the call stays
transport-only with reason `verification-failed`. If they simply **delete** it, the code
takes the `!remote` branch ([`manager.ts:263`](../frontend/src/api/rtc/manager.ts#L263)) and
both ends fall back to plain DTLS-SRTP — at which point the same attacker can substitute
DTLS fingerprints and read the media.

**This is not silent.** The reason is surfaced in the voice panel
([`VoicePanel.tsx:2179`](../frontend/src/components/VoicePanel.tsx#L2179) via
`mediaE2eeExplanation`), so a downgraded call is visible if you look. But it is not
*refused*.

**Fix:** turn on **"Require encryption for calls"** — per-user in Settings, or server-wide
in Server Settings, where it is owner-only
([`ServerSettingsModal.tsx:311`](../frontend/src/components/ServerSettingsModal.tsx#L311)).
With it on, a peer that can't do E2EE is refused instead of downgraded. Ask for it to be on
server-wide before you join a call.

> **Correction (2026-08-20).** That sentence was true only for a *remote* peer. If **your
> own** browser lacked the WebRTC Encoded Transform API — Safari, iOS, Firefox, and the
> macOS/Linux WebView builds — the setting did **nothing**: enforcement lives inside the
> encrypt/decrypt transforms, and those never attach when the API is missing, so media flowed
> in the clear while the UI told you it was blocked. Fixed by making both directions fail
> closed (audit finding H-3; the full write-up is withheld for now — see the README for why
> and for the condition that releases it). Two things follow for you as a
> reader: check which release you are on, and note that the advice this page previously gave
> — "use the desktop app" — is **wrong on macOS and Linux**, whose builds use WKWebView and
> WebKitGTK and hit exactly the same gap. On those platforms, and on any browser other than
> a Chromium one, verify the call reports *Encrypted* rather than assuming the setting did it.

---

## 5. The remote-control agent

This is the real question, so it gets the most space.

**Yes, the installer ships a remote-control agent.** `puca-agent.exe` is a Tauri
sidecar ([`tauri.conf.json:49`](../frontend/src-tauri/tauri.conf.json#L49)) installed next
to the app. There is no opt-out at install time. Windows only — on macOS/Linux it is inert.

Now, what it can and cannot do.

### It cannot log your keystrokes

The agent can **inject** input; it has no ability to **intercept** it. There is not a single
input hook in it:

```bash
rg -c 'SetWindowsHookEx|WH_KEYBOARD|WH_MOUSE|RegisterRawInput' crates/puca-agent/src/ crates/puca-input/src/
```

Returns nothing. (Low-level hooks do exist — in the *app* process, `frontend/src-tauri/src/hotkeys.rs` —
serving push-to-talk and the remote-control kill switch.)

### The agent is dormant, and it cannot survive you closing the app

- **No scheduled task, and no Windows service unless you install one yourself.** This bullet
  used to say a LocalSystem service existed in the tree but was "unshipped and unreachable —
  not in `externalBin`, and referenced by zero lines of app code". That is no longer true, and
  correcting it matters more than the reassurance it gave: `puca-service` ships as a
  bundled binary (`externalBin` in `tauri.conf.json`) and the app links and calls it
  (`src-tauri/Cargo.toml`, `src-tauri/src/lock_screen.rs`). Same rule as the Run key below — a
  sentence that loses to one command costs more trust than the thing it was denying, and the
  command here is `sc query SovereignRemote` — the service keeps its original
  registration name, because renaming it would orphan every already-installed copy.

  What is still true is the part that actually matters: **installing Púca registers
  nothing.** No service is created, nothing is written to Program Files, and no elevation
  prompt is raised unless you turn on "Let me reach this computer's lock screen" in Devices,
  which states what it installs *before* you agree. If you do turn it on, it runs as
  LocalSystem and starts with Windows — that is the whole point, since the lock and sign-in
  screens are deliberately out of reach of anything less — but it supervises a capture agent
  **only while the machine is locked or nobody is signed in**, and it holds **no network
  connection at all** while you are signed in and unlocked
  ([`supervisor.rs`](../crates/puca-service/src/supervisor.rs), `desired()`/`wants_link()`).
  Two further switches are off by default on top of that: whether the machine is reachable at
  all (enrolled), and whether a passphrase may authorise a session (armed). Remove it by
  unticking the box, or from `services.msc`, independently of the app.
- **One Run-key entry, and only if you asked for it.** Turning on "Start Púca when you
  sign in to this computer" writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` —
  per-user, no admin rights, removable by unticking the box or by deleting that value.
  Verified present on the author's own machine as `Púca : ...\app.exe --hidden`, which
  is why this bullet no longer claims there is none: this page is meant to survive someone
  running `reg query`, and a sentence that loses to one command costs more trust than the
  entry itself. It starts the APP, never the agent — the app's agent has no persistence
  mechanism of any kind.
- **No listening TCP socket.** `rg -c TcpListener crates/puca-agent/src/` → 0. Its only
  endpoint is a Windows named pipe with SDDL `D:(A;;GA;;;OW)(A;;GA;;;SY)` — owner and SYSTEM
  only, not "everyone" ([`pipe.rs:34`](../crates/puca-agent/src/pipe.rs#L34)) — gated by
  a 24-byte random per-launch token.
- **It dies with the app**, both by explicit kill on exit and by a parent-process watchdog.
  (The one exception is the separate SYSTEM-flavour agent the lock-screen service starts if
  you installed it — a different process with a different lifecycle, described in the first
  bullet, and one that runs only while the machine is locked or signed out.)
- Idle, it holds zero captures and zero sessions and is not authenticated.

It starts when you open the Devices tab, or when a connect request arrives from one of your
*own* already-paired devices. Starting is not capturing: capture requires the gates below.

### Nobody else can control your machine

- **Another user cannot — unless you explicitly shared the device with them.**
  The device lookup is scoped in SQL: your own live device, OR a device whose
  owner holds an *accepted, host-device-signed, un-revoked* share naming the
  caller as grantee (the `device_share_invites` join in the `DeviceConnect`
  handler, `src/ws.rs`). The share state is re-read fresh on every connect, so
  a revoked share cannot be replayed back to life. That grant is not a server
  row taken on faith: it exists only after a mutual-consent flow (you invite,
  they accept), it is signed by the **host device's own key** — which never
  leaves that machine and is not derivable from any password, so neither the
  server nor a password thief can mint one — and the host re-verifies the
  signature, the capabilities, and the connecting device's enrolment record
  (against the friend's TOFU-pinned account signing key,
  `users.account_sign_pub`) before accepting anything. A user you never shared
  with is exactly where they were before this feature existed: their probe
  never even resolves the device row, and the refusal is indistinguishable
  from "no such device".
- **The server operator cannot**, even with root and full database write. This was tested
  against eight separate attack paths. They can mint a JWT, insert a devices row with their
  own keypair, and pass every server-side gate — and then your machine refuses them, because
  a controller's key is only accepted from an enrolment record whose signature verifies
  under an account key your client derives from *its own* seed, which the server never holds
  ([`peerKeys.ts:78`](../frontend/src/api/devices/peerKeys.ts#L78),
  [`session.ts:1428`](../frontend/src/api/devices/session.ts#L1428)).
  Flipping the `host_enabled` database column doesn't help them either — the client reads
  armed state from a local file, not from the server.
- **The signalling is sealed**, so the operator cannot MITM the WebRTC handshake to watch
  your screen: every signal frame is AES-GCM sealed under a key derived from that verified
  device key, with no unsealed fallback.

### Screen-share control needs your click, every time

Separate, older feature: someone watching your screen share in a voice channel can request
mouse/keyboard control.

- **Default deny.** `state.controlledBy` is only ever set inside the "Allow control" handler.
  There is no auto-accept setting anywhere (`rg 'autoAccept|allowRemoteControl'` → nothing).
- Auto-denies after 45s unanswered; repeated denials enter a growing cooldown.
- Requires you to be actively sharing, on the desktop app, with E2EE handshake material.
- **Revocable six ways** — Stop button, Esc, a configurable kill key, a native low-level
  hook that works even when a game has focus, partner disconnect, and a 90s inactivity
  timeout. Teardown releases every held key so nothing sticks down.
- **The server cannot read the input.** It relays an opaque AES-256-GCM blob it has no key
  for — [`src/ws.rs:2774`](../src/ws.rs#L2774) moves `event` through untouched, and the
  header above it calls itself a dumb pipe. Forged frames fail GCM and are dropped.

### What is genuinely against you here

1. **The name in the consent prompt is not trustworthy.** `from_username` is stamped by the
   server from the authenticated connection ([`src/ws.rs:2512`](../src/ws.rs#L2512)) — so
   another *user* cannot spoof it, but the *operator* can mint a token bearing any username
   (§2). The cryptographic gates hold; the human one becomes a judgement call about a name
   the server chose.
2. **Granted control is whole-desktop, not window-scoped.** Once you click Allow, the
   controller can alt-tab out of the shared game and act anywhere — absolute mouse moves
   span the virtual desktop and keystrokes go to whatever has focus. Limited only by
   Windows UIPI (no elevated windows, no UAC prompt, no lock screen) and by your revoking
   it. Revoke-on-any-physical-input exists but is **off by default**.
3. **Unattended access, if you ever turn it on, has no password-distinctness check.** The
   only rule is 8 characters ([`unattendedHost.ts:53`](../frontend/src/api/devices/unattendedHost.ts#L53)).
   If you reuse your account password there, someone who phishes that password gets silent
   unattended control — and an armed host deliberately does not prompt, with only a tray
   tooltip as indicator. **Default is off; if you arm it, use a different passphrase.**
   (The mechanism itself is sound: Argon2id-derived Ed25519, the host stores only a salt and
   a *public* key, and the server is never consulted and cannot influence the result.)
4. **Use the desktop app, not the web app.** The desktop build loads bundled local assets
   and verifies updates against a pinned minisign key, so a malicious server cannot backdoor
   it. In a browser, the server serves the code that does your encryption — a hostile
   operator there is total compromise, and no amount of cryptography in this repo changes
   that.

---

## 6. Attack scenarios, worked

Four adversaries, run against the actual code. The ones that **failed** are listed too —
they're what make the rest credible.

| Adversary | Goal | Result |
|---|---|---|
| Server operator (root + DB + modified backend) | Open a control session on your machine | **Blocked** — enrolment signature verified under a key derived from your seed |
| Server operator | Flip DB columns to mark your machine "armed" so it skips consent | **Blocked** — armed state is read from a local file; DB columns are decorative |
| Server operator | MITM the WebRTC handshake to watch your screen | **Blocked** — signalling is sealed, no unsealed fallback |
| Server operator | Serve a backdoored client to your desktop app | **Blocked** — bundled assets, minisign-pinned updater |
| Server operator | Serve a backdoored client to your *browser* | **Reachable — total compromise.** Use the desktop app |
| Server operator | Impersonate a trusted name in your consent prompt | **Reachable** — see §5 |
| Ordinary user on the server | Reach your machine via My Devices | **Blocked** — same-user SQL scoping, unless you granted them a device share (mutual accept + host-device-signed, instantly revocable) |
| A friend you shared a device with | Exceed the share (input on view-only, files without the files capability, your other devices) | **Blocked** — capabilities are in the host-signed grant and enforced by both the host client and the server relay; the share names ONE device and cannot list the rest |
| Ordinary user | Inject input while you share your screen, without your click | **Blocked** — fails closed with no pairwise key |
| Ordinary user | Spoof the requester name to social-engineer your click | **Blocked** — server stamps the real username |
| Ordinary user | Ask nicely, then alt-tab out of the game once granted | **Reachable** — social, not technical. See §5 |
| Network attacker on a relay/TURN hop | Read your screen or keystrokes | **Blocked** — DTLS-SRTP / sealed signalling |
| Network attacker who can terminate TLS | Strip the media-E2EE line and MITM voice | **Reachable while enforcement is off** — see §4 |
| Network attacker who can terminate TLS | Substitute an identity key on *first contact* | **Reachable once per peer** (trust-on-first-use); fails closed after |
| Someone with your password | Enrol a new device on your account | **Reachable** — no second factor on enrolment |
| Someone with your password | Control your machine from that device | **Blocked** — needs your click at the keyboard, or the separate unattended passphrase |

---

## 7. Your password is the root of everything

Worth understanding before you decide.

Your identity seed is stored on the server wrapped under a password-derived key (Argon2id,
m=19456 KiB, t=2, p=1) and under a recovery-phrase key. The server never sees the seed or
either wrapping key.

**The same database row holds the SRP verifier.** Until 0.9.3 SRP applied no stretching at
all: `x = SHA-256(salt ‖ SHA-256(username:password))`, two SHA-256 calls, so an attacker
with a database dump attacked the verifier at roughly one hash per guess — about four
orders of magnitude cheaper than the Argon2id blob beside it. Since 0.9.3 the verifier is
derived at the same Argon2id cost (`x = Argon2id(password, salt ‖ username)`, m=19456 KiB,
t=2, p=1): every new registration, password change and reset uses it, and an existing
account is moved across inside its first successful sign-in from a current client. The
server records which derivation each account uses (`srp_version`) and cannot perform the
move itself, because it never sees the password. **An account whose owner has not signed in
since the upgrade still carries the SHA-256 verifier**, and a database dump taken before
then is attackable at the old rate regardless.

Practically: **seed confidentiality against a database thief reduces to your password
strength.** And the decrypted seed sits in `localStorage` on your device, described in the
code as password-equivalent.

### What the seed no longer unlocks: direct messages sealed as v4 (0.9.3)

Until 0.9.3 every DM was sealed under a key derived from the two long-term identity keys,
and those derive from the seed — so recovering the seed (a cracked password, above)
recovered every DM the account ever exchanged. **v4 changes what the seed can reach.** Each
direct message is sealed under a fresh random key, and that key is wrapped only to:

- the **session keys** of each side's signed-in devices — an X25519 key a client mints
  for its session, keeps private on that device, and publishes against its server
  session (`token_sessions.dm_pubkey`); a new sign-in mints a new one, revoking the
  session retires it;
- each account's **history key** — its private half wrapped under the 12-word recovery
  code and under nothing else (`users.history_wrapped_rc`).

None of those derive from the password. **A database copy plus a cracked password reads no
v4 message.** What it does read: v2/v3 history (already stored, cannot be re-sealed
without every device re-encrypting it — an optional later migration), and anything a
device with a stolen session key was sent during that session. This is not per-message
ratcheting: a session key opens whatever was wrapped to it while the session lived. The
recovery code is the root secret by design — someone holding it reads everything, as they
could already reset the password.

Sender authentication does not come from the body key any more (it is random), so a
server holding the public session keys could forge an envelope. Every v4 envelope carries
an HMAC under a key derived from the pairwise identity DH — the same pinned identity keys
v3 relied on — over the whole sealed record, wraps included: nothing can be added,
removed or re-pointed. Either party can compute it (no non-repudiation, as before).

**What a user sees.** A device signed in with only the password receives new v4 messages
normally (they are wrapped to its session key) and shows older v4 messages as locked until
the recovery code is entered on that device — once, kept locally. Regenerating the recovery
code re-wraps the history key under the new code; a client from before 0.9.3 is refused
that operation by the server, because a code that cannot open the history key would lock
every v4 message for good. Accounts from before 0.9.3 have no history key until their
owner regenerates the recovery code from a current client; until both sides of a
conversation have one, and every recently-seen session on both sides can read v4, the
conversation stays on v3 — nothing an existing install has can be sent a message it cannot
open. A session not seen for fourteen days is not counted; its owner, returning with a
pre-0.9.3 client, sees v4 rows as "update the app".

**One consequence to know before upgrading (0.9.3, SEC-01).** The first sign-in from a
current client replaces the SHA-256 SRP verifier with an Argon2id one. Clients that are
already signed in keep working; a client from before 0.9.3 can no longer make a *fresh*
sign-in to that account until it updates — it derives the old verifier and cannot prove the
password. Desktop auto-updates and the mobile bundle updates over the air, so this reaches
only an install that has neither.

Use a long, unique password here. It is doing more work than passwords usually do.

---

## 8. On the code being AI-written

Provenance isn't a useful axis. "Written by a person" is not a security property — plenty
of hand-written remote-access software has been catastrophic. The useful axes are **whether
it's reviewed** and **whether you can check it**. Here are the real numbers.

Reproduce them:

```bash
rg -t rust --no-filename -o '#\[(tokio::)?test\]' | wc -l          # 794
rg --files -g '*.test.ts' -g '*.test.tsx' frontend/src/ | wc -l    # 182
grep -c 'run: cargo test --workspace' .github/workflows/tests.yml   # 2  <-- the important one
rg -t rust --no-filename -o '\bunsafe\b' src/ tests/ | wc -l       # 0   (backend)
rg -t rust --no-filename -o '\bunsafe\b' crates/ frontend/src-tauri/src/ | wc -l   # 260
git log --format='%an' | sort | uniq -c                            # 1 author (see the note at the top)
```

| | |
|---|---|
| Rust test functions | **782** (src 145, tests 17, crates 522, src-tauri 98) |
| …that CI actually runs | **163** |
| Frontend tests | **176** files, **1714** cases, 0 skipped |
| e2e scripts / run in CI | **49** / **1** |
| CI backend database | real Postgres 16 container; actions pinned by commit SHA |
| `unsafe` blocks | **252** — all in the Windows desktop/capture/agent layer; **zero** in the backend |

### Read that table adversarially, because it deserves it

**This used to be the worst line in the document, and it is worth reading what it said.**
Until 2026-09-03: *"782 tests is only honest if you immediately say 'of which CI runs 163.'
The root `Cargo.toml` has no `[workspace]` section... 619 Rust tests are never built in CI.
And those 619 uncompiled tests and the 252 `unsafe` blocks are largely the same code — the
screen-capture and input-injection layer, which is precisely the part you care about."*

That is fixed. The root `Cargo.toml` is a workspace over `crates/*`, and CI runs
`cargo test --workspace --exclude puca` on **two** runners — Linux and Windows — plus the
desktop shell's own suite by manifest path. Two runners because roughly half of that code
is `#[cfg(windows)]`: a Linux-only job would have gone green having never compiled the
capture and injection layer, which is a worse lie than no job at all.

Verify it rather than believing it — the commands below print the counts, and check 7 in
the audit section shows CI passing `--workspace`. What has NOT changed: tests needing real
hardware still carry `#[ignore]`, so a headless runner skips them, and no CI runner has a
GPU or a physical display. Read `#[ignore]` as "a human has to run this".

Note the direction of travel: at v0.8.41 this said 418 tests / 92 in CI / 112 `unsafe`.
Every one of those numbers has roughly doubled, and **the untested-and-`unsafe` gap grew
faster than the tested part did**. The counts are re-measured per revision; the structural
problem behind them has not been fixed.

Other things you'd find anyway:

- **41 of the 42 e2e scripts are manual harnesses**, needing a hand-started backend and real
  audio/video hardware. Evidence of investigation, not regression protection.
- **No CI job builds the Windows installer.** The binary you'd install is an unreproducible
  local build from one machine, and it is **not code-signed** — you'd be clicking through a
  SmartScreen warning. **And it has been quarantined as malware**: Defender flagged v0.8.82
  as `Trojan:Win32/Bearfoos.B!ml` on a user's machine and closed the app. That is a
  behavioural ML detection reacting to things the remote-access agent genuinely does —
  SYSTEM-service persistence, screen capture with no on-screen indicator, synthetic input
  injection, autonomous network egress. The verdict on intent is wrong; the description of
  the behaviour is not. If you are weighing whether to trust this build, "an unsigned binary
  that does all of that" is the accurate framing, and no amount of documentation substitutes
  for a code-signing certificate this project has chosen not to buy.
- **This project's verification scaffolding has been silently broken before**, by its own
  account: `npx tsc --noEmit` was checking an empty program and always exiting 0, and a CI
  branch filter meant 309 commits shipped without CI ever running. Both are documented in
  `CLAUDE.md`. A "the tests pass" reassurance from this repo has been worth nothing before.
- **Hand-rolled protocol code**, and this is the honest core of the objection: SRP-6a
  reimplemented in TypeScript (including its own variable-time `modPow`) and matched to the
  Rust crate "empirically", with **no test vector**; an 864-line TURN client; a 512-line
  STUN gatherer; the media-frame AEAD envelope; a bespoke control-channel handshake that is
  neither Noise nor X3DH. **Only 2 of roughly 8 such constructions have known-answer tests.**
  This subsystem has already produced one full authentication bypass — found, fixed, and
  written up, but produced.
- **Nothing scans dependencies.** A `cargo-audit` config exists; no CI step, npm audit,
  dependabot or renovate ever runs it.
- **Bus factor 1.** One author, no second reviewer, and no outside audit has ever been
  performed. The source is now public, so one is at least *possible* — but
  "auditable" and "audited" are different words, and only the first one is true here.

### What's fair on the other side

The backend has **zero** `unsafe`. Cryptographic primitives are `@noble` / WebCrypto /
`dalek`, not home-made. The security-policy modules have genuinely adversarial tests —
including one that fails if anyone adds an input-injection verb to the service protocol.
The authorisation design deliberately puts the load-bearing check on the client using key
material the server cannot obtain, which is the correct place for it, and it survived eight
attacks. And the failure modes throughout are fail-closed, not fail-open.

---

## 9. On centralized, closed-source remote-access tools

Not a hit piece against any specific vendor. Modern commercial remote-access software
generally has competent cryptography — mutually authenticated TLS with strong ciphers is
standard, and reputable vendors document a user-checkable connection fingerprint (the same
construction as an SSH host key), which would detect key substitution if you actually use it.

The differences that are actually load-bearing, for the category as a whole, not any one
product:

- **A vendor-operated master cluster is typically a mandatory trust anchor.** It issues the
  certificates both endpoints check, and it is usually distinct from the (sometimes
  independently-audited) session-routing infrastructure — a disclaimer that exonerates
  routing servers says nothing about the certificate authority behind them. It is common for
  a large share of sessions to relay through vendor infrastructure by default.
- **The client is typically closed source, not reproducibly built, and auto-updates
  silently.** Published independent audits of the cryptography are the exception, not the
  rule. This class of software has a real history of shared-secret and hardcoded-key
  incidents — a single embedded key common to every installation, discovered years after
  shipping, is not a hypothetical failure mode for centralized remote-access tools.
- **You cannot check any of it.** You can check all of this.

Which is the whole argument, and it is not a claim that this software is categorically
better than any specific alternative. It's a claim about what kind of trust each model
asks for.

---

## 10. If you want to check this yourself

Highest value first.

```bash
# 1. Can the agent log keystrokes?
#    Expect: no output at all, exit code 1 (ripgrep's "no matches").
rg -c 'SetWindowsHookEx|WH_KEYBOARD|WH_MOUSE|RegisterRawInput' crates/puca-agent/src/ crates/puca-input/src/

# 2. Does the agent listen on the network? Same: no output, exit 1.
rg -c 'TcpListener' crates/puca-agent/src/

# 3. Can another user reach your machine? Every device lookup is scoped to the
#    owning user id; there is no query that finds a device without one.
rg -n -A3 'FROM devices' src/ws.rs

# 4. Does the server see your keystrokes during remote control? Read the relay.
rg -n -A12 'Remote-control relay' src/ws.rs

# 5. What stops a malicious server from controlling your machine?
sed -n '70,82p' frontend/src/api/devices/peerKeys.ts
rg -n -B2 -A6 'enrolment record verified under the account signing key' \n  frontend/src/api/devices/session.ts

# 6. Is media E2EE enforced? (expect: false — then go turn it on)
rg -n 'requireMediaE2ee' frontend/src/api/rtc/manager.ts frontend/src/components/settingsStore.ts

# 7. Does CI actually run the crates' tests, or only the backend's?
#    (expect 2 → a Linux job and a Windows job both pass --workspace)
grep -c 'run: cargo test --workspace' .github/workflows/tests.yml
#    ...and the desktop shell, which is excluded from the workspace on purpose:
grep -c 'frontend/src-tauri/Cargo.toml' .github/workflows/tests.yml

# 8. Who wrote this?
git log --format='%an' | sort | uniq -c | sort -rn
```

If any of it doesn't say what this document says it says, that is a bug in this document.
Report it — it is the kind of error that matters most here.

---

## 11. What "delete my account" actually deletes

Deletion is a **tombstone**, not a `DELETE FROM users`. The row survives with
every identifying and cryptographic field cleared, because messages, tasks and
moderation records reference it by foreign key and a hard delete would either
fail or take other people's history with it. Concretely
(`delete_account`, `src/handlers.rs`), all inside one transaction:

**Cleared on your row.** Username becomes `deleted#<id>`; display name, avatar,
join/leave sounds, email, public key, both wrapped identity seeds and both KDF
salts are nulled; the SRP salt and verifier are replaced with fresh RANDOM bytes
(not zeroes — a zero verifier is forgeable); `deleted_at` is set and
`token_version` is bumped, which revokes every outstanding JWT. Every live
socket for the account is hung up after the commit.

**Deleted outright.** Push/device tokens, notification preferences, friends,
friend requests, blocks, role assignments, server memberships, per-server
nicknames, email-verification and password-reset tokens, cross-user device
shares in both directions, and your wrapped channel keys. The role and
membership rows matter more than they look: leaving them behind would silently
restore your old grants — an Admin role included — if the account ever rejoined.

**Kept, deliberately.**

- **Your messages and tasks**, as ciphertext attributed to the tombstone. They
  are other people's conversations too, and the server cannot read them to
  decide otherwise.
- **Your enrolled devices**, REVOKED rather than deleted, because device shares
  reference those rows and "a revoked device stays revoked" is what stops a
  machine that still holds its Ed25519 key from minting fresh account tokens.
  The user-chosen machine NAME and the encrypted LAN details are wiped; the
  public keys and platform remain.
- **Moderation records** — audit-log and report rows — with the actor
  anonymised rather than removed. Erasing them on request would let an account
  delete the record of what it did.

**Your uploaded files are kept for a grace period (30 days by default — `DELETED_ACCOUNT_FILE_GRACE_DAYS`), then purged.** Your avatar, sounds, clip parts and every attachment you uploaded are stamped
`purge_after = now + 30 days` when the account is deleted, and the retention
sweep removes the file and then the row once that passes. Until then they
still open for anyone who could open them before. The grace period exists
because attachment ids live inside other people's end-to-end encrypted
messages: the server cannot see which channel a file was shared in, so it
cannot warn anyone — the delay is the warning, and the deletion confirmation
says so. An operator can clear `purge_after` within the window to undo a
mistaken deletion's file loss; nothing else about the tombstone is reversible.
Server icons and custom emoji you uploaded are NOT purged: they belong to the
server now and its members still see them.

If that changes, it needs to change as a product decision with three parts: the
deletion confirmation must say what happens to files you shared, there should be
a grace period (mark for deletion, purge after N days) so an accidental deletion
is recoverable, and the release notes have to say so. Until then, the honest
statement is the one above: **your account becomes unusable and unidentifiable,
your files do not go away.**
