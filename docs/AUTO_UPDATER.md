# Púca Desktop App Auto-Updater Setup

## Overview

Tauri's updater allows your users to automatically receive updates without manually downloading new installers.

## Setup Steps

The deployment guide covers this end to end — [`deploy/README.md`](../deploy/README.md)
section 6.1 — and is the version to follow. In short:

### 1. Generate a signing keypair (once, on your machine)

```bash
cd frontend
npx tauri signer generate -w ~/.puca/tauri-updater.key
```

You'll be prompted for a password. **Remember this password**, and back the
key up with `deploy/ops/backup-keys.sh` the same day: the public half is
compiled into every installer, and an app accepts an update only if it was
signed by the matching private key. Lose the key and no update can ever be
signed again — every installed client stays on its version until its user
reinstalls by hand.

### 2. Put the public key and your download host in the overlay

Do **not** edit the tracked `src-tauri/tauri.conf.json` (it carries this
project's key and a placeholder endpoint). Copy
`src-tauri/tauri.release.example.json` to the gitignored
`src-tauri/tauri.release.json` and set both:

```json
"plugins": {
  "updater": {
    "endpoints": ["https://download.example.com/latest.json"],
    "pubkey": "<the public key `tauri signer generate` printed>"
  }
}
```

`npm run tauri:build` merges it and prints the endpoint and the key id it
baked in, every time. The endpoint is a **static file**: `latest.json` at the
download host's root, written by `deploy/ops/dual-ship.sh installer` (the
Lite build reads `latest-lite.json` beside it, derived automatically).

### 3. Build a signed release

Set the two environment variables before building — the build fails without
them, because `createUpdaterArtifacts` is on:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "~/.puca/tauri-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "your-password-here"

npm run tauri:build
```

This creates the installer and its `.sig` in `src-tauri/target/release/bundle/nsis/`.

### 4. Publish

`deploy/ops/dual-ship.sh installer <Puca-Setup.exe> <.sig> <version> "<notes>"`
uploads the installer under a versioned name, writes `latest.json` with the
signature from the `.sig` file, writes the `/app-version` file that drives the
in-app prompt, and verifies each through the download host. `latest.json`
has the shape Tauri expects:

```json
{
  "version": "0.9.0",
  "notes": "Bug fixes and improvements",
  "pub_date": "2026-09-02T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "dW50cnVzdGVkIGNv...",
      "url": "https://download.example.com/Puca-Setup-0.9.0.exe"
    }
  }
}
```

### 5. Version bump workflow

1. Bump `version` in `frontend/src-tauri/tauri.conf.json` — the only place
   the version lives (`frontend/package.json` and the root `Cargo.toml` carry
   frozen values nothing reads).
2. Write the release notes entry in `CHANGELOG.md`.
3. Build with the signing keys (step 3).
4. Ship with `dual-ship.sh` (step 4); `deploy/ops/check-versions.sh` confirms
   every surface agrees.

---

## Quick Commands

```bash
# Development (for testing, no signing)
npm run tauri:dev

# Production build (requires signing keys)
npm run tauri:build

