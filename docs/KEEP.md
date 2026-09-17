# Púca Keep

A notes app, Google-Keep style, that is a second front door onto Púca's task
system. Same account, same end-to-end encryption, same lists and checklist
channels — its own page, its own shape. It lives at **`/keep/`** on the web
app's origin (`https://app.example.com/keep/`), and Púca's Tasks view links to
it from the tab bar.

There is nothing new on the server. A Keep **note** is a Púca **personal task
list**; a **shared note** is a **checklist channel** from one of your servers;
the rows in a note are the tasks themselves. Pinning a note favourites the tab
in Púca; reordering notes reorders Púca's tab bar; a due time set in Keep fires
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
  Upcoming; tick it done from there. Keep runs Púca's reminder loop, so a due
  item notifies while Keep is the app you have open (allow notifications from
  the Reminders view).
- **Colour, labels, archive** — Keep's own organisation (see *What stays on the
  device* below).
- **Undo** — archive and delete show an Undo snackbar; a delete reaches the
  server only when it expires.
- **Copy as text / Make a copy / Export** — a note as a Markdown checklist to
  the clipboard, a copy as a fresh note, or every note as Markdown or JSON from
  the account menu.
- **Keyboard** — `/` search, `c` new note, `r` refresh, `Esc` close, `?` help.
- **Installable** — a web app manifest lets a browser add Keep to the home
  screen or desktop. Deliberately no service worker: the main app's OTA and
  updater model must not be shadowed by a cache, so Keep is online-first with
  an honest offline banner.

## How it maps onto Púca

| Keep | Púca |
|---|---|
| Note | Personal task list (`task_lists`; title encrypt-to-self) |
| Shared note | Checklist channel (`has_checklist`), sealed under the channel key; your channel permissions apply |
| Items, nesting, completed, due times, attachments | The tasks (`channel_tasks`), through `frontend/src/api/tasks.ts` |
| Pin | `task_tab_prefs.is_favorite` — the same favourite as the Tasks tab bar |
| Note order (`Move to top / up / down`) | `task_tab_prefs` order — the Tasks tab bar's order |
| Reminders | `due_at` + `frontend/src/api/taskReminders.ts` |
| Colour, labels, archive, grid/list, sort | Device-local (below) |

Pin and order are shared **by design**: pinning in Keep pulls that tab to the
front of Púca's bar, as favouriting does there. A reorder made while notes
are filtered or archived keeps every hidden note in place (the saved order is
always the full set — `moveNoteInOrder` in `frontend/src/keep/model/keepModel.ts`).

## What stays on the device

Colour, labels, the archive flag, and the grid/list and sort choices are stored
in this browser's localStorage, namespaced per account (`pucaKeepPrefs:<user>`),
the way saved places are (`frontend/src/api/taskPlaces.ts`). The schema has no
home for them and they are presentation, not information — which is what the
task API persists. The honest cost: they do not follow the account to another
device or browser, and **signing out destroys them** (Púca's `logout()` scrubs
the per-account stores). Labels are the one item people will miss, because the
rail is built from them; a sealed-to-self server blob would carry all of this
without the server learning anything and is the natural next step.

Nothing here changes what the operator can see (`docs/SECURITY_MODEL.md`):
search is local, labels and colours never leave the device, thumbnails are
decrypted client-side as they are in Púca.

## Sessions: one origin, two pages

Keep and the web app share the origin's storage, so signing in to one signs in
to the other — in the **browser**. The desktop and phone shells run at their
own origins, where nothing is shared; that is why Púca's *Open in Púca Keep*
button appears only in the web app.

