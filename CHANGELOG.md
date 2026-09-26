# Changelog

User-facing changes per release, newest first. The desktop updater shows the
one-line summary; this file is the full story. Versions follow
`frontend/src-tauri/tauri.conf.json`.

## Unreleased

### Security
- **The server and the LAN waker use a current web library too.** 0.9.823
  moved the sign-in-screen service off an old version of its web library
  that carried a published denial-of-service flaw; the server's own outbound
  requests (to Google for phone wake-ups, and to the voice server) and the
  LAN waker's token renewals were still on it. Both now use the current one,
  and the flaw is gone from every part of Púca. Nothing changes in how they
  connect; their logs keep saying why a request failed (refused, name not
  found, certificate rejected, timed out), which the new library no longer
  does by itself. Server and waker only: no app update is needed for this.

## 0.9.823 — 2026-09-26

Stream diagnostics now cover the sending side, and the sign-in-screen service moves to a current web library.
### Improved
- **A slow or choppy stream now explains itself in the log.** A stream that
  arrives at 22 frames a second with nothing lost on the way was decided on
  the streamer's computer, and until now nothing there said why. Once a
  minute during a call, the desktop app's log now records, for each video you
  send, the frame rate you chose, how many frames a second actually reached
  the encoder, how many were sent, at what size, whether the computer was
  lowering the picture to keep up, and whether the graphics card or the
  processor was doing the encoding. So "the screen only changed 22 times a
  second" and "the computer dropped frames" are no longer the same thing in
  the log. Calls that go directly between people, not through the server, are
  now covered too, for incoming video as well as outgoing.

### Security
- **The sign-in-screen service uses a current web library.** The Windows
  service that keeps a computer reachable at its sign-in screen talked to
  your server through an old version of its web library, which carried a
  published denial-of-service flaw in a part it never used. It now uses the
  current one, and the flaw is gone from the desktop app entirely. Nothing
  changes in how it connects. When it cannot reach your server, its log now
  says why (refused, name not found, certificate rejected, timed out)
  instead of only that it failed. After updating, open Púca and choose
  **Update the service** when it asks.

## 0.9.822 — 2026-09-26

Guessing an unattended passphrase is now slow, and remote file access never offers the disk's own system files.
### Security
- **Guessing an unattended passphrase is now slow.** The passphrase is the
  second lock on unattended access, after your account password. Each try
  was already single-use, but nothing limited how quickly someone could keep
  asking, so whoever had your account password could guess the passphrase as
  fast as their connection allowed. Now, after five wrong passphrases in a
  row, the computer makes them wait 30 seconds, and each further miss doubles
  the wait, up to 15 minutes. The right passphrase clears the count. If it is
  you who mistyped, the remote screen says how long to wait.
- **A correct passphrase can no longer be lost on the way in.** Both ends of a
  remote-control session share one key, so a relay could send the computer
  one of its own messages back. The computer ignored it, but still counted it,
  and could then discard the controller's real passphrase proof as a repeat.
  It now refuses its own messages outright.
- **Remote file access never offers the system's own `$` files.** The disk's
  internal files (such as `$MFT`) and Windows' servicing folders at the top of
  each drive are now refused, like the page file already was. And every
  refused write now appears in the file-access log, including one refused
  before any file was opened.
- **The sign-in-screen service checks device signatures strictly.** It now
  refuses the special "weak" keys that can appear to sign anything. The key
  it checks against is made on your own device, so this closes a door nobody
  could open today.

## 0.9.821 — 2026-09-26

A clip buffer can no longer keep recording after it has been switched off: the app checks once a minute and stops any capture nothing owns.
### Fixed
- **A clip buffer can no longer keep recording after it has been switched
  off.** The desktop app records clips with a screen and sound capture that
  has no "you are being recorded" bar of its own; the only signs that it is
  running are the app's own clip status and the badge next to your name. If
  that capture ever outlived the buffer that owned it, it kept using the
  graphics card and the processor with nothing on screen to say so, and
  switching the buffer back on failed with "Already capturing video", until
  the app restarted. The app now checks once a minute, stops any such
  capture within two minutes, and writes a line in its log saying it did.

## 0.9.820 — 2026-09-26

Sitting in a voice call costs far less: no more redrawing the window 165 times a second for speaking rings and LIVE badges, and one person talking no longer redraws the whole app. The clip buffer hands frames over as raw bytes, and calls now keep a minute-by-minute health line in the log.
### Fixed
- **Sitting in a voice call costs far less.** Measured in a six-person call
  on the integrated graphics the desktop app uses: its graphics load fell
  from about 18% to under 2%, and the processor time it needs by about 60%. The speaking rings, the LIVE badges and the "watch" buttons
  pulsed forever in a way the graphics card cannot do cheaply, redrawing the
  window 165 times a second on a 165 Hz screen for as long as anybody talked
  or streamed. Speaking rings are now a steady ring that switches with the
  voice, and LIVE badges pulse three times when they appear, then hold still.
  And every time somebody started or stopped talking, the whole app used to
  redraw itself, messages included; now only that person's row does. On a
  laptop or a PC whose graphics chip also runs the screen, this is the
  difference you are most likely to feel during a long call.
- **The clip buffer costs the app less while it records.** Every recorded
  frame used to reach the app as text: converted to base64, wrapped, handed
  over and converted back on the app's main thread, about 1.3 MB a second
  for as long as the buffer was armed. Frames now arrive as raw bytes and go
  straight to the recorder. Clips themselves are unchanged.
- **Spinners no longer jump.** Two different spinning animations shared one
  name, so whichever loaded last knocked the other one half its height off
  centre. The same kind of clash affected a few pulsing indicators.
- **"Copy diagnostics" no longer gets stuck on "Measuring…".** A step that
  never answered — most often the clipboard, when its permission prompt
  opened somewhere you could not see it — kept the report waiting forever.
  Every step now gives up after a few seconds and the report says which one
  did not answer, and the rest of it is still copied (or printed to the
  developer console when the clipboard refuses).

### Added
- **A health line in the log during calls.** Once a minute while you are in
  a call, Púca writes one line to its log file: how any stream you are
  watching is arriving, how each incoming voice is holding up (buffering,
  gaps, speed-ups), how responsive the app itself is, its memory, and the
  noise filter's and clip buffer's state. It contains no names or message
  content. If a call ever degrades after hours, the log already holds what
  changed, instead of the evidence being gone by the time anyone looks.

## 0.9.819 — 2026-09-25

Clips no longer come back with choppy audio; switching screens in remote control shows the new screen; and a round of fixes so offline and two-device edits in Púca Notes no longer duplicate, drop or overwrite notes, pictures, recordings or ticks, and sessions end when they say they do.
### Fixed
- **Clips no longer have choppy audio.** A clip saved while the buffer was
  armed automatically could come back with its sound broken up: short
  stretches cut out or padded all the way through, and your microphone
  wavering in pitch, although it had all sounded fine live. Your computer's
  sound and your microphone now play through a clip as one continuous
  track, still lined up with the picture. The desktop sound capture also no
  longer falls behind when the computer is busy (a game, say), which could
  lose moments of sound outright.
- **Ticks made on an out-of-date screen are caught in more cases.** A tick
  could still end a repeat another device had just set up: if the repeat was
  saved in the same moment as the tick, if you had edited the item's text
  (or its pictures, due time or snooze) on this device first — offline, or
  before the list reloaded — or if you had added an item to the list since
  it last loaded. Each of those is now refused with *refresh and try again*
  (or listed as not saved, for a change queued offline). The same goes for
  moving a repeating item on to its next time after its repeat was removed
  on another device, which used to put the repeat back, and for ticking an
  item after another device moved something with a repeating item inside it
  under it.
- **Switching screens in remote control shows the new screen, not the old
  one.** Switching to a screen where nothing was moving could keep showing
  the screen you had just left, while your clicks already landed on the new
  one, until something on it happened to redraw. The old picture is no
  longer sent: the new screen appears as soon as it draws, and a screen that
  stays completely still is prompted to redraw within about a second (and
  again whenever your device asks for a fresh picture). The
  same holds when a display change moves the session onto a different
  screen, including when the screen you were watching sleeps or is
  unplugged and another one takes its place.
- **Switching to All Displays no longer blacks out the screen you were
  on.** Zooming back out to All Displays in remote control, or picking it
  from the screen list, could show the screen you had just been watching
  as a black rectangle beside the others, if nothing on it was moving,
  until something there happened to redraw. It now keeps the picture you were already looking at. If that
  picture cannot be used (just after a display change, say), the screen is
  prompted to redraw within about a second, the same way a switch to a
  still single screen is, instead of staying black until something on it
  changes.
- **"Stay signed in" now ends when it says it does.** A session renewed in
  its last month used to get a fresh 30 days, so a year-long sign-in could
  last until about day 395 (and an ordinary 30-day one until about day 31).
  Every renewal now stops at the cap: a year after you signed in with the box
  ticked, or 30 days without it, the password is asked for.
- **An expired session is no longer quietly extended.** A request that
  arrived in the minute after your session expired could renew it for another
  day (or month). That request is still served, but the session is not
  renewed: it ends and the sign-in form appears, as it always said it would.
- **Signing out one session, or revoking a device, always reaches it.** If
  the server hit a database error at the exact moment of a sign-in (or of a
  device's own sign-in), it used to let you in anyway with a session that
  "Sign out" and "revoke device" could not reach, only "Sign out of every
  device" or a password change. It now refuses that one sign-in instead; try
  again and it goes through. A computer signing itself in with its own key
  retries on its own within a minute, and does not report the server as having
  refused it.
- **A device revoked while it was connecting is really signed out.** A
  device you revoked at the moment its connection was identifying itself could
  stay connected as that device until it disconnected; it is now refused or
  hung up.
- **A tick made on an out-of-date screen no longer ends a repeating
  reminder.** If you ticked an item while offline (or on a screen that had
  missed an update) and meanwhile another device gave it — or something
  under it — a repeat, the tick used to complete it and its reminders
  silently stopped. Now the server refuses that tick: you see *refresh and
  try again* (or, for a change queued offline, it is listed as not saved)
  and can tick it again on the up-to-date note. The same goes for ticking a
  repeating item on to its next time with an old copy of its repeat rule,
  which could overwrite a change made on another device. Another device
  changing the date, repeat, tick or place of any dated item under the one
  you tick counts as a change, since the server cannot see which dates
  repeat; a change to its text, pictures, due time or snooze does not, your
  own edits on this device never do, and after a refusal the list reloads
  so you can tick again.
- **Live updates recover after a database restart.** When the server's
  connection for change notifications dropped, Púca Notes kept showing a
  "live" note that no longer updated — with the 30-second refresh off —
  until you switched away and back. Every open note is now told to reload
  as soon as the server is listening again — and on a server whose idle
  connections are cut every few minutes, changes keep arriving at once
  instead of up to 30 seconds late.
- **Signing out and in as someone else no longer mixes your note colours and
  labels.** A colour/label sync still running when one person signed out of
  Púca Notes or Púca (neither reloads the page) could finish after the next
  person signed in on the same browser, copying the first person's labels,
  colours, archive flags and reminder times into the second person's notes,
  and from there to their other devices. It could also leave the first
  person's last-synced labels in the browser's storage after the sign-out had
  cleared them. A sync now stops as soon as the account it started for is no
  longer the one signed in, and one that fails after that no longer shows
  the next person a false "offline" or error.
- **A fast swipe between Púca Notes' lists moves one list, not two.** A swipe
  that went past half-way and was then flicked could carry on past the next
  list and land on the one after it. Every swipe now stops on the next list,
  however fast, the way Google Tasks moves between lists; tapping a tab or a
  label in the rail still goes straight to that list.
- **The grid/list button in Púca Notes now does something on a phone.** On a
  phone or a small tablet the notes were always one column, so the button at
  the top right only swapped its own icon. Grid view is now two columns, like
  Google Keep, and list view one. Drag-to-reorder lives in list view there, as
  it already did on a computer; in grid view the card menu's *Move* items do
  the same job.
- **A voice note made with no signal keeps its recording.** Recording a clip
  in *Take a note…* and pressing Done while offline (or while other changes
  were still waiting to sync) saved the note without the recording and said
  nothing; the clip was gone. It is now encrypted on the device and sent with
  the note when the connection returns, like a photo. A note that is only a
  recording is called "Voice note" rather than "Untitled note".
- **A note whose save timed out is no longer made twice, or left with broken
  pictures.** If the connection dropped just after the server had saved a new
  note, Notes said it couldn't save it, deleted the uploaded pictures the saved
  note still pointed to, and pressing Done again made a second copy. Now the
  pictures are only deleted when the server definitely refused the note, and
  pressing Done again on the same draft finishes the note that was saved
  instead of making another. The same holds for *Make a copy*, for pictures
  added to a note, for pictures waiting to sync, and for *Save to Notes* in
  Púca. On a server that has not been updated yet, pressing Done again still
  makes a second note, as it always did, but the two never share pictures, so
  deleting the extra one can never break the one you keep.
- **Text typed offline no longer silently replaces newer text from another
  device.** If you edited a note's text with no connection while the same
  note's text was changed on another device, your offline version used to
  overwrite theirs when the connection came back, with nothing to say so. Now
  the note keeps the other device's text, and yours is kept as a new note
  beside it, "*title* (offline copy)", with a message telling you. Text you
  go on typing into that note goes into the same copy rather than a new one
  each time. Your own earlier changes to the note on the same device never
  count as a clash.
- **A save that gets no answer no longer duplicates a note, loses your words
  or breaks a picture.** When the connection dropped just as the server saved
  something: a photo or drawing added in Púca's Tasks view had its upload
  deleted although the note had saved it, leaving a broken picture for good
  — it is now kept, and you are told it may or may not have been saved.
  Pressing Done again on such a note in Notes with no connection (or while
  other changes were still waiting) queued it as a new note, so it could be
  made twice; that press now says the note may already have been saved and
  keeps your draft for when it can be sent. Text typed offline whose earlier
  "(offline copy)" had since been deleted for good was dropped; it now goes
  into a new copy. And a new copy whose save got no answer was made again on
  every retry; it is now made once.
- **A colour-and-label choice left waiting at sign-out no longer touches the
  next account.** Pressing *Keep this device's* or *Use the server's copy*
  while an earlier sync was stuck, then signing out, could run that choice
  for whoever signed in next on the same browser — and *Keep this device's*
  then replaced their colours, labels, archived notes and reminder times on
  every device with this browser's nearly empty copy. A sync now belongs to
  the sign-in that asked for it, and does nothing once you have signed out.
- **Two devices adding pictures to one note at the same moment no longer lose
  one of them.** When two phones synced pictures into the same note at once,
  or a picture was removed on one device while another added one, the second
  save could silently drop the first device's picture for good. Each save now
  checks that the note has not changed since it looked, and if it has, adds or
  removes its picture on top of the other device's change. *Save to Notes* in
  Púca no longer drops a picture or a paragraph added elsewhere while its sheet
  was open.
- **Self-hosting: the backend migration check no longer passes a database it
  could not read.** `dual-ship.sh backend`, and the rollback check
  `DUAL_SHIP_PREFLIGHT_ONLY=1`, printed "migrations byte-match" when the read
  of a host's migration history failed outright (postgres down, a `DB_NAME`
  in `hosts.conf` naming no database, ssh unreachable), because a failed read
  looked like an empty history. They now refuse and say the history could not
  be read. A freshly provisioned host with no migrations yet still passes, with
  a note, and is reported as "nothing to compare" rather than a byte-match. A
  host with a backend installed but no migration history in `DB_NAME` is
  refused: either that is the wrong database or the backend has never started
  against it, and the message names both.
