/**
 * `puca://` invite links: the desktop app opened from OUTSIDE Púca.
 *
 * WHY. Someone clicks an invite link (`https://<web app>/invite/<code>`) in
 * a browser, a game launcher or another chat program. Windows cannot hand an
 * https link to a desktop app, so it opens the web invite page
 * (components/InviteLanding.tsx), which — in a desktop browser on Windows —
 * offers "Open in the Púca app": a `puca://invite/<code>?host=<this web app's
 * host>` link. The desktop installer registers that scheme
 * (src-tauri/installer-url-scheme.nsh), so Windows starts or wakes the app
 * with the link as its argument, and the desktop shell (src-tauri/src/
 * deep_link.rs) parses it, refuses anything that is not exactly that shape,
 * and hands the page a URL REBUILT from the parts it accepted.
 *
 * WHAT A LINK MAY DO. Any website can fire one, as often as it likes. So the
 * only thing it can do is put an invite code in the pending-invite slot that
 * the web's own invite links use (api/pendingInvite.ts): Chat opens Join a
 * Server with the code looked up — now, if it is on screen, or after sign-in
 * if nobody is signed in — and the person decides. It never joins, never
 * navigates, never runs anything. A link naming a DIFFERENT server's web app
 * (`?host=`) is not looked up here at all: this app talks to one server, and
 * a code looked up on the wrong one could name a different server entirely.
 *
 * The parser below and the shell's must agree exactly; one table of cases
 * (tests/fixtures/deep-link-cases.json) is asserted by both test suites.
 */
import { API_BASE_URL } from './config';
import { isMobile, isTauri } from './platform';
import { fetchPublicConfig } from './publicConfig';
import { announcePendingInvite, INVITE_CODE } from './pendingInvite';

/** The shell's event for a link that arrived while the app was running
 *  (deep_link.rs `EVENT`). Its payload is the rebuilt URL. */
export const DEEP_LINK_EVENT = 'deep-link-invite';

/** deep_link.rs `MAX_URL_LEN`: checked before anything reads the text. */
const MAX_URL_LEN = 512;

export interface DeepLinkInvite {
    code: string;
    /** The web app host the invite came from, lowercased; null when the
     *  link named none (a hand-made link). */
    host: string | null;
}

/** A plain DNS hostname: no port, user, brackets or trailing dot. */
export function isPlainHostname(s: string): boolean {
    if (s.length === 0 || s.length > 253) return false;
    return s.split('.').every(label =>
        label.length >= 1 && label.length <= 63
        && /^[A-Za-z0-9-]+$/.test(label)
        && !label.startsWith('-') && !label.endsWith('-'));
}

/**
 * Parse a `puca://` URL, or refuse it (null). Accepted, exactly:
 * `puca://invite/<code>` plus an optional `?host=<hostname>`, and at most one
 * trailing `/`; scheme, "invite" and host case-insensitive, the code kept as
 * it is. Mirrors deep_link.rs `parse_invite_url` rule for rule.
 */
export function parseDeepLink(raw: unknown): DeepLinkInvite | null {
    if (typeof raw !== 'string' || raw.length > MAX_URL_LEN) return null;
    const s = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    // ASCII-only case folding, as Rust's eq_ignore_ascii_case: without the
    // `u` flag a regex never folds a non-ASCII letter onto an ASCII one.
    const prefix = /^puca:\/\/invite\//i.exec(s);
    if (!prefix) return null;
    const rest = s.slice(prefix[0].length);
    const q = rest.indexOf('?');
    const code = q < 0 ? rest : rest.slice(0, q);
    if (!INVITE_CODE.test(code)) return null;
    if (q < 0) return { code, host: null };
    const query = rest.slice(q + 1);
    if (!query.startsWith('host=')) return null;
    const host = query.slice('host='.length);
    if (!isPlainHostname(host)) return null;
    return { code, host: host.toLowerCase() };
}

/** The link the web invite page offers, or null when either part could not
 *  survive the parser above (then there is nothing safe to offer). */
export function appInviteLink(code: string, host: string): string | null {
    const url = `puca://invite/${code}?host=${host}`;
    return parseDeepLink(url) ? url : null;
}

// ---------------------------------------------------------------------------
// The web invite page's side

/**
 * Whether this page should offer "Open in the Púca app": a desktop browser on
 * WINDOWS. Not inside the desktop app itself, not in the Android apps, not on
 * a phone or tablet — and not on macOS or Linux either, because only the
 * Windows installer registers `puca://`; offering it there would be a button
 * that can only fail.
 */
export function offersDesktopAppLink(): boolean {
    if (typeof navigator === 'undefined') return false;
    if (isTauri() || isMobile()) return false;
    const uad = (navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string } }).userAgentData;
    if (uad && typeof uad.platform === 'string' && uad.platform !== '') {
        return uad.platform === 'Windows' && uad.mobile !== true;
    }
    const ua = navigator.userAgent || '';
    return /Windows NT/.test(ua) && !/Windows Phone|Mobile|Xbox/i.test(ua);
}

/** "Always open invites in the app", per browser (this web origin). */
const OPEN_IN_APP_KEY = 'puca_invite_open_in_app_v1';

