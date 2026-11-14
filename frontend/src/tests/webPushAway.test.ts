// @vitest-environment jsdom
/**
 * The web app saying, per socket, when its page cannot show a notification by
 * itself (api/webPushAway.ts, `SetPushAway`), so the server pushes instead.
 *
 * The bug: an iPhone's Home Screen app sent to the background is frozen by
 * iOS within seconds, while its socket stays up until the server's 75 s idle
 * reaper, and Web Push skips a browser whose socket is up. For about the
 * first minute after leaving the app nothing announced a message at all.
 *
 * Pinned here:
 *  - nothing is ever sent to a server that has not confirmed `push_away` on
 *    THIS socket (an older one alerts on an unknown frame);
 *  - a phone's page says so the moment it is hidden, in exactly the bytes
 *    the server's test parses (fixtures/pushAway.json), and takes it back on
 *    screen; one frame per transition;
 *  - a desktop browser's hidden tab does NOT (it keeps running and shows its
 *    own notification; a push as well would be every message twice), though
 *    a page being left does;
 *  - while it has said so, the page raises no message notification of its
 *    own (desktopNotify.ts), and plays no sound over the push's;
 *  - nothing at all without Web Push turned on here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fixture from './fixtures/pushAway.json';

const env = vi.hoisted(() => ({ tauri: false, foreground: false, invokes: [] as string[] }));
vi.mock('../api/platform', async (orig) => ({
    ...(await orig<typeof import('../api/platform')>()),
    isTauri: () => env.tauri,
    isMobile: () => false,
    appIsForeground: () => env.foreground,
}));
// The desktop app's shell, recorded: its toasts are its own path.
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string) => { env.invokes.push(cmd); return cmd === 'toast_show' ? 'popped' : null; },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => { } }));

const { wsClient } = await import('../api/websocket');
const { startWebPushAwayReporter, decideAway, hiddenPageCannotNotify, PUSH_AWAY_FEATURE } = await import('../api/webPushAway');
const { pageToldAwayForPush } = await import('../api/webPushLocal');
const { notifyNewMessage, resetConversationNotificationsForTests } = await import('../api/desktopNotify');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_SITE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

type Sock = { send: (d: string) => void; onmessage: ((e: { data: string }) => void) | null; close: () => void };
const sock = () => (wsClient as unknown as { ws: Sock }).ws;
let sent: Array<{ type: string; payload?: { away?: boolean } }> = [];
const awayFrames = () => sent.filter(f => f.type === 'SetPushAway');

async function openSocket(features: string[] | null) {
    const p = wsClient.connect('tok');
    await vi.advanceTimersByTimeAsync(1); // MockWebSocket opens on a 0 ms timer
    await p;
    const s = sock();
    vi.spyOn(s, 'send').mockImplementation((d: string) => {
        const frame = JSON.parse(d);
        sent.push(frame);
        if (frame.type === 'Ping') s.onmessage?.({ data: JSON.stringify({ type: 'Pong' }) });
    });
    if (features) s.onmessage!({ data: JSON.stringify({ type: 'ServerFeatures', payload: { features } }) });
    await vi.advanceTimersByTimeAsync(0);
}

function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
}

let stop: (() => void) | null = null;
let pushOn = true;
let phone = true;
const start = () => {
    stop = startWebPushAwayReporter({ pushOn: () => pushOn, hiddenCannotNotify: () => phone });
};

beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    pushOn = true;
    phone = true;
    env.tauri = false;
    env.foreground = false;
    wsClient.disconnect();
    setHidden(false);
});
afterEach(() => {
    stop?.();
    stop = null;
    wsClient.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('the rule', () => {
    it('away = Web Push on here AND (being left, or hidden where a hidden page cannot notify)', () => {
        const base = { pushOn: true, hiddenCannotNotify: true, hidden: false, leaving: false };
        expect(decideAway(base)).toBe(false);
        expect(decideAway({ ...base, hidden: true })).toBe(true);
        expect(decideAway({ ...base, hidden: true, hiddenCannotNotify: false })).toBe(false); // a desktop tab
        expect(decideAway({ ...base, leaving: true, hiddenCannotNotify: false })).toBe(true);
        expect(decideAway({ ...base, hidden: true, leaving: true, pushOn: false })).toBe(false);
    });

    it('which devices stop notifying when hidden: iPhone, iPad (desktop site too) and Android, not a desktop browser', () => {
        expect(hiddenPageCannotNotify(IPHONE, 5)).toBe(true);
        expect(hiddenPageCannotNotify(IPAD_DESKTOP_SITE, 5)).toBe(true);
        expect(hiddenPageCannotNotify(ANDROID, 5)).toBe(true);
        expect(hiddenPageCannotNotify(WINDOWS, 0)).toBe(false);
        expect(hiddenPageCannotNotify(IPAD_DESKTOP_SITE, 0)).toBe(false); // a real Mac
    });
});

describe('startWebPushAwayReporter', () => {
    it('sends NOTHING to a server that has not confirmed push_away (an older server), however the page moves', async () => {
        start();
        await openSocket(['presence', 'games']);
        setHidden(true);
        window.dispatchEvent(new Event('pagehide'));
        setHidden(false);
        expect(awayFrames()).toEqual([]);
        expect(pageToldAwayForPush()).toBe(false);
        // Positive control: the same socket carried other traffic.
        wsClient.send({ type: 'Ping' });
        expect(sent.some(f => f.type === 'Ping')).toBe(true);
    });

    it('a phone in the background says so at once, in the bytes the server parses, and takes it back on screen', async () => {
        start();
        await openSocket([PUSH_AWAY_FEATURE]);
        expect(awayFrames()).toEqual([]); // on screen: a fresh connection is present already
        setHidden(true);
        expect(awayFrames()).toEqual([fixture.away]);
        expect(pageToldAwayForPush()).toBe(true);
        window.dispatchEvent(new Event('pagehide')); // iOS may add this: no second frame
        setHidden(true);
        expect(awayFrames()).toEqual([fixture.away]);
        setHidden(false);
        expect(awayFrames()).toEqual([fixture.away, fixture.back]);
        expect(pageToldAwayForPush()).toBe(false);
    });

    it('iOS: back on screen without a pageshow still counts as back', async () => {
        start();
        await openSocket([PUSH_AWAY_FEATURE]);
        setHidden(true);
        window.dispatchEvent(new Event('pagehide'));
        setHidden(false); // only visibilitychange, no pageshow
        expect(awayFrames()).toEqual([fixture.away, fixture.back]);
    });

    it('NEGATIVE CONTROL: a desktop browser\'s hidden tab says nothing (it notifies itself), but a page being left does', async () => {
        phone = false;
        start();
        await openSocket([PUSH_AWAY_FEATURE]);
        setHidden(true);
        expect(awayFrames()).toEqual([]);
        window.dispatchEvent(new Event('pagehide'));
        expect(awayFrames()).toEqual([fixture.away]);
        window.dispatchEvent(new Event('pageshow')); // back from the back/forward cache
        expect(awayFrames()).toEqual([fixture.away, fixture.back]);
    });

    it('nothing without Web Push turned on here, until it is', async () => {
        pushOn = false;
        start();
        await openSocket([PUSH_AWAY_FEATURE]);
        setHidden(true);
        expect(awayFrames()).toEqual([]);
        pushOn = true;
        window.dispatchEvent(new CustomEvent('webPushOptInChanged'));
        expect(awayFrames()).toEqual([fixture.away]);
    });

    it('a socket that confirms it while the page is away is told at once; a closed one forgets', async () => {
        start();
        setHidden(true);
        await openSocket([PUSH_AWAY_FEATURE]);
        expect(awayFrames()).toEqual([fixture.away]);
        expect(pageToldAwayForPush()).toBe(true);
        // The transport drops (the server's reaper, a network change).
        (sock() as unknown as { onclose: (e: object) => void }).onclose({ code: 1006, reason: '', wasClean: false });
        expect(pageToldAwayForPush()).toBe(false);
        // A reconnect to an OLDER host: still hidden, still nothing for it.
        sent = [];
        await openSocket(['presence']);
        expect(awayFrames()).toEqual([]);
    });

    it('stopping while away leaves the server as a fresh connection would find it', async () => {
        start();
        await openSocket([PUSH_AWAY_FEATURE]);
        setHidden(true);
        stop!();
        stop = null;
        expect(awayFrames()).toEqual([fixture.away, fixture.back]);
        expect(pageToldAwayForPush()).toBe(false);
    });

    it('the default rule reads this browser: Android with Web Push on is away when hidden', async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
        Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
        (window as unknown as { PushManager: unknown }).PushManager = function PushManager() { /* present */ };
        (window as unknown as { Notification: unknown }).Notification = function Notification() { /* present */ };
        const payload = btoa(JSON.stringify({ sub: 5 })).replace(/=+$/, '');
        vi.mocked(localStorage.getItem).mockImplementation((k: string) =>
            k === 'auth_token' ? `x.${payload}.y` : k === 'puca_web_push_opt_in' ? '[5]' : null);
        try {
            stop = startWebPushAwayReporter();
            await openSocket([PUSH_AWAY_FEATURE]);
            setHidden(true);
            expect(awayFrames()).toEqual([fixture.away]);
        } finally {
            delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
            delete (window as unknown as { PushManager?: unknown }).PushManager;
            delete (window as unknown as { Notification?: unknown }).Notification;
            vi.mocked(localStorage.getItem).mockReset();
        }
    });
});