- **Self-hosting: a phone update is only reported shipped when the download
  host serves the signed bundle's exact bytes.** The three mobile update
  channels (`dual-ship.sh mobile`, `mobile-lite`, `mobile-notes`) accepted any
  HTTP 200 at the bundle's address, so a download host serving other bytes
  there read as a successful ship while every phone refused the update. They
  now compare the served file's SHA-256 with the bundle, as the installer and
  APK uploads already did — and the status too: the right bytes answered with
  a 404 or 500 (which the phone's downloader refuses) no longer pass.
- **Changing your password says what it does not do.** A new password signs
  you out of Púca everywhere else, but computers and phones enrolled in My
  Devices stay enrolled so that remote access keeps working. The password
  settings now say so, and point to *Sign out on all devices* for a lost or
  stolen machine; the security notes no longer claim the opposite.
- **Developers: the Devices phone walk fails when the This-device panel does
  not render.** `frontend/e2e/devices-mobile-walk.mjs` logged page errors
  without counting them and measured the This-device tab without checking it
  was there, so a crash that emptied the page passed. It now requires the
  panel, the selected tab and zero uncaught page errors.

### For developers
These change nothing in the app; they are about running the backend's own
tests.
- **A plain `cargo test` no longer touches your dev database.** Several
  database-backed backend tests loaded `.env` and fell back to
  `DATABASE_URL`, so in a checkout configured for a local dev database they
  migrated it and wrote test rows into it. Every one of them now reads
  `TEST_DATABASE_URL` and nothing else, and none loads `.env`: with only
  `DATABASE_URL` set they skip without opening a connection. If you kept
  `TEST_DATABASE_URL` in `.env`, export it in your shell instead.
- **A test database that is down now fails the tests instead of skipping
  them.** With `TEST_DATABASE_URL` set but the database stopped, misnamed or
  refusing the password, every database-backed test used to print "skipping"
  and pass, often after a 30-second wait each. They now fail at once and say
  why. Unset `TEST_DATABASE_URL` to skip them on purpose. The tests inside
  the server crate now also migrate the database first, so a full `cargo
  test` against a fresh throwaway database no longer fails at random with
  `relation "users" does not exist`. The separate test files in `tests/` do
  not migrate: run one of them on its own (`cargo test --test api_auth`)
  only against a database that the server or a full `cargo test` has
  already migrated.

## 0.9.818 — 2026-09-23

Púca Notes: swipe left and right between All notes and each label like Google Tasks' lists, and scroll each like Keep; "Stay signed in on this device" keeps the session alive for up to a year instead of a day; the Reminders tab reads properly on a phone.
### Added
- **Swipe between your lists.** The notes grid is now a row of pages: *All
  notes* first, then one page per label, with a tab strip above it. Swipe
  sideways on a phone, flick the trackpad or click a tab on a desktop, and
  scroll down inside a page as before, and each list keeps your place when
  you swipe away and back. The rail still works and the addresses
  are the same ones (`/` and `/label/<name>`), so a link to a label still
  lands on it. A tab or the rail adds a step to the back button; a swipe does
  not. A half-typed *Take a note…* survives a flick away and back, and
  dragging a note by its grip still reorders it rather than swiping. With no
  labels there is nothing to swipe between, so neither the strip nor the
  pager appears.
- **Stay signed in on this device.** Púca Notes' own sign-in now has a tick
  box — already ticked in the Notes phone app, clear in a browser until you
  tick it — that keeps this device signed in for up to a year rather than a
  day, as long as it is used at least once a month. On the Notes phone
  app the background reminder check counts as use, so a phone that is switched
  on can stay signed in for the year even if Notes is never opened. It is what
  stops the app asking for your password after a weekend with the phone off: until
  now a session lasted 24 hours and only stretched when you used it, so time
  away — not inactivity in the app — was what sent you back to the sign-in
  form. **In a browser it covers Púca too:** Notes and the web app share one
  sign-in there, so a ticked Notes sign-in keeps Púca in that browser signed
  in for as long, and the line under the box says so. That is why a browser
  starts with the box clear: tick it on your own computer, and a shared or
  borrowed one signs in exactly as before unless someone asks otherwise. Sign out ends the session immediately on this device. **To end it
  from anywhere else — a lost phone, a computer you left signed in — use Sign
  out of every device, or change your password.** Revoking the device under
  My Devices does not reach it: Notes never proves a device to the server, so
  its session belongs to none. The choice is remembered per device, including
  after you sign out, and an expired session suggests the box only when it is
  clear.

### Changed
- **Sessions can be long now, if you ask.** The server understands the new
  request: a session opened with the box ticked carries a 30-day pass that
  renews as it is used, up to a year from the day you signed in, after which
  it asks for your password again. Every session opened without it is
  unchanged — 24 hours, renewed as you go, one month at the outside. Púca's
  own sign-in does not offer the box yet: a sign-in there opens the ordinary
  session, and the option can be adopted later. (In a browser Púca uses
  whatever session Notes opened, long or not — they share one sign-in.)

### Fixed
- **Reminders: on a phone the item text no longer collapses to one character
  per line.** In the Reminders tab — Púca Notes' and the one in Púca's own
  Tasks view — a phone gave an item's own words only the few pixels the due
  time, the note's name and the buttons beside them left over, so the item
  read downwards, one letter at a time. Each row now gives its text the whole
  first line beside the tick box (or a note's bell), and puts the repeat and
  snooze marks, the note's name, the time and the buttons on a second line
  underneath; a long note name is shortened with "…" rather than pushing the
  buttons onto a third line. The snooze button keeps to the right edge even
  when it gets a line to itself — under an open time field, say — so its
  menu no longer opens off the left of the screen. Nothing moved on a
  desktop.

## 0.9.817 — 2026-09-22

Púca Notes grows up: share into it from any app, voice notes, a reminder on a note itself, text and pictures while offline, undo in the editor, a label manager, links, drag ordering, search that shows its matches, and its tools in Púca too; remote control no longer freezes on a screen that is not changing; Keep RNNoise keeps RNNoise; clip sound stays in step with the picture.
### Changed
- **Make a copy now copies the whole note.** A copy used to carry only a
  note's text and its unticked items, flattened. It now brings the pictures
  and drawings, every item including the ones already ticked, their nesting,
  and their dates and repeats — and it takes the note's colour and labels
  (never its pin, and never the archive). The pictures are encrypted again for
  the copy, so deleting one note forever never affects the other's; they count
  against your storage twice. Two things it no longer does quietly: a note
  holding something this device cannot read is refused with a message instead
  of copied with that part missing, and a note whose items are still loading
  is no longer copied to an empty note that says "Copied". A copy that fails
  — offline, or because the server said no — now says so, rather than
  leaving the screen unchanged with nothing to tell you it did not happen.

### Added
- **Share into Púca Notes.** On Android, Púca Notes now appears in the share
  sheet. Send it text, a text file or a picture from any app and its composer
  opens with that content already in it — a shared text file arrives as the
  note's words rather than as an attachment. You still choose the title, add
  whatever else you want, and press Done. Nothing is saved until you do, and
  what you shared is encrypted with your key like everything else in a note.
  It comes with the new Púca Notes app, not with the web update.
- **Faster ways into Púca Notes on Android.** Long-press the app icon for New
  note, New list or Reminders; add a Quick Settings tile that opens a new note
  from the notification shade; or put a home-screen widget on a home screen for
  a new list, a new note, a drawing or a photo. None of them shows anything
  about your notes — no titles, not even how many things are due — so the
  launcher, the shade and the home screen learn nothing, and the tile asks you
  to unlock first. These arrive with the new Púca Notes app.
- **A due reminder opens the item.** Tapping the reminder notification when a
  single item is due now opens that item's note with the item flagged, instead
  of the list of reminders; when more than one is due it opens Reminders, as
  before. A repeating item that comes due again opens its note again, however
  many times it fires while the app is open. The same tap works from the
  desktop app and the browser. Only the item's number travels in the
  notification — what the item says is still never in it, on the lock screen,
  or anywhere else.
- **Voice notes in Púca Notes.** Record a note instead of typing it, from the
  composer or from an open note. The recording is encrypted on your device
  and stored like a photo, and it plays back — only when you press play — in
  Púca Notes and in Púca's Tasks view. On Android 13 and newer, where the
  phone can do it without sending anything anywhere, Púca Notes also writes
  down what you said and puts the text in the note, so you can search for it
  later. Where the phone cannot write it down on its own it says so and keeps
  the recording, rather than sending it to anyone else. The microphone is used
  only while you are recording, with the app on screen, and Púca Notes asks
  before it uses it the first time. Needs the new Púca Notes app from the
  download page.
- **A reminder on a note.** A note can now remind you by itself, with no
  checklist item to hang the time on — write "call the vet" and give the note
  a time from the clock in its footer. *Date & repeat* is there too, so a note
  can be an all-day thing, repeat, carry a place or a few alerts. It appears
  in Reminders and on the calendar as the note it is, not as a to-do — in
  Púca Notes and in Púca's own Reminders and Calendar tabs, where the clock
  beside a list's name sets one and the reminder's own row clears it — and
  your phone tells you about it the same way it tells you about an item. It is
  encrypted like the rest of the note: as with items, the server sees only
  when, never what, and *Keep the time private from the server* hides even
  that. A note in the trash stays quiet, and gets its reminder back if you
  restore it.
- **Two devices, one note.** If a note's text, title or pictures were changed
  somewhere else while you were writing, Púca Notes now tells you and shows
  you both copies, with *Keep mine* and *Use theirs* — instead of quietly
  replacing one with the other. Your words stay in the field until you
  choose, nothing is saved while the question is on screen, and a title you
  are typing is no longer wiped by a rename arriving from another device.
  Ticking an item or reordering a note is never treated as a clash.
- **A note or item created on a flaky connection can no longer appear twice.**
  When Púca Notes sends a new note or item and the answer never arrives, it
  sends it again — and the server now recognises the repeat and gives back
  the note it already made, instead of making a second one. Duplicates used
  to turn up with no way to tell which copy held your later edits. Púca's own
  Tasks view and its calendar do the same when you press the button again
  after a create fails.
- **A note can hold any file, not just pictures.** Attach a PDF, a ticket, a
  spreadsheet — to a whole note or to a single item — and it is end-to-end
  encrypted like everything else. The note shows it by name and saves it back
  to your device when you tap it (on a phone, into Documents/Puca Notes). For
  safety a file is always a download and never opens inside Púca. Files are
  capped at 25 MB each and count towards your storage, and the old caution
  still applies: a note that expires from the Trash while no Púca Notes is
  open leaves its files on the server.
- **Notes written and photographed with no connection.** A note's text and
  its photos, drawings and files no longer need a signal. Type a note on a
  plane and it is kept on your device — the field says so — and sent as one
  change when you are back. Take a picture with no signal and it is encrypted
  straight away, shown on the note from your own device meanwhile, marked
  *Not sent yet*, and uploaded when the connection returns. A banner counts
  what is waiting, pictures and files included. There is a limit to how much can wait on
  the device, and Púca Notes tells you plainly when you reach it — and
  because the browser can clear a site's storage, pictures waiting are not a
  backup. Turning a note's text into a checklist still needs a connection.
- **Reset a checklist in one go.** A note's foot now has *List actions*:
  *Uncheck all* puts every ticked item back, and *Delete checked* removes them.
  Both offer Undo, and Undo brings deleted items back with their dates,
  repeats, pictures, their ticks and their place in the list — a ticked
  subtask goes back under the item it was under. If a repeating to-do whose
  series has already finished is among the ticked items, Púca Notes asks
  first — unticking it would reopen a repeat with no next time. Ticked items
  were always at the bottom in their own Completed section, so there is
  nothing to move.
- **Tappable links in notes.** A web address in a note's text, or in one of
  its items, is now a link you can tap — in Púca Notes and in Púca's Tasks
  view. Púca works out where the link goes from the text on your device: it
  never asks the internet anything to show you a link, so opening a note tells
  nobody that you are reading it, and you will never see a fetched page title
  or site icon. Only ordinary web addresses become links, and they open in
  your browser rather than inside the app. On the card grid a link is marked
  but not tappable, so tapping the card still opens the note.
- **Paste and drop into a note.** In Púca Notes, paste a screenshot straight
  into a note, or drop a picture onto it, instead of saving it to disk first.
  Pasted pictures are made smaller and encrypted on your device exactly like
  picked ones, and a paste with no connection says so rather than half-adding
  it. Paste several lines into a list and Púca Notes asks whether to make one
  item per line, showing you the lines first — items are removed one at a time,
  so it asks before it creates. Pasting text that happens to carry a picture
  alongside it — a table copied out of a spreadsheet, a paragraph out of a
  document — puts the text in the note, not a picture of it. (Púca's Tasks
  view shows the same notes and the same links, but pictures go in there
  through the picker, as before.)
- **Undo a deleted item.** Deleting an item inside a note now offers Undo for
  a few seconds, and brings the item and everything under it back with its
  date, repeat, snooze, pictures and tick state — a repeating to-do comes
  back on the date it was on, not the next one. A subtask deleted on its own
  comes back under the item it was under, and a branch that was only part
  done comes back part done. Its pictures are kept for as
  long as Undo is offered and deleted afterwards; before, they stayed on the
  server counting against your storage for good. An item brought back is a
  new item: in a shared note it is now yours, and it comes back at the end of
  its group.
- **Undo and redo a note's text.** While a note is open you can step back and
  forward through what you typed — with Ctrl+Z and Ctrl+Shift+Z, or the pair
  of buttons that appears under the text, so it works on a phone as well. A
  paste undoes in one step, even after the note has saved it. The history
  lives only on the page you are typing on: it is never written to the
  offline copy, it starts again when an edit arrives from another device, and
  it goes when you close the note.
- **Search shows you where it matched.** Púca Notes now highlights the words
  you searched for in a note's title, its text and its items, shows a piece
  of a long note around the match instead of its opening lines, and tells you
  when a note matched something the card does not show — a ticked item, an
  item further down the list, or a place on a date. Opening a result counts
  its matches and steps through them. Searching still happens only on your
  device, and a note that cannot be decrypted is never searched.
- **Drag a note into place, and *Move to bottom*.** In list view — and on a
  phone in either view — a note can be dragged by the grip beside its title
  to reorder it, with a line showing where it will land. Pinned notes
  reorder among the pinned ones. The card menu keeps *Move to top*, *Move
  up*, *Move down* and now *Move to bottom* as well, so ordering still works
  without a drag, on any screen. The order is the same one Púca's Tasks tab
  bar uses, and notes hidden by a filter, by the archive or sitting in the
  trash keep their places.
- **Rename, merge or delete a label everywhere.** *Edit labels*, beside
  Labels in Púca Notes' sidebar, lists your labels with how many notes
  carry each one — archived notes included — and lets you fix a typo,
  fold one label into another, or take one off every note at once, with
  an Undo that puts the list — and the label view you were reading — back. Until now a label could only be changed one note at a time,
  and a label left on an archived note could not be reached at all.
  Labels stay encrypted with your own key: the change is one write of
  the same sealed list, and the server still cannot read a single name.
- **Send a note into Púca.** From a note's menu — or the open note — *Send to
  Púca…* posts it as a message in one of your channels or to someone in a
  direct message: the shopping list, in the chat, without copying and pasting.
  Púca Notes always asks first and names where it is going, because a note
  sent to a channel can be read by everyone in it and cannot be unsent. It
  offers only channels you can actually post in. Anything this device cannot
  read is left out rather than guessed, and the app says how many things that
  was; pictures stay in the note and are listed by name. A note too long to go
  as one message says so before you send it, rather than failing afterwards.
- **Save a message to Notes.** Right-click a message in Púca (long press on a
  phone) and pick *Save to Notes* to keep it as a new note or as an item in one
  you already have — its pictures can come too. The copy is yours: it is
  encrypted again under your own key and uploaded as your own file, so it
  survives the message being deleted, and deleting the note does not touch the
  chat. Only your own notes are offered, never a shared one, and a note whose
  text or pictures this device cannot read yet is not offered either — saving
  into one would write over what you still have elsewhere. Messages you cannot
  read, and clips, are not offered. While it is saving, the window stays put —
  closing it would not stop the save — and if the pictures fail after the text
  has gone in, it says the text was kept, so you do not save the same message
  twice trying again.
- **Text notes, photo notes and drawings in Púca Notes.** A note can now hold
  free text as well as (or instead of) items, and its own photos and
  drawings: take a picture with the phone's camera or pick one, or draw with
  a pen and eraser; a drawing can be opened and changed again. Photos are
  made smaller on your device before they are encrypted and uploaded. The
  text and pictures are end-to-end encrypted like everything else in a note,
  and Púca's Tasks view shows and edits the same text, photos and drawings —
  a drawing made in one app opens in the other's editor — so both apps agree.
- **A Trash.** Deleting a note, in Púca Notes or in Púca's Tasks view, now
  moves it to the Trash (in Púca Notes, Undo brings it straight back). From
  the Trash you can restore a note or delete it forever. A note in the trash
  does not remind you and cannot be changed until you restore it; it keeps
  its colour, labels and place in the order. The server deletes trashed notes
  for good after 30 days (server owners: `NOTES_TRASH_RETENTION_DAYS`, 0 keeps
  them until the trash is emptied). Deleting forever also deletes the note's
  photos, drawings and attachments; Púca Notes does the same for notes about
  to expire when it is open in the last day, but a note that expires while no
  Púca Notes is open leaves its uploaded files behind on the server.
- **A calendar in Púca Notes, and the same calendar as a tab in Púca's Tasks
  view.** Month, week, day and agenda views. On a phone, the month shows dots
  and the chosen day's list. Drag an item to another day, or use *Move to
  date…* or the `[` and `]` keys. Tap a day to add something to it.
- **Reminders in Púca.** The Tasks view now has a Reminders tab: every item
  with a due time, across all your lists and checklist channels, grouped
  Overdue / Today / Upcoming, with tick and snooze in place. It is the same
  view Púca Notes has, and a due-item notification now opens it instead of
  the all-tasks board. An item in a shared checklist that someone else set
  says *Reminds whoever set it* — those go off for whoever set them, not you.
- **Dates that repeat.** An item can be an event or a to-do, all-day or at a
  time in its own time zone, with an end, a place and reminders, repeating
  daily, weekly, monthly or yearly. Ticking a repeating to-do moves it to the
  next time and reopens its subtasks. It does not end the series. The date,
  the repeat rule and the place are encrypted like the item itself. By default
  the server sees the next reminder time, so reminders reach your other
  devices. A per-item *Keep the time private from the server* switch hides that
  too, and then the item gets no reminders.
- **Snooze.** From Reminders, from the calendar, or from the item's own row
  in a note or a list: 10 minutes, an hour, or tomorrow morning. The reminder
  time the server holds moves with the snooze, so a phone reminding with Púca
  Notes closed goes off at the snoozed time. Snooze is only offered to people
  allowed to tick the item, and a snooze set by someone who may edit the item
  cannot be changed or undone by someone who may only tick it.
- **Change a reminder's time from the Reminders list.** Moving a reminder is
  the commonest thing to do with one, and it no longer means opening the note
  and finding the item: a clock on the row changes when it is due, and an item
  that repeats or is an event opens the same date-and-repeat editor as the
  calendar. It is offered only to people allowed to edit that item's time. A
  snooze on an item you move simply lapses.
- **Reminder times that are yours.** Give an item a time with one tap —
  *Morning*, *Afternoon* or *Evening* — instead of filling in a date and a
  time. What those three mean, and the time a new reminder starts at, is
  yours to set in the account menu, and it follows your account to your other
  devices, encrypted like everything else. If the time has already gone
  today, the tap means tomorrow. Snooze's *Tomorrow* now means your morning
  rather than 09:00. The server still only ever sees when an item is due,
  never what it is — and the per-item *Keep the time private from the server*
  switch is still there for the ones it should not see at all.
- **Edited.** Notes show when they were last changed, and can be sorted by it.
- **.ics export and import.** Export gives your dated items as a standard
  calendar file. The file is not encrypted, and the app says so first. Import
  brings a calendar file into a personal note. It first lists anything it
  cannot bring across, and it skips events it already has. Both are offered
  in Púca Notes' calendar and in Púca's own Calendar tab; an import always
  goes into one of your own notes, never a shared checklist, and a note the
  app is still reading cannot be picked until it has — otherwise importing
  the same file twice would bring everything in twice. In the Púca
  Notes Android app, *Add to phone calendar* copies one event to your phone's
  calendar.
- **Colours, labels and archive follow your account.** They used to live in one
  browser and vanish when you signed out. They are now sealed with your own key
  and synced, so every device you sign in on shows the same ones and a new
  sign-in brings them back. A sign-out still deletes this device's copy, so
  changes that have not reached your account yet are pushed first, and if any
  still have not, Notes (or Púca) asks before signing out. The server stores
  them encrypted and cannot read them. Grid or list view and the sort order
  still stay per device.
- **Colours, labels and archive in Púca's Tasks view.** The colours, labels and
  archive you organise your notes with in Púca Notes now show in Púca's own
  Tasks view — on the tabs and on the All tasks board — and you can set them
  from there: right-click a tab or a card for *Colour*, *Labels* and
  *Archive*. An archived note leaves the tab bar and the board, and the new
  filter beside *New list* narrows both to one label or opens the archive. It
  is the same organisation, sealed with your own key, so changing it in one
  place changes it in the other, and the server still cannot read any of it.
  Deleting a note for good from the Tasks view forgets its colour and labels
  too; moving it to the trash keeps them for a restore.
- **Notes update live.** A change made on one device or by someone sharing a
  checklist appears on your other open devices within a moment, with no
  refresh. The server says only which note changed, never what it says.
- **Notes work offline.** Your notes open with no connection, and changes you
  make offline are kept, marked *Not synced*, and sent when you are back online
  — ticks (a repeating item moves on when it syncs), dates, snoozes, items
  added from the calendar, and moving a note to the trash (and its Undo)
  included. If the server refuses one (for example a note deleted elsewhere,
  or a repeating item another device already moved on), you are told which.
  Turning a note's text into a checklist still needs a connection, and the
  app says so when there is none. Restoring from the Trash waits for a
  move to the trash that has not synced yet, so that move can never undo it.
  The copy on your device is encrypted with a key from your account.
- **Select several notes at once** and pin, colour, label, archive, move to
  the trash, copy or duplicate them together: Ctrl-click, Shift-click or
  Ctrl+A on a computer, a long press on a phone. Selection is only on the
  notes themselves — never in Reminders, the Trash or the Calendar. A copy
  keeps the note's text and its items' dates and repeats.
- **Púca Notes on Android reminds you even when it is closed.** A due item
  now raises a notification from the Notes app itself — open or closed,
  after a restart of the phone too — saying only "An item is due"; tapping it
  opens Reminders. A repeating item reminds you once at each time it comes
  round, and a snooze set on another device moves the phone's reminder with
  it. About once an hour the app also checks for due times set
  on your other devices, so they reach the phone without opening Notes (a
  time set less than about an hour ahead can arrive late, and a phone that
  has not opened Notes in days checks less often). If your session ends, one
  notice asks you to sign in again, and a reminder that was due at that
  moment still arrives. The Reminders view says plainly when
  notifications are off, when Android may delay them, and how to fix it.
- **Location reminders in Púca Notes.** The account menu can turn on
  reminders for when this phone arrives at a place you save, as in Púca.
  Places stay on the phone and are separate from the ones saved in Púca.
- **Save and share notes from the Android app.** Export now saves Markdown or
  JSON into Documents/Puca Notes, and Share sends every note or one note
  through Android's share sheet. Exports are plaintext, and the app says so.
- **Púca Notes on Android updates itself.** Like Púca, the Notes app now
  downloads each release's update when it starts, checks that it was signed
  for Notes (Notes has its own signing key, so it can never be handed Púca's
  update, or the other way round), and applies it. The account menu shows the
  version you are running and has a **Check for updates** button that does not
  close the note you have open. When a release needs a newer Notes app than
  the one installed, the app says so and links to the download page instead
  of applying an update it could not run. **One manual install is needed
  first:** a Notes app from 0.9.815 or earlier has no updater, so install the
  new one from the download page once; after that, updates arrive by
  themselves.

### Changed
- **One notification per due item when both apps are installed.** When
  Púca Notes on the phone is signed in to the same account on the same
  server, keeping up with your reminders, allowed to notify, and already
  holding the reminder that is due, Púca leaves it to Notes; in every other
  case (Notes signed out or its session about to run out, out of date,
  stopped, muted, an older version, or an item Notes has not fetched yet)
  Púca notifies as before, so an item is never left unannounced. The price of
  that rule is an occasional second alert: an item set on another device
  shortly before it falls due is announced by Púca on time, and by Notes
  again when it next checks.
  Ship the Púca Notes APK with or before the Púca APK; if you update Notes
  from an older version, allow its notifications once.
- **Signing out of Notes now removes this browser from your Devices list**, as
  signing out of Púca does, instead of leaving it enrolled. If the tab closes
  or the connection drops before the server answers, the next sign-in on that
  browser finishes it, instead of the browser being refused as a signed-out
  device.
- **Ticking an item with a repeating to-do under it** is refused with a
  reason instead of quietly ending the repeat.
- An older app can no longer tick off an item that has a date or repeats; it
  is told to update instead. It would otherwise have ended a repeating series
  without knowing.
- Apps older than this release keep working against the new server: they do
  not show trashed notes, renaming a note in them leaves its text and
  pictures alone, and their Delete still deletes at once. But they do not
  keep a trashed note whole: an older Púca Notes forgets a trashed note's
  colour, labels and archive flag, and a pin or reorder saved from any older
  app puts a restored note at the end instead of its old place. **Install
  the new Púca Notes APK on every phone before using the trash**; the camera
  button also needs the new APKs of both apps.
- **Your data export includes everything above**: a note's text, pictures and
  trash state, items' dates, repeats and snoozes (opened like the rest of
  your items), and the encrypted colour/label document as ciphertext.
- **The Windows installer no longer carries a copy of Púca Notes.** The
  desktop app never opened it; Notes on a computer is the browser page, as
  before.

### Fixed
- **Remote control no longer freezes on a screen that is not changing.**
  Switching from *All Displays* to one screen, or handing the pointer to the
  phone, could leave the stream with no picture to send while the desktop
  stayed still: the phone then saw a frozen image, so taps and clicks looked
  ignored (they were landing), zooming in never sharpened, and the picture
  only came back when something on that screen repainted by itself. The
  stream now wakes the screen if it has gone to sleep and nudges it to
  present a picture when it has none to send, keeps the last one across a
  pointer hand-over, and re-fits it when you zoom, so a still desktop
  sharpens as you zoom in like a moving one.
- **The installer no longer prints two ERROR lines on every update.** They
  came from stopping the helper programs before replacing them, which
  reports an error when a helper was simply not running; the log now says
  "not running" instead.
- **"Keep RNNoise" now keeps RNNoise.** When DeepFilter fell behind and the
  voice panel offered *Keep RNNoise*, the button only closed the notice: your
  sound was already on RNNoise, but the setting still said DeepFilter, so the
  panel kept naming it and the next microphone restart or device change
  brought DeepFilter, and the overload, straight back. The button now switches
  your microphone to RNNoise for the rest of the session and the picker says
  so; pick DeepFilter to try it again, and the next launch starts on your
  saved choice as before.
- **A direct message sent from outside the chat window now arrives straight
  away.** It reaches the other person immediately, wakes their phone and moves
  the conversation to the top of their list, exactly as one typed in Púca
  always did.
- **Sound in automatically recorded clips no longer runs 100 to 200 ms
  behind the picture, and no longer drifts.** The desktop-audio player the
  clip buffer records through schedules each packet a little ahead, and
  that lead grew over a session whenever the sound device's clock and the
  app's disagreed; the clip carried the sound where it was played, not
  where it happened. The buffer now records the lead with each packet and
  takes it back out when the clip is made; your microphone is held back
  by the same amount so it stays in step with the game audio. A rare
  clock-drift reset in that player now leaves a short gap in the clip
  instead of playing a stretch of sound twice. Measured silently in an
  emulated end-to-end run (`frontend/e2e/clip-av-emulation.mjs`).
- **Saving an attachment on Android saves it.** In both apps the Save button
  on a file reported success without writing anything. Files now land in
  Documents/Puca under a unique name, or you are told why they could not.
  On Android 10 and older, Púca can write there once its next app update
  (not an over-the-air update) is installed.

### For operators
- **Rolling back the server no longer needs a database restore — from this
  release on.** The server now starts on a database that a newer release has
  already updated, and the release script's safety check now lets such a
  rollback through (build the older release's backend and ship it with
  `dual-ship.sh backend` as usual; `deploy/ops/README.md`, "Rolling back the
  backend"). This holds as long as every update in between only added to the
  database, which is the rule for Púca's migrations. Going back to **0.9.815
  or earlier** still needs the database backup taken before the update: those
  releases refuse to start on a newer database, and the script refuses to
  ship them over one.
- Serve `/notes/sw.js` with `Cache-Control: no-cache` on every host before
  shipping this web app: add `@notesSw path /notes/sw.js` and
  `header @notesSw Cache-Control "no-cache"` inside the web app's Caddy block
  (`deploy/webapp/README.md`, step 3), reload Caddy, then purge that one URL
  from the CDN cache. `check-versions.sh` fails on `notes-sw-cache` until it
  is, and its FAIL line prints these steps.
- Run `deploy/ops/backup-keys.sh` and store both bundles off the machine
  BEFORE publishing the first Púca Notes APK that updates itself: it signs
  with its own key (`notes-updater-rsa.key`), and once phones embed that key,
  losing it stops Notes updates until everyone installs a new APK.
- New optional setting `TASK_EVENTS_MAX_PER_IP` (default 32): live Notes streams
  per address.

## 0.9.816 — 2026-09-21

Clips that cost a sixth of the CPU, no longer lose two seconds after a press, no longer put their sound late by the recorder's start-up time, and keep their pointer moving; DeepFilter rides out CPU spikes instead of giving up.

### Changed
- **DeepFilter rides out CPU spikes instead of giving up.** When a busy
  moment left DeepFilter about half a second behind, the app rebuilt your
  microphone on RNNoise and kept it there until you restarted Púca (the
  notice said "for this call", but later calls stayed on RNNoise too), and
  the rebuild itself was audible to the room. Now an RNNoise copy runs
  beside DeepFilter and covers any moment it falls behind, lined up to the
  sample, without rebuilding your microphone; DeepFilter takes over again
  as soon as it catches up. Before, those moments went out with no noise
  suppression at all. Only a device that stays behind (15 seconds, or four
  times in three minutes) is switched to RNNoise for the call, and the
  voice panel then offers **Try DeepFilter again**. The next call starts on
  DeepFilter as usual.

### Fixed
- **Clip recording uses about a sixth of the CPU it did.** With clips
  armed, the screen recorder ignored its own frame rate: on a high-refresh
  monitor showing anything that moves (a stream, a game) it captured and
  encoded every frame the screen drew, 63 to 78 a second when the preset
  asked for 30, at more than twice the bitrate. Measured on a 2560x1440
  165 Hz screen, it now records at the rate your preset sets: 30 frames a
  second at about 7 Mbit/s, and it takes proportionally less of the graphics
  card's video encoder. The same number of seconds now takes less than half
  the memory. Each frame is also cheaper: a still screen no longer converts
  the same picture again every frame, the colour conversion uses the CPU's
  vector instructions where it has them (AVX2), the recorder no longer spins
  while the video encoder
  works, and it reuses one screen buffer instead of allocating a new one per
  frame. Together: about 14% of one CPU core, down from 81-95%.
- **Saving a clip no longer leaves a gap in the clip buffer.** With the
  buffer armed automatically on joining a call, pressing Clip threw away
  up to 2 seconds of picture and sound from just after the press, so a
  later, longer clip covering that moment froze and went quiet there. A
  save that failed part-way did the same. Saving a clip while the buffer
  was full could also skip a couple of seconds and take in up to 2
  seconds recorded after the press, which the approval request never
  described, or fail.
- **Sound in automatically recorded clips no longer lags the picture by
  the screen recorder's start-up time.** It played late by however long
  the recorder took to start, plus 40 ms. The clip buffer now measures
  both clocks as it runs and lines them up when the clip is made.
- **The mouse pointer moves in automatically recorded clips of a still
  screen.** When nothing else on screen was changing (a page you were
  reading, a paused video), the pointer stayed where it was at the last
  screen update and then jumped. It now moves as you moved it.

## 0.9.815 — 2026-09-19

Remote control that survives unlocking the computer, a warning when the
sign-in screen can no longer be reached after a restart, and a sturdier phone
trackpad.

### Fixed
- **Remote control survives unlocking the computer.** A session started
  while the computer was locked (typing your PIN at its lock screen) ran on
  the lock-screen helper, which Púca's service stops the moment the computer
  is unlocked. The picture froze, nothing you did reached the computer, and about
  15 seconds later the session ended and needed a manual reconnect. The app
  now notices within a second that the helper under the session has gone and
  restarts the picture on its own helper, in the same session, keeping the
  screen, quality and privacy settings. The same recovery now covers a
  picture the helper ended by itself (a lost network path or an encoder
  fault), which restarts once instead of waiting out the timeout. A friend's
  shared session is not moved onto a locked computer's sign-in screen; it
  waits until the computer is unlocked.
- **"Reach this computer after it restarts" now says when the server is
  refusing it.** The box is ticked from files on the computer itself, so it
  stayed ticked while Púca's server turned down the computer's sign-in-screen
  connection on every attempt — the only trace was a line a minute in the
  service's own log. When that refusal persists (two refusals at least ten
  minutes apart), Devices → This device now shows a warning under the box with
  when it started and when it was last seen, how to check again (lock the
  computer for a minute), and what to do if it is still there: untick the box,
  tick it again, and set the sign-in-screen passphrase again. It does not claim
  the computer was removed, because a server fault looks the same from here. While the
  refusal persists, locking the computer during a remote session no longer
  hands the session to a sign-in screen that cannot come online; it freezes and
  resumes on unlock instead. The service now retries a refused computer every
  15 minutes rather than every minute (locking the computer retries at once),
  and a connection the server rejects for a signed-out session goes straight to
  the computer's own key instead of retrying the dead one. The service reaches
  existing installs through the usual "update the service" prompt.
- **The phone's trackpad can no longer go dead after a pinch.** If a finger's
  lift was lost mid-pinch (the app sent to the background, say), every later
  one-finger drag counted as a second finger and the pointer stopped moving,
  with the keyboard still working, until you switched Touch mode and back. The
  stuck finger is now forgotten on the next touch once the phone has let go of
  it, and whenever the app loses focus. Losing focus now also clears the
  picture's own count of fingers, so the first drag afterwards no longer
  zooms the picture, and taps in Touch mode no longer go missing. On a
  computer, a mouse button held down when the window loses focus is let go
  on the remote machine too: the same button that was pressed, right and
  middle included.
- **A click refused once is no longer swallowed from then on.** If Windows
  refused a remote mouse button or key press (the screen changed under it,
  such as the lock screen appearing), later presses of the same button or key
  were silently dropped until it was released. And letting go of everything
  at the end of a session now reaches the lock or sign-in screen too, rather
  than failing silently there.
- **The host's logs no longer count refused keystrokes.** When Windows
  refused remote input (at the lock or sign-in screen, say), the agent's log
  and the service's log, which anyone signed in to that machine can read,
  got one line per refused event, many of them naming whether it was a key
  press or a mouse move, so the number of refused keystrokes (a PIN's
  length) could be read off them. Those lines are now written at most once a
  second on each path, the first always, and none says whether it was a key
  or the mouse that was refused. Refusals are otherwise only counted, in the
  once-a-second summary described below, with refused typing as none, some
  or many.

### Added
- **Better evidence for "the mouse does nothing".** The phone's Copy
  diagnostics now says what kind of input it sent (moves, clicks, keys),
  which way it went, what the trackpad believes and whether the phone is
  drawing the pointer, how often the trackpad has recovered from a stuck
  finger, and whether a slow connection is holding mouse movement back while
  keys still get through. The host's log records what input arrived on each
  path, about once a second: mouse events counted exactly, but typing only
  as none, some or many, and any stretch with typing in it timed only to the
  second, so the log shows that typing happened then, and whether it was a
  little or a lot, but not how many keys it was or its rhythm. It also records which screen the mouse is aimed at in each
  session and, for the first few moves after the sign-in screen or a
  security prompt appears, whether the pointer followed them ("tracks", "did
  not move" or roughly how far off), never where on the screen it was.
  See the FAQ entry "The keyboard works but the mouse does nothing".

## 0.9.814 — 2026-09-17

Púca Notes: a notes app in the style of Google Keep, in the browser and as its
own Android app, over the lists and checklists you already have in Púca.

### Added
- **Púca Notes** — a notes app in the style of Google Keep, at `/notes/` on the
  web app (the Tasks view links to it). Your personal lists and every
  checklist channel from your servers appear as notes: a grid you can search,
  pin, colour, label and archive, a Reminders view of everything with a due
  time, and Púca's own task tree inside each note, so items, subtasks,
  drag-to-nest, due times and attachments work exactly as they do in Tasks.
  Archive and delete can be undone for a few seconds; notes export as Markdown
  or JSON. Colours, labels and the archive stay on the device (the server
  learns nothing new); pins and note order are the Tasks view's own, so they
  follow your account. It runs in the browser and as its own Android app; the
  Púca phone apps do not carry it and the desktop app never opens it. Notes
  never opens a live connection, so it neither counts as "online" nor
  interferes with file transfers in the chat app.

### Fixed
- **Two tabs, one account.** Signing out, or signing in as someone else, in
  one browser tab of the web app now takes effect in the other tabs on the
  same origin — before, the other tab kept the previous account's keys in
  memory until it was reloaded.
- **Someone else signing in on the same browser.** When a session expires, the
  account's keys stay in the browser on purpose, so the same person can sign
  back in without losing anything. If a different account signed in instead,
  there was a short window in which the app could still reach for the previous
  account's keys. Stored keys are now tied to the account they belong to and
  are never offered to another one.
- **Plaintext list titles are flagged.** Notes shows a "Not encrypted" mark on
  a note whose title the server holds in the clear, the way a checklist item
  is already flagged.

### Changed
- **Púca Notes ships with every release.** The Android app has no updater of
  its own, so it is now a release surface like the others: built from the same
  version, signed with the same key as Púca, and linked from the download page
  alongside the Púca and Púca Lite builds.

## 0.9.813 — 2026-09-16

Remote control sends only the pixels your screen can show, screen sharing uses
the hardware encoder it always had, and the Wake button no longer dies a month
after it is set up.

### Changed
- **Remote control sends only as many pixels as your screen can show.** The
  host used to encode its monitor at full size and your phone decoded every
  one of those pixels to display a fraction of them: a 1440x2560 monitor,
  viewed on a phone held sideways, was decoded in full (about 16 ms a frame,
  half the time budget at 30 fps) to be shown at 607x1080. Now the viewer
  tells the host how large it is showing the picture, and the host scales
  the picture down to fit before encoding. A quarter of the pixels to decode
  and to send, the same picture on screen; pinch to zoom and the detail
  comes back. Turn it off with the new Resolution control (**Fit to this
  screen** / **Full resolution**, and the matching switch in the phone's
  quality menu) if you would rather always have the native picture.

  The diagnostics you can copy from a session now also name the decoder the
  phone is using and whether it is hardware, so a slow decode can be told
  apart from a large picture.

### Fixed
- **The Wake button stopped working roughly a month after setting it up.** The
  LAN waker — the small helper that sends the magic packet to wake a sleeping
  PC — kept its access by renewing its credential, and renewing needs a
  credential that is still valid. The server stops renewing 30 days after the
  original sign-in, so on day 30 renewal quietly stopped, a day later the
  credential expired, and the waker was locked out for good. Nothing said so
  except a line in its log; the button simply did nothing.

  It now mints a fresh credential from the identity it was enrolled with,
  which is the same proof it already gives every time it connects. It recovers
  on its own within a minute, with no re-pairing, and the 30-day cliff is gone.
- **Sharing your screen was always encoded in software, even on a PC with a
  hardware H.264 encoder.** Every share this project has diagnostics from ran on
  the CPU encoder, on machines whose own clip recorder was using the NVIDIA
  encoder the same day. The cause was the H.264 *profile* the call settled on:
  the server offers two, Constrained Baseline and High, the browser lists
  Constrained Baseline first, and Constrained Baseline is the one profile the
  browser will not hand to a hardware encoder. The app now asks for High first.
  Measured on an RTX 4080 SUPER inside the same WebView2 the app ships with:
  the old order used OpenH264, the new order uses the NVIDIA H.264 Encoder MFT
  at 1920x1080. A machine with no hardware encoder is unchanged — it never
  offered High, so it still negotiates what it did before.

  The share health log now records the negotiated profile next to the
  encoder, and "Copy diagnostics" lists which H.264 profiles this machine can
  send and whether a hardware encoder is behind them, so this is visible in a
  report rather than a two-week investigation.
- **A full install with its capture helper missing now says so.** Clips record
  the screen through a small helper program installed beside Púca. If that
  helper is missing from a full install, the buffer used to fall back to
  recording inside the app itself and, when that failed, report only the raw
  graphics error. It still tries the built-in path — on most machines it works
  — but a failure now names the real cause and tells you to reinstall Púca.
  Púca Lite has no helper by design and is unchanged.
- **Pinning Púca to a GPU now covers the screen share.** Windows keys a GPU pin
  to one executable path, and the share is captured and encoded by the WebView2
  runtime, not by `Puca.exe` — a separate program whose path changes with every
  automatic runtime update. A pin on the runtime went stale each time and had
  to be re-created by hand, found only after a choppy share. Now, when
  `Puca.exe` is pinned, the app writes the same preference for the runtime it
  is about to start — on every start, before the runtime is up — and removes
  entries for runtime versions that are no longer installed. On a machine where
  Púca is not pinned nothing happens. See "I pinned Púca to my integrated GPU"
  in `docs/FAQ.md` for what the pin reaches.

### Security
- **Hardening of the Windows remote-control helpers, from an adversarial
  review of the native code.** None of these was reachable from the internet;
  all of them needed a foothold on the PC already, and each is closed with a
  test that failed against the shipped code. The helper that serves remote
  control now keeps its named pipe for its whole life instead of re-creating
  it between clients, so another local process can no longer take the name
  while it is briefly free. Every program that connects to a helper's pipe
  now checks that the process answering is the one it started before it says
  anything secret, and opens the system service's pipe with identification
  only, the way the other clients already did. The system service's control
  channel can no longer be held open indefinitely by a local account that
  connects and says nothing. Remote file access on an armed host now refuses
  the plaintext credential files that sit beside the directories it already
  refused (`.git-credentials`, `.netrc`, `.npmrc` and their kin). Both helpers
  are now linked so that the system libraries they load at startup are taken
  from Windows itself and never from a file placed beside them. And the
  mobile update check no longer treats "co.uk"-style suffixes as a trusted
  site.

## 0.9.812 — 2026-09-16

Remote control goes back to being direct when your phone and your PC are on the
same network, instead of routing every frame through a relay on the internet.

### Fixed
- **Controlling your own PC was laggy whenever a VPN was running on it.** The
  host picks the network address it advertises by asking Windows which address
  reaches the internet. With a VPN active that answer is the VPN's own tunnel
  address, which nothing else on your network can reach — so your phone, sitting
  a few feet away on the same Wi-Fi, had no direct route to offer and the
  session fell back to relaying every frame through the server. Measured on the
  affected machine: 99 ms round trip with 3% packet loss through the relay,
  against 2-7 ms straight across the network, plus the stall-and-recover cycle
  the loss caused.

  The host now also asks which address reaches *your phone*, and offers that. A
  session between two devices on the same network takes the direct path again.
  Nothing changes when you are genuinely away from home: the internet-facing
  address is still offered, and the relay is still there as the last resort.

  If it ever happens again, the host's log now names the addresses it offered
  rather than only counting them — which is what hid this for as long as it did.

### Security
- Updated a TLS library in the desktop app past a published advisory
  (RUSTSEC-2026-0285). No behaviour change.

## 0.9.811 — 2026-09-16

Security fixes from an outside review: a message that could crash everyone who
saw it, and four ways a moderator could reach past their rank.

### Fixed
- **A single malformed attachment link crashed the app for everyone who could
  see it.** A message containing a specially formed encrypted-attachment link —
  no file needed, no upload permission needed — made every viewer's app show
  the "Something went wrong" screen, on every platform, every time it opened,
  because Púca opens your first channel on launch. Deleting it was hard for the
  same reason. The link parser now never throws, and one message that fails to
  display shows a small placeholder in its own row instead of taking the app
  down, so it can still be deleted.
- **Changing your own roles through a disguised user id.** A moderator with
  Manage Roles could not give themselves a role directly, but could by writing
  their user id in a form the server did not recognise as their own. The server
  now checks the id it is actually going to use.
- **Role changes now respect the other person's rank.** Someone with Manage
  Roles could add or remove a role (below their own) on a member ranked above
  them, or on the owner. As with kicks and timeouts, you can only change the
  roles of members ranked below you; the owner and administrators are exempt.
- **Lifting a timeout now needs the same standing as imposing one.** Anyone
  with Kick Members could remove a timeout an administrator had set on a
  higher-ranked member — including their own, since a timeout only stops
  sending, not the rest of the app.
- **Silencing a member's custom join/leave sounds now respects rank** the same
  way, instead of only protecting the owner.
- **Encrypted channels no longer go back to an old key on a server's say-so.**
  A dishonest server could tell a client to encrypt under an earlier key — one
  a removed member might still hold — in three different ways. The client now
  rotates to a fresh key instead of ever going backwards, refuses to send under
  the old key when a rotation cannot be completed, and only adopts another
  member's key after confirming who published it. A server restored from an
  older backup still works; it just rotates a few times to catch up.
- **Mobile updates now compare against the version the app was actually built
  as,** not the number the update server put on it. Before, a mislabelled
  update — a mistyped version when publishing, or an old build served under a
  higher number — could leave a phone refusing every real update until the app
  was reinstalled. The publishing script now also refuses to publish a manifest
  whose version does not match the bundle it points at. This cannot undo the
  first mislabelled update on phones running older versions; see
  `deploy/mobile/README.md` for exactly what it does and does not cover.

### Changed
- Deleting your account now also clears your published direct-message keys,
  not only marks your sessions as revoked.
- The security model, FAQ and the Sessions settings text now say plainly that
  signing out a device stops it connecting but cannot take back what that
  device already held; a copied device is an account compromise, not a lost
  token.

## 0.9.809 — 2026-09-09

Arming a clip right after you open Púca works again.

### Fixed
- **The clip buffer failed to arm when the app had only just started.** Púca
  rejoins your voice channel about a second after launching, and the buffer
  arms a moment after that — while Windows is still bringing the app's window
  up. Recording a screen is not always possible that early, and when it was
  not, arming gave up and told you it could not record any of your monitors.
  The same monitors record perfectly a few seconds later.

  It now tries again, twice more, before saying anything. If your machine is
  ready straight away nothing changes; if it needs a moment, it gets one. When
  recording genuinely is not possible, you still get the same nudge on the Arm
  button as before.

  This is not new, but it was hidden: until 0.9.803 automatic arming was
  refusing to run for a different reason, so it rarely reached the point where
  the timing mattered.

### Changed
- **Screen recording now asks the graphics card that actually drives the
  monitor**, instead of whichever one Windows happened to hand the app, and no
  longer falls back to software rendering — which cannot record a screen at
  all, and only produced a confusing "not supported" message. If recording does
  fail, the message now names the graphics card, so the reason is in the report
  rather than in a guess.

## 0.9.808 — 2026-09-09

Clips now record your primary monitor, every time.

### Fixed
- **Arming the clip buffer could fail outright with a cryptic error.** It
  picked which screen to record by looking for an app running fullscreen, and
  a virtual display — a VR headset link, a phone used as a second screen, a
  remote-desktop adapter — looks exactly like an ordinary monitor until the
  moment it refuses to be recorded. A fullscreen app on one of those is
  precisely what that rule reached for, so arming stopped with
  `DuplicateOutput failed` while two perfectly recordable monitors sat beside
  the one it had chosen.

### Changed
- **Clips record the PRIMARY display now, rather than guessing.** It is the
  screen you can point at, and it is the same one every time. The old rule was
  also invisible — nothing told you which screen it had picked, so "it recorded
  the wrong monitor" was impossible to report. If your game runs fullscreen on
  a second monitor, that is the one change to be aware of: the clip records
  your primary screen instead.
- **And if the primary genuinely cannot be recorded, it tries the others**
  rather than giving up, checking each before committing to it. If none can be
  recorded, the message now names the monitors it tried and why each refused,
  instead of a bare error code.

## 0.9.807 — 2026-09-09

The same app as 0.9.806, rebuilt. Windows Defender objected to the 0.9.806
installer and this one it does not.

### Fixed
- **Windows Defender flagged the 0.9.806 update as a threat, and it was wrong.**
  If you took that update and saw `Trojan:Win32/Bearfoos.B!ml`, nothing had
  happened to you: the file you downloaded was exactly the file we built, and
  every program inside it scans clean on its own. The `!ml` on the end of that
  name means a machine-learning guess rather than a match against a known
  threat, and the guess it makes about an installer like ours — not carrying a
  paid-for signing certificate, and brand new every release, so with no
  reputation attached — sits close enough to the line that one build can land
  on the wrong side of it while the release before and after land on the right
  one. 0.9.803, 0.9.804 and 0.9.805 all pass the same check that 0.9.806 fails,
  with the same antivirus and the same definitions.

  There is no code change here. This release is 0.9.806 built again, and
  checked against Defender before it was published — which is now a step we do
  for every release rather than something we find out from you.

## 0.9.806 — 2026-09-09

Fixes for yesterday's screen-share work, including two that could leave your
camera on.

### Fixed
- **Turning your camera off could leave it on.** If the connection had dropped
  and recovered at any point during the call — a Wi-Fi blip is enough — the app
  was still holding a stale handle to the old camera, so switching the camera
  off quietly did nothing and the room kept seeing you. The same fault could
  leave a second, dead microphone published after a mic device change, and
  could leave a screen share running after you stopped it. The app now asks the
  call what is actually being published instead of trusting what it remembered.
- **"Lower it" did nothing on peer-to-peer calls.** The check that protects the
  multiple-sizes feature from being disturbed was applied to every call, not
  just the ones that use it, so on a direct call the button reported that it
  could not change your running share when there was nothing in the way.
- **One step down was the only help you got.** If lowering the quality once was
  not enough — and on a laptop screen the single available step is a small one
  — nothing offered again for the rest of that share. Taking a step now lets the
  app speak up once more if your machine is still struggling. Declining still
  means declining.
- **Lowering only the frame rate no longer changes your resolution.** Sharing a
  small window and taking a frame-rate step used to quietly rewrite your saved
  resolution down to 720p, so every later full-screen share started smaller than
  you had asked for.
- **The message after lowering says what actually changed**, and says the size
  as a limit rather than an exact number — the picture is capped to fit, so on
  anything but a 16:9 screen the real result is smaller than the figure.

## 0.9.805 — 2026-09-09

Sharing your screen now tells you when your machine cannot keep up with it, and
remembers the answer.

### Added
- **The app now says when your CPU cannot keep up with your own screen share.**
  The browser has always reported this — it is the difference between "the
  network is the limit" and "this machine is the limit" — and the app has only
  ever written it to a log file. So the way people found out was that their
  game got choppy while they were sharing, and nothing connected the two. Now,
  once a share has been struggling for long enough to be sure (and never
  nagging — it waits for you to take a step before it will say anything again),
  it offers to drop one: a single click, applied to the share already running
  so nobody watching is interrupted. If it cannot change the running share —
  which is the case when you have "send my screen at several sizes" turned on,
  because the smaller copies are fixed in proportion to the big one — it says
  so, and your next share starts at the lower setting instead.
- **The share dialog remembers the resolution and frame rate you chose.** It
  opened at 1080p and 30 fps every single time, so anyone who turned it down
  because their last share hurt was handed 1080p again on their very next
  share, and every share after that. The one control a slower machine has was
  the one control the app forgot.
- **"Copy diagnostics", from a right-click on the voice panel or from Settings,
  Advanced.** When a call is going badly the only useful evidence is what the
  app is measuring at that moment, and until now the only way to get it was to
  open a developer console and run a function nobody could be expected to know
  about. This copies the same numbers — frame rates, the video encoder in use,
  connection quality — as plain text to paste to whoever is helping. Press it
  while the problem is happening. It contains no messages, names or addresses.

### Fixed
- **A share's smallest size is now one the graphics card can actually encode** (and carries a
  little more bitrate to suit it).
  When "send my screen at several sizes" is on, the smallest of those sizes was
  270 lines tall — and browsers deliberately refuse to use the graphics card
  for anything under 360 lines, whatever hardware you have. That size was
  therefore encoded on the processor on every machine, forever, which is the
  opposite of what the setting is for. It is now 360 lines.
- **The diagnostics report was answering the hardware question wrongly.** The
  standard way to ask a browser "can this machine encode video in hardware"
  returns *no* on machines that are demonstrably doing exactly that — measured
  here on a computer whose report said no while its graphics card was encoding
  the very thing it was asked about. A report that is confidently wrong is
  worse than no report, because it ends the investigation. It now asks a
  question the browser answers truthfully, and includes what the encoder in
  your live call actually is.
- **Sharing your screen could encode far more pixels than you chose, which is
  CPU taken from the game you are sharing.** The picker's resolution was sent
  to the browser as a preference rather than a limit, and for screen capture
  the browser routinely ignores a preference and hands back the display at its
  full size. Choosing 1080p on a 1440p monitor encoded 1440p — nearly twice the
  pixels — and on a 4K monitor, four times. Since the share is encoded in
  software, and software encoding costs roughly in proportion to pixels, that
  was double or quadruple the work for a picture nobody asked for. The
  resolution is now a real limit, as it always was for the clip recorder. The
  same fix applies to remote-desktop hosting.
- **The diagnostic sampler stopped holding three seconds of measurement open
  out of every five.** A change on 7 September made the log record rates over a
  window rather than lifetime averages, which was right, but it chose a window
  of 60% of the sampling interval — so for most of every five-second tick the
  app was holding a full statistics snapshot of every stream open, on the same
  thread that encodes your screen share. A one-second window records a rate
  just as truthfully at a third of the cost. This is the only change whose date
  falls between the last clean recording in the field logs and the first
  degraded one; that is not proof it caused anything, but it is not worth
  paying for either.
- **The log now records why a share's frame rate is falling, not just that it
  is.** The app already measured encode time, the send queue and the gap
  between them for the stream you are sending, then printed only the frame
  rate. Those three numbers are what separate "this machine cannot encode fast
  enough" from "the network is backing up", and neither had ever reached a log
  file.

### Changed
- **"Send my screen at several sizes" is now off by default**, one day after it
  was turned on. It was cleared by a test rig running a hardware video encoder;
  the shipped app does not get one — every diagnostic line in the field shows
  the software encoder — so the measurement that justified three encodes was
  taken against hardware nobody has. On a machine already working hard to
  encode one copy, two more is what turns a smooth share into a stuttering
  game. The switch stays in Settings, Advanced for anyone with CPU to spare
  and a viewer who keeps freezing.

## 0.9.804 — 2026-09-08

A channel setting you change now reaches everybody, not just your own screen.

### Fixed
- **Changing a channel's settings only reached the person who changed them.**
  A rename, a category move, a slowmode change or a switch between
  peer-to-peer and server-routed calls updated the editor's own screen and
  nobody else's, and everyone else kept the old values until they restarted
  the app. For most settings that was cosmetic. For the call type it was not:
  a member whose app still believed the channel was server-routed could not
  rejoin it at all, because the server refuses the token for a channel that is
  no longer one. Everyone in the server is now told, and their channel list
  refreshes. Switching a voice channel's call type also ends the call in
  progress — the two types cannot be mixed in one room, so everybody is put
  out together and can rejoin on the new one, rather than half the room
  quietly losing the other half.

## 0.9.803 — 2026-09-08

Screen shares get smaller sizes for viewers who cannot carry the full picture,
and the person sharing can turn that off.

### Fixed
- **"Arm automatically" only reminded you to arm.** 0.9.8 added a second,
  undocumented condition: automatic arming happened only on a server you had
  already armed in by hand. The setting still said it applied to every server
  whose owner has clips on, the refusal was reported as "auto-arm did not
  start the buffer" — a failure message for a deliberate decision — and
  nothing told you that arming once by hand was what granted it. Automatic
  now means automatic, on every server that allows clips, which is what the
  setting has always said. The consequence is stated in full above the
  dropdown before you choose it: it records your whole screen continuously,
  with no popup, and nothing leaves your computer until you save a clip.
- **On a server-routed (SFU) voice channel, one viewer with a weak connection
  got a frozen slideshow while everyone else was fine.** Screen shares were
  published as a single 1080p encoding, so the server had nothing smaller to
  give a viewer who could not carry it: it sent them the same bytes as
  everyone else and their connection dropped what it could not fit. Measured
  on a real call: 1920x1080 arriving at 2 frames per second, 899 packets lost
  and 394 retransmit requests in five seconds, eight and a half seconds
  frozen, on a machine whose decoder was idle at 2.6 ms a frame. Shares now
  publish three sizes, so the server can hand a struggling viewer a smaller
  one instead of a broken large one. What each viewer receives does not go up
  and for a weak one it falls sharply; the person sharing spends about 1.6
  Mbps more upstream.

### Added
- **Settings, Advanced: "Send my screen at several sizes".** On by default,
  and the switch for the change above. The benefit goes to viewers on slow
  connections; the cost — two extra encodes and roughly 1.5 Mbps more upload —
  lands on whoever is sharing, so it is theirs to decline. Turn it off if
  sharing makes your machine struggle, for instance while playing the game
  you are sharing.

## 0.9.802 — 2026-09-08

Remote control of a machine you are signed in to stops sending every keystroke
through the server.


### Fixed
- **Controlling your own machine sent every keystroke and mouse move through
  the server, even when the two devices were in the same room.** The picture
  came straight across the LAN; the pointer went out to the server and back,
  so remote control felt a long way behind what the screen was showing. The
  direct controller-to-agent input channel had been open the whole time and
  never once used: it arms only when the helper on the host can prove it will
  serve, and it could only prove that for a session it had opened itself — the
  lock-screen path. An ordinary session, signed in with the app running, keeps
  its key in the app, so the helper stayed silent and input took the long way
  round for the whole of every session. Measured from one machine's own log:
  fifteen consecutive sessions over a fortnight, not one of them armed. The app
  now hands its helper an input-only key derived from the session key, so the
  channel arms and input takes the same short path the video already took. The
  helper can open input and nothing else — not signalling, not the clipboard —
  and it was already being handed every one of those events in plain text, so
  nothing new is trusted with anything. A machine at the lock screen is
  unchanged, and a controller or helper too old to know about this quietly
  keeps using the server, exactly as before.
- **Remote control now survives a dropped connection to the server.** With
  input on the direct channel, a controller whose WebSocket has gone (a phone
  that backgrounded, a flaky network) can still drive the machine: the two
  transports are independent, and refusing to send because one of them is down
  was right only while it was the only one.
- **A file-browsing session could reach the input channel.** Browsing a
  device's files opens no screen, and the documented rule is that a session
  with no screen cannot move a pointer on one. That was enforced on the path
  through the app and not on the direct channel. Now both.

## 0.9.801 — 2026-09-08

A security fix that was finished before 0.9.8 and held back from it, plus the
dependency housekeeping and one gate that would have caught the wake box being
offline for five days.

### Security
- **A file uploaded without a capability could be downloaded by any signed-in
  account that learned its id.** Message and DM attachments were never
  exposed (the apps ask for a capability and encrypt them), but avatars,
  custom join/leave sounds, server icons and emoji are uploaded without one,
  and `GET /files/:id` served any capability-less file to whoever held a
  valid session — including someone you had banned, for as long as they kept
  the id. Found by a live access-control probe on 2026-09-07. Such a file is
  now served only to its uploader, to the people its owner is visible to
  (friends, a shared server, a conversation they started) for avatars and
  sounds, to members of the server (or anyone, once it is public) for icons
  and emoji, and to viewers of the channel a clip was posted in for its
  parts. Uploads older than the capability migration keep working for every
  account, since nothing can scope them. An attachment a client forgot to
  protect is no longer readable by strangers: it is its uploader's alone.
  No change for ordinary use; `FILES_ENFORCE_CAP=0` lifts the scoping as it
  already did for capabilities.

### Fixed
- **A shared screen re-derives its capture when the monitor layout changes.**
  Plugging in, unplugging or rearranging a display used to leave the host
  streaming a surface that no longer existed.

### Changed
- Dependency updates: firebase, google-services, twenty frontend packages and
  the WebRTC library the device path uses. What was held back, and the failure
  proving why, is in `docs/DEPENDENCY_UPDATES.md`.

### Internal
- `check-versions.sh` now covers the LAN waker, which is the one shipped piece
  with no version surface and the one that does not ride a release. It had sat
  five days behind the server while every other check reported agreement.

## 0.9.8 — 2026-09-08

Two failures reported on the same evening — the always-on wake box offline
since the 2nd, and a PC that could not be reached at its Windows sign-in
screen — turned out to be one stale binary and one uninstalled service.
Investigating them turned up a set of defects worth more than either, most of
them things that were quietly costing performance or telling you something
untrue.

### Fixed
- **Sharing your screen no longer takes CPU priority away from your game.** A
  change in 0.9.6 raised the whole app to above-normal priority while a share
  was live, which swept up the clip replay buffer's screen capture along with
  it — the one thing that was never supposed to compete with a game. Only the
  capture and encode processes are raised now.
- **Webcams look far better.** A camera you were not focused on was pinned to
  the lowest quality rung — 320x180 at 15 fps — for the whole call, and
  because nothing ever subscribed to a better one, the sender stopped
  producing it. Cameras now follow the size they are actually displayed at.
- **Remote control stops going the long way round.** The direct
  computer-to-computer path for your mouse and keys never activated for the
  person doing the controlling, so every click travelled to the server and
  back. The handshake that enables it is now answered in both directions.
- **The clip buffer records at the quality you chose.** On a monitor larger
  than the preset assumed, "1080p 60 fps" was recording your whole screen at
  its native resolution and nearly double the bitrate, costing most of a CPU
  core. The frame rate now follows the monitor, so the cost matches the label.
- **The wake button explains itself honestly.** When a machine did not come
  back, it blamed your BIOS even when the reason was that its sign-in-screen
  service had been removed, and it told you to switch on a computer that was
  already on rather than naming the one that was offline.

### Added
- **Watch a webcam beside a screen share.** Cameras now appear in a rail under
  the streams instead of only on the voice screen, and any camera — there or
  on the voice screen — can be made fullscreen. Fullscreen also asks for the
  sharper picture while it fills the display.
- **Automatic clip arming is agreed per server.** Choosing "arm automatically"
  once no longer starts a continuous recording of your screen in every other
  server whose owner turns clips on; each server is agreed to the first time
  you arm there yourself. The setting also explains what it does before you
  pick it, rather than after.

### Diagnostics
- The wake box now reports a refused connection as a refusal rather than a
  network blip, keeps the server's explanation, and fails visibly instead of
  retrying in silence — it had been locked out for five days while looking
  healthy. The server's own refusal now names the cause, the health check
  notices a wake box that is running but being turned away, and the app warns
  when its helper program is not the one it shipped with.
- Latency numbers in the diagnostics log were lifetime averages rather than
  what was happening at the time. They are now measured over a window.
## 0.9.7 — 2026-09-06

A hotfix for the remote-control work in 0.9.6, found by reviewing that change
after it shipped.

### Fixed
- **Ending a control session while input was still queued could leave a key
  or mouse button held down on the shared machine.** The release that ends a
  session is now ordered behind every batch of input queued before it, and a
  batch that belonged to a session which has already ended is dropped instead
  of injected.
- **Refused injections no longer flood the diagnostics log.** When the shared
  machine refuses input (a lock screen, a security prompt, a window running as
  administrator), the log records the first refusal in full, then a short
  summary every ten-fold count or five seconds, then one line when injection
  works again.
- **The diagnostics log keeps about two hours of a control session** (three
  files of 2 MB) instead of truncating within minutes.

## 0.9.6 — 2026-09-06

Remote-controlling a friend's shared screen felt about a second behind. The
loop was measured end to end on one machine (a new rig, below) and the parts
of it the app owns were found and fixed; what a home network adds is now
readable from the app instead of guessed at.

### Fixed
- **Remote-control input now actually travels over the call's own
  peer-to-peer channel.** It never had: both ends created the channel and each
  closed the copy that arrived — which is the peer's own channel — so every
  mouse move and click went the long way round through the server (and the
  edge proxy in front of it) while the app believed it had a direct path,
  with nothing in any log to say so. The channel is now negotiated once per
  connection and survives the end of a control session, so the second session
  in a call is as direct as the first. On a distant server that is two
  internet legs per event less; on the test machine the lane opens on both
  ends within a second of the call connecting.
- **A stalled link no longer banks seconds of stale pointer motion.** The
  motion valve used to engage at 64 KiB of unsent input — five to ten seconds
  of movement replayed late once the link recovered — and, on the direct
  channel, to move frames onto the relay mid-session, where a press and its
  release could arrive out of order. On a direct peer-to-peer call (and on
  the relay) it engages at 4 KiB now (a few hundred milliseconds), holds
  motion in place until the pipe drains, and never changes pipe under a
  session. On an SFU call the valve cannot see the data path's queue yet, so
  it does not engage there.
- **Clicks cannot overtake the move that placed them.** The host used to hand
  the pointer position and the click to the desktop as two separate,
  un-awaited IPC calls with no ordering between them; a click and any motion
  still pending now go as one batch, successive batches are queued in order,
  and there is half the IPC traffic per click.
- **The host's input path keeps its CPU under a game.** The streaming priority
  boost skipped the app process itself — the one that services every IPC call
  and runs the injection worker, the two hops between the host page and the
  desktop — and the worker ran at normal priority. Both are raised while a
  share is watched. (What was measured: with the host page's main thread 60%
  busy, pointer-to-inject-call went from 1 ms to 25 ms typical / 65 ms at the
  90th percentile while the picture moved 5 ms — the input leg is the
  contention-sensitive one, which the batching addresses; the boost is for
  the hops the rig cannot reach.)

### Diagnostics
- `await __pucaMeshDiag(5000)` and `await __pucaVoiceDiag(5000)` measure the
  delay of a share over a five-second window of real use: jitter buffer (and
  the hint the app asked for, read back), processing, decode, encode, the
  sender's pacer, frames parked in the media-encryption transform, and the
  selected network path's protocol and round trip — enough to say which stage
  owns a slow share. An SFU viewer now gets numbers for the tracks it
  subscribes to; before it got none.
- The unattended log sampler runs on both ends of a remote-control session
  on desktop, every second, with the same fields and which pipe the input is
  on (`lane=mesh-dc|sfu-data|relay`); `[p2p-input] peer N: no P2P lane after
  2 s` is logged when a session stays on the relay. A browser or phone viewer
  writes no sampler line (there is no log file to write to): read
  `await __pucaMeshDiag(5000)` from DevTools there instead. The desktop log
  now rotates at 2 MB with two archives kept, so a session's samples survive;
  the default 40 KB file self-truncated within minutes of sampling. While the
  desktop refuses injected input (a lock screen, a UAC prompt, an admin
  window) the log gets the first refusal in full and a count after that, not
  one line per mouse move.
- `frontend/e2e/rc-latency-2peer.mjs` measures glass-to-glass and
  pointer-to-desktop latency of the in-call share on one machine (loopback,
  synthetic desktop): 1080p30 measures p50 ≈ 40–60 ms glass to glass and
  1 ms from the viewer's pointer to the host page's inject call — the floor
  the app's own pipeline sets (the IPC hop, the worker and the OS injection
  are outside the rig).