export function remembersOpenInApp(): boolean {
    try { return localStorage.getItem(OPEN_IN_APP_KEY) === '1'; } catch { return false; }
}

export function setRemembersOpenInApp(on: boolean): void {
    try {
        if (on) localStorage.setItem(OPEN_IN_APP_KEY, '1');
        else localStorage.removeItem(OPEN_IN_APP_KEY);
    } catch { /* storage unavailable: the choice is simply not kept */ }
}

/**
 * Hand a `puca://` link to the browser, which asks the OS for its handler —
 * behind an object so a test can replace it (jsdom cannot navigate, and a
 * test must never try to launch anything). Same shape as openExternal.ts's
 * `navigateAway`.
 */
export const appLauncher = {
    open(url: string): void {
        window.location.href = url;
    },
};

let downloadUrl: Promise<string | null> | null = null;

/**
 * The desktop app's download page: the one the desktop app itself sends
 * people to (`download_url` in GET /app-version, the operator's release
 * file). null when the server publishes none.
 */
export function fetchDesktopDownloadUrl(): Promise<string | null> {
    if (downloadUrl) return downloadUrl;
    const asked = (async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/app-version`, { cache: 'no-store' });
            if (!res.ok) return null;
            const body: unknown = await res.json();
            const url = (body as { download_url?: unknown } | null)?.download_url;
            return typeof url === 'string' && url.startsWith('https://') ? url : null;
        } catch {
            return null;
        }
    })();
    downloadUrl = asked;
    // A failure is not remembered: the next visit asks again.
    void asked.then(u => { if (u === null && downloadUrl === asked) downloadUrl = null; });
    return asked;
}

// ---------------------------------------------------------------------------
// The desktop app's side

export interface DeepLinkNotice {
    /** The web app host the refused invite came from. */
    host: string;
}

let notice: DeepLinkNotice | null = null;
const noticeListeners = new Set<() => void>();

/** What components/DeepLinkNotice.tsx shows (useSyncExternalStore). */
export function getDeepLinkNotice(): DeepLinkNotice | null {
    return notice;
}

export function subscribeDeepLinkNotice(cb: () => void): () => void {
    noticeListeners.add(cb);
    return () => { noticeListeners.delete(cb); };
}

function setNotice(next: DeepLinkNotice | null): void {
    if (notice?.host === next?.host) return;
    notice = next;
    noticeListeners.forEach(cb => cb());
}

export function dismissDeepLinkNotice(): void {
    setNotice(null);
}

/**
 * Is `host` the web app of the server this app talks to? Its public address
 * (GET /config `app_url`, the one every invite link is built from) or the
 * API's own host. When neither can be established the answer is no: the code
 * is not looked up on a server that may not be the one it was made on.
 */
export async function isThisServerHost(host: string): Promise<boolean> {
    const want = host.toLowerCase();
    const hostOf = (url: string | null | undefined): string | null => {
        if (!url) return null;
        try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
    };
    if (hostOf(API_BASE_URL) === want) return true;
    const { appUrl } = await fetchPublicConfig();
    return hostOf(appUrl) === want;
}

let queue: Promise<void> = Promise.resolve();

/**
 * One link from the shell (the warm-start event, or the cold-start link the
 * page takes at boot). In arrival order, one at a time: the host check can
 * wait on the network, and a later link must not overtake an earlier one.
 */
export function handleDeepLink(raw: unknown): Promise<void> {
    const run = queue.then(() => handleOne(raw));
    queue = run.catch(() => undefined);
    return run;
}

async function handleOne(raw: unknown): Promise<void> {
    const link = parseDeepLink(raw);
    if (!link) {
        // Never the text: it can be anything a website chose to send.
        console.warn('[deep-link] ignored a link that is not a Púca invite link');
        return;
    }
    if (link.host !== null && !(await isThisServerHost(link.host))) {
        setNotice({ host: link.host });
        return;
    }
    setNotice(null);
    // Chat opens the join flow with it: at once when it is on screen,
    // otherwise when it mounts after sign-in (the Login screen says an
    // invite is waiting). Nothing here joins.
    announcePendingInvite(link.code);
}

let installed = false;

/**
 * Wire the desktop app's end, once, at boot (main.tsx): listen for links that
 * arrive while the app runs, then take the one this launch carried, if any.
 * Listening FIRST, so a link arriving in between is not missed; a link that
 * reaches both paths opens the same code twice, which changes nothing.
 */
export function installDeepLinks(): void {
    if (installed || !isTauri()) return;
    installed = true;
    void (async () => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const { listen } = await import('@tauri-apps/api/event');
            await listen<unknown>(DEEP_LINK_EVENT, e => {
                void handleDeepLink(e.payload);
                // The shell also parked it, for a page that was not
                // listening; this page was, so empty the slot.
                void invoke('deep_link_take').catch(() => undefined);
            });
            const cold = await invoke<unknown>('deep_link_take');
            if (cold !== null && cold !== undefined) await handleDeepLink(cold);
        } catch {
            /* an older shell without the command: no links, nothing else changes */
        }
    })();
}

/** Test seam: forget the notice, the queue, the install and the download URL. */
export function __resetDeepLinksForTest(): void {
    notice = null;
    noticeListeners.clear();
    queue = Promise.resolve();
    installed = false;
    downloadUrl = null;
}
