# Púca — working agreement

A self-hosted, end-to-end encrypted chat, voice and video platform. Rust/axum backend (`src/`), React+TS frontend
(`frontend/src/`), Tauri desktop shell (`frontend/src-tauri/`), Capacitor
mobile, PostgreSQL. Messages, DMs, attachments and SFU media are end-to-end
encrypted.

**THIS IS THE REPOSITORY TO WORK IN.** Development moved here from the old
`sovereign` checkout on 2026-08-25. Releases ship from this worktree — verified:
a clean clone of this tree byte-matches every migration recorded on both
production hosts, which is the gate `dual-ship.sh` enforces before it will
deploy a backend. The `sovereign` checkout still exists and is still private;
treat it as the archive it is becoming, not as somewhere to make changes.

**This repository is PUBLISHED** to `github.com/Fossferous/Puca` (still private
while it is reviewed, public after). Assume anything committed from now on is
read by strangers.

**PUSHING — read this before you type a git push.** This worktree shares one
object store with the private Sovereign history: `main`, several work/archive
branches, five tags, the stash and a filter-branch backup ref all point into
material that has never been published and must not be. Exactly one push is
legitimate:

```bash
git push puca            # == puca-public -> refs/heads/main, pinned in git config
```

`--all`, `--tags` and `--mirror` would publish the private history, and there is
no undo — GitHub keeps pushed objects fetchable by SHA. A `pre-push` hook
enforces this on the public remote and stays out of the way of every other one;
if it ever refuses a push, it is right and you are about to leak something.

The published history is ONE root commit on purpose. Everything before it named
the operator's servers, containers and home network, and pattern-based redaction
kept missing things — including a personal email in the author field of fourteen
commits, which no file grep can find. Do not reconstruct that history here.

- **Never commit a secret, and never commit infrastructure identity.** Keys,
  `.env`, keystores and `google-services.json` are gitignored and none has ever
  been committed — keep it that way. The same now applies to **server IPs, SSH
  targets, host keys and LAN topology**: the operator-only files that carried
  them (`deploy/ops/hosts.conf`, `known_hosts`, the ship scripts) are gitignored
  and ship as `.example` templates. Real values live in your untracked copies.
- **Personal data is not yours to publish.** No real names of other people, no
  `C:\Users\<you>\…` paths, no personal email addresses.
- Publishing the *code* is now fine. Pasting **secrets** into an external
  service still is not.

---

## Start of every session — run this first

```bash
git worktree list && git status -sb && git log --oneline -3
```

This file is loaded automatically, but nothing tells you whether ANOTHER
session is already working. That check does:

- **More than one worktree listed** → another session may be live. Do not work
  in a folder you did not open; if you are in the main checkout and another
  worktree exists for the task you were given, use that one.
- **Dirty working tree you did not create** → a session is mid-edit, or one
  ended badly. Ask before touching those files; do not stash or revert them.
- **On a `work/` branch you did not create** → you are inside someone else's
  task. Confirm before continuing.

If the task is substantial and the main checkout is busy, make your own space
rather than sharing:

```bash
git worktree add ../puca-<topic> -b work/<topic>
```

## Branching

**The trunk here is `puca-public`, NOT `main`.** It is what pushes to `main` on
GitHub. A local branch called `main` also exists and it is *the old private
Sovereign trunk* — a different, unrelated history that shares this object store.
`git switch main` silently moves you onto it, where nothing you do reaches the
public repo and everything you commit is on the wrong lineage. Check with
`git branch --show-current` if you are unsure.

Work happens on short-lived branches named `work/<topic>`, e.g. `work/push-notifications`.
One branch per task, merged back to the trunk as soon as it is green, then deleted.
Long-lived feature branches caused the mess this replaced: the trunk sat 309
commits stale for seven months while everything shipped from a branch, so CI
never ran and a release script would have rolled production back to December.