A readiness pass before the project is advertised looked at what a stranger
meets first — the user guide, the sign-up form at the end of an invite link,
the phone app's settings, the Android app's web view — and at what an operator
needs on the day strangers arrive. Nothing here changes the protocol or the
database.

### Changed
- **The user guide describes the app that ships.** `docs/USER_GUIDE.md` was
  rewritten against the current client: every control is named by the label
  or tooltip you will find in the app (Join a Server, Add Reaction, Edit
  Profile, Upload Avatar, Generate Invite Link, and so on), and the old
  layout drawing, the developer-server address, the emoji drawn as buttons
  and the "Create Text Channel" step that stood where "add a reaction" should
  have been are gone. A lint check now refuses a `localhost:` address or an
  emoji-as-button anywhere in that file, so it cannot drift that way again.
- **An invite link and a sign-up code are told apart on the sign-up form.**
  Some servers require a sign-up code from whoever runs them before an
  account can be created; that is not the code in an invite link, but the
  form called both "invite code". When you arrive by an invite link on such a
  server, the field is now labelled "Sign-up code for this server (not the
  invite link you clicked)" and a line under it explains that the link joins
  you to the server once your account exists. If you paste the link's own
  code there, the error says exactly that instead of telling you to check for
  typos. The invite dialog's share text tells the person sharing to send the
  sign-up code along with the link on such servers. Servers with open
  registration, and sign-ups that did not start from a link, read as before.
