/*
 * Púca's service worker for the web app, scope "/". PUSH ONLY.
 *
 * It exists for one job: when the server rings this browser's Web Push
 * doorbell (src/wake/webpush.rs), put a notification on screen, and open the
 * right conversation when it is tapped. It has NO fetch listener, so it never
 * sees a request the page makes and caches nothing: the app is not available
 * offline because of it, and nothing the app shows is ever written to disk
 * here. Púca Notes' own worker (/notes/sw.js, scope /notes/) is unaffected —
 * a page is controlled by the worker with the most specific scope.
 *
 * THE PUSH CARRIES NOTHING. Its payload is the constant {"w":"1"}, the same
 * for every user and every reason, so this worker does not even read it.
 * What knocked is asked of the user's OWN server, over TLS, with this
 * subscription's own secret (kept in IndexedDB by api/webPush.ts; it can read
 * the titles of what is waiting for this user and nothing else). The answer is
 * the content-free text the Android app shows ("alice sent you a message" /
 * "New message"): never message content, which stays encrypted end to end and
 * never reaches a lock screen.
 *
 * EVERY PUSH SHOWS A NOTIFICATION. iOS revokes a subscription whose pushes
 * show nothing, and Chrome shows its own "updated in the background" notice
 * instead. So when the server cannot be asked (offline, slow, signed out), the
 * generic "New activity in Púca" is shown rather than nothing. The server
 * applies this device's mutes and blocks BEFORE it sends, for the same reason.
 *
 * Plain JavaScript, copied verbatim by Vite from public/. Its strings are
 * pinned by src/push_web_handlers.rs and its behaviour by
 * src/tests/webPushWorker.test.ts and e2e/web-push-real-browser.mjs.
 */
'use strict';

const DB_NAME = 'puca-push';
const DB_STORE = 'cfg';
const DB_KEY = 'subscription';
const GENERIC_TITLE = 'Púca';
const GENERIC_BODY = 'New activity in Púca';
const GENERIC_TAG = 'puca-activity';
const ICON = '/icon-192.png';
const PENDING_TIMEOUT_MS = 6000;
const MAX_ITEMS = 4;
// Chat.tsx's notification-tap targets, and nothing else: a tap can only ever
// open a conversation, a server or a clip prompt.
const NAV_RE = /^(dm|server|clip):[A-Za-z0-9_-]{1,80}$/;

function validNav(nav) {
    return typeof nav === 'string' && NAV_RE.test(nav) ? nav : null;
}

self.addEventListener('install', () => {
    // A new sw.js takes over at once: it holds no cache that could disagree
    // with the page.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

function readConfig() {
    return new Promise((resolve) => {
        let req;
        try {
            req = indexedDB.open(DB_NAME, 1);
        } catch {
            resolve(null);
            return;
        }
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
            const db = req.result;
            try {
                const get = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(DB_KEY);
                get.onsuccess = () => { db.close(); resolve(get.result || null); };
                get.onerror = () => { db.close(); resolve(null); };
            } catch {
                db.close();
                resolve(null);
            }
        };
    });
}

function clearConfig() {
    return new Promise((resolve) => {
        let req;
        try {
            req = indexedDB.open(DB_NAME, 1);
        } catch {
            resolve();
            return;
        }
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onerror = () => resolve();
        req.onsuccess = () => {
            const db = req.result;
            try {
                const tx = db.transaction(DB_STORE, 'readwrite');
                tx.objectStore(DB_STORE).delete(DB_KEY);
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); resolve(); };
            } catch {
                db.close();
                resolve();
            }
        };
    });
}

/** What the server says knocked, or null when it could not be asked. */
async function whatKnocked(cfg) {
    if (!cfg || typeof cfg.api !== 'string' || typeof cfg.secret !== 'string' || typeof cfg.id !== 'number') {
        return null;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PENDING_TIMEOUT_MS);
    try {
        const res = await fetch(cfg.api.replace(/\/+$/, '') + '/push/web/pending', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: cfg.id, secret: cfg.secret }),
            credentials: 'omit',
            cache: 'no-store',
            signal: ctl.signal,
        });
        if (res.status === 410 || res.status === 404) {
            // The session that subscribed has ended (signed out, revoked) or
            // the subscription is gone: stop being addressable at all.
            await clearConfig();
            try {
                const sub = await self.registration.pushManager.getSubscription();
                if (sub) await sub.unsubscribe();
            } catch { /* nothing more to do */ }
            return null;
        }
        if (!res.ok) return null;
        const body = await res.json();
        return Array.isArray(body && body.items) ? body.items : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function cleanItems(items) {
    const out = [];
    for (const it of items || []) {
        if (!it || typeof it.title !== 'string' || typeof it.body !== 'string' || typeof it.tag !== 'string') continue;
        out.push({
            title: it.title.slice(0, 120),
            body: it.body.slice(0, 120),
            tag: it.tag.slice(0, 100),
            nav: validNav(it.nav),
        });
        if (out.length === MAX_ITEMS) break;
    }
    return out;
}

async function showForPush() {
    let items = [];
    try {
        items = cleanItems(await whatKnocked(await readConfig()));
    } catch {
        items = [];
    }
    if (items.length === 0) {
        await self.registration.showNotification(GENERIC_TITLE, {
            body: GENERIC_BODY,
            tag: GENERIC_TAG,
            icon: ICON,
            data: { nav: null },
        });
        return;
    }
    for (const it of items) {
        await self.registration.showNotification(it.title, {
            body: it.body,
            tag: it.tag,
            icon: ICON,
            data: { nav: it.nav },
        });
    }
}

self.addEventListener('push', (event) => {
    // event.data is the constant {"w":"1"} and is deliberately never read.
    event.waitUntil(
        showForPush().catch(() =>
            self.registration.showNotification(GENERIC_TITLE, { body: GENERIC_BODY, tag: GENERIC_TAG, icon: ICON }),
        ),
    );
});

async function openTarget(nav) {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const own = wins.filter((w) => {
        try {
            const u = new URL(w.url);
            return u.origin === self.location.origin && !u.pathname.startsWith('/notes/');
        } catch {
            return false;
        }
    });
    if (own.length > 0) {
        const win = own.find((w) => w.focused) || own[0];
        try { await win.focus(); } catch { /* the OS may refuse; the message still lands */ }
        if (nav) win.postMessage({ type: 'puca-nav', nav });
        return;
    }
    await self.clients.openWindow(nav ? '/?nav=' + encodeURIComponent(nav) : '/');
}

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const nav = validNav(event.notification.data && event.notification.data.nav);
    event.waitUntil(openTarget(nav));
});
