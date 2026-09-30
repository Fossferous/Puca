// Cross-platform "open this link outside the app".
//
// The Tauri v2 webview registers no shell/opener plugin and denies new-window
// requests by default, so target="_blank" anchors and window.open are silent
// no-ops in the desktop shell. Desktop routes through the existing
// `open_external` Rust command (scheme-allowlisted, same one the update
// banner uses).
//
// The Capacitor apps are the same story for a different reason:
// @capacitor/android never calls setSupportMultipleWindows, so window.open is
// refused there too. They get a top-level navigation instead, which the
// bridge turns into ACTION_VIEW. Only the browser keeps plain window.open.
//
// WHICH clicks come here is decided in one place, api/linkRouter.ts: every
// link on the page in the two shells — except an invite link to this
// server, which opens Púca's own join flow instead. Components do not call
// this for their own anchors.

import { isMobile, isTauri } from './platform';
import { pushMessageToast } from '../components/messageToastBus';

/**
 * A top-level navigation, behind an object so a test can replace it: jsdom's
 * `location` cannot be stubbed. Same shape (and same reason) as
 * `downloadPage` in notes/model/notesUpdate.ts. `pageHref` is where the page
 * is, for the same reason — a test puts it at the Capacitor apps' own
 * https://localhost, which jsdom's fixed origin cannot be.
 */
export const navigateAway = {
    go(url: string): void {
        window.location.assign(url);
    },
    pageHref(): string {
        return window.location.href;
    },
};

/**
 * Would a top-level navigation to `url` from a page at `pageHref` load INSIDE
 * the Capacitor app's own WebView rather than reach the system browser?
 *
 * Bridge.launchIntent (@capacitor/android, Bridge.java) hands a navigation to
 * ACTION_VIEW only when its host OR its scheme differs from the app's own URL
 * — the PORT is not compared — or when `allowNavigation` lists the host, which
 * neither capacitor.config.ts does (check-lite-identity.mjs keeps Notes' that
 * way). Both apps are served from https://localhost, so https://localhost/chat
 * would reboot Púca in place (socket closed, call dropped, and no browser) and
 * https://localhost:8443/ would replace it with an error page until it is
 * restarted. http://localhost differs by scheme and does reach the browser.
 */
export function loadsInsideTheApp(url: string, pageHref: string): boolean {
    try {
        const to = new URL(url);
        const page = new URL(pageHref);
        return to.protocol === page.protocol && to.hostname === page.hostname;
    } catch {
        return false;
    }
}

/** Schemes we will hand to the OS. Mirrors the chat parser's SAFE_URL_SCHEMES
 *  minus the internal sovereign-enc scheme (never an external link). */
const EXTERNAL_SCHEMES = /^(https?:|mailto:)/i;

export function isExternalHref(href: string): boolean {
    return EXTERNAL_SCHEMES.test(href);
}

export function openExternalUrl(url: string): void {
    if (!isExternalHref(url)) return;
    if (isTauri()) {
        void import('@tauri-apps/api/core')
            .then(({ invoke }) => invoke('open_external', { url }))
            .catch(err => console.error('[openExternal] failed:', err));
        return;
    }
    if (isMobile()) {
        // Capacitor: a top-level navigation to another host is handed to the
        // system browser (Bridge.launchIntent → ACTION_VIEW) and the app
        // stays where it is, because neither capacitor.config.ts lists an
        // `allowNavigation` for foreign hosts. window.open / target="_blank"
        // is NOT a substitute: @capacitor/android never calls
        // setSupportMultipleWindows, so the new window is simply refused.
        // Do not "simplify" this back to window.open.
        //
        // Except the app's OWN host (loadsInsideTheApp): the bridge keeps
        // that navigation in the app's WebView, which is the app navigating
        // itself away. Nothing on this device can open it for us — say so
        // rather than leave the tap dead.
        if (loadsInsideTheApp(url, navigateAway.pageHref())) {
            const host = new URL(url).hostname;
            pushMessageToast({ title: `Can’t open that link from the app: ${host} is the app’s own address on this device` });
            return;
        }
        navigateAway.go(url);
        return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
}
