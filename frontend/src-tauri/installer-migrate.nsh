; Migrate an existing install of this app under an OLD product name to the
; current one, in place, instead of leaving a stale copy running side by side
; with a fresh one.
;
; WHY THIS EXISTS. On Windows, NSIS keys three separate identities off
; productName: the install directory, the Add/Remove Programs entry, and the
; autostart Run value. None of them are found by a build that uses a DIFFERENT
; productName -- Windows has no idea the two names are "the same app" -- so a
; naive rename produces a second, parallel install: two directories, two
; Add/Remove entries, two copies launching at login, both reading the SAME
; data directory (keyed by `identifier`, which is independent of productName
; and frozen -- see CLAUDE.md -- so it correctly carries over either way).
;
; This hook detects the OLD name's Add/Remove Programs entry and, if found,
; silently runs ITS uninstaller before this installer writes anything under
; the current name. NSIS_HOOK_PREINSTALL is the earliest hook Tauri provides:
; it fires before files are copied and before any registry key for the
; CURRENT productName is touched, so the old install is fully gone before the
; new one claims the install directory, Start Menu entry and autostart slot.
;
; APP DATA IS NOT TOUCHED. The uninstaller's "also delete app data" checkbox
; defaults to unchecked and is NEVER SHOWN in silent (/S) mode -- confirmed
; against the actual NSIS template this installer is built from. User
; messages, device keys, notes and settings live under %APPDATA%\<identifier>
; and %LOCALAPPDATA%\<identifier>; they are untouched by this hook.
;
; `_?=<dir>` forces the uninstaller to run WITHOUT its usual
; copy-itself-to-temp-and-relaunch trick, so ExecWait actually blocks until
; the old files, shortcuts, Add/Remove entry and autostart value are gone.
; Without it, ExecWait can return as soon as the relaunch happens, before the
; real cleanup runs -- leaving a window where stale registry state could
; survive the new install finishing.
;
; Safe to leave in permanently: on a machine that never had "Sovereign"
; installed (every future self-hoster who was never a Sovereign user), the
; registry read below finds nothing and this is a silent no-op.
;
; --- WHY OLD_BINARY IS A PARAMETER, AND WHAT THE RISK MODEL ACTUALLY IS ------
;
; The pre-install taskkill used to name ${MAINBINARYNAME}.exe -- the INSTALLING
; build's own binary, which is not the same thing as the binary of the install
; being migrated over, and which was "app.exe" for every variant while the
; Tauri crate was still called `app`. `taskkill /IM` matches by image name
; MACHINE-WIDE, `/F` skips save prompts and `/T` takes the tree, so that was
; "force-kill every process on this computer called app.exe".
;
; The earlier write-up called that acceptable because it sat on "a once-per-
; machine path" for the legacy Sovereign rename. THAT WAS WRONG, and the
; correction is the point of this comment: installer-hooks.nsh inserts this
; macro for "Puca Lite" UNCONDITIONALLY on every full install, and
; installer-hooks-lite.nsh does the same for "Puca" on every lite install.
; Switching between Full and Lite is an advertised, repeatable user flow (the
; two share their data deliberately), so the machine-wide kill fired on every
; variant switch, not once per machine.
;
; Naming the TARGET's binary removes that: each variant now installs under its
; own mainBinaryName ("Puca" / "Puca-Lite"), so the recurring Full<->Lite path
; kills a name only this product uses. Only the one legacy
; `MigrateRenamedInstall "Sovereign" "app"` call still names the generic
; binary, and that one genuinely is once per machine -- which is what the
; original reasoning claimed for all of them.
;
; THE 0.8.x TRANSITION. Installs made before the rename ran app.exe for BOTH
; variants, so the "Puca"/"Puca-Lite" install a first renamed installer
; migrates over is running app.exe, not Puca.exe. Killing only the new name
; would silently stop killing the running old-variant binary, and the file
; deletions below would then fail against a locked exe. So whenever OLD_BINARY
; is not already "app", app.exe is killed AS WELL -- same scoping as before,
; and only on the path that found an old install to migrate. Delete that
; second kill once no supported upgrade path starts from a pre-rename build.
;
; Path-scoped killing is not available: `wmic` is gone from current Windows 11,
; and `taskkill /FI "IMAGENAME eq ..."` filters by the same machine-wide image
; name it already matches on.
!macro MigrateRenamedInstall OLD_NAME OLD_BINARY
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_NAME}" "UninstallString"
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_NAME}" "UninstallString"
  ${EndIf}
  ${If} $R0 != ""
    DetailPrint "Found a previous '${OLD_NAME}' install - migrating it to ${PRODUCTNAME}..."
    ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_NAME}" "InstallLocation"
    ${If} $R1 == ""
      ReadRegStr $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_NAME}" "InstallLocation"
    ${EndIf}
    ; Strip the wrapping quotes Tauri's own installer writes around this value.
    StrCpy $R1 $R1 "" 1
    StrCpy $R1 $R1 -1

    ; The OLD install's main binary may still be running (e.g. the tray app
    ; kept alive for background notifications -- see CLAUDE.md). A locked file
    ; silently survives the uninstaller's own Delete calls below, so close it
    ; first. Ignoring the exit code is correct: the common case is nothing to
    ; kill. ${OLD_BINARY}, not ${MAINBINARYNAME}: the binary that has to stop
    ; is the one the install being replaced actually runs.
    ExecWait 'taskkill /F /T /IM "${OLD_BINARY}.exe"'
    !if "${OLD_BINARY}" != "app"
      ; ...and the pre-rename build of that same variant, which ran app.exe.
      ; See the transition note in this file's header; remove when no supported
      ; upgrade path starts from a pre-rename install.
      ExecWait 'taskkill /F /T /IM "app.exe"'
    !endif

    ExecWait '$R0 /S _?=$R1' $R2
    ; Belt and braces: the uninstaller above already does this, but if an
    ; older build's uninstaller predates that logic, or the run above failed
    ; partway, a stale Run value would try to launch a now-deleted exe on
    ; every future login.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${OLD_NAME}"

    ; VERIFIED AGAINST A REAL HISTORICAL INSTALL (2026-08-25): the old
    ; uninstall.exe is a COMPILED ARTIFACT from whatever Tauri CLI version
    ; built THAT release, not this one, and its own internal Delete-file list
    ; is outside this hook's control. In the real machine this was tested
    ; against, it correctly removed the Uninstall key and shortcuts but left
    ; several of its own bundled binaries and a log file on disk. This runs
    ; regardless of what that out-of-our-control old binary actually did.
    ; RMDir does not fail the install if something cannot yet be removed --
    ; the one case observed in testing (the running uninstall.exe unable to
    ; delete itself) is a file Windows clears at the next reboot via its own
    ; delayed-delete mechanism, which the uninstaller sets up itself.
    RMDir /r "$R1"
  ${EndIf}
!macroend

; --- Why this now lives in its own file -------------------------------------
; Two hook files need this macro: the full build removes a legacy "Sovereign"
; install AND the lite build, and the lite build removes the full one. NSIS
; refuses a duplicate !macro definition, so it is defined once here and
; included by both.
