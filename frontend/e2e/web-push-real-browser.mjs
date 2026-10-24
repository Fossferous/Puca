// The web app's push worker (public/sw.js) in a REAL browser, woken by a REAL
// Web Push message from a local stand-in push service.
//
// WHY THIS EXISTS. vitest runs sw.js against a fake worker scope; only a real
// browser can say that the file registers at scope "/" beside Púca Notes'
// own worker without either taking the other's pages, that a push event
// really wakes it, that it really reaches the user's server cross-origin
// (CORS and all), and that showNotification really produces a notification
// the browser holds. Nothing here touches an outside network: Chromium's own
// push service is Google's, so the stand-in plays that part — it receives
// the wake exactly as the server sends it (RFC 8291 aes128gcm, the server's
// headers), DECRYPTS it with the subscription's private key, refuses anything
// but the constant {"w":"1"}, and hands the plaintext to the browser through
// the DevTools protocol (ServiceWorker.deliverPushMessage), which is the step
// a real browser's push client performs.
//
// The sealing here is a JS port of src/wake/webpush.rs; this script first
// proves its decryption is the standard one on RFC 8291 Appendix A, the
// vector the Rust test pins byte for byte. The Rust sender's own wire test is
// `a_wake_reaches_the_push_service_as_the_protocol_requires`.
//
// Checks, each with a control:
//  - sw.js registers at "/" and Notes' worker at "/notes/": a /notes/ page is
//    controlled by Notes' worker, a "/" page by the push worker;
//  - a wake shows what the user's own server said knocked ("alice sent you a
//    message" / "New message", tag and tap target), having asked it with the
//    subscription's secret, cross-origin;
//  - the API down, or no config: the generic "New activity in Púca" (iOS
//    revokes a subscription whose pushes show nothing);
//  - a 410 from the API forgets the secret;
//  - CONTROL: the same push delivered to Notes' worker shows nothing — the
//    notifications above came from sw.js, not from the rig;
//  - the stand-in refuses a body that is not the constant.
//
// SILENT and headless: notifications are not audible in headless Chromium,
// and nothing here plays media.
//
//   cd frontend && node e2e/web-push-real-browser.mjs
//
// No server and no build needed.
import { chromium } from '@playwright/test';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderNotesServiceWorker } from '../scripts/notes-sw.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SW_SRC = fs.readFileSync(join(here, '..', 'public', 'sw.js'), 'utf8');

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};

// ---- RFC 8291 (aes128gcm), both halves ------------------------------------

const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

function derive(shared, auth, uaPublic, asPublic, salt) {
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, keyInfo, 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    return { cek, nonce };
}

/** The server's seal (src/wake/webpush.rs `seal_wake`), for a subscription. */
function seal(plaintext, uaPublic, auth) {
    const as = crypto.createECDH('prime256v1');
    as.generateKeys();
    const asPublic = as.getPublicKey();
    const salt = crypto.randomBytes(16);
    const { cek, nonce } = derive(as.computeSecret(uaPublic), auth, uaPublic, asPublic, salt);
    const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const sealed = Buffer.concat([c.update(Buffer.concat([plaintext, Buffer.from([2])])), c.final(), c.getAuthTag()]);
    const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
    return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, sealed]);
}

/** The receiving browser's half — what the stand-in push client does. */
function open(body, ua, auth) {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen);
    const sealed = body.subarray(21 + idlen);
    const { cek, nonce } = derive(ua.computeSecret(asPublic), auth, ua.getPublicKey(), asPublic, salt);
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    const rec = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
    if (rec[rec.length - 1] !== 2) throw new Error('not a single last record');
    return rec.subarray(0, rec.length - 1);
}

{
    // RFC 8291 Appendix A: the stand-in decrypts the standard, not merely itself.
    const ua = crypto.createECDH('prime256v1');
    ua.setPrivateKey(fromB64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'));
    const body = fromB64u('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
    const pt = open(body, ua, fromB64u('BTBZMqHH6r4Tts7J_aSIgg')).toString();
    ck(pt === 'When I grow up, I want to be a watermelon', 'the stand-in push client opens RFC 8291 Appendix A');
}

// ---- servers ---------------------------------------------------------------

function listen(handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(handler);
        srv.listen(0, '127.0.0.1', () => resolve({ srv, origin: `http://127.0.0.1:${srv.address().port}` }));
    });
}

const PAGE = '<!doctype html><meta charset="utf-8"><title>push rig</title><body>rig</body>';
const app = await listen((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(SW_SRC);
    }
    if (path === '/notes/sw.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(renderNotesServiceWorker('push-rig', []));
    }
    if (path === '/' || path === '/notes/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
    }
    res.writeHead(404); res.end();
});

