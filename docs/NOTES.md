# Púca Notes

A notes app, Google-Keep style, that is a second front door onto Púca's task
system. Same account, same end-to-end encryption, same lists and checklist
channels — its own page, its own shape. It lives at **`/notes/`** on the web
app's origin (`https://app.example.com/notes/`), and Púca's Tasks view links to
it from the tab bar.

The server holds little that is new: a note's sealed text, its pictures and
the trash (migration 065 — *Text, pictures and the trash* below), an item's
sealed date, repeat and snooze (066 — *Calendar, repeats and snooze*), and one
sealed document for Notes' own colours, labels and archive plus a
content-free stream of "this changed" (067 — *What follows the account*,
*Live updates*). A Notes **note** is a Púca **personal task list**; a
**shared note** is a **checklist channel** from one of your servers;
the rows in a note are the tasks themselves. Pinning a note favourites the tab
in Púca; reordering notes reorders Púca's tab bar; a due time set in Notes fires
Púca's reminders. Anything you do in one is what you see in the other.

## What it does

- **Grid of notes** — pinned first, masonry on desktop, one column on a phone,
  grid/list toggle. Each card shows the open items with live checkboxes,
  progress, the next due time, image thumbnails, labels and (for a shared note)
  the server it belongs to.
- **Take a note…** — a title and items, Enter for the next item; on a phone the
  `+` button opens the same composer as a sheet. Where the server has
  migration 065 the composer also takes free text, photos (the camera on a
  phone) and a drawing.
- **Open a note** — Púca's own task tree: inline edit, subtasks, drag an item
  to reorder it and to nest it, due times, attachments, the collapsible
  Completed section. It is the same component Púca renders, so a note lays out
  exactly as it does in the Tasks view. (Dragging a whole NOTE into place is a
  different thing — see *How it maps onto Púca*.) A **List actions** button
  appears in its foot as soon as something is ticked, with *Uncheck all* and
  *Delete checked* — what a weekly shopping list needs to start again. Both
  offer Undo, and Undo after a delete brings the items back with their dates,
  repeats, pictures, their ticks and their nesting — a ticked subtask under a
  parent that was not ticked goes back under that parent, not to the top of
  the list. *Uncheck all* asks first when a ticked repeating to-do whose
  series has already finished is among them, because unticking that one
  reopens a repeat with no next time. Both are refused while offline or while
  changes are waiting to sync, for the same reason *Show checkboxes* is — a
  hundred writes that replay later is not what the button looked like when it
  was tapped. And there is deliberately no "move checked to bottom": ticked
  items are always in the Completed section at the bottom, here and on the
  server, so there is nowhere else for them to be.
- **Search** — over decrypted titles, items, labels and server names, on the
  device; nothing about the query leaves it. Matches are **highlighted** in a
  card's title, its text and its items. A long note shows a piece of itself
  around the match instead of its opening lines, and a card says so when it
  matched something it cannot show — a ticked item, an item past the eighth,
  or a place on a date, all of which the card normally folds away. Opening a
  result steps through its matches. The marking up is worked out in memory
  from text this device has already decrypted: it is never stored, never
  cached and never sent, the query still never reaches the address bar, and
  text that cannot be decrypted is neither searched nor highlighted.
  Each "also matched" line is windowed around its own match: the row is a
  single ellipsised line, and the match is the only thing it exists to show.
- **Reminders** — everything with a time, grouped Overdue / Today /
  Upcoming: every open item with a due time, and **every note that reminds
  you by itself** — a note needs no checklist item to hang a time on (*A
  reminder on the note itself*, below). Tick an item done from there; a note
  row has nothing to tick, so it offers *clear this reminder* instead. Or
  move it: a clock on the row changes when it is due without opening the
  note, and an item that repeats or is an event opens the same *Date &
  repeat* editor the calendar uses. That is offered only to people who may
  edit the item's time — its creator, a task manager, anything in a personal
  note — which is what the server enforces; on a server that stores no
  schedules only a plain due time can be moved this way. In a browser, Notes runs Púca's reminder
  loop, so a due item notifies while the Notes tab is open (allow
  notifications from the Reminders view). The Android app notifies whether it
  is open or closed (see *The Android app*), and adds an **At a place**
  section for items with a place saved on that phone. A due item in a shared
  note that someone else created says **Reminds whoever set it**: the
  reminder feed covers the shared items *you* created, so that one never
  alerts you. **Púca's own Tasks view pins the same view as a Reminders
  tab**, over every personal list and checklist channel, and a due-item
  notification opens it — whether Tasks was closed or already on screen: the
  tap and the web notification click both raise one window event, which a
  mounted Tasks view answers by switching tabs. That tab and the Calendar tab
  read every scope through one cached query (`components/taskSources.ts`) with
  a 30-second staleness window, while a list tab keeps its items in its own
  state and writes straight to the API — so every writer outside those two
  tabs calls `invalidateTaskScope` once the server has answered, or a date set
  in a list is missing from Reminders for up to half a minute. That is all of
  them: the Tasks view's own due and completion writes, the shared date/repeat
  and snooze setters, and `ChecklistBody` — the channel side panel, a
  checklist channel, the All-checklists board and Notes-to-self. The socket
  does not cover that last one either way: a checklist broadcast excludes the
  member who made the change, and a personal list has no channel to broadcast
  on at all. So this is not
  a Notes-only surface, and the
  "Reminds whoever set it" line matters more there, because Púca's rows
  include items every other member set.
- **Calendar, repeats, snooze, Edited** — a Calendar in the rail, dates and
  repeat rules on items, snoozing reminders, and an Edited time on every note
  (see *Calendar, repeats and snooze* below).
- **Colour, labels, archive** — shared organisation, sealed to your own key
  and synced across your devices (see *What follows the account* below).
  Púca's Tasks view shows and sets the same three (see *Both front doors
  agree* below). *Edit labels* beside **Labels** in the rail renames, merges
  or deletes a label across every note, the archived ones included (see
  *Managing labels* below).
- **Select several** — a checkbox on hover, Shift/Ctrl-click and Ctrl+A on a
  desktop, a long press on a phone (then taps add to the selection); `Esc`
  clears. The bar pins or unpins, colours, labels, archives, moves to the
  trash (personal notes, after an Undo window — shared notes and Notes to
  self are skipped and the button says so), makes copies or copies them as
  text, all at once. Pinning is one save of the full order, so notes hidden
  by a filter or sitting in the trash keep their slots; colour, labels and
  archive are one sealed write. Selection exists only on the note grid:
  Reminders, Trash and Calendar have none (Ctrl+A there selects nothing), and
  leaving the grid drops a selection and sends a bulk delete that is still in
  its Undo window.
- **Undo** — archive and delete show an Undo snackbar. Against a server with
  the trash, *Move to trash* happens at once and Undo restores the note (both
  go through the offline queue, so an Undo made offline replays right behind
  the move); against an older server a delete reaches the server only when
  the snackbar expires, as before. A bulk delete always waits out its Undo
  window first.

  Deleting an ITEM inside a note shows the same snackbar, and Undo puts the
  item and everything under it back: its text, its nesting, its date, repeat
  and snooze, its pictures, and whether it was ticked. A subtask deleted on
  its own goes back under the item it was under. A branch that was part done
  comes back part done — a subtask that was still open under a ticked parent
  stays open. A repeating to-do comes back on the date it was on, not the next
  one. Two things the Undo
  cannot promise, because a note's items have no undelete on the wire and the
  item is CREATED again: it comes back as a new item, so in a shared note it
  is now yours (the byline changes, and with it who may edit it), and it lands
  at the end of its group rather than in its old slot. An Undo made offline is
  queued behind its own delete, so both land when the queue drains. The
  editor shows one snackbar at a time: a second delete, or a checkbox
  conversion, ends the Undo before it.

- **Undo and redo the note's text** — while a note is open, Ctrl+Z and
  Ctrl+Shift+Z (Ctrl+Y as well) step back and forward through what you typed,
  and a pair of buttons appears under the text once there is anything to go
  back to, so it works on a phone too. A burst of typing is one step and a
  paste is its own, so undoing a paste the note has already saved is a single
  step. The history lives only in the page you are typing on: it is never
  written to the offline copy, it starts again when text arrives from another
  device (so it can never put your older text back over their newer save),
  and it goes when you close the note or sign out.
- **Make a copy** — the whole note again: its text, its pictures and
  drawings, and every item, ticked or not, with its nesting, its due time and
  its date & repeat. The repeat is copied as a NEW series rather than the same
  event twice, so ticking one does not touch the other. The pictures are
  encrypted again for the copy, so it owns its own files: deleting either note
  forever never touches the other's, and the copy counts against your storage
  as well. The copy takes the note's colour and labels, and is never pinned
  and never lands in the archive. A note holding something this device cannot
  read — its title, an item, a date, the text, or a pictures sidecar whose
  key has not arrived — is not copied at all, rather than copied with the
  unreadable part quietly missing; and a note whose items have not loaded is not
  copied yet, which used to make an empty note and still say "Copied". A copy
  with pictures needs the network: like the composer, it never queues — and
  a copy that fails says so, so a copy that did not happen can never look
  like one that did.
- **Copy as text / Export / Share** — a note as a Markdown
  checklist to the clipboard, or every note as
  Markdown or JSON from the account menu: a download in the browser, a file in
  `Documents/Puca Notes/` (name plus a timestamp) in the Android app, which
  also offers **Share** for every note or one note through Android's share
  sheet. Either way the copy is plaintext, and the app says so. Each share
  writes its own cache copy, so a second share cannot pull the file out from
  under an app still uploading the first; copies older than 15 minutes go at
  the next share, and signing out removes them all.
- **Share INTO Púca Notes (Android app).** Púca Notes appears in the phone's
  share sheet. Send it text, a text file or a picture from any app and the
  composer opens with that content already in it — a shared text file becomes
  the note's words, not an attachment — and you still choose the title, add
  anything else, and press **Done**. Nothing is saved until you do, and what
  you shared is sealed with your key exactly like anything you type. Being a share target
  does mean "Púca Notes" is visible in every share sheet on the phone, i.e. it
  discloses that the app is installed; that is unavoidable if the feature
  exists at all.
- **Faster ways in (Android app).** Long-press the app icon for **New note**,
  **New list** or **Reminders**; add a **quick-settings tile** that opens a new
  note from the notification shade (account menu → *Add the quick tile*); or
  put the **home-screen widget** on a home screen for new list / new note /
  draw / photo. Every one of them carries a single constant word and nothing
  else — no note titles, no counts — so the launcher, the shade and the home
  screen learn nothing about your notes.
- **Keyboard** — `/` search, `c` new note, `r` refresh, `Esc` close, `?` help.
- **Installable, and it works offline** — a web app manifest lets a browser add
  Notes to the home screen or desktop, and a service worker scoped to
  `/notes/` opens it with no network (see *Offline* below).
- **Live** — an edit on one device shows on the others within a second or so,
  with no refresh (see *Live updates* below).

## How it maps onto Púca

