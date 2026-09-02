; Installer hooks for the LITE build.
;
; MUTUALLY EXCLUSIVE VARIANTS, SHARED DATA. Lite and full deliberately use the
; SAME `identifier`, so they share %APPDATA%/%LOCALAPPDATA%\com.sovereign.chat
; — that is what makes switching between them keep you signed in, with your
; keys, settings and history intact.
;
; Sharing a data directory is only safe because they are never installed at the
; same time. Two processes against one WebView2 user-data folder is a known
; silent failure in this app: the second window gets NO WEBVIEW AT ALL, no
; error, nothing in any log. So this installer REMOVES the full build (and a
; legacy "Sovereign" install) before writing anything.
;
; APP DATA IS NOT TOUCHED by the uninstaller this runs: its "also delete app
; data" checkbox defaults to unchecked and is NEVER SHOWN in silent (/S) mode,
; verified against the NSIS template these installers are built from. That is
; precisely what carries the session across the switch.
;
; No self-guard is needed on the names below: this file is used ONLY by the
; lite build, whose ${PRODUCTNAME} is "Púca Lite" and therefore never matches
; either target. installer-hooks.nsh removes "Púca Lite" symmetrically.
; ${__FILEDIR__} is THIS file's directory. A bare !include resolves relative to
; the GENERATED installer.nsi (target/release/nsis/x64/), not to this file —
; Tauri includes this hook by absolute path — so a bare name is not found and
; the installer fails to build at all. Caught only by actually running a real
; NSIS build; no amount of reading proved it.
!include "${__FILEDIR__}\installer-migrate.nsh"

!macro NSIS_HOOK_PREINSTALL
  ; The FULL variant's own mainBinaryName, not this build's — see
  ; installer-migrate.nsh: the binary that has to stop is the one the install
  ; being replaced actually runs.
  !insertmacro MigrateRenamedInstall "Púca" "Puca"
  ; The legacy pre-rename install, which ran the generic "app.exe".
  !insertmacro MigrateRenamedInstall "Sovereign" "app"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro RepairShortcutsToRenamedBinary
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
