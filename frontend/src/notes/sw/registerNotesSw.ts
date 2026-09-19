/**
 * Register Notes' offline worker (scripts/notes-sw.mjs) — on the WEB page at
 * /notes/ only. Never in the Android Notes app (its page is served from the
 * APK at `/`, and it is a native platform), never in development (there is
 * no sw.js on the dev server), and never anywhere outside /notes/, so it can
 * never be registered from Púca's own page.
 *
 * A new build's worker takes over on its own (skipWaiting + clients.claim);
 * when that happens under an open page, the user is told once that a reload
 * picks the new version up — nothing reloads on its own.
 */
import { isMobile } from '../../api/platform';
import { pushMessageToast } from '../../components/messageToastBus';

export function shouldRegisterNotesSw(env: { prod: boolean; pathname: string; native: boolean; hasSw: boolean }): boolean {
    return env.prod && !env.native && env.hasSw && env.pathname.startsWith('/notes/');
}

export function registerNotesServiceWorker(): void {
    if (!shouldRegisterNotesSw({
        prod: import.meta.env.PROD,
        pathname: window.location.pathname,
        native: isMobile(),
        hasSw: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    })) return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('/notes/sw.js', { scope: '/notes/' }).catch(err => {
        // An older deployment without the file answers with the app's HTML:
        // registration fails harmlessly and Notes stays online-only.
        console.info('[notes] offline worker not registered:', err instanceof Error ? err.message : err);
    });
    let told = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || told) return;
        told = true;
        pushMessageToast({ title: 'Púca Notes was updated — reload the page to use the new version' });
    });
}
