/**
 * "Install Púca" for Chromium browsers (Chrome, Edge, Samsung Internet, Opera):
 * the download page's "Install Púca as an app" button.
 *
 * The download page is on another origin, so it cannot install this app. It opens
 * the web app at `/?install=1`, and this module turns that marker into a small
 * banner (components/InstallBanner.tsx) whose button calls the browser's own
 * deferred `beforeinstallprompt`. The install itself still happens on the user's
 * tap, in the browser's own dialog.
 *
 * WHEN THE BANNER SHOWS. Only after an explicit ask: the marker in the URL, which
 * is remembered (`puca-install-requested`, with the time of the ask) for ten minutes,
 * or until the banner is dismissed or the app installed, because a sign-in or a
 * reload drops the query string and the browser may fire `beforeinstallprompt` a
 * moment later. An ask that never got its event (a browser that cannot install)
 * expires, so an ordinary visit months later is left alone. `beforeinstallprompt` is
 * captured, and the browser's own prompt suppressed, ONLY while an ask is open: an
 * ordinary visit to the web app is left exactly as the browser would treat it.
 *
 * WHEN IT NEVER SHOWS. Inside the Tauri desktop app and the Capacitor app (they
 * are installed already, and nothing here is attached there), in a window that is
 * already an installed app (display-mode standalone / fullscreen / minimal-ui, or
 * iOS's `navigator.standalone`), on an iPhone or iPad (no `beforeinstallprompt`
 * there; the Home Screen steps and profile on the download page are the route), and
 * in any browser that never fires the event (Firefox, Safari): no event, no banner.
 *
 * A dismissal persists (`puca-install-dismissed`). Asking again from the download
 * page (the marker) is a fresh ask and clears it.
 */
import { isTauri, isMobile } from './platform';

export interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>;
}

const REQUESTED_KEY = 'puca-install-requested';
const DISMISSED_KEY = 'puca-install-dismissed';

/** How long an ask from the download page stays open. */
export const ASK_TTL_MS = 10 * 60 * 1000;

function read(win: Window, key: string): boolean {
    try {
        const v = win.localStorage.getItem(key);
        if (key !== REQUESTED_KEY) return v === '1';
        // The ask is stored as the time it was made. A value that is not a recent
        // time (an expired ask, or the plain "1" an older build wrote) is no ask.
        const at = Number(v);
        if (v && Number.isFinite(at) && at > 1e12 && Date.now() - at >= 0 && Date.now() - at < ASK_TTL_MS) return true;
        if (v) win.localStorage.removeItem(key);
        return false;
    } catch {
        return false;
    }
}

function write(win: Window, key: string, on: boolean): void {
    try {
        if (on) win.localStorage.setItem(key, key === REQUESTED_KEY ? String(Date.now()) : '1');
        else win.localStorage.removeItem(key);
    } catch {
        /* storage blocked: the ask then lasts for this page load only */
    }
}

/** An installed app's window, in any of the ways a browser reports it. */
export function isInstalledWindow(win: Window): boolean {
    const nav = win.navigator as Navigator & { standalone?: boolean };
    if (nav.standalone === true) return true;
    try {
        return ['standalone', 'fullscreen', 'minimal-ui'].some((m) => win.matchMedia(`(display-mode: ${m})`).matches);
    } catch {
        return false;
    }
}

/** iPhone and iPad (an iPad asking for desktop sites says "Macintosh"; it has a touch screen). */
export function isIosDevice(win: Window): boolean {
    const nav = win.navigator;
    const ua = nav.userAgent || '';
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
}

/** The install banner may exist at all in this window. */
export function installContextAllowed(win: Window): boolean {
    if (isTauri()) return false;
    if (isMobile()) return false;
    return !isInstalledWindow(win) && !isIosDevice(win);
}

export interface InstallState {
    /** Show the banner. */
    visible: boolean;
}

type Listener = () => void;

let deferred: BeforeInstallPromptEvent | null = null;
let requested = false;
let dismissed = false;
let snapshot: InstallState = { visible: false };
const listeners = new Set<Listener>();
let started: Window | null = null;

function compute(win: Window): boolean {
    return installContextAllowed(win) && requested && !dismissed && deferred !== null;
}

function publish(win: Window): void {
    const visible = compute(win);
    if (visible === snapshot.visible) return;
    snapshot = { visible };
    listeners.forEach((l) => l());
}

/**
 * Wire the listeners and read the marker. Called once, early in main.tsx (the
 * event can fire before React mounts). Returns an undo for tests.
 */
export function installInstallPrompt(win: Window = window): () => void {
    if (started === win) return () => {};
    if (!installContextAllowed(win)) return () => {};
    started = win;

    dismissed = read(win, DISMISSED_KEY);
    requested = read(win, REQUESTED_KEY);

    let url: URL | null = null;
    try {
        url = new URL(win.location.href);
    } catch {
        /* no usable location */
    }
    if (url && url.searchParams.get('install') === '1') {
        // A fresh ask from the download page.
        requested = true;
        dismissed = false;
        write(win, REQUESTED_KEY, true);
        write(win, DISMISSED_KEY, false);
        url.searchParams.delete('install');
        try {
            win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash);
        } catch {
            /* leave the address as it is */
        }
    }

    const onBefore = (e: Event) => {
        if (!requested || dismissed) return; // not asked: the browser keeps its own behaviour
        e.preventDefault();
        deferred = e as BeforeInstallPromptEvent;
        publish(win);
    };
    const onInstalled = () => {
        deferred = null;
        requested = false;
        write(win, REQUESTED_KEY, false);
        publish(win);
    };
    win.addEventListener('beforeinstallprompt', onBefore);
    win.addEventListener('appinstalled', onInstalled);
    publish(win);
    return () => {
        win.removeEventListener('beforeinstallprompt', onBefore);
        win.removeEventListener('appinstalled', onInstalled);
        deferred = null;
        requested = false;
        dismissed = false;
        snapshot = { visible: false };
        started = null;
        listeners.forEach((l) => l());
    };
}

export function getInstallState(): InstallState {
    return snapshot;
}

export function subscribeInstallState(l: Listener): () => void {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

/** Close the banner for good (until the download page asks again). */
export function dismissInstallBanner(win: Window = window): void {
    dismissed = true;
    requested = false;
    write(win, DISMISSED_KEY, true);
    write(win, REQUESTED_KEY, false);
    publish(win);
}

/**
 * The tap on Install: show the browser's own dialog. The event can be used once,
 * so it is spent either way; a refusal in that dialog is a dismissal.
 */
export async function runInstallPrompt(win: Window = window): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const ev = deferred;
    if (!ev) return 'unavailable';
    deferred = null;
    publish(win);
    try {
        await ev.prompt();
        const choice = await ev.userChoice;
        if (choice.outcome === 'accepted') {
            requested = false;
            write(win, REQUESTED_KEY, false);
            publish(win);
            return 'accepted';
        }
    } catch {
        /* the browser refused to show it */
    }
    dismissInstallBanner(win);
    return 'dismissed';
}
