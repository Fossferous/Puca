; The app an update comes back as: with its window, not in the tray.
;
; WHAT WENT WRONG (reported 2026-11-06: "puca doesnt currently reopen when
; update is complete"). The updater plugin runs this installer as
; `/P /UPDATE /R /ARGS <the arguments the RUNNING app was started with>`, and
; Tauri's template, in .onInstSuccess, starts the new exe with whatever follows
; /ARGS. Windows starts Puca at sign-in as `Puca.exe --hidden` (the autostart
; plugin, lib.rs), and the app reads `--hidden` as "start in the tray": it hides
; its window. So a Puca that was started by Windows, or that came back from an
; earlier update, carries `--hidden`; click Update in its window and the new
; version starts again with the same `--hidden`: the update installed, the app
; is running, and there is nothing on the screen. The new process carries
; `--hidden` too, so every later update did the same until the app was
; restarted by hand. Seen on the owner's PC: the relaunched Puca.exe, started
; nine seconds after the 0.9.858 installer wrote its files, had the command
; line `Puca.exe --hidden`.
;
; WHAT THIS DOES. A passive install (`/P`, what the Update button and Install
; updates automatically both run) puts a progress window on the screen: someone
; started it and is looking, so the app comes back with its window. This takes
; `--hidden` out of the command line the template reads. $CMDLINE is an
; ordinary writable NSIS variable and .onInstSuccess runs after the Install
; section, so editing it here is all it takes; no part of the template is
; replaced. Only `--hidden` goes: any other argument (a puca:// invite the app
; was started with) still reaches the new process.
;
; A SILENT install (`/S`) is left exactly as it is. That is a PC keeping itself
; up to date while nobody is there (host_update.rs): it must come back in the
; tray, and it has its own marker for that. Its command line is NOT a bare
; `/S`: the config's install mode supplies `/P` and host_update.rs adds `/S`
; after the plugin's arguments, so it reads
; `/P /UPDATE /R /ARGS <arguments> /S`, passive AND silent. `$PassiveMode = 1`
; alone would edit it; the test for silence is what spares it (found by the
; independent review of this change, 2026-11-06).
;
; THE TRADE-OFF. An update the app installs by itself at sign-in (Settings >
; Install updates automatically, off by default) is passive too, so the app
; that comes back from it shows its window rather than going to the tray. That
; install already put its progress window up.
;
; WHO OWNS IT. This is the NEW version's installer, which is the one that
; relaunches: the update TO the first version carrying this file is the first
; to come back with a window. The version being replaced does not matter.
;
; Kept in its own file, with no other macro in it, because
; scripts/check-installer-hooks.mjs compiles it and RUNS it in a stand-alone
; test installer (a copy of the template's relaunch lines that writes the
; arguments to a file instead of starting an app). That is only safe because
; nothing here touches the registry, the install folder or a process.
!include "WordFunc.nsh"

!macro RelaunchVisibleAfterPassiveUpdate
  ${If} $PassiveMode = 1
  ${AndIfNot} ${Silent}
    ; The space added at the end makes `--hidden` a whole word even when it is
    ; the last thing on the line; the StrCpy below takes that space off again.
    StrCpy $R9 "$CMDLINE "
    ${WordReplace} "$R9" " --hidden " " " "+*" $R8
    StrCpy $CMDLINE "$R8" -1
    ; WordReplace sets the error flag when there was nothing to replace.
    ClearErrors
  ${EndIf}
!macroend
