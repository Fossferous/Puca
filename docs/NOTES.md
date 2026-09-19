# Púca Notes

A notes app, Google-Keep style, that is a second front door onto Púca's task
system. Same account, same end-to-end encryption, same lists and checklist
channels — its own page, its own shape. It lives at **`/notes/`** on the web
app's origin (`https://app.example.com/notes/`), and Púca's Tasks view links to
it from the tab bar.

The server holds almost nothing new: one sealed document for Notes' own
colours, labels and archive, and a content-free stream of "this changed". A
Notes **note** is a Púca **personal task
list**; a **shared note** is a **checklist channel** from one of your servers;
the rows in a note are the tasks themselves. Pinning a note favourites the tab
in Púca; reordering notes reorders Púca's tab bar; a due time set in Notes fires
Púca's reminders. Anything you do in one is what you see in the other.

## What it does

- **Grid of notes** — pinned first, masonry on desktop, one column on a phone,
  grid/list toggle. Each card shows the open items with live checkboxes,
  progress, the next due time, image thumbnails, labels and (for a shared note)
  the server it belongs to.
- **Take a note…** — a title and items, Enter for the next item; on a phone the
  `+` button opens the same composer as a sheet.
- **Open a note** — Púca's own task tree: inline edit, subtasks, drag to reorder
  and to nest, due times, attachments, the collapsible Completed section. It is
  the same component Púca renders, so a note lays out exactly as it does in the
  Tasks view.
- **Search** — over decrypted titles, items, labels and server names, on the
  device; nothing about the query leaves it.
- **Reminders** — every open item with a due time, grouped Overdue / Today /
  Upcoming; tick it done from there. Notes runs Púca's reminder loop, so a due
  item notifies while Notes is the app you have open (allow notifications from
  the Reminders view).
- **Colour, labels, archive** — Notes' own organisation, sealed to your own
  key and synced across your devices (see *What follows the account* below).
- **Select several** — a checkbox on hover, Shift/Ctrl-click and Ctrl+A on a
  desktop, a long press on a phone (then taps add to the selection); `Esc`
  clears. The bar pins or unpins, colours, labels, archives, deletes (personal
  notes, with Undo — shared notes are skipped and the button says so), makes
  copies or copies them as text, all at once. Pinning is one save of the full
  order, so notes hidden by a filter keep their slots; colour, labels and
  archive are one sealed write.
- **Undo** — archive and delete show an Undo snackbar; a delete reaches the
  server only when it expires.
- **Copy as text / Make a copy / Export** — a note as a Markdown checklist to
  the clipboard, a copy as a fresh note, or every note as Markdown or JSON from
  the account menu (in the browser; the Android app has no file export yet).
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
| Pin | `task_tab_prefs.is_favorite` — the same favourite as the Tasks tab bar |
| Note order (`Move to top / up / down`) | `task_tab_prefs` order — the Tasks tab bar's order |
| Reminders | `due_at` + `frontend/src/api/taskReminders.ts` |
| Colour, labels, archive | One sealed-to-self document per account (`/sealed-blobs/notes-prefs`, below) |
| Grid/list, sort | Device-local (below) |

Pin and order are shared **by design**: pinning in Notes pulls that tab to the
front of Púca's bar, as favouriting does there. A reorder made while notes
are filtered or archived keeps every hidden note in place (the saved order is
always the full set — `moveNoteInOrder` in `frontend/src/notes/model/notesModel.ts`).

## What follows the account

Colour, labels and the archive flag are one document, sealed to your own key
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
  banner; the local copy is kept either way.
- **Deleting a note forgets its colour and labels.** Nothing prunes state from
  one device's partial view of the notes any more.

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
  the cache is put back before the first render. On the web, a service worker
  (`/notes/sw.js`, built by `frontend/scripts/notes-sw.mjs`) serves the page
  itself: network first with a short timeout, then the cached copy; hashed
  assets from cache. Its scope is `/notes/`, so by the service-worker spec it
  can never control the main app or its updater, and it never answers for the
  API. The operator serves it `Cache-Control: no-cache`
  (`deploy/webapp/README.md`). The Android app has no worker: its page is
  already in the APK.