// The user's own server, on ANOTHER origin, as in production.
const apiState = { mode: 'ok', seen: [] };
const api = await listen((req, res) => {
    const cors = {
        'Access-Control-Allow-Origin': app.origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        if (req.method !== 'POST' || req.url !== '/push/web/pending') { res.writeHead(404, cors); return res.end(); }
        apiState.seen.push({ body, cookie: req.headers.cookie ?? null });
        if (apiState.mode === 'down') { res.writeHead(503, cors); return res.end('down'); }
        if (apiState.mode === 'gone') { res.writeHead(410, cors); return res.end('gone'); }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            items: [{ tag: 'dm:conv-1', title: 'alice sent you a message', body: 'New message', nav: 'dm:conv-1' }],
        }));
    });
});

// ---- the browser -----------------------------------------------------------

// FULL Chromium in headless mode, not Playwright's default headless shell:
// the shell answers every notification permission "denied" (measured: its
// showNotification throws), so a run on it could only ever fail. Headless all
// the same — no window, no focus taken — and NativeNotifications is switched
// off so a notification can never be handed to the operating system's own
// toasts (measured on Windows: with it on, headless Chromium wrote nothing to
// the notification centre either; this pins it).
const CHANNEL = process.env.CHANNEL || 'chromium';
const browser = await chromium.launch({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--mute-audio', '--disable-features=NativeNotifications,SystemNotifications'],
});
const context = await browser.newContext();
await context.grantPermissions(['notifications'], { origin: app.origin });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
let registrations = [];
cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
    for (const r of e.registrations) {
        registrations = registrations.filter((x) => x.registrationId !== r.registrationId);
        if (!r.isDeleted) registrations.push(r);
    }
});
await cdp.send('ServiceWorker.enable');

await page.goto(app.origin + '/');
const scopes = await page.evaluate(async () => {
    const push = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const notes = await navigator.serviceWorker.register('/notes/sw.js', { scope: '/notes/' });
    const wait = (r) => new Promise((resolve) => {
        const w = r.installing || r.waiting || r.active;
        if (w.state === 'activated') return resolve();
        w.addEventListener('statechange', () => { if (w.state === 'activated') resolve(); });
    });
    await Promise.all([wait(push), wait(notes)]);
    return { push: push.scope, notes: notes.scope, pushScript: push.active.scriptURL };
});
ck(scopes.push === app.origin + '/' && scopes.pushScript === app.origin + '/sw.js', 'sw.js registers at scope "/"', JSON.stringify(scopes));
ck(scopes.notes === app.origin + '/notes/', 'Notes’ worker keeps scope "/notes/" beside it');

// Which worker controls which page.
const notesPage = await context.newPage();
await notesPage.goto(app.origin + '/notes/');
await notesPage.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
const notesController = await notesPage.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
ck(notesController === app.origin + '/notes/sw.js', 'a /notes/ page stays with Notes’ worker', String(notesController));
await page.reload();
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
const appController = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null);
ck(appController === app.origin + '/sw.js', 'a "/" page is the push worker’s', String(appController));

// ---- the stand-in push service ---------------------------------------------

// The browser's subscription keys: only the stand-in (playing the browser's
// push client) holds the private half, as only a browser would.
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const subAuth = crypto.randomBytes(16);
const pushState = { delivered: 0, refused: 0, headers: null, target: 'push' };

const regId = (scope) => registrations.find((r) => r.scopeURL === scope)?.registrationId;
const pushService = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
        pushState.headers = req.headers;
        let plaintext;
        try {
            if (req.headers['content-encoding'] !== 'aes128gcm') throw new Error('not aes128gcm');
            plaintext = open(Buffer.concat(chunks), ua, subAuth).toString();
        } catch {
            pushState.refused++; res.writeHead(400); return res.end();
        }
        if (plaintext !== '{"w":"1"}') { pushState.refused++; res.writeHead(400); return res.end(); }
        const scope = pushState.target === 'notes' ? app.origin + '/notes/' : app.origin + '/';
        await cdp.send('ServiceWorker.deliverPushMessage', { origin: app.origin, registrationId: regId(scope), data: plaintext });
        pushState.delivered++;
        res.writeHead(201); res.end();
    });
});

