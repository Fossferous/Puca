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
- **Open a note** — Púca's own task tree: inline edit, subtasks, drag to reorder
  and to nest, due times, attachments, the collapsible Completed section. It is
  the same component Púca renders, so a note lays out exactly as it does in the
  Tasks view.
- **Search** — over decrypted titles, items, labels and server names, on the
  device; nothing about the query leaves it.
- **Reminders** — every open item with a due time, grouped Overdue / Today /
  Upcoming; tick it done from there. In a browser, Notes runs Púca's reminder
  loop, so a due item notifies while the Notes tab is open (allow
  notifications from the Reminders view). The Android app notifies whether it
  is open or closed (see *The Android app*), and adds an **At a place**
  section for items with a place saved on that phone. A due item in a shared
  note that someone else created says **Reminds whoever set it**: the
  reminder feed covers the shared items *you* created, so that one never
  alerts you.
- **Calendar, repeats, snooze, Edited** — a Calendar in the rail, dates and
  repeat rules on items, snoozing reminders, and an Edited time on every note
  (see *Calendar, repeats and snooze* below).
- **Colour, labels, archive** — Notes' own organisation, sealed to your own
  key and synced across your devices (see *What follows the account* below).
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
- **Copy as text / Make a copy / Export / Share** — a note as a Markdown
  checklist to the clipboard, a copy as a fresh note (its text and its open
  items, which keep their dates and repeats where the server stores them —
  with or without text), or every note as
  Markdown or JSON from the account menu: a download in the browser, a file in
  `Documents/Puca Notes/` (name plus a timestamp) in the Android app, which
  also offers **Share** for every note or one note through Android's share
  sheet. Either way the copy is plaintext, and the app says so. Each share
  writes its own cache copy, so a second share cannot pull the file out from
  under an app still uploading the first; copies older than 15 minutes go at
  the next share, and signing out removes them all.
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
| Note order (`Move to top / up / down`) | `task_tab_prefs` order — the Tasks tab bar's order |
| An item's date, repeat, place and alerts; its snooze | `channel_tasks.schedule` / `.snooze` (066), sealed like attachments |
| Edited | `updated_at` on the list and its items (066) |
| Reminders | `due_at` + `frontend/src/api/taskReminders.ts` |
| Colour, labels, archive | One sealed-to-self document per account (`/sealed-blobs/notes-prefs`, below) |
| Grid/list, sort | Device-local (below) |