```bash
git switch puca-public                 # the trunk (NOT main)
git switch -c work/<topic>             # your branch
# ...work, commit...
git switch puca-public
git merge work/<topic>                 # merge back
git branch -d work/<topic>             # tidy up
git push puca                          # publish (pinned refspec; see the top)
```

Always run the gates after a merge, not just before it. Git resolves *textual*
conflicts; it cannot see *semantic* ones — one branch renaming a function while
another adds a call to the old name merges cleanly and breaks the build.

## Two sessions at once — use worktrees

Two sessions in the same folder share the same files on disk and will corrupt
each other's work. Branches do not prevent this. A worktree gives each session
its own directory backed by the same repository:

```bash
git worktree add ../puca-<topic> -b work/<topic>   # new folder + branch
git worktree list                                       # what exists
git worktree remove ../puca-<topic>                # when merged
```

Point the second Claude Code session at `../puca-<topic>`. Keep concurrent
sessions on **different areas of the codebase** — parallelism is safe when the
work does not overlap, not because merging is clever.

Each worktree needs its own `npm install` (`node_modules` is not shared).

---

## Deploying

Production domains, the install path, the systemd unit, the service user
and the database name all live in **`deploy/ops/hosts.conf`, which is
gitignored** — every ship/verify script sources it. Do not copy real values
back into this file or any other tracked one; `hosts.conf.example` documents
each setting. There is no `/health` route: health is `GET /` returning 200.

Those settings exist because a deployment is usually older than the name the
project currently goes by. Point them at whatever your servers ALREADY run and
you can release from this repo without renaming a live `/opt` directory,
systemd unit, system user or database — none of which a user can see, and every
one of which is a way to take production down for nothing.

**EVERY host listed in `hosts.conf` must receive every release.** If you keep a
second box as a rollback target, that rollback is only real if it has kept
receiving every release — otherwise "rolling back" means downgrading every user
to whatever it was last given, without warning.

**Ship with `deploy/ops/dual-ship.sh {webapp|mobile|mobile-lite|installer|
installer-lite|backend|apk|apk-lite} ...`, never a manual `scp`/`ssh` to one
box.** A single-host deploy leaves the others silently stale, which looks
identical to a successful release. dual-ship.sh refuses to report success
unless it verified EVERY host individually, over that host's own loopback — if
you run an origin lock (only your CDN may reach the origin), an external check
depends on the caller's source IP being exempt, and a changed source IP once
turned a perfectly healthy box into a connection timeout.

**The `*-lite` subcommands ship the Lite variant** (no remote-control code —
My Devices, Wake-on-LAN, remote file transfer, in-call screen-share control —
excluded at compile time, not just hidden). Lite is a separate artifact under
a separate name (`INSTALLER_NAME_LITE`, `MOBILE_BUNDLE_PREFIX_LITE`,
`APK_PREFIX_LITE` in `hosts.conf`), uploaded **alongside**, never over, the
full one — both variants ship the same version number. `apk-lite` refuses to
publish until `deploy/download-site/index.html` actually links the exact lite
APK filename, the same page-and-APK-ship-together gate `apk` has. The
installer links carry no version in their filenames, so neither installer
subcommand has that gate — the page's own HTML comments say which names must
be kept in step by hand. **There is no lite webapp and no lite backend** —
the web app and the server are shared unconditionally between both variants,
so `webapp` and `backend` ship once and cover both.

Mobile OTA is variant-aware over one query param: the installed app requests
`GET /api/mobile-updates/check?variant=lite` (full omits the param), and
`src/update_routes.rs` resolves that to `mobile-update-lite.json` instead of
`mobile-update.json` on the server (env vars `MOBILE_UPDATE_FILE_LITE` /
`MOBILE_UPDATE_FILE` override the filenames; defaults match). `mobile-lite`
writes the lite manifest and verifies it through that same query param,
demanding the `"variant": "lite"` tag in the answer — the version number alone
proves nothing, since both variants ship the same one and a backend that
predates the variant-aware route answers `?variant=lite` with the full
manifest. Never assume the plain endpoint reflects a lite ship. The download page
(`deploy/download-site/index.html`) understands `?variant=lite` too, so the
client's own "no update path" fallback (`api/appVersion.ts`'s
`openDownloadPage`, which appends `?variant=lite` when `RC_ENABLED` is false)
lands a lite user on the lite tab, not the full one.