/** What the server does: seal THE constant and POST it with its headers. */
async function wake(plaintext = Buffer.from('{"w":"1"}')) {
    const res = await fetch(pushService.origin + '/push/sub-1', {
        method: 'POST',
        headers: {
            TTL: '3600', Urgency: 'high', Topic: 'pucawake',
            'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
            Authorization: 'vapid t=stand-in, k=stand-in',
        },
        body: seal(plaintext, ua.getPublicKey(), subAuth),
    });
    return res.status;
}

const shown = () => page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration('/');
    return (await r.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, nav: n.data?.nav ?? null }));
});
const closeAll = () => page.evaluate(async () => {
    for (const s of ['/', '/notes/']) {
        const r = await navigator.serviceWorker.getRegistration(s);
        for (const n of await r.getNotifications()) n.close();
    }
});
async function waitShown(n) {
    for (let i = 0; i < 50; i++) {
        const s = await shown();
        if (s.length >= n) return s;
        await new Promise((r) => setTimeout(r, 100));
    }
    return shown();
}
const writeConfig = (cfg) => page.evaluate((cfg) => new Promise((resolve, reject) => {
    const req = indexedDB.open('puca-push', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cfg');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
        const tx = req.result.transaction('cfg', 'readwrite');
        if (cfg) tx.objectStore('cfg').put(cfg, 'subscription'); else tx.objectStore('cfg').delete('subscription');
        tx.oncomplete = () => { req.result.close(); resolve(); };
    };
}), cfg);
const readConfig = () => page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('puca-push', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cfg');
    req.onsuccess = () => {
        const get = req.result.transaction('cfg').objectStore('cfg').get('subscription');
        get.onsuccess = () => { req.result.close(); resolve(get.result ?? null); };
    };
}));

const CFG = { api: api.origin, id: 42, secret: 'rig-secret', endpoint: pushService.origin + '/push/sub-1', key: 'K' };

// 1. The real path.
await writeConfig(CFG);
apiState.mode = 'ok';
ck((await wake()) === 201, 'the stand-in push service accepts the sealed constant');
ck(pushState.headers?.ttl === '3600' && pushState.headers?.topic === 'pucawake', 'with the server’s headers');
let got = await waitShown(1);
ck(got.length === 1 && got[0].title === 'alice sent you a message' && got[0].body === 'New message', 'a wake shows who, from the user’s own server', JSON.stringify(got));
ck(got[0]?.tag === 'dm:conv-1' && got[0]?.nav === 'dm:conv-1', 'with its conversation as tag and tap target');
const asked = apiState.seen.at(-1);
ck(asked && JSON.parse(asked.body).secret === 'rig-secret' && JSON.parse(asked.body).id === 42, 'having asked with the subscription’s secret, cross-origin');
ck(asked && asked.cookie === null, 'and no cookies');
await closeAll();

// 2. The server down: generic, never silent.
apiState.mode = 'down';
await wake();
got = await waitShown(1);
ck(got.length === 1 && got[0].title === 'Púca' &&got[0].body === 'New activity in Púca', 'the API down still shows "New activity in Púca"', JSON.stringify(got));
await closeAll();

// 3. No config at all: generic, and nobody asked.
await writeConfig(null);
const before = apiState.seen.length;
await wake();
got = await waitShown(1);
ck(got.length === 1 && got[0].body === 'New activity in Púca', 'no config shows the generic notification');
ck(apiState.seen.length === before, 'and asks nobody');
await closeAll();

// 4. 410: the session ended — the secret is forgotten.
await writeConfig(CFG);
apiState.mode = 'gone';
await wake();
got = await waitShown(1);
ck(got.length === 1 && got[0].body === 'New activity in Púca', 'a 410 still shows something');
ck((await readConfig()) === null, 'and forgets the secret');
await closeAll();

// 5. CONTROL: the same wake delivered to Notes' worker (no push listener)
// shows nothing — the notifications above are sw.js's own.
await writeConfig(CFG);
apiState.mode = 'ok';
pushState.target = 'notes';
await wake();
await new Promise((r) => setTimeout(r, 1500));
const notesShown = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration('/notes/');
    return (await r.getNotifications()).length;
});
ck(notesShown === 0 && (await shown()).length === 0, 'CONTROL: a push to a worker without sw.js’s listener shows nothing');
pushState.target = 'push';

// 6. The stand-in refuses anything but the constant: it is checking.
const refusedBefore = pushState.refused;
ck((await wake(Buffer.from('{"from":"alice"}'))) === 400 && pushState.refused === refusedBefore + 1, 'CONTROL: a payload that is not the constant is refused, never delivered');

await browser.close();
for (const s of [app, api, pushService]) s.srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