Pin and order are shared **by design**: pinning in Notes pulls that tab to the
front of Púca's bar, as favouriting does there. A reorder made while notes
are filtered or archived keeps every hidden note in place (the saved order is
always the full set — `moveNoteInOrder` in `frontend/src/notes/model/notesModel.ts`).

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
  permanent; a note moved to the trash keeps them for a restore. Notes deleted
  *outside* Notes (Púca's Tasks view, a removed checklist channel) are pruned
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
  save, in your words. Item edits are last-write-wins: the task API has no
  revision to compare against. **Creates are at-least-once:** the create
  routes take no client op id, so a create the server committed whose answer
  was lost (the connection dropped mid-response) is replayed and the note or
  item appears twice; delete the extra one. Closing that needs an idempotency
  key on the server's create routes. A change sent right after a cold start
  waits for the queue a previous page left behind before it may run.
- **Not offline:** anything that uploads or seals a note's own content —
  adding an attachment, a photo or a drawing, saving a note's text, creating
  a note with text or pictures, *Show checkboxes* (turning the text into
  items: it is refused, with a message, while offline or while anything is
  queued, so it can never leave the text AND queued copies of its lines) —
  and the Trash view's *Delete forever* and *Empty trash*. They fail with a
  message and nothing is queued. The Trash view's *Restore* is the same
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
  content) to a per-account flag Púca's sign-out reads.

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
at the next arm. Tapping the notification opens Reminders. Just before firing,
the alarm asks the server once (a few seconds, no retries), so an item
completed or re-timed on another device since the last look is not
announced; offline, it fires from what it has. If that check finds the session
has ended (401), the items the alarm woke up for are still announced — a lost
session is no reason to swallow a reminder that is already due.

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
app stayed in *working set*.) When the session dies (expiry, the 30-day cap,
*Sign out of every device*, a password change) the job or the pre-fire check
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
does not expire within five minutes (a stored token past its JWT `exp` — the
30-day cap — is not one, even before the job's next run sees the 401), signed
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
- **`attachments`** — the note's own photos and drawings, the same sealed
  sidecar a task item carries, pointing at ordinary end-to-end encrypted
  uploads. Photos are shrunk on the device before encryption
  (`api/imagePrep.ts`, long edge 2048 px). A drawing is uploaded twice: a PNG
  that every card and Púca's gallery show, and its strokes, so it can be
  edited again (`notes/model/drawing.ts`). On a phone, *Photo* offers the
  camera (`<input accept="image/*" capture>`); on Android that needs the
  `IMAGE_CAPTURE` entry under `<queries>` in each app's manifest, so the
  camera arrives with a new APK of each app, not with an OTA.
- **`trashed_at`** — *Move to trash* (`POST /task-lists/:id/trash`) hides the
  note from every listing and from the reminder feed, and makes it read-only
  (every write is a 409) until it is restored. The Trash view (rail, in
  Notes; the end of the All tasks board, in Púca) lists it with *Restore* and
  *Delete forever*. The server deletes a trashed note for good after
  `NOTES_TRASH_RETENTION_DAYS` (default 30; 0 keeps it until you empty the
  trash).

**Both front doors agree.** Púca's Tasks view shows and edits a personal
list's text and photos, and its *Delete list* becomes *Move to trash* on a
server that has one. A client decides all of this from
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
immediate delete. *Hide checkboxes* deletes the files of items it drops once
its Undo is gone — only of items whose delete went through, and never a file
a live item names at that moment. An item whose delete failed stays an item,
with its pictures, and only the other items become lines of text.

## Not built (and why)

- **Per-person sharing.** A shared note is a channel; there is no "share with
  one person" that the data model could honour.
- **A desktop Notes app.** Notes on a computer is the browser page; the
  desktop installer deliberately carries no copy of it (see *Building and
  serving*).
- **Pictures and a note's text while offline.** The offline queue holds
  intents it can replay (ticks, dates, snoozes, items, renames, the trash);
  an upload cannot wait for a connection, so adding a photo or drawing,
  saving a note's text, and creating a note with text or pictures need the
  network, and fail with a message when there is none.
- **Exactly-once creates.** A create whose answer was lost replays and can
  leave a duplicate note or item (see *Offline*): the create routes take no
  client op id yet.
- **Item text in a reminder or place notification.** It would put decrypted
  note content on the lock screen and in app storage; the phone's background
  code never holds it. The notification says "An item is due" and opens
  Reminders.
- **Done or Snooze buttons on the notification.** The background code cannot
  seal a snooze or read a repeat rule, and a blind "Done" could end a
  repeating item wrongly; tapping opens Reminders instead.
- **Places that follow the account.** Places stay per app and per device (see
  *The Android app*); syncing them would hand the operator ciphertext of home
  and work coordinates.
- **A push doorbell for the closed Android app.** An open Notes page has the
  live stream (*Live updates*); a closed app has nothing worth delivering
  over a push, and the hourly refresh is the part that matters.

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
- **Reminder times**: what *Morning*, *Afternoon* and *Evening* mean to you,
  and the time a new reminder starts at. Set them in the account menu
  (09:00 / 14:00 / 19:00, new reminders at 09:00, until you change them). An
  item's clock button then offers those three as one tap, the *Date & repeat*
  dialog offers the same row, and Snooze's *Tomorrow* means your morning. A
  preset lands on today if that time is still ahead and on tomorrow if it has
  gone, by wall clock, so the day the clocks change still gives you the time
  you asked for. The times follow your account in the sealed document above —
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
  Snooze or Unsnooze on that item (`taskSchedule.snoozeLocked`): putting
  `due_at` back needs the edit right, and a sealed-only re-snooze would
  either not apply or overwrite the time Unsnooze restores.
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
  **Calendar** tab.
- **Reminders** lists events by their next occurrence and never calls them
  overdue, so a calendar of past appointments does not flood Overdue or the
  badge. The server's `/task-reminders` returns recent past items and upcoming
  ones separately, so old items cannot push future ones out.
- **.ics**: export writes RFC 5545 (VERSION, PRODID, DTSTAMP, CRLF, folding,
  VTIMEZONE). Its UIDs are deterministic: the schedule's own uid, or an HMAC of
  the task id under a key derived from your identity key. Exporting twice
  therefore updates the same events rather than duplicating them. The file is
  plaintext, and the app says so first. It goes out through the share sheet in
  Púca Notes on Android (when the installed app has `NotesNative.shareText`),
  through the Save As dialog on the desktop, or as a download in a browser.
  **Import** is into personal notes only. It shows a preview that lists
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
and the sign-out revokes the browser's device row.
