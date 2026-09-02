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
    ; "app" is this product's pre-rename binary name, and the ONLY call that
    ; still names it -- genuinely once per machine. See installer-migrate.nsh.
    !insertmacro MigrateRenamedInstall "Sovereign" "app"
  !endif
  ; The lite variant. No guard needed: this file is used only by the full
  ; build, whose productName is never "Púca Lite". The binary name is the LITE
  ; build's mainBinaryName, not this build's -- see installer-migrate.nsh for
  ; why that distinction is the whole fix.
  !insertmacro MigrateRenamedInstall "Púca Lite" "Puca-Lite"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro RepairShortcutsToRenamedBinary
!macroend

; Remove the LocalSystem service the FULL build can install, before the app's
; own files go.
;
; WHY THIS IS NOT OPTIONAL. `SovereignRemote` runs as LocalSystem, starts at
; boot, and lives in %ProgramFiles%\Sovereign\service — OUTSIDE the app's
; install directory, so the uninstaller's own file removal never touched it —
; holding this machine's enrolment secrets. Uninstalling through Add/Remove
; Programs left all of that registered and running: the user believes they
; removed a chat app and has in fact kept a SYSTEM-privileged remote-access
; service. That is the worst thing an uninstall can leave behind, and "the app
; has an in-app leftover detector" is no answer once the app is gone.
;
; ELEVATION. Deleting a service needs administrator rights, which a
; currentUser-mode uninstaller does not have. So: try, and when it fails TELL
; THE USER exactly what remains and the commands that remove it. Silence here
; would be worse than not trying at all. The dialog is suppressed under /S,
; because a silent uninstall must never block waiting for a click.
!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'sc query "SovereignRemote"'
  Pop $R0
  ${If} $R0 == 0
    DetailPrint "Removing the SovereignRemote background service..."
    nsExec::Exec 'sc stop "SovereignRemote"'
    Pop $R1
    nsExec::Exec 'sc delete "SovereignRemote"'
    Pop $R1
    ${If} $R1 == 0
      DetailPrint "SovereignRemote removed."
      RMDir /r "$PROGRAMFILES64\Sovereign\service"
      RMDir "$PROGRAMFILES64\Sovereign"
      ; The machine-wide secure-attention policy the service set, removed the
      ; same way rc_leftovers.rs does it: ONLY when our own ownership marker
      ; says the value is ours. Without this the uninstall leaves an
      ; unattributable HKLM policy behind — SoftwareSASGeneration permits
      ; software-generated Ctrl+Alt+Del, and an admin later auditing this
      ; machine has no way to tell what set it or whether it is still needed.
      ; Never delete a policy we did not set: the marker is the whole check.
      ReadRegDWORD $R2 HKLM "SOFTWARE\Sovereign" "SovereignSetSoftwareSAS"
      ${If} $R2 == 1
        DeleteRegValue HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" "SoftwareSASGeneration"
        DeleteRegValue HKLM "SOFTWARE\Sovereign" "SovereignSetSoftwareSAS"
        DeleteRegKey /ifempty HKLM "SOFTWARE\Sovereign"
        DetailPrint "Secure-attention policy restored."
      ${EndIf}
    ${Else}
      ; LogicLib rather than a relative `IfSilent +2`: ${If} blocks compile to
      ; several instructions, so a hand-counted jump inside one is fragile.
      ${IfNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION|MB_OK "Puca could not remove its background service, because that needs administrator rights.$\r$\n$\r$\nThe service 'SovereignRemote' is still installed and still starts with Windows. To remove it, open Command Prompt as administrator and run:$\r$\n$\r$\n    sc stop SovereignRemote$\r$\n    sc delete SovereignRemote$\r$\n$\r$\nThen delete this folder:$\r$\n    $PROGRAMFILES64\Sovereign\service"
      ${EndIf}
    ${EndIf}
  ${Else}
    ; NO service registered, but the folder may still be there: enrolment
    ; copies the binaries and writes the machine's secrets BEFORE it registers
    ; the service, so a provision that failed part-way (seen in a clean-Windows
    ; sandbox run: the copy succeeded, the service install did not) leaves a
    ; keyed folder under Program Files with nothing pointing at it. The branch
    ; above only ever ran when the service existed, so that folder survived
    ; every uninstall. Removing it needs the same rights as removing the
    ; service; when we lack them, say so rather than pretend.
    ${If} ${FileExists} "$PROGRAMFILES64\Sovereign\service\*.*"
      DetailPrint "Removing a leftover service folder (no service was registered)..."
      RMDir /r "$PROGRAMFILES64\Sovereign\service"
      RMDir "$PROGRAMFILES64\Sovereign"
      ${If} ${FileExists} "$PROGRAMFILES64\Sovereign\service\*.*"
        DetailPrint "Could not remove $PROGRAMFILES64\Sovereign\service (needs administrator rights)."
        ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION|MB_OK "Puca could not remove a leftover folder from an earlier enrolment, because that needs administrator rights.$\r$\n$\r$\nIt holds this machine's sign-in-screen secrets. Please delete it yourself:$\r$\n    $PROGRAMFILES64\Sovereign\service"
        ${EndIf}
      ${Else}
        DetailPrint "Leftover service folder removed."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