describe('the page\'s own notifications while it has said so', () => {
    class Recorded {
        static permission: NotificationPermission = 'granted';
        static made: string[] = [];
        onclick: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(title: string) { Recorded.made.push(title); }
        close() { /* nothing */ }
    }
    const message = (id: string, conv = 'c1') => notifyNewMessage({
        title: 'alice sent you a message', isOwn: false, isMuted: false, notifyKey: `dm:${conv}`, nav: `dm:${conv}`,
        group: { key: `dm:${conv}`, kind: 'dm', where: 'alice', author: 'alice', messageId: id },
    });

    beforeEach(() => {
        Recorded.made = [];
        (globalThis as { Notification?: unknown }).Notification = Recorded;
        resetConversationNotificationsForTests();
    });
    afterEach(() => {
        delete (globalThis as { Notification?: unknown }).Notification;
    });

    it('raises none, quietly, while the push carries them; raises them again once back', async () => {
        start();
        await openSocket([PUSH_AWAY_FEATURE]);
        // CONTROL: hidden but not said (a desktop tab): the page notifies.
        phone = false;
        setHidden(true);
        expect(message('m1')).toEqual({ fire: true });
        expect(Recorded.made).toHaveLength(1);
        // A phone: said, and the page raises nothing, with no sound either.
        // (A conversation of its own: a second message in c1 would be a
        // quiet update anyway, and prove nothing.)
        phone = true;
        setHidden(true);
        expect(pageToldAwayForPush()).toBe(true);
        expect(message('m2', 'c9')).toEqual({ fire: true, quiet: true });
        expect(Recorded.made).toHaveLength(1);
        // Back (and then away from the window, a desktop's way): its own
        // again (another conversation, so it is a pop-up, not an update).
        setHidden(false);
        expect(pageToldAwayForPush()).toBe(false);
        phone = false;
        setHidden(true);
        expect(message('m3', 'c2')).toEqual({ fire: true });
        expect(Recorded.made).toHaveLength(2);
    });

    it('the desktop app is never stopped by it (it never says so, but even a stray flag must not)', async () => {
        start();
        await openSocket([PUSH_AWAY_FEATURE]);
        setHidden(true);
        expect(pageToldAwayForPush()).toBe(true);
        env.tauri = true;
        env.invokes = [];
        expect(message('m4')).toEqual({ fire: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(env.invokes).toContain('toast_show'); // its own toast, as ever
        expect(Recorded.made).toHaveLength(0);
    });
});