- **Edits made offline are queued.** New notes, items, ticks, renames, due
  times, moves, deletes, pins and order go into an outbox (same database, same
  sealing) and stay on screen. The card says *Not synced* and a banner counts
  what is waiting. When the connection returns, the queue replays first-in
  first-out through the same task API (content is sealed for the server at that
  moment), under a lock so two tabs never send the same change. Notes created
  offline get temporary ids that are rewritten on replay; if a create is
  refused, everything under it is dropped with it. A change the server refuses
  (lost access, deleted elsewhere) is dropped and one message lists what did not
  save, in your words. Item edits are last-write-wins: the task API has no
  revision to compare against.
- **Not offline:** adding an attachment (the upload needs the network) — it
  fails with a message and nothing is queued.
- **A session that expires while offline** keeps the cached notes on screen with
  a *Sign in to sync* banner instead of clearing them. The queue replays only
  for the same account; signing in as someone else drops the other account's
  cache.
- **Sign-out** deletes every Notes database on this browser, and warns first if
  offline edits have not been sent.

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
browser it may be another account's enrolment), and so does being offline, so
the next sign-in re-attests as the same device instead of adding a ghost row to
the Devices view.

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
still carries `dist/notes/` inside its resources, unused: the shell only ever
loads `index.html` and nothing in the app links to `/notes/` there; dropping it
from the Tauri bundle is a follow-up. `deploy/ops/dual-ship.sh webapp` checks
Notes' entry chunk for the API host the same way it checks the main one.

In development the main dev server serves it: `npm run dev`, then open
`/notes/` on the dev server's origin. The main app's account remembers you.

### The Android app

`frontend/notes-app/` is a second Capacitor project that wraps the same page as
its own Android app, **Púca Notes** (`com.sovereign.notes`), installed beside the
Púca app with its own storage and its own sign-in (the same Púca account).
None of Púca's native plugins are in it — notifications, background delivery,
location reminders and the OTA updater stay Púca's — so due-time reminders show
in the Reminders view but do not notify from this app, and it updates by
installing a new APK.

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

**It ships with every release.** The app has no updater of its own, so a Púca
Notes that trails the task API it talks to would break quietly; it is therefore
a release surface like the others: built from the same version
(`tauri.conf.json`, checked by `scripts/check-lite-identity.mjs`), release-signed
with the same keystore as Púca, uploaded by `deploy/ops/dual-ship.sh apk-notes`
under `APK_PREFIX_NOTES` from `hosts.conf`, linked from the download page (the
ship refuses until it is), and asserted by `check-versions.sh`.

## Not built (and why)

- **Free-text notes.** Every note is a checklist: the schema's only text is a
  task's description. A paragraph note needs a sealed body column first.
- **Trash.** Púca deletes lists server-side with a cascade and no history;
  Notes gives a six-second Undo instead.
- **Per-person sharing.** A shared note is a channel; there is no "share with
  one person" that the data model could honour.
- **Photo/drawing notes, recurring or snoozable reminders,
  edited-at.** No source in the task API yet.

## Verifying

`frontend/e2e/notes-walk.mjs` drives the built bundle (`e2e/serve-dist.mjs`,
which serves `/notes/` correctly) at desktop size and at 390×844 with a coarse
pointer against a throwaway backend, asserting the design rules
(`docs/DESIGN_PHILOSOPHY.md`) rather than only taking screenshots. With a
second browser context as a second device it also checks sync: a note and a
label made on one appear on the other with no refresh, a bulk colour change
lands as one write, labels survive a sign-out, the page reloads offline from the
worker and the sealed cache, an offline edit replays when the network returns,
and the sign-out revokes the browser's device row.
