/**
 * What a click on a link does: ONE router for every link on the page, in
 * every shell Púca runs in.
 *
 * WHY. `target="_blank"` and `window.open` do nothing in two of the three
 * places this code runs (api/openExternal.ts has the details): the Tauri v2
 * webview registers no opener plugin and denies new windows, and the
 * Capacitor apps never enable multiple windows. Before this router the
 * desktop had a bubble-phase interceptor of its own and the phone had none,
 * so a link in a message was dead in Púca's Android app, and an invite link
 * to the very server the desktop app was signed in to opened a browser tab
 * at the web app instead of Púca's own join screen.
 *
 * HOW. One `click` + `auxclick` listener on the document, in the CAPTURE
 * phase, installed once per page at boot: main.tsx (Púca, which also hosts
 * Notes inside the desktop app) and notes/main.tsx (Púca Notes' own page and
 * its Android app). Capture, so no component can make a link dead by
 * stopping the click on its way up — NoteLinkText does exactly that, to keep
 * a tap on a link from also editing the row around it. Components therefore
 * never open their own links; src/tests/linkRouterSweep.test.tsx fails when
 * an anchor tries to.
 *
 *   1. An INVITE LINK TO THIS SERVER (thisServerInviteCode) opens the join
 *      flow on this page, code filled in and looked up, in every shell, the
 *      web included — when the page has one (Chat registers it with
 *      setInviteOpener). A page with no join flow (Notes' own page, the
 *      sign-in screen) treats the link like any other.
 *   2. Desktop and phone: every other http(s)/mailto link goes through
 *      openExternalUrl — the system browser or mail app. Modified and middle
 *      clicks too: a shell has no tabs, and a Ctrl+click that did nothing
 *      would be the very bug this fixes.
 *   3. The web: left alone, because the anchor's own target="_blank" works —
 *      except (1), and (1) only on a plain left click. Ctrl/Cmd/Shift/Alt or
 *      a middle click there is someone asking for a new tab, and gets it.
 *
 * NEVER TOUCHED: a click an earlier listener already prevented (a drag's
 * trailing click, a mouse button bound to push-to-talk), a relative href
 * (react-router's in-app links, `#`), any scheme but http(s)/mailto
 * (javascript:, data:, a blob: download), an anchor with `download`, an
 * anchor inside editable content, and any button but the primary and the
 * middle one.
 */
import { isMobile, isTauri } from './platform';
import { isExternalHref, openExternalUrl } from './openExternal';
import { API_BASE_URL } from './config';
import { fetchPublicConfig, peekPublicConfig } from './publicConfig';
import { parseInviteCode } from './pendingInvite';

export type LinkShell = 'desktop' | 'phone' | 'web';

/**
 * Which shell this page is in, behind an object so a component's test can
 * put the router in a shell without faking the whole platform module — the
 * same shape, for the same reason, as `navigateAway` in openExternal.ts.
 */
export const linkShell = {
    kind(): LinkShell {
        if (isTauri()) return 'desktop';
        if (isMobile()) return 'phone';
        return 'web';
    },
};

/**
 * The addresses a client before 0.9.2 copied into invite links as its own
 * (api/pendingInvite.ts): the desktop app's webview origin and the Android
 * app's. No such link opens anywhere else — each one points at the reader's
 * own machine — and the code in it was made on a Púca server, so the join
 * flow here is the only place it can work.
 */
const LEGACY_APP_ORIGINS = ['http://tauri.localhost', 'https://tauri.localhost', 'https://localhost'];

/** `origin + path`, no trailing slash — or null for anything not http(s). */
function baseOf(url: string): string | null {
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        return u.origin + u.pathname.replace(/\/+$/, '');
    } catch {
        return null;
    }
}

/**
 * Every address that is THIS server's, as `origin + path`:
 *  - the web app's public address from GET /config (APP_URL) — the one
 *    inviteLink builds every shared link from. With its path, so a
 *    deployment under a sub-path claims only its own `/invite/`;
 *  - the API base this build talks to (VITE_API_URL), with its path;
 *  - this page's own origin — on the web, the web app itself;
 *  - the legacy client origins above.
 */
