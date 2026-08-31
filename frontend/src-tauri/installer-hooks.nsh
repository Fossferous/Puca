; Installer hooks for the FULL build.
;
; Removes any OTHER variant or older name of this app before installing, so
; only one is ever present. The variants deliberately share `identifier` (and
; therefore %APPDATA%/%LOCALAPPDATA%\com.sovereign.chat), which is what makes
; switching keep you signed in — and is only safe because they are never
; installed at the same time. Two processes against one WebView2 user-data
; folder leaves the second with NO WEBVIEW AT ALL, silently.
;
; App DATA survives: the uninstaller's "also delete app data" checkbox defaults
; to unchecked and is never shown in silent (/S) mode.
; ${__FILEDIR__} is THIS file's directory. A bare !include resolves relative to
; the GENERATED installer.nsi (target/release/nsis/x64/), not to this file —
; Tauri includes this hook by absolute path — so a bare name is not found and
; the installer fails to build at all. Caught only by actually running a real
; NSIS build; no amount of reading proved it.
!include "${__FILEDIR__}\installer-migrate.nsh"

!macro NSIS_HOOK_PREINSTALL
  ; SELF-GUARDING against the pinned-name build. A deployment may pin
  ; productName "Sovereign" in tauri.release.json (keeping the old install
  ; identity instead of renaming). In that build, OLD_NAME equals the CURRENT
  ; name — so this migration would find OUR OWN install on every routine
  ; update and turn an in-place upgrade into kill + full uninstall +
  ; reinstall (and delete the autostart value until the next launch). The
  ; guard is compile-time: the migration only exists in builds that actually
  ; rename.
  !if "${PRODUCTNAME}" != "Sovereign"
    !insertmacro MigrateRenamedInstall "Sovereign"
  !endif
  ; The lite variant. No guard needed: this file is used only by the full
  ; build, whose productName is never "Púca Lite".
  !insertmacro MigrateRenamedInstall "Púca Lite"
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
