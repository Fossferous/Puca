# Sticky notes (Púca's desktop app, Windows)

A Púca Notes note can live on the desktop as a **sticky note**: a small
coloured window of its own that you move, resize, keep on top of other
windows or dock to the side of the screen, and that comes back where you
left it when Púca starts. It is the same note Púca Notes shows everywhere
else — the same sealed text, items, pictures and colour, synced end to end
encrypted between your devices — in a different frame. Both installers (the
full app and Lite) have it: it is Notes, not remote control.

This document is the design. It starts from what Microsoft's Sticky Notes
actually does (checked against Microsoft's own pages, linked), says for each
feature whether Púca Notes already had it, builds it, or does not, and why.

## What Microsoft's Sticky Notes does

Two apps carry the name. The **classic** Sticky Notes (the Microsoft Store
app, 3.x to 6.x, still in Windows 11) and the **new** Sticky Notes inside
OneNote for Windows (2024, opened with Win+Alt+S). The new one has no
support article of its own; its documentation is three Microsoft 365 blog
posts.

Sources (opened 2026-11-16):

- [Keyboard shortcuts for Sticky Notes](https://support.microsoft.com/en-us/accessibility/windows/stickynotes/keyboard-shortcuts-for-sticky-notes) (the complete table)
- [Get started with Sticky Notes](https://support.microsoft.com/en-us/windows/apps/stickynotes/get-started-with-sticky-notes)
- [Create a sticky note](https://support.microsoft.com/en-us/windows/apps/stickynotes/create-a-sticky-note)
- [Delete a sticky note](https://support.microsoft.com/en-us/windows/apps/stickynotes/delete-a-sticky-note)
- [See your sticky notes on other devices and the web](https://support.microsoft.com/en-us/windows/apps/stickynotes/see-your-sticky-notes-on-other-devices-and-the-web)
- [Troubleshoot Sticky Notes](https://support.microsoft.com/en-us/windows/apps/stickynotes/troubleshoot-sticky-notes)
- [FAQ for Sticky Notes administrators](https://support.microsoft.com/en-us/windows/apps/stickynotes/faq-for-sticky-notes-administrators)
- [Use a screen reader with Sticky Notes](https://support.microsoft.com/en-us/accessibility/windows/stickynotes/use-a-screen-reader-with-sticky-notes)
- [Sticky Notes release notes](https://learn.microsoft.com/en-us/previous-versions/windows-insider/apps/sticky-notes) (archived; nothing after 3.7, 2019)
- [Introducing the new Sticky Notes app on Windows](https://techcommunity.microsoft.com/blog/microsoft365insiderblog/introducing-the-new-sticky-notes-app-on-windows/4223819)
- [Remember better with the new Sticky Notes experience from OneNote](https://techcommunity.microsoft.com/blog/microsoft_365blog/remember-better-with-the-new-sticky-notes-experience-from-onenote/4127624)
- [OneNote's new Sticky Notes feature for Windows receives update](https://techcommunity.microsoft.com/blog/microsoft_365blog/onenote%E2%80%99s-new-sticky-notes-feature-for-windows-receives-update/4240339)
- [Keyboard shortcuts in OneNote](https://support.microsoft.com/en-us/office/keyboard-shortcuts-in-onenote-44b8b3f4-c274-4bcc-a089-e80fdcc87950) (Win+Alt+N is OneNote's Quick Note)
- [Keyboard shortcuts in Windows](https://support.microsoft.com/en-us/windows/keyboard-shortcuts-in-windows-dcc61a57-8ff0-cffe-9796-cb9706c75eec)

The seven colour names (Yellow, Green, Pink, Purple, Blue, Gray, Charcoal)
are on no Microsoft page; they are the strings of the classic app itself.

## Feature by feature

**Had** = Púca Notes already did it. **Built** = new with this change.
**Not built** = and why, with what Púca offers instead.

### The classic app

| Microsoft | Púca | |
|---|---|---|
| Each note in its own window; drag the top bar to move it, the edges to resize it | Each sticky note is its own window: drag its coloured bar, resize from its edges. *Open as sticky note* on a note's menu, in the open note's footer, or a new one from the tray, the global shortcut or Ctrl+N | Built |
| A note can be maximised | Not offered: a maximised sticky note is not a sticky note. *Open in Notes* (Ctrl+H) shows the note in Púca Notes' full editor | Not built |
| Notes reopen where you left them | The notes that were open come back when Púca starts, each where it was and at its size (Settings › *Reopen sticky notes when Púca starts*, on) | Built |
| Close a note without deleting it (X, Ctrl+W) | X or Ctrl+W closes the window; the note stays in Notes | Built |
| The notes list (Ctrl+H), newest first, with search (Ctrl+F) | Púca Notes itself: Ctrl+H in a sticky note opens it in Púca's window, Ctrl+F opens it with the search box ready. Its sort (Púca order, title, newest, edited), labels, archive and reminders are more than the list had | Had; the doors Built |
| Seven colours | Twelve tints, the seven among them; a new sticky note starts yellow | Had; default Built |
| Light, dark or "Use my Windows mode" | Sticky notes wear Púca's theme (eight, with high contrast), and change with it | Had |
| Bold, italic, underline, strikethrough, bullets — a bar at the bottom and Ctrl+B, I, U, T, Ctrl+Shift+L | The same bar and the same keys in a sticky note — and the keys in every note's text in Púca Notes and Púca's Tasks view (*Formatting* below) | Built |
| Font and size cannot be changed | The same | — |
| Pictures (camera button; right-click to remove) | A sticky note shows the note's pictures and drawings; *Add picture*, paste and drop add more. Removing one, and drawing, are in the open note in Notes | Had; in the sticky Built |
| Ink and pen | Drawings (Púca Notes' drawing canvas) | Had |
| Delete (Ctrl+D, *Delete note*), permanent | Ctrl+D or *Delete note* moves the note to Púca Notes' **trash**, where it can be restored for 30 days | Built |
| *Confirm before deleting* | *Ask before deleting a sticky note* (on), with *Don't ask again* in the question itself | Built |
| Sign in to sync (Microsoft account); notes on OneNote mobile, Outlook, the web | Synced, end to end encrypted: Púca Notes on the web, its Android app, Púca's Tasks view | Had |
| Export through Outlook.com | Notes' own Markdown and JSON export | Had |
| Insights (times, addresses, phone numbers turned into actions, through Cortana/Bing) | Web addresses are links, found on the device, nothing fetched (docs/NOTES.md, *Links in a note*). The rest needs a third party to read the note (a maps or search service), which is the one thing an end-to-end encrypted note must not do; a time belongs in a reminder, which a note has | Not built |
| Always on top: not supported in the classic app | Every sticky note has a pin: on top of other windows, or not (off for a new note) | Built |
| Taskbar menu: *New note*, *All notes*; *Show all notes*, *Hide all notes* | Púca's tray menu: *New sticky note*, *Show sticky notes*, *Hide sticky notes*. Sticky notes take no taskbar buttons of their own | Built |
| Virtual desktops, Alt+Tab | Sticky notes are ordinary top-level windows | Built (not walked on a real desktop) |
| Narrator, keyboard, high contrast | Every control is a labelled button reachable by Tab, every action has a key, high contrast follows Púca's | Built |
| Ctrl+Tab / Ctrl+Shift+Tab cycle through the notes | The same, between the sticky notes that are open | Built |
| Alt+F4 closes Sticky Notes | Alt+F4 closes the one sticky note window, as it closes any window; Púca stays in the tray | Built |

### The new app (in OneNote)

| Microsoft | Púca | |
|---|---|---|
| Win+Alt+S opens it from anywhere | A global shortcut makes a new sticky note from anywhere: **Win+Shift+N** by default (Win+Alt+S is Microsoft's own and Win+Alt+N is OneNote's Quick Note), changed or removed in Settings, which says when Windows or another app already holds it | Built |
| *+ Note* | *+* on every sticky note's bar, Ctrl+N, the tray, the shortcut | Built |
| Pop a note out larger; an image full size | A sticky note resizes freely; *Open in Notes* shows it in the full editor, pictures and all | Had |
| Dock to the side of the screen | *Dock left* / *Dock right* on the note's menu: the full height of the screen at the side, at its own width; *Undock*, or dragging it away, puts it back. It does not push other windows aside (that would be an app bar, which reserves the edge of the screen for itself) | Built |
| Always on top (a pin) | The pin | Built |
| *Copy Note* | *Copy as text* on the note's menu (Markdown, as Notes' own *Copy as text*); pictures are not copied | Built |
| A screenshot of the window in front, with a link back to the web page it came from | Windows' own Snipping Tool (Win+Shift+S) puts a picture on the clipboard and Ctrl+V pastes it into a sticky note. Reading another app's window, and the address of the page it shows, needs the browser's cooperation (Edge's, in Microsoft's case) that Púca does not have and should not ask for | Not built |
| Recall: a note rises when you return to the page, document or meeting it was made in | It would mean Púca watching which app and page is in front, all day, and keeping that record beside your notes: a log of everything you do on the PC. Not something a private notes app keeps | Not built |
| Search inside pictures (OCR) | Search reads a note's text; pictures are not read | Not built |
| Microsoft 365 account, Outlook, OneNote | Púca's own account and server; no Microsoft service sees a note | — |

## How it works

### One window per note, drawn by the main page

A sticky note window is the same kind of window as a stream pop-out
(`frontend/src-tauri/src/popout.rs`, `components/streamOsWindows.ts`): the
main page calls `window.open("about:blank#puca-sticky-<slot>")`, WebView2
raises *NewWindowRequested*, and the shell (`src-tauri/src/sticky.rs`)
answers with a real Tauri window built in the SAME WebView2 environment. The
popup is a same-origin, blank document that the MAIN page scripts directly:
React portals the note into it (`createPortal(…, popup.document.body)`),
exactly as the pop-out portals a `<video>`.

That is the whole security argument, and it is why this design and not a
window per note running its own copy of the app:

- **The decrypted note, the vault keys and the session never leave the main
  page.** Nothing is sent over IPC, nothing is decrypted a second time, and
  no second page signs in. The popup's own realm runs no Púca code; every
  handler in it is a main-page React handler. A sticky window therefore holds
  exactly what the main window already holds — no more, in no new place.
- **No content crosses into the shell.** The commands a sticky window uses
  carry a slot number, a note's key (`<user id>/list:<id>`), a rectangle and
  a pin. The window's title is always *Sticky note*, never the note's: a
  window title is readable by every other program on the PC (the window
  list, task switchers, accessibility and automation tools), the same reason
  Notes' launcher shortcuts carry no note titles.
- **A sticky window can only ever be `about:blank`**: the shell refuses every
  navigation, and the popup's own `window.open` has no handler, so it is
  denied. Links in a note leave through the same router the main page uses
  (`api/linkRouter.ts` `routeLinkClick`), installed on each popup document.
- **The shell remembers geometry only**, per note: `sticky-windows.json` in
  the app's config folder holds a rectangle, the pin and the dock side under
  the note's key, the 400 most recently used. WHICH notes are open is the
  page's, on this device, per account (`pucaStickyOpen:<user>` in local
  storage), because only the page knows whether a note still exists; signing
  out clears it.

The windows have no system frame (`decorations: false`) and draw their own
coloured bar: drag it to move the window (`sticky_drag` →
`start_dragging`), and tao keeps a frameless resizable window resizable from
its edges. They take no taskbar button (`skip_taskbar`). A note reopened
when Púca starts is opened without taking the focus.

**Closing is told apart from going.** The person closing a sticky window
(Alt+F4) is a close REQUEST, which the shell reports to the page
(`sticky://closed`, with the slot): that note leaves the desktop, as X and
Ctrl+W do. When the shell destroys the windows itself — the page reloading,
Púca quitting, the main window going — there is no request: the windows
leave the screen and the notes stay in the stored set, so they come back at
the next start. Without that difference every quit would have looked like
the person closing every note.

Slots, not note numbers, name the windows (`sticky-1` … `sticky-24`), as for
pop-outs: the URL filter stays the strict one-number filter, and a note made
offline — whose number changes when it is saved — keeps its window
(`sticky_rekey`). The page binds a slot to a note (`sticky_bind`) before it
opens it, and the shell refuses a sticky window for a slot nothing is bound
to. Closing waits for the window to be destroyed before the slot can open
again (`sticky_close`, popout.rs has the measurement of why).

### Inside Púca Notes, not beside it

The sticky windows are part of Púca Notes' own tree in the desktop app
(`NotesDesktopView` → `NotesShell` → the sticky layer,
`components/sticky/`). So a sticky note uses the same data layer as the note
in the grid: the same query cache, live updates, offline queue, the same
compare-and-swap save of the note's text (a sticky note and another device
typing in the same note get the same *Keep mine / Use theirs* question —
it is the same `NoteBodyField`), the same colours. An edit in a sticky note
is on the grid at once, and the other way round.

This is why Notes is mounted at start when there are sticky notes to bring
back, or as soon as the global shortcut or the tray asks for a new one,
even before the rail's *Tasks & notes* is pressed. Mounted, it is hidden
(as it is when you leave it for a channel) and it costs what an opened Notes
costs: its queries and one live-update stream for the account.

The sticky code lives in `components/sticky/`, outside `src/notes`:
`NotesShell` takes it through its `embedded` prop, so Notes' own web page
and its Android app never load it.

### Formatting

Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+T and Ctrl+Shift+L — Microsoft's keys — work in
a sticky note, and in every note's text in Púca Notes and Púca's Tasks view.
A sticky note has the bar at the bottom too.

The formatting is **written into the note's text as marks**, a subset of
GitHub-flavoured Markdown (`notes/model/noteFormat.ts`):

    **bold**   *italic*   <u>underline</u>   ~~strikethrough~~   - a bullet

The text stays the one sealed string it always was. Nothing changes on the
server, search and export read the same words, a note exported as Markdown
shows the same formatting in any Markdown viewer, and an older Púca or Notes
shows the marks as typed characters rather than losing anything.

The text field shows the marks while you type in it; the note shows the
formatting everywhere it is read — a sticky note you are not typing in, the
open note's text in Notes, a card on the grid, Púca's Tasks view. Clicking
the formatted text puts the caret where you clicked.

It is **not chat's Markdown**, on purpose: `utils/linkSegments.ts` records
why a note's text is not read by the chat parser (`__file__` would turn into
underline). Underline is `<u>…</u>` here, never `__…__`, and a mark counts
only where it cannot be ordinary writing — it opens at the start of a word
and closes at the end of one, on one line, around something that does not
start or end with a space. `2*3*4`, `a**b`, `snake_case`, `__init__` and
`C++` stay exactly as typed; nothing inside a web address is ever a mark.
Enter on a bullet starts the next one; Enter on an empty bullet ends the
list.

### The global shortcut

A Win32 hot key (`RegisterHotKey`) on a thread of its own in the shell, not
the low-level keyboard hook Púca uses for push-to-talk: Windows delivers a
hot key only when its exact combination is pressed, so no keystroke of any
other app passes through Púca, and Windows refuses a combination another app
already holds — Settings then says *taken by Windows or another app*. It
needs Ctrl, Alt or the Windows key (Shift and a letter is typing), and it
does not repeat while held. It is registered while Púca is signed in, and a
press makes a new sticky note, which takes the focus.

The default is Win+Shift+N. Windows' own list of shortcuts has no
Win+Shift+N, Win+Alt+S is Microsoft's new Sticky Notes, and Win+Alt+N is
OneNote's Quick Note. Ctrl+Alt+letter was ruled out: on many keyboards
Ctrl+Alt is AltGr, and a global Ctrl+Alt+N would take away a letter
(Polish *ń*) from every app.

### Settings

Settings › *Desktop App* › **Sticky notes** (desktop app only):

- **New sticky note shortcut** — Win+Shift+N; click to change, Reset, or
  remove it.
- **Reopen sticky notes when Púca starts** — on.
- **Ask before deleting a sticky note** — on. *Don't ask again* in the
  question turns it off.

All three stay on this device.

## Keys in a sticky note

| Key | |
|---|---|
| Ctrl+N | New sticky note |
| Ctrl+W | Close this note (it stays in Notes) |
| Ctrl+D | Delete this note (to the trash) |
| Ctrl+H | Open Púca Notes |
| Ctrl+F | Search in Púca Notes |
| Ctrl+Tab / Ctrl+Shift+Tab | The next / previous sticky note |
| Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+T | Bold, italic, underline, strikethrough |
| Ctrl+Shift+L | Bullets |
| Ctrl+Z, Ctrl+Y (Ctrl+Shift+Z) | Undo, redo |
| Alt+F4 | Close this note's window |

## What a sticky note holds

A personal note: its text, then its items (tick them, add one), then its
pictures, with the formatting bar at the bottom. A shared note (a checklist
channel) has no text of its own, so it shows its items. A note with headings
shows them as section titles, as Notes does. Dates, repeats, reminders,
labels, moving items and drawing are in the open note in Notes; the sticky
note's menu has *Open in Notes*.

A new sticky note is a draft until something is typed in it: closing it
untouched saves nothing, as closing an untouched *Take a note…* does. Its
first words make the note, named after its first line, as the composer
names a note with no title — exactly once, however many saves the text field
asks for while that first one is still out, and the words typed meanwhile go
into that note. It starts yellow (*sand*). A picture added to a draft makes
the note too.

A note the window shows that Notes has not read yet (Púca just started) gets
no window until Notes has it, so an empty page that typing into would make a
new note never appears; a note Notes no longer has (trashed here or on
another device, deleted, its server left) closes. A note this window has just
made is not taken for a missing one while Notes catches up with it.

The sticky note says its own few things in its own window (*Copied as
text*, a picture refused, a save that failed): Púca's toasts are drawn in
Púca's window, which may be in the tray. A message the data layer raises
for any note (a refusal from the server, say) still appears in Púca's
window.

## Verifying

- `cargo test` in `frontend/src-tauri` (`sticky::tests`): the sticky URL
  filter, labels, note keys, placement, docking, the store, and the
  shortcut's rules.
- `src/tests/noteFormat.test.ts`: what reads as a mark and what never does,
  and the edits the keys make. `src/tests/noteFormatField.test.tsx`: the
  keys and the read view in the real NoteBodyField, a click's place in the
  text, and every field's save waited for by a delete.
- `src/tests/stickyNotes.test.tsx`: the sticky layer under jsdom with the
  shell faked — bind before open, the note drawn in the window's document,
  reopening only once Notes has the note, the draft making one note, the
  keys, Delete's question. `src/tests/stickyHotkeySettings.test.tsx`: the
  shortcut's registration and the Settings row.
- `e2e/notes-desktop-embed.mjs`: sticky notes in the BUILT bundle under its
  fake desktop shell, the popups being real same-origin windows in headless
  Chromium (no window opens on the desktop). Ctrl+N and Ctrl+W are headless
  Chromium's own reserved keys — pressed in a popup, the browser opens a
  window or closes the popup whatever the page does — so the walk hands
  those two to the page; WebView2 has no tabs and reserves neither.

None of these opens a real window. What only a real desktop shows — the
frameless window's shadow and edge resizing, dragging, Alt+Tab and virtual
desktops, the hot key reaching Púca from a game — has not been walked.