- **The phone app no longer offers settings that cannot do anything on a
  phone.** The Keybinds tab, and the Screen control group under Privacy &
  Safety (the remote-control kill-switch hotkey and "Stop when I touch my
  mouse or keyboard"), are hidden in the Android app: a phone has no host
  agent to inject input and no kill switch to bind. The Push-to-talk and
  Push-to-mute key rows under Voice & Video are still there when that input
  mode is selected. The desktop app and the browser are unchanged.
- The security model's "check this yourself" recipe and its threat table now
  say that encryption for calls is required by default (since 0.8.130),
  matching the setting's actual default.

### Security
- **The Android app's web view now carries a Content-Security-Policy.** The
  web origin and the desktop app already had one; the page bundled into the
  Android app had none. Every APK built through the Android build (full or
  Lite) now has a policy equivalent to the web origin's header written into
  its bundled page: scripts only from the app itself, connections only to the
  server the build was made for (and the call server it hands out per call),
  no embedded objects. A build without a usable server address fails at this
  step rather than shipping a policy naming the wrong server. The web app and
  the desktop app are untouched.

### For self-hosters
- **An abuse runbook for the day the instance gets a public audience.**
  `deploy/ops/README.md` now walks through, with every command real and every
  behaviour cited to the file that defines it: rotating the sign-up code and
  exactly what that does to codes already handed out (server invite links
  are unaffected); removing an account and its uploads with `psql`, since
  there is no instance-level admin API; watching storage against the
  per-user quotas, which have no global cap; what kick, timeout, ban, block
  and report each do and where they live; and proving that the rate limiter
  counts per visitor behind Cloudflare. Linked from the deployment guide.
- **The health check now catches a collapsed rate limiter.** On a box behind
  Cloudflare, `healthcheck.sh` asserts every five minutes that the Caddyfile
  carries the global `servers { trusted_proxies … client_ip_headers
  CF-Connecting-IP }` block from `deploy/cloudflare/caddy-behind-cloudflare.snippet`;
  without it every per-visitor limit is keyed on the edge address and the
  whole internet shares one bucket, so one visitor's burst rate-limits
  everyone. A missing block, an unreadable Caddyfile, or the nonexistent
  `{http.request.client_ip}` placeholder each write a FATAL line to
  `health.log` and syslog; the check never edits or reloads Caddy. Two knobs:
  `CADDYFILE` for a Caddyfile that lives elsewhere, and `OPS_BEHIND_CLOUDFLARE=1`
  (or `=0`) to override the Cloudflare detection.

## 0.9.5 — 2026-09-06

A second adversarial pass over the same boundary, this time against 0.9.4,
looked for what a member who has been removed, blocked, or hidden from a
channel could still do or learn. It found twenty-five smaller holes in that
family; all are closed here. The ones you will notice come first.

### Security
- **Invites expire after 7 days unless you choose otherwise, and stop working
  when the person who made them leaves.** Both invite dialogs now offer 1 hour
  to 30 days or Never and preselect 7 days; an invite created without choosing
  gets 7 days (a client older than this release that picks Never gets 7 days
  too, until it updates — never-expiring codes now have to be asked for
  explicitly). When the member who created an invite is kicked, banned, leaves
  the server, or deletes their account, every invite they created is revoked
  on the spot, and invites whose creator had already left are removed on
  upgrade. The invite list shows who created each code, and creating or
  deleting one is written to the server's audit log.
- **Blocking someone also unfriends them** and withdraws any pending friend
  request between you; unblocking does not put the friendship back. Someone
  you have blocked, or who has blocked you, no longer sees whether you are
  online anywhere: not in the live online/offline notices, and not in the
  member list of a server you share, its members-with-roles list, or user
  search, where you now always read as offline to them. A friend request
  across a block is a real request on the sender's side — sending it again
  says "already pending", it sits in their outgoing list — but the other
  person never sees it: it is missing from their incoming list, and accepting
  or rejecting it by id answers "not found"; unblocking discards it, which to
  the sender looks like a rejection. Blocking an id that does not exist, or a
  deleted account, answers the same empty success as blocking a real one and
  writes nothing. On upgrade, every friendship and every pending friend
  request still sitting beside a block made before this release is removed
  once (migration 063), so people you had blocked disappear from your friends
  list without any action from you; unblocking one of those older blocks
  clears anything that pass left behind.
- **A role with Manage Channels no longer sees channels hidden from it**
  unless it is Administrator (or the owner). Until now Manage Channels
  anywhere in your roles — `@everyone` included — quietly overrode every "hide
  this channel from that role" rule for you; on a server where `@everyone`
  carried it, hiding a channel did nothing at all. A channel manager who is
  hidden from a channel cannot open its settings in the app (that editor
  lives inside the channel); the overwrite API still accepts their
  server-level Manage Channels, and an administrator or the owner can undo
  the override for them.
- **Leaving a call now cuts your media off from the others immediately, and
  theirs from you**, whether you left or were removed: the remaining
  participants close the connection the moment the roster drops you, rather
  than waiting for a separate "stopped streaming" signal that a client could
  skip.
- **Your keys are handed out only to people who have a reason to hold
  them.** A user's identity and signing public keys could be read by any
  signed-in account for any id; now only that user, their friends, members of
  a server they share, and people they have written to get them, and a
  deleted account, a stranger and an impossible id all get the same "not
  found". A block does not withhold these keys: they are what a shared voice
  call's media encryption and its connection pin are built from, and what
  decrypts the direct messages you already have, so blocking someone changes
  nothing about call encryption or about reading an old conversation. The
  per-device DM key list, which exists only to send a new direct message, is
  refused across a block.
- **Revoking a device signs out every connection that device signed in**, not
  only the one that proved it was that device.
- Seeing who reacted to a message, and reacting or un-reacting yourself, now
  need "Read Message History" in the channel, like the message list does.
- "Mark server as read" no longer marks channels you cannot see, so getting
  access to one later no longer hides what was posted in the meantime.
- A chat message sent into a voice channel now needs Send Messages there and
  honours timeouts, exactly like a message into a text channel. The mute,
  deafen and clip-armed status pings of someone who is in the call are
  exempt: they need only the right to see and connect to the channel, so a
  member who can join but not send still shows their state to the room.
- Clip proposals are re-checked against what each person can see at the
  moment every frame is sent: a proposer or approver who has been removed
  from the voice channel stops receiving them, cannot vote, and cannot fetch
  the proposal, and a consent prompt that was waiting for their device to
  come online is dropped instead of ringing for a call they were removed
  from. An approver who cannot see the text channel the clip would be posted
  to is still asked and their vote still counts, but the proposal no longer
  tells them which channel that is. A server's pinned clips channel is not
  shown to members who cannot see it.
- File offers and direct messages waiting for a device to come online are
  re-checked at delivery: one that a block, or a change to "Allow DMs from
  server members", now forbids is not handed over.
- Sending a file to someone who hides their online status now looks the same
  to the sender whether that person is online or not; the file still reaches
  them when they are.
- Moving or disconnecting someone from voice requires being able to see the
  channel they are in; reporting a message requires being able to read its
  channel; a friend request to a deleted account answers "User not found",
  and deleted accounts never appear in friend or request lists; leaving a
  room you never joined no longer announces you leaving it to the people in
  it; and the operator-only migration password reset now signs the account
  out everywhere instead of leaving old sessions and devices valid.

## 0.9.4 — 2026-09-06

An adversarial audit of the boundary between members and non-members confirmed
that nobody outside a server can read its content, and found a set of smaller
leaks and stale grants around that line. All of them are closed here; most are
invisible in normal use, and the ones you may notice are listed first.

### Security
- **Members of the oldest servers may lose channel and role management they
  never should have had.** A very early database migration gave the
  `@everyone` role of every server that already existed when it ran a
  permission mask copied from another product's number layout; under ours it
  read as Manage Channels, Manage Roles, Kick and Ban for every member, and
  Manage Channels also made every "hide this channel from that role" rule
  inert (the same mask also handed everyone the voice moderation controls:
  mute, move, priority speaker). Servers created since were never affected.
  Those `@everyone` rows are now reset to the ordinary member defaults plus
  the anyone-can-manage-checklists behaviour those servers were deliberately
  left with, and the affected servers' channel keys rotate; if a control
  disappeared from your sidebar, that is why, and the owner can grant it back
  through a real role.
- **Revoking "Connect" on a voice channel now removes the person from the
  call**, in both mesh and SFU calls. Until now it only stopped them
  rejoining.
- **You cannot use Manage Roles on yourself** unless you are an administrator
  or the owner. A role's per-channel overrides are not permissions, so a
  moderator could give themselves a permission-less role whose override opened
  a hidden channel, or remove from themselves the role whose override hid it.
- **Losing access to a channel now stops its notifications too.** Message
  notifications that were waiting for you to come back online, and clip
  proposals still open for a vote, are re-checked against what you can see
  now: a kicked, banned or newly hidden-from member no longer receives them,
  cannot vote, and cannot fetch the proposal.
- **Direct messages between two people who share no server are refused**
  unless they are friends or the recipient wrote first. The Settings toggle
  "Allow DMs from server members" now means exactly that: with it on, people
  who share a server with you can write to you; with it off, only friends and
  people you have written to. A deleted account can no longer be messaged, and
  the per-device keys a sender needs are handed out under the same rule.
- **Pinned messages and edit histories respect "Read Message History".** A
  member denied that permission could read message bodies through both.
- **A private moderator queue can no longer be salted.** A report must name a
  message in this server, and a person who is a member of it (or the author of
  that message); the moderators' list no longer shows names or ids that were
  planted from elsewhere.
- **Attachment capabilities are enforced by default.** A file uploaded with a
  capability is served only to a client presenting it, so an account that has
  been kicked, or that merely learned a file id, no longer fetches the blob.
  Every official client has sent the capability since 0.8.134; self-hosters
  with older clients still in the field can set `FILES_ENFORCE_CAP=0` while
  they update.
- **Several routes gave away whether an id exists, or where someone else
  is.** Marking a channel read, deleting someone else's file, moving a member
  who is in a call on another server, reading a stranger's personal checklist,
  parenting a task to one in another list, and replying to a message from
  another channel all answered differently for "does not exist" and "not
  yours"; each now gives one answer that says nothing about what you cannot
  see. Listing who is in voice accepted a channel's *name* as a room id, so a
  channel named after another server's room showed its occupants; rooms are
  now matched by id only.
- **Safety checks no longer fail open on a database error.** Ban, timeout,
  block and accepts-DMs lookups refuse when the database cannot answer,
  rather than treating "no answer" as "allowed"; the same for whether a clip
  approver shows as online, which also now honours "Show online status".

## 0.9.3 — 2026-09-05

### Security
- **Direct messages are now sealed under keys your password cannot unlock.**
  Until now a DM was sealed under a key derived from both people's identity
  keys — and your identity key is what your password unwraps, so someone with
  a copy of the server's database who cracked your password could read every
  DM you ever exchanged. Each DM is now sealed under a fresh random key that is
  wrapped only to your devices' session keys and to your account's history key,
  whose private half is wrapped under your 12-word recovery code and nothing
  else. A cracked password reads none of them. On a new device, new messages
  arrive as usual; older ones show as locked until you enter the recovery code
  there — it stays until that device signs out. **Accounts from before this release turn it on by generating a
  new recovery code in Settings → My Account**; a conversation switches only
  when both people have, and every device either of you has used in the last
  two weeks can read the new format — nothing you have installed is sent a
  message it cannot open. Messages from before the switch stay as they were.
  This is not per-message forward secrecy; the security model says exactly
  what it is.
- **The server cannot add itself as a reader of those messages.** Every key a
  message is sealed to — each device's session key and the account's history
  key — is signed by the account, and a sender checks each signature before
  using it. The signing key itself is vouched for to each contact under the
  two identity keys already pinned between them (the ones the safety number
  covers), in a form the server cannot compute. A key the server lists on
  its own is ignored; a signing key it substitutes fails that check and the
  conversation stays as it was. Published keys are write-once, so a stolen
  session token cannot replace them.
- **Sign-in timing no longer depends on your password.** The secret exponents
  in the SRP exchange go through a fixed-width Montgomery ladder with exponent
  blinding.
- **A message that was never encrypted, in a conversation that is, is now
  labelled as such.** Every plaintext row already carried a "Not encrypted"
  tag. One that arrives *after* the conversation was carrying sealed messages
  — which no app of ours would write — is now badged "Not encrypted —
  unexpected" in red: the server, or someone with its database, put it there.
- **Your sign-in verifier is now derived with Argon2id.** The server never sees
  your password; what it stores is an SRP verifier, and until now that verifier
  was derived with two plain SHA-256 calls — so someone holding a copy of the
  database could test guesses against it about ten thousand times faster than
  against the Argon2id-wrapped identity key beside it. New accounts, password
  changes and every kind of reset now derive the verifier at the same Argon2id
  cost as that wrap. **Existing accounts move across automatically the next
  time you sign in** from a current client: the app proves your password the
  usual way and, in that same exchange, hands the server a replacement
  verifier, which it accepts only because the proof succeeded. There is no
  separate "upgrade" request that a stolen session could call. Until you sign
  in, your account keeps the old verifier; a database copy taken before then is
  as attackable as it always was.
- Older clients keep working: a client from before this release still signs in
  and can still register or reset a password, and the server records which
  derivation such a client used rather than assuming the new one — assuming it
  would have locked those accounts out of every current client. **One
  consequence:** once you have signed in from a current app, an app from before
  this release can no longer make a *fresh* sign-in to that account until it
  updates; already-signed-in ones are unaffected. Desktop updates itself and the
  mobile app updates over the air.
- **The Windows build can now sign its binaries.** Nothing changes until a
  certificate exists: with none configured the build is unsigned exactly as
  before. When one is (an environment variable; see `docs/CODE_SIGNING.md`),
  the app, the installer and the helper binaries are signed in the one order
  that keeps auto-update working.

### Added
- **Linux hosting transport (groundwork; the Linux desktop app is still
  unreleased).** The Linux helper that captures the screen and injects input
  (X11) has existed for a while; what it lacked was any way for the desktop app
  to reach it — on Windows that is a named pipe. It now has a Unix socket:
  owner-only (0700 directory, 0600 socket), one client at a time, and every
  connection's uid checked by the kernel before the token handshake. Exercised
  end to end against the built helper, headless. A full controller session
  through a Linux host has not yet been run; the FAQ says exactly where that
  stands.

### Changed
- The Lite build's description now says what it is: it cannot be remotely
  controlled (no host agent is installed), but it is not a build with the
  screen-capture code compiled out — no build that can share a screen could
  be. The README, the FAQ and the installer text were corrected.
- A new FAQ (`docs/FAQ.md`) says what works on each platform, and the security
  model now says that the client — not the server — is what marks a message
  that was never encrypted.
- **Opening a voice channel no longer drops you into a silent call.** On a
  browser that cannot end-to-end encrypt live media (Firefox, Safari, iOS) with
  “Require encryption for calls” on — the default — the app used to auto-join
  the channel anyway, muting you and everyone else by design, and only then
  show the notice explaining why. The notice now comes first and the auto-join
  does not fire; Join Voice is still there if you want it, and the notice says
  what to do instead: a Chromium-based browser, or the Windows or Android app.
- **Turning that setting off now says what you get.** With encryption not
  required, the same browsers used to join with no notice at all, which read as
  “encrypted anyway”. A warning now sits above Join: the call will be
  transport-encrypted only, and the server can access your voice and video.

### Fixed
- **Updating part of your profile no longer fails.** Changing, say, your bio
  without also changing your status hit a bad SQL placeholder and returned an
  error; the query is now built from the fields actually present.

### Upgrading
- **Update the server first, then the clients.** A current client refuses to
  create an account or change a password against a server older than this
  release: that server could not record which derivation produced the
  verifier, and the account would never sign in again. An older client keeps
  working against the new server — it signs in, reads and sends — as rehearsed
  with a real 0.9.2 client against this backend.
- If you have enrolled a computer as a remote-control host, its background
  service holds sessions of its own. Sessions it created before this update
  count as "recent" for up to two weeks, so forward-secret DMs to and from
  that account may start up to two weeks after the update rather than at once.

## 0.9.2 — 2026-09-03

A follow-up to 0.9.1 for one problem that could not fix itself, plus the
groundwork for publishing the source.

### Fixed
- **"Live connection failed" that never cleared.** If you updated from an older
  release, the pre-rename `app.exe` was left in your install folder, still
  launchable — and a taskbar pin aimed at it started a months-old client rather
  than failing. That client cannot open a live connection to a 0.9.1 or newer
  server: it signs in, then shows a connection error blaming your firewall,
  which nothing on that screen can fix. The installer now removes the
  superseded binary and stops the background helpers that were holding their
  own files open and preventing replacement. **If you have a pin that still
  misbehaves, unpin it and pin again from the Start Menu.**
- **That error screen told you two untrue things.** It said the problem
  "usually clears by itself" while nothing was retrying, and it blamed a
  firewall — the least likely cause. It now says what actually happened, and
  when your copy is out of date it says so and offers the update.
- **A backend restart no longer throws an error at everyone connected.** The
  app gave up reconnecting after about three seconds, which is shorter than a
  restart takes, so every server update produced an error dialog for a
  condition that resolves on its own. It now waits about fifteen.
- **The source link the licence requires is reachable.** Settings → App Info
  shows the licence and links the source of the version your server runs, which
  the AGPL entitles you to and which previously existed only as an endpoint
  nobody could find.

### Changed
- Documentation now states what the software does rather than what was once
  planned: that the installers are unsigned and warn on first run, that
  encrypted call media needs a Chromium-based browser, and that search runs on
  your own device over the conversation you have open.

## 0.9.1 — 2026-09-03 (the launch release)

Everything the launch-readiness pass found, in one update.

### Added
- **Download your data.** Settings → Privacy & Safety will produce a single
  JSON file holding your account's own rows — profile, memberships, friends,
  the messages you wrote, tasks, uploads, devices and preferences — decrypted
  on your own machine by your own keys, with anything this device cannot open
  left as ciphertext and counted in the summary. It asks for your password,
  and allows one export a minute. Other people's messages are not included:
  they are theirs.
- **A plain statement of what leaves your device and what your server can
  see**, in Settings → Privacy & Safety, next to the export. It names the
  metadata a server operator can read, what it cannot read, and the two
  places anything is fetched from a third party.

### Fixed
- **Voice hotkeys that worked about half the time.** Push-to-talk, mute and
  deafen from inside a game now come from two independent sources: the system
  hook, and a 20 ms check of the physical key state that catches a press or
  release the hook missed. Windows removes a hook without warning when the
  machine is loaded, and a key released on a security prompt was never seen
  at all; one lost release used to leave push-to-talk open and swallow the
  next press too, which is why it felt like every other press worked.
  Hotkeys could also vanish whenever the app wrongly believed it still had
  focus while a game was in front, and for a mouse button pressed with the
  pointer outside the window; the answer now comes from Windows itself. Keys
  sent by a gaming mouse's own software (G HUB, Synapse) or by AutoHotkey
  were being ignored as "injected"; only Púca's own remote-control input is
  now. A game going fullscreen mid-call used to restart the whole hotkey
  system, closing a held push-to-talk. A Ctrl or Shift pressed in the same
  instant as its key could go unseen by a toggle. A hotkey on a mouse button
  no longer stops working while the message box you type in has focus, and a
  quick settings change can no longer leave one keypress handled twice. If a
  game runs as administrator, Windows hides its keys from every program that
  does not, and Púca now says so in a banner instead of failing silently.
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
- **Updates could stop looking after one wrong answer.** The desktop and
  mobile update checks try more than one address; a reply from something that
  was not Púca used to end the search instead of moving on to the next one,
  leaving the app on an old version with no sign anything was wrong. The
  failure message now names what would help.
- Joining a call from Firefox, Safari or iOS now says up front that the
  browser cannot encrypt live media, and what your options are, instead of
  the call simply being silent in one direction.
- Sharing a folder that sits on a network drive is refused when you pick it,
  naming the reason, rather than being accepted and then failing on every
  browse.

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