export function thisServerBases(): string[] {
    const out = new Set<string>();
    const add = (url: string | null | undefined) => {
        const b = url ? baseOf(url) : null;
        if (b) out.add(b);
    };
    add(peekPublicConfig()?.appUrl);
    add(API_BASE_URL);
    if (typeof window !== 'undefined') add(window.location.origin);
    LEGACY_APP_ORIGINS.forEach(add);
    return [...out];
}

/**
 * The invite code in `href` when it is an invite link to THIS server, else
 * null. The ORIGIN must match exactly — scheme, host and port, as the URL
 * parser normalises them — so a look-alike host, another port, or another
 * site's `/invite/` path is never taken for ours. The path must be exactly
 * `<base>/invite/<code>`; a trailing slash, a query and a fragment are
 * tolerated (chat apps and phones add them). Deliberately STRICTER than
 * parseInviteCode, which reads a code out of any pasted text: pasting is a
 * choice to join, a click on someone else's link is not.
 */
export function thisServerInviteCode(href: string): string | null {
    let u: URL;
    try {
        u = new URL(href);
    } catch {
        return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const at = u.origin + u.pathname;
    for (const base of thisServerBases()) {
        const prefix = `${base}/invite/`;
        if (!at.startsWith(prefix)) continue;
        const rest = at.slice(prefix.length).replace(/\/$/, '');
        if (!rest || rest.includes('/')) return null;
        return parseInviteCode(rest);
    }
    return null;
}

type InviteOpener = (code: string) => void;
let inviteOpener: InviteOpener | null = null;

/**
 * Register how this page opens its join flow for a code (Chat does, on
 * mount). The newest registration wins; the returned function unregisters it
 * and leaves a newer one alone, so a remount cannot clear its successor.
 */
export function setInviteOpener(open: InviteOpener): () => void {
    inviteOpener = open;
    // Which links are this server's depends on the web app's public address;
    // ask for it now, while no click is waiting on the answer.
    void fetchPublicConfig();
    return () => {
        if (inviteOpener === open) inviteOpener = null;
    };
}

/** The element a click landed on, or the element around a text node. */
function elementOf(target: EventTarget | null): Element | null {
    if (target instanceof Element) return target;
    if (target instanceof Node) return target.parentElement;
    return null;
}

/**
 * Inside text being edited: a click there places the caret, it is not a
 * visit. The attribute walk as well as isContentEditable, which not every
 * DOM implements (jsdom does not).
 */
function isEditable(el: Element): boolean {
    if (el instanceof HTMLElement && el.isContentEditable === true) return true;
    const host = el.closest('[contenteditable]');
    return host !== null && host.getAttribute('contenteditable')?.toLowerCase() !== 'false';
}

/** The router itself: exported so a test can drive it with a bare event. */
export function routeLinkClick(e: MouseEvent): void {
    if (e.defaultPrevented) return;
    const aux = e.type === 'auxclick';
    if (aux ? e.button !== 1 : e.button !== 0) return;
    const anchor = elementOf(e.target)?.closest('a[href]');
    if (!anchor) return;
    if (isEditable(anchor)) return;
    if (anchor.hasAttribute('download')) return;
    const href = (anchor.getAttribute('href') ?? '').trim();
    if (!isExternalHref(href)) return;

    const shell = linkShell.kind();
    const plain = !aux && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
    const open = inviteOpener;
    const code = open ? thisServerInviteCode(href) : null;
    // No answer from GET /config yet (it failed at boot — offline, say): this
    // click cannot wait for it, but the next one can have it.
    if (open && peekPublicConfig() === null) void fetchPublicConfig();
    if (open && code && (shell !== 'web' || plain)) {
        e.preventDefault();
        open(code);
        return;
    }
    if (shell === 'web') return;
    e.preventDefault();
    openExternalUrl(href);
}

let uninstallInstalled: (() => void) | null = null;

/**
 * Install the router on this document, once: a second call returns the
 * first installation's uninstall instead of adding a second listener (which
 * would open every link twice). The uninstall is for tests.
 */
export function installLinkRouter(): () => void {
    if (uninstallInstalled) return uninstallInstalled;
    const onClick = (e: MouseEvent) => routeLinkClick(e);
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);
    const uninstall = () => {
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('auxclick', onClick, true);
        if (uninstallInstalled === uninstall) uninstallInstalled = null;
    };
    uninstallInstalled = uninstall;
    return uninstall;
}