| Notes | Púca |
|---|---|
| Note | Personal task list (`task_lists`; title encrypt-to-self) |
| Shared note | Checklist channel (`has_checklist`), sealed under the channel key; your channel permissions apply |
| Items, nesting, completed, due times, attachments | The tasks (`channel_tasks`), through `frontend/src/api/tasks.ts` |
| A note's text, photos and drawings; the Trash | `task_lists.body` / `.attachments` (encrypt-to-self) and `.trashed_at` — personal notes only (below) |
| Pin | `task_tab_prefs.is_favorite` — the same favourite as the Tasks tab bar |
| Note order (drag in one-column views; `Move to top / up / down / to bottom`) | `task_tab_prefs` order — the Tasks tab bar's order |
| An item's date, repeat, place and alerts; its snooze | `channel_tasks.schedule` / `.snooze` (066), sealed like attachments |
| Edited | `updated_at` on the list and its items (066) |
| Reminders | `due_at` on `channel_tasks` (an item) **and** on `task_lists` (a note's own, 068) + `frontend/src/api/taskReminders.ts`; the grouping and the timing rules are `frontend/src/api/reminderGroups.ts` + `reminderSlots.ts`, the list itself `frontend/src/components/reminders/` (both front doors) |
| A note's own date, repeat and alerts | `task_lists.due_at` + `task_lists.schedule` (068), sealed exactly like an item's |
| Colour, labels, archive | One sealed-to-self document per account (`/sealed-blobs/notes-prefs`, below) |
| Grid/list, sort | Device-local (below) |

Pin and order are shared **by design**: pinning in Notes pulls that tab to the
front of Púca's bar, as favouriting does there. A reorder made while notes
are filtered or archived keeps every hidden note in place (the saved order is
always the full set — `applyVisibleOrder` in
`frontend/src/notes/model/notesModel.ts`, which both the menu's moves and the
grid drag go through).

**Reordering a note.** The card menu always offers *Move to top*, *Move up*,
*Move down* and *Move to bottom* — the tap and keyboard path, on every
layout. Where a section really is one column — list view, or either view on
a phone — a note can also be **dragged by the grip beside its title**, with a
line showing where it will land. Pinned notes reorder among the pinned ones
and others among the others: the two sections are two drag groups, so a card
cannot cross between them (nothing visible would change, yet Púca's tab bar
would be rewritten). The grid's masonry on a mouse is two-dimensional and the
drag is one-axis, so it keeps the menu alone. Ordering is offered only against
the saved order, never a display sort or a search result.

**Colour, labels and archive are shared too.** They are not Notes' private
state: Púca's Tasks view reads the same sealed document and writes it through
the same mutators and the same compare-and-swap, so there is one merge rule
and not two (`frontend/src/components/TasksView.tsx`; the picker, the popover
and the tints they share live in `frontend/src/components/notes/` and
`frontend/src/styles/noteChrome.css`). Púca's bar hides an archived note and
its filter narrows to one label, and — exactly as in Notes — a favourite or a
tab drag made while notes are hidden saves every hidden note back in its slot.
Creating a list puts that filter back to everything: a brand-new note carries
no label and is not archived, so any filter would hide it, and the *Show all
notes* way back only appears on an empty board. Leaving the Tasks view inside
the push debounce sends the pending colour rather than dropping it.
Grid/list and sort stay Notes' own, per device.

## What follows the account

Colour, labels, the archive flag and your four **reminder times** are one
document, sealed to your own key
(`sealAccountBlob` in `frontend/src/api/e2ee.ts`: its own HKDF key, and an AAD
naming your account and the document, so the server cannot swap it for another
sealed field) and stored as ciphertext with a revision number
(`GET/PUT /sealed-blobs/notes-prefs`, `src/sealed_blob_handlers.rs`). This
browser keeps a copy in localStorage (`pucaNotesPrefs:<user>`) so the UI reads
it synchronously; `frontend/src/notes/model/notesPrefsSync.ts` keeps the two in
step:

- **A copy that has never synced is merged once.** Labels made on this browser
  before sync existed are unioned into the account's document per note, the
  account's colour wins, archive flags are unioned. That happens exactly once.
- **After that the account wins** for anything this device did not change. The
  merge is three-way against the last synced document, so removing a label or
  unarchiving a note on one device is not undone by another device's older copy.
- **Writes are compare-and-swap.** A write names the revision it was built on;
  if another device got there first, the server answers with the newer
  document, this device's changes are replayed onto it, and the write is
  retried. Pushes are debounced (~0.5 s); the document is re-read on focus and
  whenever the live stream says it changed.
- **Nothing is dropped quietly.** A document over the 256 KiB cap, one that will
  not open, or one older than a revision already seen (a rollback) is shown as a
  banner; the local copy is kept either way. A refused rollback (usually a
  restored server backup) offers *Use the server's copy* or *Keep this
  device's*; either resumes syncing. A conflict re-reads this device's copy
  after the round trip, so an edit made while it was out is merged, not lost.
- **Deleting a note forgets its colour and labels** when the delete is
  permanent, wherever the delete is made: Púca's Tasks view forgets them on
  its own *Delete List* and on *Delete forever* in its Trash section, rather
  than leaving a dead key for Notes' prune to find. A note moved to the trash
  keeps them for a restore. Notes deleted *outside* either app (a removed
  checklist channel) are pruned
  only once they have been missing from two settled, complete fetches at least
  a minute apart, both made by this page (a view rebuilt from the device cache
  never counts), never while offline edits are queued, and a personal list
  only after the trash has been asked and does not hold it
  (`frontend/src/notes/model/notesPrune.ts`). One device's momentary view — a
  note created elsewhere a second ago, a channel query that failed — never
  prunes anything.

A backend without the route (404) leaves Notes as it was: device-local.

**What stays on this device:** grid/list and the sort choice, deliberately —
choosing list view on a phone should not flip a desktop. Sign-out scrubs them.

Nothing here lets the operator read your notes (`docs/SECURITY_MODEL.md`):
search is local, thumbnails are decrypted client-side as they are in Púca, and
the prefs document is ciphertext. What the server does learn is the document's
size and when it is written.

*Uncheck all* and *Delete checked* send the same tick and delete requests the
server already sees when you tick and delete by hand — one per item, spaced
out, with no new kind of request and no new field. They are not free of
signal, though, and it is worth saying plainly: a run of them inside a few
seconds tells the operator that a list was reset in one go, and how many items
were ticked. Pacing blunts that; it does not remove it.
### What a search highlights

The highlighting runs over the same decrypted strings the boolean search
already reads, so there is no second source of truth: `noteMatches` decides
WHETHER a card is a result, and `frontend/src/notes/model/noteSearch.ts`
decides WHERE, from the same normalisation. That normalisation changes the
text's length three ways — accents are folded, letters lowercased, runs of
whitespace collapsed — so a match's position in the normalised string is not
its position in the note. `noteSearch.ts` keeps an index map back to the
original for exactly that reason; without it a highlight drifts by one
character per accent and several per run of spaces.

One thing is deliberately NOT highlighted: a note's own text while the note
is **open**. That field is a real `<textarea>` the user is about to type in,
and marked-up text cannot live inside one. It is highlighted on the card,
where it is read rather than edited; in the open note, the counter and the
next/previous buttons step through the item matches.

The counter counts the marks that are actually **on screen**, because those
are the ones the arrows can reach: collapse the *Completed* section and its
matches leave the count and the walk together.

Nothing about any of this reaches the server, which holds ciphertext for
every field a search reads (`docs/SECURITY_MODEL.md`): searching, matching
and marking up all happen on the device, and the query is deliberately kept
out of the address bar and history too.

### Managing labels

The per-note pickers only reach notes the grid is showing, and a label view
hides archived notes — so a label left on an archived note could not be
renamed or cleared from anywhere. **Edit labels** (the pencil beside
*Labels* in the rail) lists every label with how many notes carry it,
**archived notes included**, and offers three things:

- **Rename** it everywhere. A pure respelling counts: *home* to *Home*
  rewrites every note.
- **Merge**: renaming onto a label you already have asks first, then folds
  the two together under the existing label's own spelling, so the account
  is never left with two casings of one name.
- **Delete** it from every note, after a confirmation that says how many
  notes it will change. One **Undo** puts the whole label list back.

`Esc` belongs to whatever is open innermost: it cancels the name you are
typing, or the confirmation you are being asked, and only closes the dialog
when neither is up.

Each of the three is a SINGLE change to the sealed document — one
compare-and-swap write, the same write the server already sees when you
tick a label on one note. Nothing new reaches the server: it learns that
you organised, never what into. No migration and no new route were needed.
If you are looking at the label you renamed, the view follows it — and an
Undo brings both the labels and that view back, because the name the view
was filtered by stops existing again.

## Live updates

Notes reads `GET /events/tasks` (`src/task_events.rs`), a Server-Sent Events
stream of ids only: "list 12 changed", "your pins changed", "the prefs document
changed". Each event marks the matching query stale and it is fetched and
decrypted as always; no content rides the stream. Row triggers in migration
067 raise the events, so no write path can forget to. A channel checklist's
event reaches only the people who can view that channel at that moment.

The client (`frontend/src/notes/model/taskEvents.ts`) reads the stream with
`fetch` (the token stays in a header, never the URL). An event for a note this
page is still writing waits for the write, so a refetch cannot undo an edit on
screen. On an older backend (404), or after repeated failures, Notes falls back
to what it did before: refetch on focus and a 30-second poll while a shared note
is open. The poll is off only while the stream is live.

## Two devices, one note

Two people — or one person with a phone and a laptop — in the same note at the
same time used to end with one copy silently replacing the other. A note's own
content (its **text**, its **title** and its **pictures**) now carries a
revision, and a save names the revision it was written on top of. If that is no
longer the current one, the server refuses the save, writes nothing, and hands
back the copy it holds (migration 069, `expect_rev` on
`PATCH /task-lists/:id`).

- **Your words are never thrown away before you choose.** The text you typed
  stays in the field, and a line above it shows the other copy with *Keep
  mine* and *Use theirs*. *Keep mine* saves again on top of the copy that won;
  *Use theirs* takes it. If the other copy cannot be read on this device (a
  key you do not have yet), only *Keep mine* is offered — sealing the words of
  an error over real content is the one thing the note text field exists to
  prevent.
- **The revision is taken when you start typing**, not when the save goes out
  — for the text and for the title alike. The other device's change usually
  arrives while you are still writing: the field keeps what you typed, and the
  save is still judged against what you were writing on top of. Reading the
  revision at send time would name theirs and quietly win — which for a title
  would mean their rename disappearing with nothing on screen to say so. A
  picture takes its revision when the sidecar it is being added to is read,
  before the upload, for the same reason: the upload is the window the other
  device's change arrives in.
- **Nothing is saved while the question is on screen.** Leaving the field,
  closing the note or moving it to the trash does not answer it: those all
  used to save, and the save always said *keep mine*, so the other device's
  words went with nobody choosing. Only three things answer it — *Keep mine*,
  *Use theirs*, and simply writing more (which dismisses the line and keeps
  what you wrote). Close the note without answering and the copy that won is
  what stays; what you had typed is not saved.
- **Ticking, adding, editing or reordering an ITEM is never a clash.** A note
  is one card holding both its text and its items, and the revision moves only
  for the note's own content.
- **Pictures get no two-way choice** (there is no half of a set of pictures to
  keep): the note goes back to the copy that won and you are told, so you can
  add yours again on top of it. A **title** is one line and works the same way.
- **A title being typed is no longer wiped** by a rename arriving from another
  device — it used to vanish mid-keystroke.
- Against a server older than migration 069 nothing here appears and the last
  save wins, exactly as before.

## Offline

- **Your notes open with no network.** Every Notes query result is kept in
  IndexedDB (`pucaNotesCache:<user>`), sealed with a key derived from your
  identity seed and bound to your account (`sealLocal` in `e2ee.ts`); a result
  containing anything that failed to decrypt is never stored. On a cold start
  the cache is put back as soon as IndexedDB answers (the first render does not
  wait for it) and is marked stale, so an online start re-reads the server at
  once; offline, the cached copy fills the grid. On the web, a service worker
  (`/notes/sw.js`, built by `frontend/scripts/notes-sw.mjs`) serves the page
  itself: network first with a short timeout, then the cached copy; hashed
  assets from cache. Its scope is `/notes/`, so by the service-worker spec it
  can never control the main app or its updater, and it never answers for the
  API. The operator serves it `Cache-Control: no-cache`
  (`deploy/webapp/README.md`). The Android app has no worker: its page is
  already in the APK.
- **Edits made offline are queued.** New notes, items (with their date when
  added from the calendar), ticks — a repeating item's move to its next time
  included — dates and repeats, snoozes, renames, due times, moves, *Move to
  trash* and its Undo, pins and order go into an outbox (same database, same
  sealing) and stay on screen. A delete is probed for the trash when it
  replays, so it is never made permanent because the server could not be
  asked; a repeating tick replays with the time this device showed, so if
  another device moved the item on meanwhile it is refused and reported
  rather than applied twice. The card says *Not synced* and a banner counts
  what is waiting. When the connection returns, the queue replays first-in
  first-out through the same task API (content is sealed for the server at that
  moment), under a lock so two tabs never send the same change. Notes created
  offline get temporary ids that are rewritten on replay; if a create is
  refused, everything under it is dropped with it. A change the server refuses
  (lost access, deleted elsewhere) is dropped and one message lists what did not
  save, in your words. Edits of an ITEM are last-write-wins: an item carries
  no revision, so a change replayed hours later replaces a newer edit of the
  same item made elsewhere. A note's own text, title and pictures do not work
  that way any more — see *Two devices, one note*; a rename replayed off the
  queue is the one exception, and deliberately still wins, because refusing it
  would throw away work done offline that nobody can get back. **A create is
  made once.** Each create carries a random id made on this device when you
  act and repeated on every retry, so a create the server committed whose
  answer was lost (the connection dropped mid-response) is recognised when it
  is sent again and answered with the note or item it already made, instead of
  making a second one. The id says nothing about what you wrote, and the
  server forgets it after a day (server owners:
  `NOTES_OP_KEY_RETENTION_HOURS`, 0 keeps them). A change sent right after a
  cold start waits for the queue a previous page left behind before it may
  run.
- **A note's text and its pictures are queued too.** Type a note with no
  connection and the words are kept on this device (*Kept on this device — it
  will sync* under the field) and sent as one change when the connection
  returns — one change however long you type, because a second save for the
  same note replaces the one waiting rather than adding to it. Take or pick a
  photo, make a drawing, or attach a file with no connection and it is
  **encrypted on this device the moment you add it**; only the ciphertext is
  kept, in the same sealed database as the rest of the queue (store `m` of
  `pucaNotesCache:<user>`, each record sealed with `sealLocal`), and it is
  uploaded when the queue replays. The picture shows on the card and in the
  editor from those local bytes meanwhile, marked *Not sent yet*, and the
  banner counts what is waiting separately from the other changes — as
  "pictures or files", because the queue counts records, not their kind, and
  a waiting PDF is not a picture. A note made offline
  WITH text or pictures is three queued changes rather than one request, so
  for a moment it exists without its photo — unlike online, where the note and
  its pictures land together.
  - **Online with nothing waiting, nothing is parked at all.** The photo is
    uploaded there and then, as it always was. Sealing a second copy into
    the device's own store first would cost a phone two more passes over the
    ciphertext and twice its size on disk, and it let the on-device limit
    below refuse a picture on a device that was perfectly online.
  - **There is a limit, and it is honest about it.** At most 64 MiB of
    pictures may wait on the device at once — or less, when the browser says
    the site has less room than that (`navigator.storage.estimate()` is asked
    first, so an over-quota park is the same plain refusal rather than
    "Couldn't add the picture", which blames the picture). Over the limit,
    adding one is refused with a message and nothing of that pick is kept.
    The 64 MiB figure has NOT yet been measured against a real Android
    WebView's quota; the estimate check is what stands in for that until it
    is. The browser may also evict the whole site's storage under pressure —
    `navigator.storage.persist()` is a request, not a promise — so pictures
    waiting are not a backup. Signing out revokes the decrypted previews of
    anything still waiting, as well as deleting the database behind them.
  - **Nothing is left behind.** A picture you remove before it was ever sent
    has its ciphertext deleted and is dropped from the change that would have
    sent it; a change the server refuses takes its ciphertext with it; and
    anything no queued change names is swept when the queue next loads (with a
    minute's grace, so a photo taken a moment ago is never swept before its
    change exists). Remove one after its upload has already gone out — too
    late to drop it from the change waiting, and before the note has been
    re-read and knows the uploaded file by name — and the queue raises the
    removal itself, so the picture does not come back on the next fetch with
    its bytes charged to your storage. That covers both halves of the gap:
    the upload still in the air, and the one that has landed while the screen
    still shows the copy on your device (`notesOutbox.ts`:
    `forgottenInFlight` and `sentAs`).
  - **Uploads are added to the sidecar the server holds at that moment**, never
    to the copy this device last saw, so a picture added on another phone in
    the meantime is not deleted by a replay. Removing a picture works the same
    way round. Whatever that add or remove ACTUALLY took out of the sidecar
    has its upload deleted straight after — only what was really there, so a
    ref another device still names is never destroyed — which is the same
    rule Púca's own Tasks view follows, kept in one place
    (`api/noteMedia.ts`: `addNoteRefs`, `removeNoteRefs`).
- **Not offline:** *Show checkboxes* (turning the text into items) — it
  clears the text and then creates one item per line, and a queue would put
  those halves hours apart, so it is refused with a message while offline or
  while anything is queued — and the Trash view's *Delete forever* and
  *Empty trash*. They fail with a message and nothing is queued. Everything
  else that seals a note's own content — a photo, a drawing, a recording, a
  file, the note's text, a note created with any of them — is queued now,
  not refused. The Trash view's *Restore* is the same
  outbox op as Undo, so it queues. A note whose move to the trash is itself
  still queued is listed in the Trash at once, but its *Restore* and *Delete
  forever* wait until that move reaches the server, and *Empty trash* leaves
  it alone: anything run before the queued move would be undone by it.
- **A session that expires while offline** keeps the cached notes on screen with
  a banner (*Your session has expired. You're offline, so this is what this
  device last saw — sign in again when you're back online to sync.*) instead
  of clearing them. The queue replays only
  for the same account; signing in as someone else drops the other account's
  cache.
- **Sign-out** deletes every Notes database on this browser and this account's
  local colours and labels. It first pushes any colour or label change still
  pending (bounded), then asks if offline edits or colour/label changes have
  still not reached the server. Signing out from **Púca** deletes the same
  things, so it asks the same question: Notes publishes the counts (never
  content) to a per-account flag Púca's sign-out reads. Púca writes the
  colour/label half of that flag as well, since it makes those changes now. It
  may RAISE the flag from anywhere, but it clears it only off the back of a
  sync that succeeded in its own tab: a warning Notes raised for a reason Púca
  cannot see from where it sits — a refused rollback, a backend with no route
  — must not be dropped by a Púca tab that has never opened Tasks.

## Sessions: one origin, two pages

Notes and the web app share the origin's storage, so signing in to one signs in
to the other — in the **browser**. The desktop and phone shells run at their
own origins, where nothing is shared; that is why Púca's *Open in Púca Notes*
button appears only in the web app.

Two pages on one origin also share the token and the E2EE seed at rest but not
in memory. `frontend/src/api/sessionSync.ts` watches the `storage` event so a
sign-out, a soft expiry, or an account switch in one tab lands in the other
(caches cleared, back to sign-in, or a reload for a new account), and the
identity memo in `frontend/src/api/e2ee.ts` re-validates against storage once
another document has changed it. Signing out **from Notes** also revokes this
browser's *device enrolment*: the device id is derived from the browser's device
key, so no socket is needed (`logout()` in `frontend/src/api/auth.ts`). The key
is deleted only when the server confirms the revoke. A 404 keeps it (on a shared
browser it may be another account's enrolment). Any other outcome — offline, the
tab closed straight after, the answer lost after the server committed — keeps
the key and a local marker written before the request
(`frontend/src/api/deviceIdentity/pendingRevoke.ts`); the next sign-in on this
browser sends the revoke again before it enrols (the server answers 200 for a
row it already revoked) and then enrols as a new device, so the browser is
never left refused as a revoked device. A Púca tab and a Notes tab never both
act on that marker: each takes one Web Locks lock (Púca across the revoke and
its enrolment), and a tab that waited re-reads the marker first — so the
waiting tab finds the marker the enrolment left, cleared. Púca holds that lock
across its POST, so a hung enrolment delays the other tab's settle to the next
page load; nothing the user is waiting on. Where Web Locks are missing (an
insecure context, an old engine) each tab falls back to its own in-flight
guard, which is how this behaved before. The session itself is revoked after the
device, but never only after it: leaving the page or 1.5 s without an answer
sends it anyway.

Notes **never opens the WebSocket**. Púca wires its file-transfer handlers
before its socket opens because the server sweeps parked P2P file offers to
any connection that registers, delivered once; a bare Notes socket would eat
them. Freshness comes from its own event stream (*Live updates* above), which
has a separate server-side registry and none of the socket's side effects;
without it, from refetch on focus, a 30-second poll while a shared note is
open, and the refresh button.

### Staying signed in

Notes' own sign-in form carries **Stay signed in on this device**, ticked by
default. With it, the token this device holds lives **30 days and renews as it
is used, for up to a year** from the sign-in; without it, the ordinary **24
hours, renewed as you go, for up to 30 days**. An ordinary session does not end
because you stopped using the app: it ends because the token's day ran out, so a
phone that was off for a weekend comes back to the sign-in form however much it
was used before. With the box ticked it opens straight into the notes. Even then
a device that sends no request for more than 30 days asks again — the year is
the outer limit for a device that keeps coming back, after which the password is
asked for whatever the box says. **On the Notes phone app the background
refresh counts as coming back** (*Background refresh* under *The Android app*):
each hourly `GET /task-reminders` renews a token more than four hours old, so a
phone that is switched on and signed in stays signed in for the whole year
whether or not Notes is ever opened. When a session expires with the box clear,
the form says so and suggests the box; with the box ticked that advice is
already taken, and the form leaves it out.

It is a choice about the DEVICE, not the account: sign in on a phone with it
ticked and a borrowed laptop with it cleared, and each keeps its own length.
The tick is remembered on the device (`STAY_SIGNED_IN_KEY` in
`frontend/src/api/auth.ts`) and deliberately survives signing out, so the form
comes up with the answer you last gave. The request is one optional field on
the step-2 sign-in body, sent only when ticked; the flag then travels in the
token itself (`ls` in `src/auth.rs`) — no column, nothing stored server-side
about it, and a renewal carries it forward.

**In a browser the long session is Púca's too.** Notes at `/notes/` and the web
app share one origin and one token (*Sessions: one origin, two pages* above), so
a Notes sign-in with the box ticked puts Púca in that browser — chat, direct
messages, My Devices — on the same 30-day, up-to-a-year session, where Púca's
own sign-in would have given it a day. In a browser the line under the box says
so ("stays signed in to Notes and to Púca"); the phone app runs at its own
origin, shares nothing with the Púca app, and says "this device". The box starts
ticked in a browser as well, so on a shared or borrowed computer clear it before
signing in, or sign out before you leave.

**Ending one early.** *Sign out* drops the token here and revokes this session
by its id, so the server refuses it on the next request. **From anywhere else,
the way to end it is *Sign out of every device*** (Notes' account menu; *Sign
out on all devices* in Púca's settings) **or a password change** (or a reset
with the recovery code): each bumps the account's token version and revokes
every session, so every token on every device stops working at once — and
everything else is signed out with it. **Revoking a device under Púca's My
Devices does not reach a Notes session.** That revokes only the sessions the
device *proved* (`token_sessions.device_id`, set by a `DeviceAttest` on Púca's
socket in `src/ws.rs` or by a device-token mint), and Notes never opens the
socket, so its session is bound to no device. On the Notes phone app that is
always so: revoking the phone ends the Púca app's session on it and leaves
Notes signed in, its hourly refresh still renewing. In a browser it is reached
only if Púca has since opened its socket there on the same session. **For a
lost or stolen phone, use *Sign out of every device* or change the password.**
A long session is a longer *idle* life, not a weaker one: every request still
checks the session and the token version. Púca's own sign-in does not offer the
box — it opens the ordinary session — though the server accepts the request
from any client that sends it.

## Building and serving

`npm run build` builds Notes after the main bundle (`vite.notes.config.ts` →
`dist/notes/`) and `scripts/check-dist-entries.mjs` then asserts both pages
name an `assets/index-*.js` entry that bakes the API host. Notes is a separate
build on purpose: a second entry in the main one would rename the entry chunk
the release scripts grep for and hoist the baked API host out of it
(`vite.shared.ts` has the story).

The web tarball ships it (`deploy/webapp/README.md`); the operator's Caddy
`try_files` needs `{path}/` once so `/notes/` serves the directory index
(until then only `/notes/index.html` works, which is what every link uses). The
phone shells strip `dist/notes/` (`scripts/strip-notes-from-native.mjs` after
every `cap sync`, and `rm -rf ota-src/notes` in the OTA recipe) — a browser-only
page with no CSP meta has no business inside a WebView. The desktop installer
no longer carries it either: Tauri embeds `dist-desktop/`
(`tauri.conf.json` `frontendDist`), a copy of `dist/` without `notes/` that
`scripts/stage-desktop-dist.mjs` makes after every full and Lite build — the
shell only ever loads `index.html`, and `dist/` itself stays whole because it is
the webapp tarball. `scripts/check-lite-identity.mjs` fails if the installer is
pointed back at `dist/`. `deploy/ops/dual-ship.sh webapp` checks
Notes' entry chunk for the API host the same way it checks the main one.

In development the main dev server serves it: `npm run dev`, then open
`/notes/` on the dev server's origin. The main app's account remembers you.

### The Android app

`frontend/notes-app/` is a second Capacitor project that wraps the same page as
its own Android app, **Púca Notes** (`com.sovereign.notes`), installed beside the
Púca app with its own storage and its own sign-in (the same Púca account). It
is sideload-only (the download page), which is what makes `USE_EXACT_ALARM` and
background location acceptable permissions for it. None of Púca's native
plugins are in it; it has its own, small ones (`NotesNativePlugin`,
`NotesLocationPlugin` under Púca's `SovereignLocation` name),
`@capacitor/filesystem` and the OTA updater `@capgo/capacitor-updater` (below,
so its web layer updates itself), all listed in `notes-app/package.json` only —
**nothing notes-only goes into `frontend/package.json`**, because `cap sync`
there would link it into Púca's own APK.

**Due reminders, open or closed.** The page still polls `GET /task-reminders`
(ids and due times only), but in the app it posts nothing itself: every fetch
goes to the native side as `{id, at, mark, due}` entries (one type,
`api/reminderFeed.ts`), which arms ONE exact
alarm for the next owed reminder and posts ONE notification for everything due
— "Púca Notes · An item is due" / "3 items are due", never the item's text.
An item fires once per `mark` (see *Calendar, repeats and snooze*), so an
edited due time fires again. A repeating item arrives as several entries with
one id — its reminders in the next 14 days, which the page precomputes
because the native side cannot open the sealed rule — and only the latest past
entry of an id counts (`ReminderPlan.plan`), so each occurrence fires once and
never re-fires an earlier one. The alarm is re-armed
after a reboot, an app update, a clock or time-zone change and a change to
the exact-alarm grant, and a time that passed while the phone was off fires
at the next arm. Tapping the notification opens the item's note with that item
flagged when exactly ONE item is due, and Reminders when more than one is (with
several, naming one of them would send you to an arbitrary note and hide the
rest). The only thing that is added to the notification is the item's
**number** — the same integer the server already holds in clear and already
sends this phone in the content-free feed. The notification's words are still
"An item is due", and what the item says is decrypted by the page after the
tap, never before. The id is removed from the intent as it is read, so a
rotation cannot replay a tap from hours ago. Just before firing,
the alarm asks the server once (a few seconds, no retries), so an item
completed or re-timed on another device since the last look is not
announced; offline, it fires from what it has. If that check finds the session
has ended (401), the items the alarm woke up for are still announced — a lost
session is no reason to swallow a reminder that is already due.

**Share into Notes.** A `SEND` / `SEND_MULTIPLE` filter on the main activity
makes Púca Notes a share target for text and pictures. What arrives is
decrypted note content, so the native side copies the shared bytes into
`cache/share-in/` once, hands the WebView a one-shot payload, erases the
intent's extras (a rotation re-delivers the same intent — without this the
composer would re-open with the user's shared text every time), and wipes the
directory on sign-out. It never reaches the reminder store, a notification or
logcat, and it is never saved on its own: the composer opens and the user
presses Done. The payload is capped the way a note is — a title no longer than
the composer's own limit, at most 12 pictures, a size ceiling per file — and
each file's type is the one the app resolved itself, not the one the sender
claimed. The rules live in `ShareIntake.java`, tested off-device.

Three refusals in that file are worth naming, because each one had a way of
failing quietly:

- **Only a `content://` URI is opened.** A share is a grant; a `file://` URI
  would be opened with Púca Notes' own uid, which would let any app on the
  phone name a path inside the app's sandbox and have Notes read it back to
  the composer. Nothing legitimate sends one — since Android 7 the sender
  throws for trying.
- **Only pictures are copied.** The page has exactly one destination for a
  shared file (the picture list), so a shared `.txt` copied as an attachment
  would be sealed and stored as a photo no view can render. A shared text file
  is read into the note's body instead, capped, and only when the sender did
  not also send text.
- **`#` and `%` are stripped from a shared name.** The page reads each copy
  back over the app's own origin, by a URL built from the path: a `#` would
  start a fragment and a `%` an escape, and the picture would be dropped
  without a word.

The text extras are read as `CharSequence`, not `String` — an app sharing
styled or selected text puts a `Spanned` there, and `getStringExtra` answers
null for one, silently.

On the page side the share **waits for `GET /notes/features`** before it
decides anything (`model/composeIntent.ts`'s `takeShare`). A share is normally
a cold start — that is the point of the entry point, the app was not running
— and the native handoff is a bridge call plus a local file read, while the
features request is a round trip to the user's own server. Judged at the
instant the share lands, the answer is still `NO_LIST_FEATURES`: the shared
picture would be thrown away, the user told this server cannot keep pictures
when it can, and shared text opened as a checklist. When the server cannot be
asked at all — offline — the page falls back to what it last knew, so an
offline share still opens something.

That wait is **bounded** (`SHARE_ASK_MS`, 1.5 s), and the bound is not
belt-and-braces: offline the ask does not fail, it never answers. The features
query is a react-query fetch with the default `networkMode: 'online'`, and
that retryer does not reject an offline fetch — it *pauses* it, and the
promise stays pending until the device is back. Nothing is thrown, so the
`try`/`catch` around the ask sees nothing, and because
`consumeNativeLaunchShare` is a one-shot an offline share waiting there was
gone for good: no composer, no toast, nothing to retry. A local walk cannot
catch any of this: against `127.0.0.1` the features query wins, and the
picture check passes for the wrong reason, so the cases are held in
`notesShareIntake.test.ts` instead — including one whose `ensureContent`
never settles at all, because a mock that resolves `null` is not what offline
does.

**Shortcuts, the quick tile and the widget.** Three launcher shortcuts
(`res/xml/shortcuts.xml`), a quick-settings tile (`NotesTileService`) and a 4×1
home-screen widget (`NotesWidgetProvider`) all put one constant word in the
same `notes_nav` extra the notification uses, and the page routes it
(`routeNativeTarget`). They are **static on purpose**: dynamic shortcuts would
write decrypted note titles into the launcher's own database, outside the app
sandbox and outside anything a sign-out can scrub, and a widget's views are
inflated, drawn and cached by the *launcher* process, where a note title — or
the information an item count leaks — would sit on a home screen and survive a
reboot. The widget is never polled (`updatePeriodMillis` 0) because there is
nothing on it that could go stale. The tile's label is a compile-time constant
for the same reason the notification's text is a count: the shade is reachable
over a locked screen on some phones. Tapping the tile on a locked phone asks to
unlock first, because the composer belongs to a signed-in shell that can show
decrypted content the moment it mounts. The widget is a fixed dark surface: it
cannot follow the app's eight themes or `[data-contrast="high"]`.

**Voice notes, and the microphone.** *Voice note* in the composer and in an
open note records on this device: the recorder asks with a prominent
disclosure first, then takes the microphone, shows the elapsed time and a
level, and stops at five minutes. The APK declares `RECORD_AUDIO` and
`MODIFY_AUDIO_SETTINGS` — Capacitor's WebView bridge asks for the pair
together, and an undeclared one denies the whole request. **Foreground only**:
there is no service and no `FOREGROUND_SERVICE_MICROPHONE` type, and the
recorder releases the microphone when it stops, when it is closed, and when
Púca Notes leaves the screen. As with the camera, a permission arrives with a
NEW APK, not with an OTA — `native-min.json` rises to the release that ships
it, so an older APK is offered "install the new app" instead of web code it
cannot run.

**Transcripts stay on the phone.** Where the phone can do it, Púca Notes also
writes down what you said and puts the text in the note. It uses Android's
**on-device** recogniser only — `SpeechRecognizer.createOnDeviceSpeechRecognizer`,
and only when `isOnDeviceRecognitionAvailable` says the model is installed —
because the browser's own `SpeechRecognition` is a cloud service in Chrome and
Android's default recogniser is a cloud service on many phones;
`EXTRA_PREFER_OFFLINE` is a hint, not a promise, and is never used as one.
Feeding a recorded clip to the recogniser needs `EXTRA_AUDIO_SOURCE`, which is
**Android 13 or newer**. Everywhere else — the browser page, an older APK, an
older phone, a phone with no model — Púca Notes REFUSES, says so in words, and
keeps the recording rather than sending it anywhere. `TranscribeGate` (pure
Java, JUnit-tested) is the only thing that may say yes, and it has no branch
that allows a networked recogniser; `src/tests/notesTranscribeNoCloud.test.ts`
sweeps the Notes sources so the refusal cannot be "fixed" with a fallback.

The recogniser reads raw audio from a file, so the clip is decoded on the
device to 16 kHz mono PCM, written to the app's **cache** for the length of
the call, and deleted afterwards on every path, refusals included; the sealed
copy in the note is the only one that lasts. Clips longer than two minutes are
not written down (the PCM would be megabytes crossing the bridge for no better
transcript) — they are still saved. The transcript is ordinary sealed note
text, which is also what makes a voice note findable: search reads a note's
title, text, labels and items, and never an attachment's name.

That cache file is written through Capacitor's Filesystem plugin, which takes
base64 and nothing else, so the decoded PCM crosses the JS/native bridge as
base64 — in 192 KB chunks (about six seconds of speech each), so no single
multi-megabyte string is ever built, but it crosses. **This was weighed and
accepted.** What it costs: on a DEBUGGABLE build, Capacitor logs every plugin
call's payload (`Bridge.callPluginMethod`, guarded by `Logger.shouldLog()`),
so the audio of a voice note is recoverable from logcat on a developer's own
machine. A release APK is not debuggable and logs none of it, nothing leaves
the phone on either build, and the two-minute cap bounds what a debug build
could spill. What avoiding it would cost: handing the COMPRESSED clip over
instead (~8x fewer bytes) and decoding it natively with MediaExtractor and
MediaCodec — a new native audio-decode path, with its own formats and
failures, to close a hole that only exists in builds we hand to nobody. If
Notes ever grows a native decoder for another reason, move this onto it.

Both capture surfaces write it down, and each puts the words where they
survive. In the COMPOSER the take is transcribed as soon as it is kept, and
*Done* waits for it if it has not finished, so the note is created with the
text already in it. In an OPEN note the transcript goes through the text
FIELD — added to what is being typed, not written to the note behind it:
transcribing takes a second or two, the recorder sheet is already closed, and
that field's own autosave would otherwise put a half-typed line back over the
words. If the note is closed before the transcript is ready it is dropped
rather than written over whatever was saved last. Both sides of the call are
bounded (`TranscribeGate.watchdogMs`, `transcribeBudgetMs`): a recogniser
whose service dies mid-session never calls back, and waiting for ever would
leave that cache file — the one unsealed copy of the recording — on the phone.
What a segmented session heard before a later segment failed is kept, not
thrown away with the error.

**Background refresh.** While signed in, the app keeps a copy of the session
token in its private, backup-excluded storage (`allowBackup=false` plus the
include-only backup and data-extraction rules copied from Púca) and a
JobScheduler job refreshes the reminder feed about once an hour, with any
network, while Notes is closed — so a due time set on the desktop reaches the
phone without opening Notes. The refresh sees only `{id, due_at}`, so
(`ReminderMerge.merge`): an unchanged `due_at` keeps every entry the page
armed for that id, occurrences included; a `due_at` advanced on another device
to one of the id's own occurrence instants keeps that occurrence (with the
mark it may already have fired under) and the later ones; any other move — an
edit, a snooze by an editor, which moves `due_at` — starts that id over from
the server's time, and an id gone from the feed (completed, deleted) is
dropped with all its entries. The page's next sync fills the series back
in. A renewed token the server hands back is kept,
and adopted by the page (same account, longer life only) — at launch, each
time the page comes back into view, when the network returns after the token
ran out offline, and before it would treat a 401 as the end of the session, so
a Notes process that slept in the background for a day does not wake on the
sign-in screen. A 401 for a token the page has already replaced (a request that
left just before the adoption) is not an expiry at all (`api/client.ts`, and
the live stream reconnects with the new token).
Android decides when the job really runs: roughly hourly for an app in use,
much less often for one left unopened for days, so a due time set elsewhere
less than about an hour ahead can arrive late. (Holding an exact-alarm
permission keeps Notes out of the deepest standby buckets: on the Android 16
emulator, `am set-standby-bucket com.sovereign.notes rare` was refused and the
app stayed in *working set*.) When the session dies (expiry; the cap, 30 days
from the sign-in or a year with *Stay signed in*; *Sign out of every device*; a
password change — but not revoking the phone under My Devices, which a Notes
session is not bound to, see *Staying signed in*) the job or the pre-fire check
gets **401** — only 401 counts; a 403, a 5xx or a proxy's error page is a
failed look, retried next period. Then it stops for good, drops the
reminders whose time has already passed (they may be done by now — except
the ones the firing alarm is announcing), keeps the future ones armed, and
posts ONE "Sign in again to keep getting reminders" on its own *Sign-in
needed* channel at default importance (it sounds: from here on Notes cannot
see new due times, and Púca only stays quiet while Notes can). Its tap and
its **Sign in** button open Notes, which checks its own session and lands on
sign-in if it is dead. Signing out, a soft expiry and an account switch clear
every alarm, marker, token, job and location fence on the phone.

**Honest status.** The Reminders view says what will actually happen: an
**Enable** banner while notifications can still be asked for, **Open
settings** once they are blocked, "may arrive a few minutes late" when exact
alarms are not allowed, and "Android may hold reminders back" while the app is
battery-optimised (a force-stopped app, and some vendors' battery managers,
cancel alarms until Notes is next opened — nothing but that line can fix it).

**Púca stays quiet — only when Notes can deliver.** One due item is one
notification, never zero. Before posting a due-item notification on Android,
Púca asks Púca Notes (`SovereignAppPlugin.notesOwnsDueReminders` →
`ReminderOwnerProvider`, a read-only, one-row content provider) and stays
quiet **only on its yes**, which Notes gives while ALL of these hold
(`ReminderRules.ownsDueReminders`, JUnit-tested): a live session whose token
does not expire within five minutes (a stored token past its JWT `exp` is not
one, even before the job's next run sees the 401), signed
in to the **same account on the same server** Púca names (Púca passes its API
base; user 42 on another server is someone else); the reminder feed read
successfully within the last **three hours** (the hourly job, or the open
page's own poll); notifications allowed (permission, app switch and Reminders
channel); its alarm set whenever something is owed; and **every reminder Púca
is about to post armed in Notes under the same mark** (Púca passes their
`{id, mark}`, which both apps derive the same way). Anything else — Notes not
installed, a Notes APK from before the provider, signed out, another account
or server, a job Android has not run for hours, notifications off, an item
Notes has not fetched yet, an error — and Púca notifies. That last rule is what
keeps a freshly set item on time: one created or re-timed on another device
after Notes' last look is announced by Púca when it falls due, not up to the
freshness window later by Notes' next refresh — which may then announce it a
second time. Two alerts, late or not, is the accepted way to fail; none is
not. The provider is guarded by
`com.sovereign.notes.permission.DUE_REMINDER_OWNER` with
`protectionLevel="signature"`, declared by Notes and requested by Púca, so
only an app signed with the same key can ask — both APKs release-sign with
the Púca keystore — and all it learns is that one bit. On the Android 16
emulator the grant also arrived when Notes was installed AFTER Púca. An older
Púca APK without the method keeps notifying as before (both apps alert until
it is updated).

**Ship order: the Notes APK with or before the Púca APK.** `dual-ship.sh apk`
and `apk-notes` go out in the same release. If they ever have to be
staggered, ship Notes first: its worst case against an older Púca is a
second notification for an item, never none. (The capability check keeps the
opposite order safe too — a new Púca with an old Notes gets no yes and
notifies — but that is the fallback, not the plan.) Upgrading from a Notes
APK that predates its reminders also needs the user to allow Notes'
notifications once; until then Notes answers no and Púca keeps notifying.

**Location reminders.** The account menu's *Location reminders (this phone)*
is the same feature as Púca's (disclosure first, then foreground location,
then "Allow all the time"), with a location-only foreground service and Púca's
geofence engine copied byte for byte (`GeofenceParityTest` fails if the two
drift). Arrival notifications are a count ("An item is waiting here"), never
a place. **Places are per app and per device**: Púca and Púca Notes keep
separate stores on one phone, so a place saved in Púca does not appear in
Notes (save it again there), and nothing about any place reaches the server.
After a reboot the watch restarts on its own where Android allows a location
service to start in the background; otherwise one "Open Púca Notes once to
resume location reminders" notice says so.

**For the calendar work**, the plugin also offers
`NotesNative.addToPhoneCalendar({title, beginMs, endMs?, allDay?, location?})`
(the phone's calendar app on a pre-filled event, no calendar permission — the
title becomes plaintext in that app) and `NotesNative.shareText({filename,
mime, text})`; `frontend/src/notes/native/notesNative.ts` wraps both and
answers `unsupported` on an older APK.

```bash
cd frontend && npm run notes:android            # debug APK, sideloadable
cd frontend && npm run notes:android:release    # signed with Púca's own keystore (~/.android/puca-keystore.properties)
```

`scripts/build-notes-app.mjs` builds the page in native mode
(`NOTES_TARGET=native`, base `/`, output `dist-notes-app/`), injects the Android
CSP meta (`scripts/cap-index-csp.mjs --index`), runs `cap sync android` inside
`notes-app/`, and calls gradle. The API host comes from `frontend/.env.production`
like every other build. Output:
`frontend/notes-app/android/app/build/outputs/apk/debug/app-debug.apk`.

**It ships with every release — twice.** A Púca Notes that trails the task API
it talks to would break quietly, so it is a release surface like the others,
built from the same version (`tauri.conf.json`, checked by
`scripts/check-lite-identity.mjs`) and release-signed with the same keystore as
Púca. The steady-state rule, every release:

1. **`dual-ship.sh mobile-notes`** — the OTA bundle, which is what brings
   installed apps up to date (next section);
2. **`dual-ship.sh apk-notes`** — the APK, under `APK_PREFIX_NOTES` from
   `hosts.conf`, linked from the download page (the ship refuses until it is),
   so a fresh install starts current rather than needing its first OTA.

`check-versions.sh` asserts the notes OTA manifest carries the release once one
is deployed; with a current notes OTA a trailing APK is INFO, and with none it
is a FAIL. Whatever the APK's version — the release's own included — a
manifest `native.min` newer than the APK the page links (a fresh install would
refuse its own first update) or newer than the manifest itself is a FAIL.

### Updates over the air

From the first APK that carries the updater (the release after 0.9.815),
Notes updates its web layer the way Púca does — a signed bundle applied at
launch — on **its own channel**:

- It asks `GET /api/mobile-updates/check?variant=notes`, which the server
  answers from `mobile-update-notes.json` (`MOBILE_UPDATE_FILE_NOTES`;
  `src/update_routes.rs`). A server from before that route answers with Púca's
  full manifest, and the app refuses anything not tagged exactly
  `"variant": "notes"` (`otaChannelMatches`), so that skew leaves Notes where it
  is rather than installing Púca into it.
- Bundles are signed with a **separate Notes key** (`notes-updater-rsa.key` in
  the keys directory, backed up by `deploy/ops/backup-keys.sh` — **run it, and
  store both bundles off the machine, before the first OTA-capable Notes APK
  ships**: once phones embed its public half, losing the key freezes Notes
  updates until everyone installs an APK with a new one); the APK embeds
  only its public half (`notes-app/capacitor.config.ts`). A Púca bundle cannot
  decrypt or verify inside Notes, nor a Notes bundle inside Púca, whatever an
  unsigned manifest claims. `deploy/mobile/verify-bundle.mjs` proves a bundle
  against the TARGET app's key before `dual-ship.sh` uploads it.
- The bundle is the native Notes build: `node scripts/build-notes-app.mjs --ota`
  writes `notes-ota/puca-notes-web-<v>.zip` after checking the CSP meta and the
  `"app": "notes"` tag in `version.json`; `encrypt-bundle.mjs --notes` refuses
  anything else (in particular `dist/notes/`, the web page, which would
  white-screen the app). Recipe: `deploy/mobile/README.md`, *Púca Notes*.
- The gate (`src/notes/components/NotesUpdateGate.tsx`, engine shared with Púca
  in `src/api/mobileOta.ts`) may delay the app but never hold it, and
  `notes/main.tsx` blesses the running bundle first thing, so a bundle that
  never boots is rolled back.
- The share filter, the shortcuts, the tile and the widget are **native**, so
  they arrive with a new Púca Notes rather than over the air; `min` in
  `notes-app/native-min.json` does **not** move for them, because the web layer
  degrades on an older APK (`notesNative.ts` feature-detects every call) and
  `scripts/notes-native-min.mjs` records only packages, plugin classes and
  permissions — it cannot see an intent-filter, a widget or a tile, so that has
  to be a deliberate judgement rather than a gate.
- **Native changes** still need a new APK. Every notes manifest carries a
  `native` block: an APK older than `native.min` does not apply the bundle and
  shows *Install the new Púca Notes app* with a Download button to the download
  page's `#notes-app` section (same-site HTTPS only); a newer `native.version`
  (`dual-ship.sh mobile-notes ... --native-version <v>`) is a strip in its own
  row below the top bar (never over it: the account button there is the way to
  *Check for updates*), dismissable once per version.
- **`native.min` is a floor that lives in the tree**:
  `frontend/notes-app/native-min.json`. It only goes up. The Notes build writes
  it into `version.json`, `encrypt-bundle.mjs --notes` copies it into the
  bundle's `.native-min` sidecar, and `mobile-notes` publishes it on EVERY
  release — refusing one newer than the release, and one lower than what a host
  already serves unless `--lower-native-min` says so. (It was a
  `--native-min` flag once; the release after the one that passed it published
  no floor, and old APKs applied web code calling plugins they lacked.) The same
  file records the APK's native surface — Capacitor packages,
  `@CapacitorPlugin` classes, `<uses-permission>` entries — and
  `scripts/notes-native-min.mjs` fails vitest (`notesNativeMin.test.ts`, on
  the real tree) and `build-notes-app.mjs` when the surface changes and the record does not: a
  change that adds a plugin or permission the web code calls raises `min` to
  the release that first ships it, then re-records the surface.
- The account menu shows the running version and a **Check for updates** that
  re-runs the check without closing an open note.
- **Device check, not yet done (no test can reach it):** stall a download (cut
  the network mid-download), wait for *Retry*, restore the network and press
  it. Capacitor delivers every download's progress to every listener, and the
  first download of the same version cannot be told apart from the retry's
  (its bundle id is only known when it finishes), so both run at once, the bar
  follows whichever is further along (it never goes backwards), and the stall
  watchdog is fed by either. Expect: the gate still ends in the app or a control (never a bare
  spinner), exactly one reload into the new version, and no *Update failed*
  when the first download finishes late. The unit tests
  (`notesUpdateGate.test.tsx`) cover each run's own listener and an event
  labelled with another version, which the engine drops. They cannot reach
  the case above: the plugin commits the bundle's info, real version string
  included, before it sends the first progress event (CapgoUpdater.java's
  download: saveBundleInfo, then notifyDownload), so a live run's events do
  carry a usable label and the filter really does drop another version's
  events on a device; it is the SAME version's abandoned download that no
  label can separate. The `builtin` escape hatch stays for ids with no stored
  info (the built-in bundle, a deleted entry, an unknown id) and for payloads
  with no label at all, where dropping the event would fake a stall; a run
  that ends in *Update failed* without the network ever dropping again is the
  symptom of narrowing it.

**Existing installs need one manual install.** Notes APKs up to and including
0.9.815 have no updater, so nothing can reach them over the air; they stay as
they are until their owner installs the first OTA-capable APK from the download
page. After that one install, updates arrive by themselves.

## Text, pictures and the trash

Migration 065 gives a personal list three nullable columns, and
`src/list_content.rs` owns them:

- **`body`** — the note's free text, sealed to the owner exactly like the
  title (an encrypt-to-self envelope). A note can be text only, items only, or
  both. The server refuses a value that is not an envelope, and the client
  reads these fields STRICTLY (`frontend/src/api/listSeal.ts`): unlike titles,
  they never held plaintext, so a non-envelope value shows as unreadable
  instead of as your own words.
- **`attachments`** — the note's own photos, drawings, voice notes **and any other file**,
  the same sealed sidecar a task item carries, pointing at ordinary
  end-to-end encrypted uploads. Photos are shrunk on the device before
  encryption (`api/imagePrep.ts`, long edge 2048 px); anything that is not a
  picture is not — there is nothing to shrink, and pulling a 25 MB PDF
  through the image decoder only stalls a phone. The server never learns the
  real name or type of any of them: everything goes up as `attachment.enc` /
  `application/octet-stream`, and the name and type live in the sealed
  sidecar. A file's display name is clamped to 120 characters before it is
  sealed, because the sidecar's envelope has a 16 KiB cap
  (`MAX_LIST_ATTACHMENTS_LEN`, `src/list_content.rs`) and a pathological
  filename would make the note's save fail with a 400 nobody could explain.
  A non-picture is **download-only, by design**: it is shown as a button that
  writes it to your device (`api/saveAttachment.ts` — into
  `Documents/Puca Notes/` on a phone), never as an inline preview and never as
  a link to a `blob:` URL. A `blob:` document inherits the app's own origin
  and takes its type from the ref, so an in-origin document could read the stored token and
  the E2EE key material; `safeBlobType` reduces anything that is not an
  image, video or audio file to opaque bytes, and that must not be relaxed
  to make a PDF preview. Each upload is capped at 25 MB, and a note holds 12
  sidecar slots (a drawing takes two). A drawing is uploaded twice: a PNG
  that every card and Púca's gallery show, and its strokes, so it can be
  edited again (`frontend/src/api/drawing.ts`; the editor is
  `frontend/src/components/DrawingCanvas.tsx`, shared by both apps). A **voice
  note** is recorded on the device (`notes/components/AudioRecorder.tsx`) and
  uploaded RAW — never through the image path — but sealed by exactly the same
  helper, so the server holds an encrypted blob and its size and cannot tell a
  recording from a picture. It plays back in Púca Notes and in Púca's Tasks
  view, with controls and never by itself, and takes one sidecar slot of the
  twelve (25 MB a clip, five minutes). A recording is never a card's hero
  picture. On a phone, *Photo* offers the camera (`<input accept="image/*"
  capture>`); on Android that needs the `IMAGE_CAPTURE` entry under `<queries>`
  in each app's manifest, so the camera arrives with a new APK of each app, not
  with an OTA.
- **`trashed_at`** — *Move to trash* (`POST /task-lists/:id/trash`) hides the
  note from every listing and from the reminder feed, and makes it read-only
  (every write is a 409) until it is restored. The Trash view (rail, in
  Notes; the end of the All tasks board, in Púca) lists it with *Restore* and
  *Delete forever*. The server deletes a trashed note for good after
  `NOTES_TRASH_RETENTION_DAYS` (default 30; 0 keeps it until you empty the
  trash).

**Both front doors agree.** Púca's Tasks view shows and edits a personal
list's text, photos AND drawings — a drawing made in either app opens in the
other's editor, and saving one replaces the pair (the picture and its
strokes) so nothing is orphaned — and its *Delete list* becomes *Move to
trash* on a server that has one. A sidecar this device cannot read still
refuses every edit, in both apps, rather than writing over refs it cannot
see. It also wears the same organisation: a note's colour tints its tab and
its board card, its labels show as chips, an archived note is off the bar and
off the board, and *Colour*, *Labels* and *Archive* sit on every tab's and
card's context menu with a filter beside *New list* for the labels and the
archive. An older Púca (0.9.816 or earlier) shows every note as an untinted,
unlabelled tab and keeps archived notes in its bar — it never writes the
document, so nothing is lost by using one. A client decides all of this from

`GET /task-lists/features`, which does not depend on having any lists; an
older server answers it with an error and every client behaves exactly as it
did before 065. An older client on a newer server keeps working: it never
sees trashed lists, its title-only rename leaves text and pictures alone, and
its *Delete* is still the immediate delete it always was. What an older
client does NOT do is keep a trashed note whole:

- **An older Púca Notes** (0.9.815 or earlier — and Notes has no updater, so
  it stays old until the new APK is installed) sees a trashed note as
  deleted, and prunes this device's colour, labels and archive flag for it.
  Restoring the note brings its text, items and pictures back, but not those.
- **Any older Púca or Notes** that saves the pin/order row (a pin, a move, a
  favourite, a tab drag) saves a full replace without the trashed notes, so a
  note restored after that returns at the end of the order, not in its slot.

So update Púca Notes on every phone before using the trash — install the new
APK from the download page — and update Púca's desktop app with it; the web
app and Púca's mobile app update themselves.

**Trash keeps what is on the device.** A trashed note is gone from the default
listing, but its colour, labels and archive flag are kept (the one prune,
`notesPrune.ts` via `useNoteCards`, counts the cached trash as live, waits
until the trash has been read, and forgets a personal list missing from both
only after two settled fetches a minute apart AND a fresh read of the trash —
it may have been trashed in Púca or on another device a moment ago), and so is its slot in
the saved order: a pin or a reorder made while it is in the trash saves it
back where it was (`keepHiddenSlots` in `api/listContent.ts`), and neither
front door saves the order before it has read the trash, so a restored note
returns to its place. A note trashed elsewhere while this page is open
reaches the trash through the live stream too — a `lists` event refreshes the
listing and the trash together (`taskEvents.ts`), so the next pin still knows
about it. *Notes to self* cannot be trashed and is not offered for
it.

**What the server cannot clean up.** The uploads behind a note's pictures and
item attachments are named only inside sealed sidecars, so the server cannot
tell which files a note used. *Delete forever* and *Empty trash* delete the
files first, then the note — and refuse, deleting nothing, when this device
cannot name every file (its items cannot be listed, or a sidecar cannot be
read yet); try again once Púca is unlocked and online. Púca Notes also purges
its own expired trash, files first, during the last day of the window
whenever it is open, measured on the server's clock (a phone whose clock is
wrong must not delete early), skipping any note whose files it cannot name.
A note whose window runs out while no Notes is open is deleted by the
server's sweep and its uploads stay behind, counted against your quota — the
same as any delete made by a client older than this, or by Púca's own
immediate delete. **That gap costs more now that a note can hold any file:**
what it strands used to be a photo shrunk to 2048 px, and can now be up to
25 MB per file against a 512 MiB quota. Nothing but `DELETE /files/:id` by
hand reclaims it, so open Púca Notes before a long trip if the trash is
full of large files. *Hide checkboxes* deletes the files of items it drops once
its Undo is gone — only of items whose delete went through, and never a file
a live item names at that moment. An item whose delete failed stays an item,
with its pictures, and only the other items become lines of text. Deleting a
single item does the same: its pictures are kept for as long as Undo is
offered and deleted once it is gone. Before this they were orphaned on the
server against your quota for good, because nothing could ever name them
again.

**Paste and drop.** A picture can be pasted (Ctrl+V) or dropped onto the
composer or onto an open note, instead of being saved to disk and picked
again. It takes exactly the same path a picked one does — shrink, encrypt on
this device, upload — because the paste and drop handlers only produce a
`File[]` and hand it to the entry point the picker already fed
(`addPictures` in `QuickAdd.tsx`, `addPhotos` in `NoteContentSection.tsx`).
There is no second upload call site, and a drop of more pictures than a note
can hold is refused by the sidecar cap before anything is uploaded, never
half-applied. A picture pasted with no connection is refused *before* the
attempt, with a message: an upload never queues (see *Offline*), so failing
afterwards would be the same outcome with worse manners. The drop outline
appears only while a drag carrying files is actually over the target, so it
never promises something a shell that does not deliver drops could not do.

These are Púca **Notes'** gestures. Púca's Tasks view renders the same note
text and the same pictures (`ListContentBlock.tsx` → `NoteBodyField`,
`NoteImages`) and therefore shows the same links, but it wires no paste or
drop handler: there, a picture still goes in through the picker.

A paste that carries TEXT is text, whatever picture came with it. Chromium
puts an `image/png` on the clipboard *beside* the text for any rich copy — a
Word paragraph, a range of Excel cells, a selection of a web page — so a
handler that asks only "is there an image?" turns a pasted table into a
screenshot of a table. `isTextPaste` (`notes/model/noteContent.ts`) is the
guard: a real screenshot, or *Copy image*, carries no text at all, which is
what tells the two apart. Drops are unaffected; an OS drop of files has no
text. (Púca's chat composer takes the other branch on purpose — an image
pasted into a message IS the message.)

**Pasting a list.** Paste several lines into an item field, or into *Add an
item…*, and Púca Notes asks first — showing the lines it is about to add, with
*Add N items*, *Add as one item* and *Cancel*. It asks because items are
removed one at a time and an item delete has no Undo: a stray paste of a
document would otherwise make forty items nobody can take back in one go. The
lines are split by the same rule *Show checkboxes* uses, so `- `, `* `, `• `,
`[ ]` and `[x]` are dropped and blank lines are ignored. A paste of ONE line is
never intercepted — it lands in the field as any paste would.

A pasted line is truncated to the same length the field itself accepts
(`MAX_ITEM_LENGTH`, 500), so no route into a list can produce an item you
could not have typed. In the open note the creates are **paced** like every
other fan-out in the app (`icsImport`'s `PACE_MS`, well under the server's
50/s per IP), and a run that stops part-way says how many items landed
rather than leaving an arbitrary prefix of the list unexplained.

**Links in a note.** A web address typed or pasted into a note's text, or
into an item, becomes tappable. Púca Notes works out where it goes by looking
at the text it has already decrypted — **nothing is fetched to render a
link**. No favicon, no page title, no description, no preview card, no site
icon. The note stays as private on screen as it is on the server.

That refusal is deliberate, and worth stating so nobody adds it back as an
improvement: fetching a page's metadata or its icon would tell a third party
the hostname, this device's IP address and the moment of reading — and for a
note, which the server itself cannot read, it would additionally announce that
someone is reading *this note* right now. `frontend/src/api/linkPreview.ts`
records the same deletion for chat.

- Only `http` and `https` become links. `javascript:`, `data:`, `file:`,
  `mailto:` and a scheme-less `//host` stay plain text
  (`frontend/src/utils/linkSegments.ts`, sharing chat's `URL_RE`).
- A link opens OUTSIDE the app: a new browser tab on the web, the desktop
  shell's `open_external` under Tauri, and the system browser from the
  Android apps — where it is a top-level navigation the Capacitor bridge
  turns into `ACTION_VIEW`, because `window.open` is not a path there.
  Every anchor carries `rel="noopener noreferrer"`, so the destination does
  not learn the origin and path of the page that was reading a sealed note.
- Text holding an address swaps to a read view when it is not being edited;
  tapping anywhere but the link puts the cursor back where you tapped. Text
  with no address never leaves its editing field.
- A tap on the link is the link's, including the FOCUS it takes: a browser
  focuses an anchor on mousedown, and that focus bubbles to the read view
  around it before the link is ever clicked. The read view ignores a focus
  that landed on a link, exactly as it ignores a click on one — otherwise the
  field would replace the link between press and release and the address
  could be read but never followed.
- On the card grid a link is **marked but not tappable**: the card's own tap
  opens the note, and a 44px tap target cannot live inside a clamped two-line
  preview at 390px.
- Púca's Tasks view shows the same links, because it renders the same text
  through the same components.
- A search inside the open note marks its hits in the link renderer's PLAIN
  stretches, never inside an anchor. The item row has to compose the two by
  hand (`NoteEditor`'s `renderDescription`, exactly as a card's preview does),
  because `TaskTree` prefers a caller's renderer over its own link renderer:
  a highlighter handed in on its own silently takes every link in the open
  note away while the same item keeps them in Púca's Tasks view, which hands
  in nothing.

## Sending a note into Púca, and keeping a message as a note

Notes and the chat are two front doors onto one account, and these are the two
doors between them. Both are one-way COPIES made at the moment you ask for
them: neither creates a share, a membership or a live link, and neither keeps
anything in step afterwards.

**Send to Púca…** is on a note's menu and in the open note's footer. It lists
the text channels you can actually post in — your channel permissions are
known here, so a channel you cannot post in is not offered rather than offered
and refused — and the direct-message conversations you already have. Checklist
channels are left out: a shared note IS one, and posting its text into its own
feed means nothing.

It always asks first and names where the text is going, because the message is
re-encrypted for that channel's members or that person and **cannot be
unsent**. Rows this device cannot read are LEFT OUT rather than guessed, and
the sheet says how many (the export writes the marker instead — a file you
keep may say what it could not read; a message other people read may not).
Pictures do not travel: a note's photos are sealed under the note's own key,
so the message lists them by name. A clip reference loses its payload, which
is the clip's key.

A note can also simply be too long. The server's limit is 8000 bytes of the
ENCRYPTED message, and sealing costs a nonce, a tag, base64 and — for a direct
message — one wrapped key per device the recipient has, so a note of roughly
six thousand characters is already over it. The sheet measures that before it
seals anything and says so in the confirm step, and the DM path re-measures the
real envelope before it posts, because only then is the true size known. While
a send is in flight the sheet cannot be dismissed at all: closing it would not
cancel the request, and confirming again would post the note twice.

The mechanics, for the next reader: a channel goes through the same
`POST /channels/:id/messages` the composer uses, so the server broadcasts,
notifies and wakes exactly as it does for anything typed in Púca; a DM goes
through `POST /dms/:conversation_id/messages` — **not** the socket, which
Notes still never opens (*Sessions*, above). That REST route now delivers,
parks-and-wakes and bumps the conversation's timestamp the way the socket path
always has, so a note sent from Notes is indistinguishable from a message
typed in Púca. That fan-out is not a pure function and is not provable by
reading, so it has its own live two-client harness —
`frontend/e2e/notes-send-verify.mjs`, run against a throwaway backend. Its
header says how to confirm it can fail: revert the block in
`src/dm_handlers.rs` and the delivery, echo, park and timestamp stages go red
while the WebSocket control stage stays green.

**That fan-out must reach EVERY host before this bundle does.** The repo's
standing order is clients first (CLAUDE.md), and the DM half is the exception:
the client cannot tell an old server from a new one, so against a host without
the fan-out *Send to Púca…* still says "Sent to …", the message is stored, and
nothing is announced — no live bubble, no wake, no reorder, just a silent
delivery whenever the recipient next opens that conversation. It is the
failure the feature was built to avoid, and it looks like success from both
ends. So ship `dual-ship.sh backend` to BOTH hosts first, then the Notes
bundle that offers DM targets. ("No HTTP contract change" is true of the route
and says nothing about the order: the route already existed, and what changed
is what it DOES.)

**Save to Notes** is the other direction, on a message's menu in Púca (right
click, or long press on a phone). It keeps the message as a new note or as an
item in one you already have, and only your OWN notes are offered — never a
shared checklist, which would publish the message to that channel. The text is
re-sealed to your own key with every attachment reference stripped out: those
references carry the file's key and its fetch capability, and neither belongs
in a note. A picture you choose to keep is decrypted, encrypted again under a
NEW key and uploaded as your own file, so deleting the message later leaves
the note intact, and deleting the note takes only its own copy. A message this
device cannot decrypt is not offered, and neither is a clip post — its body
carries the clip key, and a note outlives the window the clip was approved for.

A note whose TEXT or whose pictures this device cannot read yet is not offered
as a destination either. Every write here replaces what is stored — the note's
text wholesale, the picture list wholesale — so saving into such a note would
seal the captured line over ciphertext the account still holds under a key this
device has not got, and no device could ever read it again. That is the rule
`isAttachmentsLocked` already carried for the picture list; it applies to the
text for exactly the same reason. The refusal survives changing your mind about
pictures after picking a note, and a save that half-succeeds — the note made,
the item refused — undoes the note rather than leaving it behind with pictures
that nothing names.

Into a note you ALREADY have there is nothing to undo: the item, or the text
appended to it, is in a note you keep. So a failure after that point says the
text was kept and the pictures were not, and points you at Notes to finish it
— rather than "nothing was kept", which is a lie that earns a retry, and the
retry writes the same line a second time. And like the send sheet, this one
cannot be dismissed while a save is in flight: neither the backdrop nor the X
closes it, because closing does not cancel the upload and saving again would
keep the message twice.

Like every other picture and text save, a capture needs the network (see the
offline bullet below); it is never queued.

## Not built (and why)

- **A transcript in the browser, or below Android 13.** Writing a recording
  down happens with Android's own on-device recogniser or not at all (see
  *The Android app*); everywhere else Púca Notes says so and keeps the
  recording. Sending it somewhere to be transcribed is not a fallback this
  app will grow.
- **Recording with the app closed.** The microphone is foreground-only, with
  no service behind it: the phone's background code never holds decrypted note
  content, and a microphone a notes app can run unattended is not one it
  should own.
- **Per-person sharing.** A shared note is a channel; there is no "share with
  one person" that the data model could honour. *Send to Púca…* is not that:
  it posts a snapshot as a chat message, and creates no share, no membership
  and no live link — edits afterwards do not follow it.
- **Link previews.** A note shows the address itself — never a fetched title,
  description or picture. See *Links in a note* above for why that is a
  refusal and not a gap.
- **Pasting a picture inside the Android app.** Android's keyboard inserts a
  picture through a different mechanism than the clipboard, so a paste there
  is unreliable; the camera and the picker stay the way in on a phone, and the
  app does not claim otherwise.
- **Sending a note to several places, or several notes at once.** The bulk bar
  offers *Copy as text*, not a bulk send: N messages from one click is a spam
  hazard, and a send that is refused half way through has no sensible undo.
- **A desktop Notes app.** Notes on a computer is the browser page; the
  desktop installer deliberately carries no copy of it (see *Building and
  serving*).
- **Undoing an item's position, or an edit to its text.** An item put back by
  Undo is appended to its group rather than returned to its old slot, and
  there is no undo of a committed item edit (Escape still cancels one that
  has not been committed). A note's own TEXT has undo and redo; an item's does
  not.
- **Item text in a reminder or place notification.** It would put decrypted
  note content on the lock screen and in app storage; the phone's background
  code never holds it. The notification says "An item is due" and opens that
  item's note (one item due) or Reminders (more than one) — it carries the
  item's number, never a word of what it says. A **place** notification still
  opens Reminders whatever it found, because naming the item there would also
  name where you are.
- **Done or Snooze buttons on the notification.** The background code cannot
  seal a snooze or read a repeat rule, and a blind "Done" could end a
  repeating item wrongly; tapping opens Reminders instead.
- **Places that follow the account.** Places stay per app and per device (see
  *The Android app*); syncing them would hand the operator ciphertext of home
  and work coordinates.
- **Recent notes as launcher shortcuts, and anything data-derived on the quick
  tile or the home-screen widget.** Google Keep's widget lists note titles;
  this one cannot. A widget's views are built by Púca Notes but inflated, drawn
  and cached by the *launcher* process, and a shortcut's label lives in the
  launcher's own database — both outside this app's sandbox, both surviving a
  reboot, and neither scrubbed by signing out. Even an item count leaks. The
  widget shows four fixed labels, the tile one, the shortcuts three.
- **A share target in the BROWSER.** `public/notes/manifest.webmanifest` has no
  `share_target` and no `shortcuts` array, so sharing into Notes and the
  long-press entries are the Android app only. The page has no URL that opens
  the composer, which is what a PWA shortcut would need.
- **Opening the camera straight from the widget's Photo button.** A programmatic
  click on a file input needs a user activation and an app launch is not one,
  so Chromium refuses it. The target opens the composer with the camera button
  focused — one tap — rather than a button that appears to do nothing.
- **A push doorbell for the closed Android app.** An open Notes page has the
  live stream (*Live updates*); a closed app has nothing worth delivering
  over a push, and the hourly refresh is the part that matters.
- **Snoozing a note's own reminder.** Migration 068 gives a note a `due_at`
  and a sealed `schedule`, not a `snooze`: a snooze has its own edit right
  and must never rewrite the schedule, and the trigger that decides what
  counts as an edit would need the carve-out it has for items. So Reminders
  and the calendar offer no Snooze on a note row rather than a button that
  does nothing.
- **Editing a note's reminder from the calendar.** A note's reminder appears
  there, and its menu opens the note; dragging it to another day, skipping an
  occurrence and ticking it belong to controls a note does not have. Change
  it from the note. The day list says so rather than leaving a dead control:
  where an item has its tick box, a note's reminder has a **bell** — the same
  mark Reminders puts on a note row.

## A reminder on the note itself

Until migration 068 the only way to be reminded about a note was to invent a
checklist item to hang the time on — which then showed as a to-do nobody
wrote, in the card preview, in Reminders and on the calendar, and ticking it
"completed" something that was never a task. A note now carries its own time.

- **Where it is.** The clock in an open note's footer (and the same control in
  Púca's Tasks view, beside the list title, so the two front doors agree).
  *Remind me* takes a plain date and time; **Date & repeat** opens the same
  editor an item's schedule uses, so a note gets all-day, an end, a place,
  alerts, skipped dates and a repeat rule for free. The card shows the note's
  own reminder as its own chip, next to — never merged with — the chip for the
  soonest due **item** in it: they are two different things.
- **Where it shows, in BOTH doors.** Púca Notes' Reminders list and calendar,
  and Púca's pinned Reminders and Calendar tabs. The tabs read
  `components/taskSources.ts`, which projects a list carrying `due_at` or
  `schedule` through the same `noteAsCalendarItem` the Notes views use, gated
  on the same `note_reminders` feature that decides whether the control above
  is offered at all — so a note's reminder cannot be settable in the Tasks
  view and invisible in the tab beside it, which is exactly what the
  twelve-branch merge shipped. The projection says `canEdit: false` on
  purpose: both tabs read that ONE array, and `canEdit` is what opens the
  calendar's drag, *Move to date…*, *Skip this time* and *Date & repeat…*,
  each of which would `PATCH /tasks/-5`. The row is a **bell** with *This
  note itself*, no tick box, no snooze and no note column; its one control is
  **Clear**, which goes back to the view that owns the lists and uses the
  same setter as the clock in the note's header, rolled back and explained
  the same way when the server refuses.
- **What the server holds.** Two nullable columns on the note's row:
  `due_at`, the next reminder instant **in plaintext**, exactly the trade an
  item's `due_at` already makes (docs/SECURITY_MODEL.md §2 — the server
  learns WHEN, never WHAT), and `schedule`, the same client-sealed
  EventSchedule an item carries, sealed to yourself. Because the note has its
  own sealed column, **Keep the time private from the server** means the same
  thing on a note as on an item: the time lives inside the sealed schedule,
  `due_at` stays empty, and the note still reminds on a device that can open
  it.