Two pages on one origin also share the token and the E2EE seed at rest but not
in memory. `frontend/src/api/sessionSync.ts` watches the `storage` event so a
sign-out, a soft expiry, or an account switch in one tab lands in the other
(caches cleared, back to sign-in, or a reload for a new account), and the
identity memo in `frontend/src/api/e2ee.ts` re-validates against storage once
another document has changed it. Signing out **from Keep** signs the account
out of this browser but cannot revoke the browser's *device enrolment* (that
needs the attested id only Púca's socket holds), so the next Púca sign-in
re-attests as the same device — the same outcome as signing out of Púca before
its socket attested. On a shared machine, revoke it from Púca's Devices view,
or use *Sign out of every device* from Keep's account menu.

Keep **never opens the WebSocket**. Púca wires its file-transfer handlers
before its socket opens because the server sweeps parked P2P file offers to
any connection that registers, delivered once; a bare Keep socket would eat
them. Freshness comes from refetch on focus, a 30-second poll while a shared
note is open, and the refresh button.

## Building and serving

`npm run build` builds Keep after the main bundle (`vite.keep.config.ts` →
`dist/keep/`) and `scripts/check-dist-entries.mjs` then asserts both pages
name an `assets/index-*.js` entry that bakes the API host. Keep is a separate
build on purpose: a second entry in the main one would rename the entry chunk
the release scripts grep for and hoist the baked API host out of it
(`vite.shared.ts` has the story).

The web tarball ships it (`deploy/webapp/README.md`); the operator's Caddy
`try_files` needs `{path}/` once so `/keep/` serves the directory index. The
phone shells strip `dist/keep/` (`scripts/strip-keep-from-native.mjs` after
every `cap sync`, and `rm -rf ota-src/keep` in the OTA recipe) — a browser-only
page with no CSP meta has no business inside a WebView. The desktop installer
still carries `dist/keep/` inside its resources, unused: the shell only ever
loads `index.html` and nothing in the app links to `/keep/` there; dropping it
from the Tauri bundle is a follow-up. `deploy/ops/dual-ship.sh webapp` checks
Keep's entry chunk for the API host the same way it checks the main one.

In development the main dev server serves it: `npm run dev`, then open
`/keep/` on the dev server's origin. The main app's account remembers you.

### The Android app

`frontend/keep-app/` is a second Capacitor project that wraps the same page as
its own Android app, **Púca Keep** (`com.sovereign.keep`), installed beside the
Púca app with its own storage and its own sign-in (the same Púca account).
None of Púca's native plugins are in it — notifications, background delivery,
location reminders and the OTA updater stay Púca's — so due-time reminders show
in the Reminders view but do not notify from this app, and it updates by
installing a new APK.

```bash
cd frontend && npm run keep:android            # debug APK, sideloadable
cd frontend && npm run keep:android:release    # needs a keystore under keep-app/android
```

`scripts/build-keep-app.mjs` builds the page in native mode
(`KEEP_TARGET=native`, base `/`, output `dist-keep-app/`), injects the Android
CSP meta (`scripts/cap-index-csp.mjs --index`), runs `cap sync android` inside
`keep-app/`, and calls gradle. The API host comes from `frontend/.env.production`
like every other build. Output:
`frontend/keep-app/android/app/build/outputs/apk/debug/app-debug.apk`.

## Not built (and why)

- **Free-text notes.** Every note is a checklist: the schema's only text is a
  task's description. A paragraph note needs a sealed body column first.
- **Server-synced colour, labels, archive.** See above.
- **Trash.** Púca deletes lists server-side with a cascade and no history;
  Keep gives a six-second Undo instead.
- **Per-person sharing.** A shared note is a channel; there is no "share with
  one person" that the data model could honour.
- **Photo/drawing notes, recurring or snoozable reminders, bulk selection,
  edited-at.** No source in the task API yet.

## Verifying

`frontend/e2e/keep-walk.mjs` drives the built bundle (`e2e/serve-dist.mjs`,
which serves `/keep/` correctly) at desktop size and at 390×844 with a coarse
pointer against a throwaway backend, asserting the design rules
(`docs/DESIGN_PHILOSOPHY.md`) rather than only taking screenshots.
