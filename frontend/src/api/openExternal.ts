// Cross-platform "open this link outside the app".
//
// The Tauri v2 webview registers no shell/opener plugin and denies new-window
// requests by default, so target="_blank" anchors and window.open are silent
// no-ops in the desktop shell. Desktop routes through the existing
// `open_external` Rust command (scheme-allowlisted, same one the update
// banner uses); web and Capacitor keep normal browser semantics.

import { isTauri } from './platform';

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
    } else {
        window.open(url, '_blank', 'noopener,noreferrer');
    }
}

/**
 * One document-level click interceptor for the Tauri shell: any anchor with an
 * external href opens in the system browser. Registered once at boot
 * (main.tsx) and ONLY under Tauri — on web/Capacitor the anchors' own
 * target="_blank" already works and must stay untouched.
 */
export function installTauriLinkInterceptor(): void {
    if (!isTauri()) return;
    const handle = (e: MouseEvent) => {
        if (e.defaultPrevented) return;
        const anchor = (e.target as Element | null)?.closest?.('a[href]');
        if (!anchor) return;
        const href = anchor.getAttribute('href') ?? '';
        // Only external schemes: SPA-internal links (react-router) and
        // in-app pseudo-hrefs must keep their default handling.
        if (!isExternalHref(href)) return;
        e.preventDefault();
        openExternalUrl(href);
    };
    document.addEventListener('click', handle);
    // Middle-click ("open in new tab") — there are no tabs in the shell, so
    // it opens the system browser like a plain click.
    document.addEventListener('auxclick', (e) => {
        if (e.button === 1) handle(e);
    });
}
