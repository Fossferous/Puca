# Privacy statement

What Púca collects, what the person running your server can see, and which
third parties the apps talk to. This is written against the code as shipped;
where a claim has a source, it is named so you can check it.

## No telemetry, no analytics

Neither the apps nor the server contain an analytics, crash-reporting or usage
library, and nothing reports to the project's developers. The one third-party
component that would phone home by default — the Capgo updater plugin used
for Android OTA updates — is configured with an empty `statsUrl`, which
disables its reporting entirely (`frontend/capacitor.config.ts`). There is no
account with the project: your account exists only on the server you joined.

## What the server operator can see

The server is run by whoever invited you, and it necessarily sees:

- your username, display name, avatar, and any email address you give it
  (avatars, server icons, custom emoji and notification sounds are stored as
  ordinary images and audio, not encrypted);
- which servers and channels you are a member of, your roles, who you are
  friends with, whom you have blocked;
- who talks to whom and when: the timing and size of every message and
  attachment, presence (online/offline), voice-channel joins and leaves,
  typing indicators;
- your IP address, at the reverse proxy and at the backend (used for rate
  limiting), and the identifiers of any phone registered for wake signals;
- the ciphertext of everything below — which it cannot read.

## What the server operator cannot read

Messages, direct messages, attachments and checklist content are encrypted on
your device before they are sent, under keys derived from a seed only your
devices hold (`docs/E2EE.md`, `docs/SECURITY_MODEL.md` §3). Voice, video and
screen-share frames are encrypted end to end as well, on the peer-to-peer
path and through the optional SFU, which forwards ciphertext (§4 of the
security model). Firefox, Safari and iOS cannot encrypt call media frame by
frame. The app does not silently downgrade them: it says so before you join
and blocks the call's media, unless you choose to allow transport-only calls
in Settings → Privacy & Safety. Remote-control input between your own
devices is encrypted the same way. The operator can deny you service, delete
things, or impersonate you *to the server* — the security model spells out
that limit — but cannot read content.

## Who else the apps contact

- **Your operator's servers only, for the app itself:** the API and
  WebSocket, the download host for update checks (desktop `latest.json` and
  `/app-version`, Android `/api/mobile-updates/check`), the TURN relay and,
  where deployed, the SFU. The update endpoints are compiled in at build time
  by the person who built your app; there is no central update server.
- **STUN, for address discovery in calls.** Every call starts by asking a
  STUN server "what is my public address?", which tells that server your IP
  and the timing of the call setup — never any media, never who you are
  calling. When the operator runs their own TURN relay it is used for STUN
  too and nothing leaves their infrastructure. Only on a deployment with
  **no** relay configured does the server hand out Google's public STUN
  servers as a last resort (`.env.example`, `STUN_SERVERS`). The app itself
  has no built-in STUN list: if the server's ICE configuration cannot be
  fetched it contacts nobody (`frontend/src/api/rtc/config.ts`).
- **Google (Firebase Cloud Messaging), only if your operator enabled wake
  signals for Android.** The message that crosses Google is the constant
  `{"w":"1"}` plus your device's push token — its entire body is pinned by
  the server's test suite — so Google learns that *a* wake was sent to *a*
  device and when, never a sender, a channel or content. Delivery itself
  happens over the app's own socket to your operator's server.
- **Sites you paste links to.** An image or GIF URL in a message is loaded by
  your device directly from that site, which then sees your IP like any web
  page would. Nothing else is fetched from outside your operator's hosts:
  fonts, emoji and the noise-suppression models are bundled with the app.

## Retention and deletion

- Deleting your account tombstones it: identifying fields are cleared, every
  session is revoked, memberships, friendships, device tokens and wrapped
  keys are removed. Your messages stay, as ciphertext attributed to the
  tombstone, because they are other people's conversations too; the files
  you uploaded are removed after a grace period the operator configures
  (30 days by default, `DELETED_ACCOUNT_FILE_GRACE_DAYS`). The exact list is
  in `docs/SECURITY_MODEL.md` §11.
- Moderation reports and the audit log are pruned on operator-configured
  windows (`REPORTS_RETENTION_DAYS`, `AUDIT_RETENTION_DAYS`); clips on
  `CLIP_RETENTION_DAYS`, which the app shows you.
- Backups are the operator's: the recommended setup encrypts any copy that
  leaves the server to a key kept off it (`deploy/ops/README.md`).

## Logs

The reverse proxy in front of the server logs client IPs and request paths
the way any web server does. Since 0.9.1 the app never puts your session
token in a URL, so it cannot land in those logs. The backend logs at the
level the operator sets (`RUST_LOG`); it does not log message bodies, which
it could not read in any case.
