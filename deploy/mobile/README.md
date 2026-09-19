# Authenticated mobile OTA (Capgo public-key signing)

Mobile web-bundle updates are **signed** so a compromised download host cannot
push a *forged* update — the same authenticity guarantee the desktop updater
gets from minisign. This is self-hosted: no Capgo cloud.

**Authenticated, NOT confidential.** Capgo's scheme "encrypts" the bundle with
a key wrapped by the *public* key (embedded in every APK), so anyone with the
app can decrypt it — the AES layer provides authenticity, not secrecy. Treat
OTA bundles as public: **never ship a secret (API token, private URL) in a web
bundle.**

## Residual risks (accepted)

- **Rollback / replay.** The signature covers the bundle *bytes*, not the
  advertised version. A host that serves the manifest can point a HIGHER
  version number at an OLD, still-validly-signed bundle, and the client will
  install it. Bound in practice by: the attacker needs to compromise the
  (self-hosted) host, and can only replay *past legitimate* releases, not
  inject new code. What the client does about it, honestly stated:
  - It compares every manifest against the version **compiled into the
    running bundle** (`__APP_VERSION__`), not against the label the manifest
    gave that bundle. Before 0.9.811 it recorded the label as "what I am
    running", so ONE mislabelled manifest — attack or a mistyped
    `dual-ship.sh mobile ... <version>` — made every genuine later release
    read as "already have it" and locked that phone out of OTA until an APK
    reinstall. A phone locked that way by the OLD code cannot be rescued by a
    new bundle: the old gate refuses it before the new code can run. Only a
    fresh APK recovers it.
  - It cannot stop the **first** replay: nothing in JavaScript can learn a
    bundle's true version before running it, and a replayed bundle from before
    this change runs its own, older gate, which still trusts the label. So a
    replay still lands and the "lock" above still happens for pre-0.9.811
    bundles. Do not describe the client check as prevention.
  - The check that actually prevents the accident is **publish-side**:
    `encrypt-bundle.mjs` writes the bundle's own version beside it
    (`<bundle>.version`, from the `version.json` every web build now emits)
    and `dual-ship.sh mobile` / `mobile-lite` REFUSE a manifest whose version
    differs from it. That runs on the operator's machine, where no OTA can
    replace it. Durable anti-replay against a hostile host would need the
    floor to live where the bundle swap cannot reach it — a native check in
    the APK before the WebView loads — which is future work, not something a
    web bundle can provide.
- **Key rotation is a flag day.** One embedded key, one global manifest, no
  key-id field: rotating the signing key (e.g. after a suspected compromise)
  strands whichever cohort's embedded key doesn't match until every client
  reinstalls the new APK. Same coordination as the initial transition.

## How it works

