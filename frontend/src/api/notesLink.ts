import { isMobile, isTauri } from './platform';
import { isIosStandalone } from './iosStandalone';

/**
 * Where Púca Notes lives, or null where the link would be wrong. WEB ONLY:
 * Notes is a second page on the web app's origin, and it is signed in there
 * because the two pages share the origin's storage. The link names the FILE
 * (`/notes/index.html`), not the folder: a vhost whose `try_files` still reads
 * `{path} /index.html` answers both `/notes` and `/notes/` with THIS app
 * (measured on production the day Notes shipped — the folder only works once
 * the operator adds `{path}/`, deploy/webapp/README.md), while a real file is
 * served by every configuration. Notes' own routes are hash routes, so the
 * file name stays in the address bar and nothing else changes. The desktop shell runs at tauri://localhost and the phone at
 * https://localhost, where nothing is shared: a link from either would open
 * a signed-out, default-themed page in the system browser, so they get none.
 * The desktop app needs none anyway — Notes is inside it, on the rail's
 * "Tasks & notes" (NotesDesktopView.tsx; Chat's `notesInApp`), already signed
 * in.
 */
export function notesUrl(): string | null {
    // None in an iPhone's Home Screen app either: a standalone window has no second
    // window, so a _blank link would REPLACE the app, and with it the socket and any
    // live call. People there add Púca Notes to the Home Screen on its own
    // (docs/USER_GUIDE.md, "iPhone and iPad") or open /notes/ in Safari.
    if (typeof window === 'undefined' || isTauri() || isMobile() || isIosStandalone()) return null;
    return `${window.location.origin}/notes/index.html`;
}