- **One feed, no new app.** A note's reminder rides the same
  `GET /task-reminders` array as an item's, under the **negative** id
  `-list_id`, with `list_id` naming the note. Task ids are always positive, so
  the two can never collide in a per-id map — the web loop's fired markers,
  Púca Notes' `ReminderPlan` / `ReminderMerge` — and the Android app needed no
  change at all to arm them: its engine treats an id as an opaque key and a
  mark as an opaque string (`ReminderPlan.java`'s header says so on purpose).
  A JUnit case pins that. As for an item, the notification stays content-free.
  A client older than 068 polling a 068 server sees those rows too and fires
  its ordinary content-free "a task is due" toast for them, which is right;
  the only rough edge is that such a client would try to advance a note's
  repeating *event* through `/tasks/-5` and get a 404 each cycle. A 068
  client advances it on the list instead.
- **A trashed note does not remind**, and its reminder comes back with it on
  restore — the same rule the item arm has had since 065.
- **Two devices cannot both move it.** A note's reminder is written through
  the same compare-and-swap an item's is (`expect_due_at`): the loser gets a
  409 and writes nothing. A note's repeating **event** is advanced after its
  alert fires exactly as an item's is, on the list rather than on a task.
- **Offline**, setting or clearing a note's reminder queues like every item
  date and replays in order.
- **It leaves with the note.** Both exports carry it: the Markdown one as a
  `reminder:` line in the note's meta row, the JSON one as the note's own
  `dueAt` and `schedule` beside each item's. An export that kept every item's
  time and quietly dropped the note's would restore a note nobody is
  reminded about.
- **Version skew.** `GET /task-lists/features` answers `note_reminders`. A
  listing cannot be read as the probe: on a 067 server and a 068 one, an
  account whose notes have no reminders looks identical.

## Calendar, repeats and snooze

Migration 066 gives every item two optional sealed fields and an edit time.
The server stores both fields and cannot read them (docs/SECURITY_MODEL.md
§2 says what it can see). Nothing here appears until the server answers
`GET /task-features`. On an older server every screen behaves as it did before.

- **Schedule** (`frontend/src/api/taskSchedule.ts`, EventSchedule v1). An item
  is an **event** (it happens: never "overdue", and ticking it is not the
  point) or a **to-do** with a date. Either can be all-day or timed (with its
  time zone), have an end, a place, up to five alerts, skipped dates, and a
  repeat rule from a tested subset of RFC 5545 RRULE
  (`frontend/src/api/recurrence.ts`: daily, weekly on days, monthly on a date or
  "the 2nd Tuesday", yearly; every N; until or N times). The parser is strict,
  keeps keys a newer build added, and goes **read-only** ("update the app to
  edit this") on a newer version or an unreadable value. It never rewrites
  either. Time zones follow RFC 5545: a local time the clocks skip takes the
  offset from before the change. Every view shows times in the **viewer's** zone. The
  editor shows the event's own zone.
- **due_at is the next reminder.** For an item with a schedule, `due_at` is
  derived on the device: by an editor when it saves the schedule, and moved on
  by the reminder loop only after an alert has fired and 15 minutes have
  passed, with `expect_due_at` so that two devices cannot both move it. Opening
  a note never moves it. **Keep the time private from the server** (per item,
  off by default) keeps `due_at` empty. The item still shows in the calendar
  but gets no reminders from the feed. An item with a schedule never shows the
  raw due editor or a "Due" chip: its date chip says when it is.
- **Ticking a repeating to-do** moves it to its next occurrence and reopens its
  subtasks. It does not end the series. Every view ticks through one path
  (`frontend/src/api/taskCompletion.ts`). The server refuses (409 "update the
  app") when an older app tries to complete an item, or a parent of one, that
  carries a schedule. Otherwise that app would end a repeating series without
  knowing it was one. This app refuses the same thing itself: ticking a parent
  whose subtree holds an open item that still repeats (or whose schedule it
  cannot read) says so and changes nothing — tick the repeating item on its
  own, or remove its repeat.
- **Snooze**: 10 minutes, 1 hour or tomorrow at 09:00, from either Reminders
  view, from the calendar, and from the item's own row inside a note or a list
  (one control, `components/reminders/SnoozeControl.tsx`), for anyone who may
  tick the item. Its menu closes on Escape or a press outside it: on an item
  row it floats over the row below, which it would otherwise swallow clicks
  for. It **consumes** that Escape (`preventDefault` + `stopPropagation`), so
  the note editor it sits inside does not close with it — the editor's own
  Escape skips a `defaultPrevented` one, and its `escapeBlocked` hatch covers
  popovers and context menus, not this layer. When the snoozer may also
- **Reminder times**: what *Morning*, *Afternoon* and *Evening* mean to you,
  and the time a new reminder starts at. Set them in the account menu
  (09:00 / 14:00 / 19:00, new reminders at 09:00, until you change them). An
  item's clock button then offers those three as one tap, the *Date & repeat*
  dialog offers the same row wherever it is opened from (a Reminders row, the
  calendar, or the item inside its note), and Snooze's *Tomorrow* means your
  morning. A preset lands on today if that time is still ahead and on tomorrow
  if it has gone, by wall clock, so the day the clocks change still gives you
  the time you asked for. On an **event** a preset moves the start and keeps
  the length: a 09:00-10:00 hour tapped to *Evening* is 21:45-22:45, not an
  event running to 10:00 the next day. A preset also takes the item off
  all-day, which moves its reminder onto an offset the timed list actually
  offers (the all-day 09:00 offsets are not in it) — but **No reminder** is a
  choice rather than a default, and it is in both lists, so a preset, the
  **All day** switch and the Event/To-do switch all leave it alone instead of
  switching a notification back on. The times follow your account in the sealed document above —
  the server never sees them — but a preset writes the same plaintext `due_at`
  any reminder does, so the per-item *Keep the time private from the server*
  switch is still the way to hide when something is. Púca's own Tasks view
  shows the same three buttons at the standard times; the setting lives in
  Púca Notes.
- **Snooze**: 10 minutes, 1 hour or tomorrow at your morning time, from Reminders and from
  the calendar, for anyone who may tick the item. When the snoozer may also
  edit the item's time (its creator, a task manager, any personal note), the
  snooze **moves the plaintext `due_at` to the snooze instant** — the server,
  and a phone reminding with Notes closed, see the next reminder — and the
  sealed snooze keeps the time it pushed back, which Unsnooze restores. A
  member who may only tick gets a sealed snooze alone, which applies while
  `due_at` is unchanged. Either way it lapses by itself when the item moves.
  Once an editor's snooze has moved `due_at`, such a member is not offered
  Snooze or Unsnooze on that item — on any of those surfaces, which all ask
  the one question (`taskSchedule.maySnooze` over `snoozeLocked`): putting
  `due_at` back needs the edit right, and a sealed-only re-snooze would
  either not apply or overwrite the time Unsnooze restores.
- **Retime** (from the Reminders row): writes the same plaintext `due_at`, or
  the same sealed `schedule`, that the editor inside the note writes, through
  the same optimistic path and the same outbox — so a retime made offline
  queues and replays like any other change, and the reminder feed is poked
  either way. An active snooze **lapses by itself** when the time moves
  (`activeSnooze` matches neither `forDue` nor `until` any more) and nothing
  clears it explicitly: a snooze rides the completion right while a retime
  rides the edit right, so sending both would 403 for a channel-task creator
  without COMPLETE_TASKS. A retime carries **no** `expect_due_at`, so two
  devices retiming at once is last-writer-wins — exactly as it already is
  from the calendar and from inside a note.
  Every reminder engine reads the same entries, `{id, at, mark, due}`
  (`frontend/src/api/reminderFeed.ts`): `at` is the snooze time while one is in
  force, `mark` changes whenever the item must fire again, and `due` is the raw
  server `due_at` the entry came from. A repeating item also gets an entry for
  each of its reminders in the next 14 days (capped at 24), same id, each
  marked with that instant — what `due_at` will read once advanced there — and
  an engine fires only the latest past entry of an id.
- **Calendar**: in the rail at `/calendar`, the view and day in the URL (never
  a title). **Month**: on a phone it shows dots and the chosen day's list.
  **Week** and **Day** are time grids off the phone, opening on working hours
  (or just before now on today). On a phone there is no time grid: **Day** is
  the day's list, and Week falls back to it. One gate,
  `components/calendar/calendarGate.ts`, is shared with the CSS and by both
  hosts (Notes' `/calendar` and Púca's Calendar tab). **Agenda**
  lists what is coming. Drag an item to another day, or use *Move to date…*
  (tap), or `[` / `]` (keyboard). Tap a day to add: the item and its timing go
  in one request. *Skip this time* skips one occurrence. *Show completed* and
  *Show plain reminders* are switches. Shared notes on the calendar refresh
  every 30 seconds. Púca's Tasks view pins the same component as a
  **Calendar** tab, and the Reminders list as a **Reminders** tab beside it —
  the two shared hosts read the same per-list/per-channel queries under the
  same cache keys (`frontend/src/components/taskSources.ts`), so switching
  between them costs no extra requests.
- **Reminders** lists events by their next occurrence and never calls them
  overdue, so a calendar of past appointments does not flood Overdue or the
  badge. Neither Reminders view is built on `/task-reminders`: that feed is
  ids and times only (it is what FIRES a reminder), so the rows come from the
  ordinary per-list and per-channel reads and are decrypted on the device. The server's `/task-reminders` returns recent past items and upcoming
  ones separately, so old items cannot push future ones out.
- **.ics**: export writes RFC 5545 (VERSION, PRODID, DTSTAMP, CRLF, folding,
  VTIMEZONE). Its UIDs are deterministic: the schedule's own uid, or an HMAC of
  the task id under a key derived from your identity key. Exporting twice
  therefore updates the same events rather than duplicating them. The file is
  plaintext, and the app says so first. It goes out through the share sheet in
  Púca Notes on Android (when the installed app has `NotesNative.shareText`),
  through the Save As dialog on the desktop, or as a download in a browser.
  **Import** is offered in Púca Notes' calendar and in Púca's own Calendar
  tab, and is into personal notes only — an import into a shared checklist
  would notify every member for every item, so the picker is built from
  personal lists and cannot be handed a channel
  (`api/icsImport.ts`'s `icsImportTargets`). A note whose items this device
  has not read yet is shown as *still loading* and cannot be chosen: with no
  items in hand there is nothing to skip against, so a second import of the
  same file would bring every event in twice, and the per-note cap would be
  counted from zero. A file over 5 MB is refused
  before it is parsed (`icsPickRefusal`, one cap and one wording shared by both
  front doors — parsing a large calendar in order to then reject it costs
  exactly what accepting it would). It shows a preview that lists
  everything it cannot represent. It skips events whose UID is already there,
  and paces itself under the rate limiter, retrying after a 429 and able to
  resume. It starts a new note before one reaches the 2000-item cap. **Add to
  phone calendar** (Púca Notes on Android, when the app has
  `NotesNative.addToPhoneCalendar`) hands one event to the phone's calendar app,
  after a one-time notice that the phone may sync it.
- **Edited**: `updated_at` changes when an item's content changes. A reorder,
  a snooze or the reminder loop moving a derived `due_at` does not count.
  Known looseness: the server cannot open the snooze, so migration 066's
  trigger ignores any `due_at` change made in the same UPDATE as a snooze
  change. A client that bundled a real due-time edit with a snooze toggle
  would not stamp Edited. This client never does, and Edited is a display
  hint, not a security boundary. A
  personal note's time is the newest of its list and its items. A shared note
  has no list row, so its time is the newest item's, and a deleted item there
  leaves no trace. The editor shows it beside Created, and the sort menu has
  *Recently edited*.

## Verifying

The Android app's decision logic is pure Java under JUnit
(`frontend/notes-app/android/app/src/test/`: the reminder plan, the feed
merge, the token rule, and the geofence parity with Púca) — a gate in
CLAUDE.md. Everything else native was checked on a headless emulator
(`adb shell dumpsys alarm`, `cmd jobscheduler run`, a reboot, mock location).

`frontend/e2e/notes-walk.mjs` drives the built bundle (`e2e/serve-dist.mjs`,
which serves `/notes/` correctly) at desktop size and at 390×844 with a coarse
pointer against a throwaway backend, asserting the design rules
(`docs/DESIGN_PHILOSOPHY.md`) rather than only taking screenshots. With a
second browser context as a second device it also checks sync: a note and a
label made on one appear on the other with no refresh, a bulk colour change
lands as one write, labels survive a sign-out, the page reloads offline from the
worker and the sealed cache, an offline edit replays when the network returns,
and the sign-out revokes the browser's device row. Signing in from Notes' own
form reads the token the server minted: ticked, about 30 days with `ls: true`;
cleared, about 24 hours and no `ls` — each the other's control — and the
cleared answer is still there after a sign-out; the line under the box says, in
a browser, that Púca stays signed in too and that it takes a visit a month; on
the phone the row is a 44px, 16px target that toggles from anywhere along it.