# Check for signing key
ls .tauri/puca.key
```

## Files Changed for Auto-Updater

| File | Change |
|------|--------|
| `package.json` | Added `@tauri-apps/plugin-updater` |
| `src-tauri/Cargo.toml` | Added `tauri-plugin-updater` |
| `src-tauri/src/lib.rs` | Registered updater plugin |
| `src-tauri/tauri.conf.json` | Added updater config |
| `src-tauri/capabilities/default.json` | Added updater permissions |
| `src/api/appVersion.ts` | Detection (`checkForNewVersion` against `GET /app-version`) + in-place install (`installUpdateInPlace`) |
| `src/components/UpdateBanner.tsx` | The prompt: shows a newer release, installs only on click |
| `src/components/UpdateGate.tsx` | Pre-load gate; installs desktop updates automatically ONLY when `autoInstallUpdates` is on |
| `src/components/updateGate.utils.ts` | Pure decisions: `shouldAutoInstallOnLaunch`, once-per-version key |
| `src/components/HostAutoUpdate.tsx` | A PC set up for remote control installs an update by itself while nobody is connected (full build only, mounted from `RcGlobals`) |
| `src/api/devices/hostUpdate.ts` | Its pure decision (`decideHostUpdate`), what counts as a host, and its `puca.log` lines |
| `src-tauri/src/host_update.rs` | Its download, silent install and hidden relaunch, and its records on disk (remote-control builds only) |

(There is no `useUpdater` hook and never was — an earlier revision of this doc
described one that did not exist.)

## How the Desktop Update Actually Runs

1. **Detection.** `checkForNewVersion()` in `src/api/appVersion.ts` fetches
   `GET /app-version` (an operator-pushed JSON file, hardcoded production
   fallback base, 8 s per-base timeout) and compares it with the running
   version.
2. **The prompt.** `UpdateBanner` calls that 8 s after it mounts, then every 10
   minutes and on window focus, and shows an "Update available" banner. It
   **never installs on its own** — clicking Update runs
   `installUpdateInPlace()` (Tauri updater plugin: minisign-verified download,
   passive NSIS install, relaunch).
3. **Automatic installation (opt-in).** Settings → Advanced → Desktop App →
   "Install updates automatically" (`autoInstallUpdates`, default OFF). When
   on, `UpdateGate` — which renders at `main.tsx` before routing and before
   sign-in — checks and installs at startup, before the app loads, with the
   same visible progress screens as the mobile OTA. One automatic attempt per
   version (`sovereign_update_auto_attempted` in localStorage) so a failed
   install can never loop; every phase is bounded so the gate may delay the
   app but never hold it. On an ordinary PC nothing installs mid-session,
   ever.
4. **A PC set up for remote control (on by default there).** Such a PC often
   has nobody at it to click the banner — one laptop, reached only from the
   owner's other machines, stayed on 0.9.844 for days after 0.9.847 shipped
   the host half of the pointer work. So `HostAutoUpdate` installs a newer
   release by itself, and Púca restarts on it. Not with
   `installUpdateInPlace()`: that runs NSIS in the configured passive mode, a
   progress window on the screen of a PC whose owner may be watching a film on
   it, and the plugin's JavaScript takes no per-call mode. The shell does it
   (`src-tauri/src/host_update.rs`): the same updater, built with NSIS's silent
   switch `/S` for this install only, so nothing appears (the template still
   relaunches a silent install, `/R /ARGS`, and closes the running app without
   asking, as passive does); the relaunched app starts hidden in the tray,
   whatever arguments it had, by a one-shot marker that names the version
   being installed (a start on any other version, such as the old one started
   by hand after a failed install, shows its window as always). The marker is
   believed for 5 minutes from the installer's start (`RELAUNCH_MARKER_MAX_AGE_MS`),
   kept short because a start of the new version BY HAND inside that window
   would come up hidden too; a silent per-user install takes seconds, well
   under a minute on a slow, busy disk. A PC that sleeps between the
   installer's start and the relaunch shows its window when it wakes, which is
   accepted: asleep, it had no screen anybody was using. The download is a
   task the page aborts. What installs is the version `latest.json` offers
   (`host_update_offer`), so the soak and the loop guard key on that one, and
   it installs only while `/app-version` names the same version: during a
   ship to several boxes the two can differ, and while they do it waits and
   says so once ("the server announces it but the updater offers X"). The
   download itself refuses any version but the one just judged. That look at
   `latest.json` is bounded at 30 s (`OFFER_CHECK_TIMEOUT`, a `tokio` timeout
   around the check only; the updater builder's own `.timeout()` would cap
   the download too): one that hangs is a failed look, said once in
   `puca.log`, and the next look, 10 minutes later, asks again. Unbounded, a
   hung request kept every later look waiting until Púca restarted. The soak:
   it installs once this PC has been BEHIND for 24 hours
   (`HOST_UPDATE_BEHIND_MS`, counted from the first time it saw ANY version
   newer than the one it runs) and the version it installs has been on offer
   for 2 hours (`HOST_UPDATE_FRESH_MS`). The 2 hours let the people who update
   by hand meet a release with a problem first; counting the day from falling
   behind, not per version, means a burst of releases a few hours apart does
   not keep a host on an old one (the first rule, a day per version, did:
   during a burst a host never caught up). So a host is about 26 hours behind
   at most. Both times are on disk (`host_update_note_seen`), so a restart
   restarts neither; the behind clock starts again only once the PC runs a
   different version, or a look finds nothing newer than the one it runs
   (`host_update_offer` then clears both clocks, `forget_offer`; a look that
   FAILED clears nothing). So a release that is seen and then pulled leaves
   no clock running: the next one, weeks later, waits its full day, and so
   does the same version republished. A host asks `latest.json` at every look
   for that, even when `/app-version` announces nothing. "Set up for remote control" is read from the machine, never
   guessed: unattended access armed (`unattended_state`) or lock-screen access
   installed (`service_state`) — the two switches in Devices → This device
   that let a PC be controlled with nobody at it. The service is the
   machine's, so on a PC with lock-screen access every Windows account's Púca
   counts as a host, deliberately: a remote sign-in through the lock screen
   lands in whichever account signs in, and the session then runs on that
   account's own Púca and agent. Each account's update is its own per-user
   install, judged in its own session (a switched-away one reads as "not
   present" and installs unseen), and each has the switch in its own Devices.
   It installs only while
   nobody is connected (no device session on the PC, either role, in any phase
   but ended), no call is active in Púca there, no DM's direct file transfer
   is connecting or moving bytes, none of those ended in the last 2 minutes,
   the app has been connected to its server (and the PC awake) for 2 minutes
   — the moment someone who woke it to reach it is about to connect — and
   nobody has used the PC's keyboard or mouse for 10 minutes
   (`get_idle_seconds`; injected remote input counts too). Idle is not
   "nobody here", though: a film, a game on a controller and a presentation
   touch no key. So it also needs the shell's notification state for this
   Windows session (`host_presence`, `SHQueryUserNotificationState`) to say
   "not present" (locked, screen saver, a switched-away session) or "accepts
   notifications" (nothing full screen, no presentation); any other answer
   waits (`nobodyWatching` in `src/api/devices/hostUpdate.ts`). The system-wide
   "display required" execution state (`CallNtPowerInformation(SystemExecutionState)`)
   is NOT used: on the owner's PC it read SYSTEM|DISPLAY required before,
   during and after another process held a display request, so it could not be
   shown to mean anything here. A DM's direct transfer counts from the moment
   it is prepared or offered, and an upload on its way to the server (an
   attachment, task or note media, a Clip) or a message in the composer not
   sent yet waits too (`src/api/workInFlight.ts`). All of it is judged
   again every 2 s while the update downloads, and a session (or anything
   else) that starts meanwhile STOPS the download and keeps the PC as it is;
   once more before the installer. An install committed to is recorded by the
   shell, synced to disk before the installer starts
   (`%LOCALAPPDATA%\<identifier>\host-update\state.json`): if Púca comes back
   on the old version, that version is tried again only a day later; a
   download that failed waits half an hour, and so does one that received
   nothing for 2 minutes (`HOST_UPDATE_STALL_MS`: the updater has no timeout
   of its own, so the page stops it, from the bytes the shell counts). Every decision is one `[host-update]` line in `puca.log`, written
   when it changes ("update X available, waiting: a session is live",
   "installing X: nobody connected"). The owner's switch is **Keep Púca up to
   date on this computer while nobody is connected** (Devices → This device,
   shown only on such a PC; settingsStore `hostAutoUpdate`). A Lite build has
   no remote control, is never a host and does not contain it.

   **If the relaunch fails, the host is down until the next sign-in or
   start: the residual risk, accepted.** The installer relaunches Púca only
   from `.onInstSuccess`, so an install that fails part-way (or a relaunch
   that does not happen) leaves the PC without Púca, and with nobody at it,
   unreachable, until Windows starts Púca again: at the next sign-in (with
   Púca's start at sign-in on, as a PC set up for remote control needs) or the
   next start of the PC. What makes it unlikely: the soak (a version installs
   only after this PC has been behind a day and the version has been out 2
   hours, so a release that breaks installs has usually been met, and
   replaced, first); silent mode, which never waits on a dialog (the
   template closes the running app without asking, and a failure aborts
   instead of asking); and the start at sign-in. There is deliberately NO
   safety net that would start Púca again after a failed install (a one-shot
   scheduled task, say): creating a scheduled task from an unsigned binary is
   exactly what Defender's behaviour monitoring flags, this project has had
   Defender false positives before, and the installer is not
   Authenticode-signed (see *Known-unbuilt* in CLAUDE.md).

   **The sign-in-screen service is NOT updated this way.** The app update is
   the per-user NSIS install (currentUser mode, `%LOCALAPPDATA%`): no
   elevation, and it replaces `Puca.exe` with the agent and service helpers
   beside it, which is the agent a session to the signed-in desktop uses. The
   SovereignRemote service and its agent copy live under
   `%ProgramFiles%\Sovereign\service` with an administrator-only ACL, and
   `service_update` runs `puca-service.exe update` through the `runas` verb —
   a UAC prompt every time. With nobody there to answer it, an unattended
   update must never raise one, so the service keeps waiting for someone at
   the PC (ServiceUpdateBanner, "One Windows prompt"), and a session at the
   lock or sign-in screen meets the older agent until then.

### Downgrade and replay (desktop)

The minisign signature covers the installer **bytes**, not the version printed
in `latest.json`. A host that serves that file can therefore point a higher
version number at an older, genuinely signed installer, and nothing in the
NSIS installer stops it landing: `installMode: "passive"` passes `/P`, never
`/S`, so the installer's own downgrade refusal (gated on NSIS's `${Silent}`)
cannot fire, and the updater also passes `/UPDATE`, which skips the reinstall
page — and its version comparison — entirely. `bundle.windows.allowDowngrades:
false` is therefore **not** a fix for this path: it only changes what the
interactive installer offers when a user double-clicks an older setup by hand,
and it turns that into an uninstall-first, which runs the full uninstaller
hooks. It is deliberately not set.

What bounds it: the attacker needs the download host, can only replay past
signed releases, and the one-automatic-attempt latch above means a replayed
version is tried once, not looped. After a replay the app reports the version
it was actually built as, and the next honest `latest.json` applies normally.
The manual download page has the same property — `SHA256SUMS.txt` lives on
the same host as the installer, so it proves integrity, not provenance.