Confirm which box actually answered a request with
`curl -sI https://$API_HOST/ | grep -i "$HOST_HEADER"` (both from `hosts.conf`).
Remove a host's line from `hosts.conf` once that box is genuinely
decommissioned, so the ship scripts stop expecting it.

**Version** lives in `frontend/src-tauri/tauri.conf.json` only. The `version`
fields in `frontend/package.json` and the root `Cargo.toml` are frozen fossils
(0.8.21) that nothing reads — do not bump them, and never read them as current.

Order: **client surfaces before the backend**, unless the client needs a server
change to exist first. A server-first deploy has caused a production incident
here before: the server started answering in a shape the shipped clients did not
understand yet.

The steps below are what `dual-ship.sh` does per artifact, per host — read them
to understand the mechanics or to deploy by hand in an emergency; do not run
them against a single host as the normal path.

1. Run `deploy/ops/check-versions.sh --preflight` — is the version you are about
   to build still free? Other sessions ship too. Then bump the version and run
   all gates.
2. Build the installer with `npm run tauri:build`, which merges the
   untracked `frontend/src-tauri/tauri.release.json` (see
   `tauri.release.example.json`) so the binary's updater endpoint is YOUR
   download host — it prints the endpoint it baked in, every time, because a
   build against the tracked placeholder silently never finds an update. The
   Tauri signing key is **not** loose in the keys directory — it is inside the
   `key-backups/` bundles, and since 2026-09-02 there are **TWO**, deliberately:
   `puca-keys-<ts>.tar` holds `tauri-updater.key`, `puca-key-passwords-<ts>.tar`
   holds its `.password`. A key and its passphrase in one archive is a key with
   no passphrase, so `backup-keys.sh` splits them and refuses to write a bundle
   that carries both. Extract from both, export
   `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, build,
   then delete the extracted copies. Without it `npm run tauri:build` fails
   (`createUpdaterArtifacts: true`). Bundles made before that date are single
   tars and still restore fine — nothing reads them programmatically.
3. Webapp: build locally and ship as a tarball — **there is no npm on the
   container**.
4. Mobile OTA: every bundle must go through `deploy/mobile/encrypt-bundle.mjs`.
   An unsigned bundle is rejected by the installed app. The manifest must be
   written to **`/opt/puca/mobile-update.json`** — the app reads it via
   `GET /api/mobile-updates/check`, which the backend resolves relative to its
   working directory. `downloads/mobile-update.json` is a different file that
   nothing reads; publishing only there froze mobile on 0.6.15 for six
   releases. Verify with `curl https://chat.example.com/api/mobile-updates/check`,
   not by looking at the file.
