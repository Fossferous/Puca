; The `puca://` link scheme, registered by BOTH installers (full and Lite).
;
; WHY. An invite link clicked in a browser, a game launcher or another chat
; program is an https link, and Windows can only give an https link to a
; browser. The web invite page therefore offers "Open in the Púca app": a
; `puca://invite/<code>?host=<web app host>` link, which Windows hands to
; whatever is registered here. src-tauri/src/deep_link.rs parses it — and
; refuses anything that is not exactly that shape, because ANY website can
; fire one — and the most it can do is open the Join screen with the code
; looked up.
;
; WHAT IS WRITTEN, per user, no administrator rights (HKCU, like the rest of
; this currentUser install):
;
;   HKCU\Software\Classes\puca                      (Default) "URL:<product> invite link"
;                                                   "URL Protocol" ""
;   HKCU\Software\Classes\puca\DefaultIcon          (Default) "<install dir>\<exe>",0
;   HKCU\Software\Classes\puca\shell\open\command   (Default) "<install dir>\<exe>" "%1"
;
; <exe> is ${MAINBINARYNAME}, which Tauri's generated installer defines from
; the config the bundler used (Puca / Puca-Lite) — never a name typed here, so
; a variant can never register the OTHER variant's binary. "%1" is quoted: the
; whole link is ONE argument, and deep_link.rs refuses a command line that
; carries two.
;
; THE VARIANTS share the one scheme and replace each other, as they replace
; each other's installs: each installer first runs the other's uninstaller
; (MigrateRenamedInstall, PREINSTALL), then registers its own binary here
; (POSTINSTALL). An update re-registers the same way, so the key always names
; the binary that is actually installed.
;
; UNINSTALL removes the key ONLY while it still points at THIS install's exe
; (the same guard Tauri's own template uses for deep links): an uninstaller
; must never take away a registration that another install owns now.
;
; Every ${...} below is expanded where a macro is INSERTED, inside the
; generated installer's sections, after Tauri has defined PRODUCTNAME and
; MAINBINARYNAME — which it does AFTER including the hook files, so nothing
; here may use them at the top level. check-installer-hooks.mjs builds its
; harness in that same order, and preprocesses both variants to prove what
; is written and removed, and for which exe.

!macro RegisterUrlScheme
  DetailPrint "Registering puca:// invite links to open ${MAINBINARYNAME}.exe..."
  WriteRegStr HKCU "Software\Classes\puca" "" "URL:${PRODUCTNAME} invite link"
  WriteRegStr HKCU "Software\Classes\puca" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\puca\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKCU "Software\Classes\puca\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
!macroend

!macro UnregisterUrlScheme
  ReadRegStr $R7 HKCU "Software\Classes\puca\shell\open\command" ""
  ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    DeleteRegKey HKCU "Software\Classes\puca"
    DetailPrint "Removed the puca:// invite link registration."
  ${EndIf}
!macroend