- An **RSA-2048 keypair** (PKCS#1 PEM). The **public** key is embedded in the
  app (`capacitor.config.ts` → `CapacitorUpdater.publicKey`, compiled into the
  APK). The **private** key is kept OFF-server at `~/.puca/mobile-updater-rsa.key`.
- Each bundle is **AES-128-CBC encrypted** with a random key+IV; that AES key is
  **RSA-private-encrypted** (the app public-decrypts it), and the bundle's
  **SHA-256 is RSA-signed** with the private key.
- The manifest carries `url` (encrypted zip), `sessionKey` (`base64(iv):base64(encKey)`),
  and `checksum` (RSA-signed SHA-256, hex). The native plugin decrypts the
  bundle, recovers the signed hash with the embedded public key, and **rejects**
  anything that doesn't decrypt/verify.
- Format verified against the plugin's real `CryptoCipher.java` (RSA/ECB/PKCS1,
  AES/CBC/PKCS5, PKCS#1 key) — see `encrypt-bundle.mjs`.

## Keys — CRITICAL

- `~/.puca/mobile-updater-rsa.key` (private) — **BACK THIS UP.** If lost, no
  new signed bundle can ever be produced and mobile OTA is stuck until a new APK
  ships (with a new key or none). Treat it like the Android keystore / Tauri
  updater key.
- `~/.puca/mobile-updater-rsa.pub` (public) — mirrored in `capacitor.config.ts`.
- Regenerate (only if starting fresh): `openssl genrsa -traditional -out
  mobile-updater-rsa.key 2048 && openssl rsa -in mobile-updater-rsa.key
  -RSAPublicKey_out -out mobile-updater-rsa.pub`.

## Rollout requirement (hard)

Once the public key is embedded, the plugin **refuses any bundle that isn't
validly signed.** Therefore:
- **Every** OTA bundle from now on MUST be encrypted with `encrypt-bundle.mjs`.
- OTA-only users on an older APK (no embedded key) **cannot consume encrypted
  bundles** — everyone must install the **new signed APK once** to make the
  transition. After that, OTA continues seamlessly.

## Publish steps

`deploy/ops/dual-ship.sh mobile <enc.zip> <version> <sessionKey> <checksum>`
uploads the bundle to every host, writes the manifest where the backend reads
it, and verifies through the endpoint. The bundle it uploads is renamed to
`<MOBILE_BUNDLE_PREFIX>-<version>.enc.zip` from `deploy/ops/hosts.conf`
(`puca-web` by default), so the local filename below does not matter — but
if you publish by hand, use that same prefix in the manifest URL or the two
paths produce different names for the same release.

```bash
cd frontend && npm run build
rm -rf ota-src && cp -r dist ota-src && rm -rf ota-src/notes && node scripts/cap-index-csp.mjs --index ota-src/index.html
                                                     # the rm is load-bearing: `cp -r` into an EXISTING
                                                     # ota-src nests dist/ inside it and leaves the
                                                     # previous release's index.html at the root, which
                                                     # the CSP step reports as "already present" (exit 0)
                                                     # and the zip below then ships under the new version.
                                                     # `rm -rf ota-src/notes` too: Púca Notes (dist/notes/)
                                                     # is a browser-only second page with no CSP meta of
                                                     # its own — the APK build strips it the same way
                                                     # (scripts/strip-notes-from-native.mjs)
( cd ota-src && zip -r ../puca-web-<ver>.zip . )     # plaintext bundle, WITH the Android CSP: the OTA
                                                     # replaces the APK's index.html, so a bundle zipped
                                                     # straight from dist/ would remove the policy
node deploy/mobile/encrypt-bundle.mjs \
    puca-web-<ver>.zip ~/.puca/mobile-updater-rsa.key \
    puca-web-<ver>.enc.zip ota-src/version.json       # prints {ivSessionKey, checksum}. The 4th
                                                     # argument is REQUIRED: it writes
                                                     # puca-web-<ver>.enc.zip.version, which
                                                     # dual-ship.sh checks the manifest version
                                                     # against and REFUSES on a mismatch, or when
                                                     # the sidecar is missing (see "Residual risks"
                                                     # for what a mismatch costs).
rm -rf ota-src                                       # disposable staging dir (also gitignored) — AFTER the
                                                     # signer has read ota-src/version.json from it. The signer
                                                     # also REFUSES a bundle that still carries notes/.
```

Upload the **`.enc.zip`** as the bundle, and write `mobile-update.json`:

```json
{
  "version": "<ver>",
  "url": "https://download.example.com/mobile/puca-web-<ver>.enc.zip",
  "sessionKey": "<ivSessionKey from the script>",
  "checksum": "<checksum from the script>",
  "notes": "..."
}
```

Older clients ignore `sessionKey`/`checksum`; new (public-key) clients require
and verify them.

## Where the manifest goes — BOTH places (this froze mobile for six releases)

There are two `mobile-update.json` paths on the container and they are NOT the
same file:

| Path | Served by | Who reads it |
|---|---|---|
| `/opt/puca/mobile-update.json` | the **backend**, at `GET /api/mobile-updates/check` | **the app** (`UpdateGate.tsx`) |
| `/opt/puca/downloads/mobile-update.json` | Caddy static, `download.example.com/mobile-update.json` | nothing — humans/debugging only |

`UpdateGate` fetches `${VITE_API_URL}/api/mobile-updates/check`, and the backend
resolves `MOBILE_UPDATE_FILE` (default `mobile-update.json`) **relative to its
working directory**, i.e. `/opt/puca/`. Publishing only under `downloads/`
therefore updates the copy nobody reads: the download host shows the new
version while every phone keeps being told the old one, with no error anywhere.
Found 2026-07-27 with the API endpoint still advertising **0.6.15** while
`downloads/` had been updated through 0.7.1 — six releases of mobile users
silently stranded on an old bundle.

Copy the manifest to both, then **verify the endpoint, not the file**:

```bash
curl -s https://chat.example.com/api/mobile-updates/check
```

If that does not report the version you just shipped, mobile did not ship.

## Púca Notes — its own channel, its own key

Púca Notes' Android app (`com.sovereign.notes`, `frontend/notes-app/`) updates
its web layer over the air too, from the first APK that carries the updater.
It is a different app, not a variant, so everything that could let one app's
bundle reach the other is separate:

| | Púca (full / lite) | Púca Notes |
|---|---|---|
| Asks | `/api/mobile-updates/check` (`?variant=lite`) | `/api/mobile-updates/check?variant=notes` |
| Manifest on the server | `mobile-update.json` / `mobile-update-lite.json` | `mobile-update-notes.json` (`MOBILE_UPDATE_FILE_NOTES`) |
| Accepts | untagged or `"full"` / exactly `"lite"` | exactly `"notes"` |
| Signing key | `mobile-updater-rsa.key` | `notes-updater-rsa.key` |
| Public key embedded in | `frontend/capacitor.config.ts` | `frontend/notes-app/capacitor.config.ts` |
| Bundle | `dist/` minus `notes/` + CSP | `dist-notes-app/` (native build, CSP injected) |
| Signer flag | none | `--notes` |
| Ship | `dual-ship.sh mobile` / `mobile-lite` | `dual-ship.sh mobile-notes` |

### Keys

- `notes-updater-rsa.key` (private) — in the same keys directory as Púca's,
  **backed up by `deploy/ops/backup-keys.sh`** (a missing one fails it). If lost,
  Notes OTA stops until a Notes APK embedding a new key ships. **Run
  `backup-keys.sh`, and move both bundles off the machine, BEFORE the first
  OTA-capable Notes APK is published**: from then on phones trust only this key.
- `notes-updater-rsa.pub` — mirrored into `frontend/notes-app/capacitor.config.ts`
  (`CapacitorUpdater.publicKey`). `scripts/check-lite-identity.mjs` fails if it
  ever equals Púca's key.
- Generate (only when starting fresh, never twice):
  `openssl genrsa -traditional -out notes-updater-rsa.key 2048 && openssl rsa -in
  notes-updater-rsa.key -RSAPublicKey_out -out notes-updater-rsa.pub`, then paste
  the `.pub` into the Notes config. Rotating it is the same flag day as Púca's.

### Publish steps, every release

```bash
cd frontend && node scripts/build-notes-app.mjs --ota
                         # native Notes build -> dist-notes-app/, CSP injected, then
                         # notes-ota/puca-notes-web-<ver>.zip (its CONTENTS, index.html
                         # at the root). Refuses without exactly one CSP meta or with a
                         # version.json that does not say "app": "notes".
cd ..
node deploy/mobile/encrypt-bundle.mjs --notes \
    frontend/notes-ota/puca-notes-web-<ver>.zip <keys dir>/notes-updater-rsa.key \
    frontend/notes-ota/puca-notes-web-<ver>.enc.zip frontend/dist-notes-app/version.json
                         # prints {ivSessionKey, checksum}; writes .version,
                         # .channel (= notes) and .native-min beside the bundle
deploy/ops/dual-ship.sh mobile-notes frontend/notes-ota/puca-notes-web-<ver>.enc.zip <ver> \
    <ivSessionKey> <checksum> [--native-version <v>] [--lower-native-min]
deploy/ops/dual-ship.sh apk-notes <Puca-Notes-<ver>.apk> <ver>   # every release too
```

`mobile-notes` refuses a bundle whose `.channel` is not `notes`, or that does
not verify under the key `frontend/notes-app/capacitor.config.ts` embeds
(`deploy/mobile/verify-bundle.mjs`), then writes `mobile-update-notes.json` and
demands `?variant=notes` answer the version AND `"variant": "notes"` on every
host — a backend from before the route answers with Púca's manifest, so **ship
the backend first**. It proves the full and lite endpoints did not change.
`mobile` and `mobile-lite` refuse a Notes bundle the same way.

`native.min`, the oldest Notes APK that can run this bundle, is NOT a flag: it
is `frontend/notes-app/native-min.json`, carried by the build's `version.json`
into the bundle's `.native-min` sidecar, and `mobile-notes` publishes it on
every release (older APKs then show *Install the new Púca Notes app*, linking
`https://<download host>/#notes-app`, instead of applying a bundle they cannot
run). Raise it in the file — to the release that first ships the plugin,
permission or manifest entry the web code needs — never on the command line.
`mobile-notes` refuses a floor newer than the release, and one lower than what
any host already serves unless `--lower-native-min` is passed (for a floor
raised by mistake). `--native-version <v>`: nudge (once per version) about a
newer APK; never newer than the release. Neither is signed — a hostile manifest
host could withhold updates or nag, not deliver an APK (Android refuses one
signed with another key).

**Existing installs need one manual install.** Notes APKs up to 0.9.815 carry
no updater; they update only by installing the first OTA-capable APK from the
download page.