5. Backend: built **on the server** (`cargo` lives under root's home there).
   Upload `src.tar.gz`, extract, build, install over `$INSTALL_DIR/$SERVICE_NAME`,
   restart. Migrations run automatically at startup. `dual-ship.sh backend`
   builds **once** (on the first host in `hosts.conf`) and copies the resulting
   binary to every other host rather than rebuilding per host. That is only safe
   while every host runs the same distribution, libc and architecture — verify
   that yourself for your own fleet, and re-verify it whenever a host is rebuilt
   or upgraded. It also removes any chance of two hosts ending up on subtly
   different builds of the same commit.
6. Verify every surface: served artifact hash must equal the local one. Verify
   through the endpoint the CLIENT actually calls, not the file you wrote — a
   correct file in the wrong place looks identical to a successful deploy. Run
   that verification **over the host's own loopback via ssh, never
   `--resolve` from your own machine** — the origin lock drops non-Cloudflare
   traffic, so an external check depends on your current source IP being
   exempt, which it may not be; a changed source IP once produced a timeout
   against a perfectly healthy box.

Keep a rollback of whatever you replace, and take a database dump before any
migration.

### Deploy traps that have cost real time

- `tar -xzf` on the server needs `--no-same-owner`, or it fails applying a
  Windows uid. It also needs `--touch` plus `find … -exec touch {} +`, or stale
  mtimes make `cargo build` "finish" in 0.2s and reuse the **old binary**. A
  real backend rebuild takes ~50s — if you see 0.2s, you shipped nothing.
- SSH from the **Bash tool** needs `-i ~/.ssh/<your-deploy-key> -o IdentitiesOnly=yes`:
  Git Bash cannot see the Windows ssh-agent, and a deploy key with a
  non-default filename is never offered automatically. From **PowerShell**, plain `ssh` works
  via the agent. Never combine `IdentitiesOnly=yes` with an agent-only key.
- Git Bash has no `zip`; use `python -c "shutil.make_archive(...)"`.

---

## Gates — all of these, before shipping

```bash
cd frontend && npm run typecheck && npx vitest run && npm run build && npm run lint
cargo test                                   # repo root
cd frontend/android && ./gradlew testDebugUnitTest    # the pure-Java logic
node frontend/e2e/feature-flows.mjs          # needs a backend + isolated DB
cd frontend && node e2e/ice-url-real-browser.mjs   # real RTCPeerConnection; no server needed
```

**`ice-url-real-browser.mjs` is REQUIRED and exists because every other gate is
blind to it.** Nothing else in this repo ever constructs a real
`RTCPeerConnection`: all 25 RTC test files mock `../api/iceConfig`, and vitest
runs under jsdom, which has no WebRTC. Three consecutive security-review rounds
therefore shipped an ICE defect straight past `cargo test`, `vitest`, `tsc -b`
and `eslint` — a malformed `stun:` URL derived from the `TURN_SERVER` this
repo's own provisioner writes, then the sibling TURN branch emitting an empty
URL from a stray comma, then entries like `turn:` surviving the empty-filter.
None of those is a degraded ICE server: `new RTCPeerConnection()` THROWS, so the
failure takes out mesh voice, screen share, both My Devices paths and
peer-to-peer file transfer at once, for every user of that deployment. This
script hands each shape the backend can emit to a real Chromium and asserts it
constructs, with negative controls so a browser that accepted anything would
fail the run rather than pass it vacuously. It needs no server and no build.

**The JUnit gate is REQUIRED and was missing from this list until 0.8.68.**
`frontend/android/app/src/test/` holds the pure-Java decision logic —
`PushGate`, `GeofenceEngine`, `PushFrames`, `KeepAliveReasons`,
`DeliveryCreds` — extracted specifically so it can be tested off-device, which
is worth nothing if the suite is never run. From the **Bash** tool it needs a
modern JDK, which Git Bash does not default to:

```bash
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew testDebugUnitTest
```

**The root `build.rs` is what keeps migrations from going stale in a warm
`target/`.** `src/main.rs` calls `sqlx::migrate!("./migrations")`, which reads
that directory at COMPILE time; Cargo cannot see a proc macro's file reads, so
a rebuild reused an object file whose embedded migration set stopped wherever
it last compiled. Measured here on 2026-09-02: with no build script, adding a
migration and running `cargo build` finished in 0.49s and the new file was NOT
in the binary; with `build.rs` the same step recompiles (~16s) and it IS. The
server would have booted, reported the migrations it knew about as applied, and
failed at runtime on every query naming a missing column. This replaces the old
hand-bumped `// Force rebuild for migrations` comment at the top of `main.rs`,
which had gone three migrations stale before anyone noticed. Do not delete
`build.rs`, and do not add a `rerun-if-changed` for a path you have not tested —
naming any path opts out of Cargo's "rerun on any change" default.

**`cargo test` at the repo root covers ONLY the root package.** The root
`Cargo.toml` declares no `[workspace]`, so nothing under `crates/` (the whole
capture/input/encode/agent layer, `unsafe` included) and none of the
`src-tauri` tests compile under this gate — measured once at 92 of 418 tests.
When you touch a crate, run `cargo test` inside that crate's directory as well.

**NEVER use `npx tsc --noEmit` here — it checks NOTHING and always exits 0.**
The root `tsconfig.json` is solution-style (`"files": []` plus two
`references`), so a bare `tsc` compiles an EMPTY program. Proven 2026-08-04 by
appending `export const X: number = "a string"` to a real source file: `tsc
--noEmit` exited 0, `tsc -b` reported TS2322. That is why a missing
`@capacitor/filesystem` dependency sailed through the typecheck and only
`npm run build` caught it — and it means every "typecheck passed" in this
repo's history proved nothing.

`npm run typecheck` is `tsc -b`, which builds both referenced projects. Both
set `noEmit: true` with their `.tsbuildinfo` under `node_modules/.tmp/`, so it
is a pure check that leaves the tree clean.

**`npm run typecheck` does not type-check the tests.** `frontend/tsconfig.app.json`
excludes `src/tests` and `*.test.ts*`, and vitest transpiles with esbuild, which
drops types without checking them. So a test can call a function with the
wrong number of arguments, pass every gate, and keep passing for the wrong
reason (found 2026-09-02: four `decryptDMContent` calls with a missing required
argument, green because the omitted context is ignored for v2 envelopes). When
you change a signature, grep the tests for its call sites yourself.

`npm run build` is still a separate gate: it also runs the agent build and
vite, either of which can fail when the typecheck passes.

Run `npm install` in the checkout you are building from before trusting any of
this — each worktree has its own `node_modules`, and a dependency added in
another worktree is missing here until you do.

**`npm run lint` is a REQUIRED gate, and the note that it was "broken by a
build-tree scan" is stale — it runs fine.** It is the only gate that catches
`react-hooks/rules-of-hooks`, and that rule is not a style preference here: in
v0.7.7 a hook placed below an early return shipped as far as a signed
installer. The typecheck, `vitest` and `npm run build` all passed it. It threw
React #310 on the first click of "Edit Profile" and the root ErrorBoundary
replaced the ENTIRE app with the crash screen — every user, every platform,
recoverable only by reloading (which drops any live call). Only the review
caught it.

`npm run lint` is four checks chained, not just eslint: eslint, then
`scripts/check-no-ui-emoji.mjs` (no emoji in chrome — docs/ICON_LANGUAGE.md),
then `scripts/check-source-hygiene.mjs`, then `../scripts/check-docs-links.mjs`.
The last two were added 2026-09-02 and each exists because of something that
shipped: a user-facing diagnostic told people to install the APK from
`download.example.com`, a `TODO: Replace with your production server URL` sat
above the line that already did it, and `docs/GETTING_STARTED.md` pointed every
<!-- docs-lint:allow-missing — naming the reference that was REMOVED is the point -->
new self-hoster at `.agent/HANDOFF.md` — a directory scrubbed for the public
repo. All three are invisible to a type checker and to every test. Both new
checks take an inline escape hatch (`hygiene-lint:allow-placeholder-domain — reason`,
a `TODO(owner)` tag) and both REQUIRE a reason.

**`npm run lint` now EXITS 0. Treat any non-zero exit as a failed gate.**

It was previously red with 13 errors, and this file described them as advisory
`set-state-in-effect` findings. That was wrong and it made the gate useless: a
gate nobody can pass is one nobody reads, and "13 errors, same as before" hid
whatever you actually added. Only 4 were the advisory kind. The other 9 were
dead code — 7 `getFileUrl` imports and a `parseServerTimestamp` left behind when
avatars moved to `AuthedImg`/`authedMedia`, plus a `&&` used as a statement.
All are now deleted; the genuinely-advisory sites carry inline suppressions with
reasons. That population grows with new features — the count is not the
contract. The contract is that every directive still FIRES: eslint reports dead
ones as "Unused eslint-disable directive" warnings, and a dead directive must be
deleted, not left as decoration (two had gone dead by 2026-08-10 and were
removed).

Two traps when suppressing, both of which had already produced directives that
silenced nothing while eslint reported them as unused:

- `eslint-disable-next-line` applies to the next LINE, not the next statement.
  Leading a multi-line `//` comment block means it lands on another comment.
- `react-hooks/set-state-in-effect` reports at the **setState call site**, not
  at the `useEffect`. For a multi-line effect the directive goes inside the
  body, immediately above the call.

The rule that must never regress, whatever the exit code says:

```bash
cd frontend && npm run lint 2>&1 | grep -c "rules-of-hooks"   # must print 0
```

Two `react-hooks/exhaustive-deps` **warnings** remain, both known. `SmartAvatar.tsx`
is deliberate: the effect must run after every render to catch `img.complete`
flipping on the DOM node without telling React, so following the rule's advice
(`[loaded]`) would break it. `StreamStage.tsx` (missing `setFocusedStream` dep)
is unassessed — do not "fix" a hook-dep warning blind; dependency changes change
behaviour. Warnings do not fail the gate, but a NEW warning in the lint output
is a finding: read it, decide, then document it here or fix it.

Live suites need a backend against a **throwaway** database — never the dev or
production one. See the header of `frontend/e2e/e2ee-live-verify.mjs`.

**Throwaway stack recipe (used for every 0.9.0 gate):** a second Postgres
cluster on **5433** (`pg_ctl -D <scratch>/pgdata -o "-p 5433" start`), a
fresh database per run, the debug backend on :3000 with `DATABASE_URL`
pointing at it (migrations apply at startup), then the harness with its env:

- `frontend/e2e/e2ee-live-verify.mjs` — `PGDB=<db> PGPORT=5433 API=http://127.0.0.1:3000`
  (real SRP; covers E2EE, the password-proof/session binding and per-session
  revocation stages).
- `tests/batch7-permbits-live.mjs` — same env; it mints its own JWTs, so the
  backend must run with `JWT_SECRET=puca_super_secret_key_change_in_production`.
- the browser two-peer voice suites (`frontend/e2e/voice-camera-2peer.mjs`,
  `perfect-negotiation-2peer.mjs`, `voice-rejoin-2peer.mjs`) — add
  `APP=http://localhost:5174` with vite started via `.claude/launch.json`'s
  `frontend-dev-alt`; the FIRST run against a cold dev server times out on
  `page.goto` (vite compiling) — rerun, do not debug.
- `cargo test` has one DB-backed test (`auth::session_tests`) that **silently
  passes without a database**: run it with `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/<migrated db>`
  once per change to the session code, and confirm it did not print "skipping".

---

## Standing rules

**Distrust green tests.** This codebase has repeatedly contained tests that
could not fail: assertions on emptiness that pass when the request errored,
`status < 500` passing on a 401, upper bounds that pass at zero. Before trusting
a passing test, ask what would have to break for it to go red — and check by
reverting the fix.

**Audit findings over-state severity and under-state scope.** Measured: of 13
findings reported as HIGH/CRITICAL, two survived an independent re-read. The
same audit listed 10 instances of a bug where there were 14. Open the cited
file, confirm the code says what the report says, look for the guard three lines
away, then sweep for other instances yourself.

**Review your own diff adversarially before shipping.** Three passes over
already-gated diffs found 33 real defects.

**Ship the client before the server** when a server change needs new client
behaviour.

**A setting needs its UI in the same change.** Adding a stored value with no
control that changes it produces a feature nobody can use — this has happened
more than once, including for the tray toggle.

**Icons come from `frontend/src/components/Icons.tsx`; emoji are not
iconography.** Emoji render in the host font (a different picture per
platform), are full-colour bitmaps that ignore all eight themes and
`[data-contrast="high"]`, and overflow their em box by a different amount per
glyph so a row never optically aligns. `npm run lint` fails on emoji in chrome.
Emoji stay where they are *content* — the picker dataset, the `:shortcode:`
map, reactions. Rules in `docs/ICON_LANGUAGE.md`; keep the wrapper span and
swap only the glyph, because wrappers like `.menu-icon` set `width: 20px` and
CSS beats the `<svg>`'s width attribute.

**A password proof belongs to ONE session.** `/auth/login/step2` records the
proof for the session whose token it returns; a signed-in client re-proving
for a key-custody write (change password, recovery code, delete account)
must send its bearer on the exchange so the proof binds to the session that
will spend it. 0.8.136 minted a fresh session on every exchange and every
in-app password change was refused — the unit tests were green because
nothing exercised the two halves together. Live-verify now does.

**Do not fix what you have not reproduced.** Two speculative timing fixes for
one transfer bug were both wrong. Instrument, get evidence, then fix.

**Mobile ships with desktop.** Web changes go out as a signed OTA; native
changes need a new APK. New UI must pass the 390x844 coarse-pointer walk
(`frontend/e2e/mobile-walk*.mjs`) and `docs/DESIGN_PHILOSOPHY.md`.

---

## Secrets

Never commit `.env`, `*.key`, `*.pem`, keystores or `google-services.json` —
`.gitignore` covers these, and nothing sensitive is currently tracked. Keys live
in your keys directory (outside this repo) and are backed up off-machine.

Losing that directory's `key-backups/*.tar` bundles would permanently break
desktop auto-update and the mobile OTA: no validly signed release could ever be
produced again and every user would need a manual reinstall.

`backup-keys.sh` writes **two** bundles — key material, and the passphrases that
unlock it — and they are only a real separation if you store them in DIFFERENT
places. Both in one vault is the single-artifact backup the split replaced.
`deploy/ops/backup-keys.test.sh` exercises the whole script against fixture
files, so it is safe to run any time.

---

## Known-unbuilt

Do not assume a feature exists because a doc says so — one doc claimed push
notifications were "fully implemented in `pushNotifications.ts`", a file that
has never existed.

- **Push/background delivery** (rewritten three times on 2026-08-13 — read
  `src/wake/mod.rs`'s header before touching it): data NEVER rides a relay.
  Android delivery is `NativeDelivery.java`'s OkHttp socket to the user's own
  server; frames missed while it was dead park server-side (bounded queue) and
  an optional FCM **wake signal** — constant payload `{"w":"1"}`, entire body
  pinned by a test — reconnects the socket through Doze. An earlier FCM design
  that carried sender names was removed on principle the day it shipped.
  Desktop notifications still require the app running (tray keeps it so).
- **Authenticode code signing** of the Windows installer and binaries is NOT
  done (the only launch item deliberately deferred by the owner): SmartScreen
  warns on first run, and Defender false positives (see the 2026-08-17
  incident) can only be cleared by MS WDSI submission. Everything else the
  updater needs — the Tauri updater signature — is in place.
- **Clips (replay buffer)** — built end to end (`docs/CLIPS.md`): desktop
  capture/seal/preview, the server presence log + approval protocol, and the
  client prompt/composer/attachment. Off per server until the owner enables
  it (Phase 3, 2026-09-02, removed the experimental flag and surfaced
  retention). The 30 s "how it works" is in `docs/CLIPS.md`; do not
  re-derive it from the code.
