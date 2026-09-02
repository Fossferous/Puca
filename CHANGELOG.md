# Changelog

User-facing changes per release, newest first. The desktop updater shows the
one-line summary; this file is the full story. Versions follow
`frontend/src-tauri/tauri.conf.json`.

## 0.9.1 — unreleased (the launch release)

Everything the launch-readiness pass found, in one update.

### Fixed
- **Voice hotkeys that worked about half the time.** Push-to-talk, mute and
  deafen from inside a game now come from two independent sources: the
  system hook, and a 20 ms check of the physical key state that catches a
  press or release the hook missed (Windows silently removes a hook under
  load; a key released on a UAC prompt was never seen). A lost release used
  to leave push-to-talk open AND swallow the next press. Hotkeys pressed
  while Púca itself was in front were also being dropped by a focus test the
  WebView answers unreliably; the OS's answer is used now. Keys delivered
  by a gaming mouse's own software (G HUB, Synapse) or AutoHotkey used to be
  ignored as "injected"; only Púca's own remote-control input is now.
  A game going fullscreen mid-call (which arms the clip buffer) used to
  restart the whole hotkey feed, closing a held push-to-talk. A Ctrl or Shift
  pressed in the same instant as its key could go unseen by a toggle A
  hotkey bound to a mouse button no longer stops working while the message
  box has focus, and a rapid settings change can no longer leave the same
  keypress being handled twice.
  If a game runs as administrator, Windows hides its keys from every
  program that does not, and Púca now says so in a banner instead of
  failing silently.
- **Taskbar pins and shortcuts left dead by the 0.9.0 rename.** 0.9.0 renamed
  the program file from `app.exe` to `Puca.exe` (`Puca-Lite.exe` for Lite), and
  a taskbar pin you made yourself kept pointing at the old name. This update's
  installer repairs every pin and shortcut of ours that no longer resolves. If
  a pin still shows an error afterwards, unpin it and pin Puca again from the
  Start Menu.
- Password-reset and email-verification tokens are stored hashed on the
  server; a database dump no longer contains a usable reset link.
- The obsolete `sessions` table (raw login session keys, written by nothing
  since 0.9.0) is dropped.

### Security
- Keystrokes sent by someone controlling this machine through My Devices
  still cannot trigger its owner's hotkeys. The new key-state check added
  for reliability reads the same table Windows fills for injected input, so
  it is explicitly blinded to keys Púca itself is injecting.

### Changed
- **Deleting your account now also removes the files you uploaded** —
  attachments, your avatar, sounds — after a 30-day grace period (operators
  can set `DELETED_ACCOUNT_FILE_GRACE_DAYS`). Server icons and custom emoji
  you contributed stay with the server. The deletion screen says so.
- On the desktop, the "remember this device" seed for unattended remote
  control is sealed with Windows data protection (DPAPI) instead of being
  kept in the app's web storage.
- The WebSocket no longer accepts a session token in the URL; every app
  since 0.9.0 sends it in a header. A native background helper older than
  0.9.0 updates together with the desktop app.

### For self-hosters
- Relay (TURN) responses are verified for integrity end to end; the check has
  been proven against a production coturn.

## 0.9.0 — 2026-09-03

### Added
- Sign out on one device without touching the others, and revoking a device
  from the Devices tab now really ends its sessions.
- Invites are a permission (Create Invites); attaching files is honoured at
  the upload door; camera and screen share are permission-checked before a
  single frame is sent, and other people's video is shown only once the
  server has confirmed it.
- Messages show an "(edited)" marker.

### Fixed
- In-app password change was refused on 0.8.136; it works again.
- Invite links expired early on servers whose database runs in a non-UTC
  time zone.

### Security
- File transfers and mesh calls pin the other side's connection certificate
  through the identity-authenticated handshake; channel keys are bound to
  their channel and epoch; deleting an account scrubs device shares, wrapped
  keys and device names; the agent's file jail and relay handling were
  hardened; offsite backups refuse to ship unencrypted.

### Changed
- The Windows program file is now `Puca.exe` / `Puca-Lite.exe`.
- Existing remote-control file grants under system folders (AppData,
  Program Files) are refused from this version on.

Older releases: see the git history of `frontend/src-tauri/tauri.conf.json`.
