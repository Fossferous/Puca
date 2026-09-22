/**
 * Live verification of the REST DM send's fan-out (src/dm_handlers.rs
 * send_message), which "Send to Puca..." is the first caller of.
 *
 * Why it needs a live harness at all: the block under the INSERT is not a pure
 * function. It bumps dm_conversations.updated_at, fans a DirectMessage frame
 * out to the recipient's sessions, parks it when nobody is home, wakes the
 * phone, and echoes to the sender's OTHER sessions. "It compiles and it mirrors
 * the socket path" is not evidence that any of that reaches anyone: a
 * send_to_user resolving to the wrong session set, an enqueue that never fires
 * or a dropped frame all ship silently, and the symptom is exactly what the
 * change exists to prevent -- a "Sent" toast for a message the other person's
 * open conversation never renders.
 *
 * To trust it, REVERT the block at src/dm_handlers.rs (everything from
 * `let timestamp = ...` down to the sender echo), rebuild, and re-run: the
 * fan-out, echo, park and updated_at stages must all go RED while the WS
 * control stage stays green. That control is the point -- it proves this
 * harness can see a DirectMessage frame at all, so a red REST stage means the
 * REST path is broken rather than the observer.
 *
 * NOT covered, and not claimed: the FCM wake. `wake_user_kind` returns
 * immediately unless the server has wake credentials configured
 * (state.wake.enabled()), so on a throwaway backend it has no observable
 * effect. What IS covered is the branch it shares with the park -- if the
 * frame parks, the code reached the wake call.
 *
 * SRP-6a, apiFetch and the tiny WS client below are the same helpers
 * e2ee-live-verify.mjs and checklist-selfdm-verify.mjs carry.
 *
 * Run:  API=http://127.0.0.1:3309 PGDB=puca_walk node e2e/notes-send-verify.mjs
 *
 * NEVER run against the real dev/prod DB -- point PGDB at a throwaway database.
 */
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';

const API = process.env.API || 'http://127.0.0.1:8181';
const PSQL = process.env.PSQL || 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
const PGDB = process.env.PGDB || 'puca_apptest';
const PGPORT = process.env.PGPORT || '5432';
const PGUSER = process.env.PGUSER || 'postgres';
const PGPASS = process.env.PGPASS || 'postgres';

const results = [];
function check(stage, ok, detail) {
    results.push({ stage, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}${detail ? '  -- ' + detail : ''}`);
}
function section(name) { console.log(`\n=== ${name} ===`); }

function sql(query) {
    const env = { ...process.env, PGPASSWORD: PGPASS };
    return execFileSync(PSQL, ['-U', PGUSER, '-h', '127.0.0.1', '-p', String(PGPORT), '-d', PGDB, '-t', '-A', '-c', query], { env }).toString().trim();
}

// ---------- SRP-6a (faithful to auth.ts / rust srp crate) ----------
const enc = new TextEncoder();
const toB64 = (b) => Buffer.from(b).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const toHex = (b) => Buffer.from(b).toString('hex');
const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));

import { webcrypto, randomFillSync } from 'node:crypto';
const crypto = webcrypto;
function randBytes(n) { const b = new Uint8Array(n); randomFillSync(b); return b; }

const N_HEX = ('AC6BDB41 324A9A9B F166DE5E 1389582F AF72B665 1987EE07 FC319294 3DB56050 A37329CB B4A099ED 8193E075 7767A13D D52312AB 4B03310D CD7F48A9 DA04FD50 E8083969 EDB767B0 CF609517 9A163AB3 661A05FB D5FAAAE8 2918A996 2F0B93B8 55F97993 EC975EEA A80D740A DBF4FF74 7359D041 D5C33EA7 1D281E44 6B14773B CA97B43A 23FB8016 76BD207A 436C6481 F1D2B907 8717461A 5B9D32E6 88F87748 544523B5 24B0D57D 5EA77A27 75D2ECFA 032CFBDB F52FB378 61602790 04E57AE6 AF874E73 03CE5329 9CCC041C 7BC308D8 2A5698F3 A8D0C382 71AE35F8 E9DBFBB6 94B5C803 D89F7AE4 35DE236D 525F5475 9B65E372 FCD68EF2 0FA7111F 9E4AFF73').replace(/\s/g, '');
const N = BigInt('0x' + N_HEX);
const g = 2n;
const N_BYTES = 256;
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
const toBytesBE = (n, len) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; let b = fromHex(h); if (len) { const p = new Uint8Array(len); p.set(b, len - b.length); b = p; } return b; };
const bytesToBig = (b) => BigInt('0x' + (toHex(b) || '0'));
const minimalBytes = (n) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; return fromHex(h); };
const padHex = (n, len) => { let h = n.toString(16); return '0'.repeat(Math.max(0, len * 2 - h.length)) + h; };
async function shaBytes(...parts) { const tot = parts.reduce((a, p) => a + p.length, 0); const buf = new Uint8Array(tot); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; } return new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); }
async function computeIdentityHash(username, password) { return await shaBytes(enc.encode(`${username.toLowerCase()}:${password}`)); }
async function computeX(salt, idHash) { return bytesToBig(await shaBytes(salt, idHash)); }
const computeVerifier = (x) => modpow(g, x, N);
async function computeK() { return bytesToBig(await shaBytes(toBytesBE(N, N_BYTES), toBytesBE(g, N_BYTES))); }
async function computeU(A, B) { return bytesToBig(await shaBytes(minimalBytes(A), minimalBytes(B))); }

async function apiFetch(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
}

async function registerUser(username, password) {
    const salt = randBytes(32);
    const idHash = await computeIdentityHash(username, password);
    const x = await computeX(salt, idHash);
    const v = computeVerifier(x);
    await apiFetch('POST', '/auth/register', {
        username, salt_hex: toHex(salt), verifier_hex: padHex(v, N_BYTES),
        public_key: 'x25519:' + toB64(randBytes(32)),
    });
    return { username, password };
}

async function loginUser(username, password) {
    const a = bytesToBig(randBytes(32));
    const A = modpow(g, a, N);
    const s1 = await apiFetch('POST', '/auth/login/step1', { username, a_pub_hex: padHex(A, N_BYTES) });
    const salt = fromHex(s1.salt_hex); const B = BigInt('0x' + s1.b_pub_hex);
    const u = await computeU(A, B);
    const k = await computeK();
    const idHash = await computeIdentityHash(username, password);
    const x = await computeX(salt, idHash);
    const gx = modpow(g, x, N);
    let base = (B - (k * gx) % N) % N; if (base < 0n) base += N;
    const S = modpow(base, a + u * x, N);
    const K = minimalBytes(S);
    const M1 = await shaBytes(minimalBytes(A), minimalBytes(B), K);
    const s2 = await apiFetch('POST', '/auth/login/step2', { username, m_hex: toHex(M1) });
    return { token: s2.token };
}

// ---------- tiny WS client ----------
function connectWs(token) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${API.replace('http', 'ws')}/ws`, ['bearer', token]);
        const timer = setTimeout(() => reject(new Error('ws connect timeout')), 5000);
        ws.on('open', () => { clearTimeout(timer); resolve(ws); });
        ws.on('error', reject);
    });
}
function send(ws, type, payload) { ws.send(JSON.stringify({ type, payload })); }
function waitForMessage(ws, type, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => { ws.off('message', onMsg); resolve(null); }, timeoutMs);
        function onMsg(data) {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === type) { clearTimeout(timer); ws.off('message', onMsg); resolve(msg); }
            } catch { /* ignore */ }
        }
        ws.on('message', onMsg);
    });
}

/** A DELIVERY socket (?mode=delivery): the only kind the server hands parked
 *  frames to on connect (ws.rs -- replaying into a visible client would
 *  double-render an open chat). */
function connectDeliveryWs(token) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${API.replace('http', 'ws')}/ws?mode=delivery`, ['bearer', token]);
        const timer = setTimeout(() => reject(new Error('ws connect timeout')), 5000);
        ws.on('open', () => { clearTimeout(timer); resolve(ws); });
        ws.on('error', reject);
    });
}

/** Collect every frame of a type for a while, so "exactly one" can be asserted
 *  as well as "at least one" -- the self-DM case turns on the difference. */
function collect(ws, type) {
    const got = [];
    const onMsg = (data) => {
        try { const m = JSON.parse(data.toString()); if (m.type === type) got.push(m); } catch { /* ignore */ }
    };
    ws.on('message', onMsg);
    return { got, stop: () => ws.off('message', onMsg) };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
async function main() {
    console.log(`REST DM fan-out live verification against ${API}  (db=${PGDB})`);
    const RUN = 'run' + Date.now();

    section('Setup: register + login 2 users via real SRP');
    const A = await registerUser(`ann_${RUN}`, 'passwordAnn1!');
    const B = await registerUser(`ben_${RUN}`, 'passwordBen1!');
    A.token = (await loginUser(A.username, A.password)).token;
    B.token = (await loginUser(B.username, B.password)).token;
    A.id = (await apiFetch('GET', '/profile', null, A.token)).id;
    B.id = (await apiFetch('GET', '/profile', null, B.token)).id;
    check('setup/register+login (2 users)', !!(A.token && B.token && A.id && B.id), `ids A=${A.id} B=${B.id}`);
    // DMs default to friends-and-shared-servers only, so put them in one
    // server together first (the same setup checklist-selfdm-verify.mjs uses).
    const srv = await apiFetch('POST', '/servers', { name: `srv_${RUN}` }, A.token);
    const inv = await apiFetch('POST', `/servers/${srv.id}/invites`, { max_uses: 5, expires_in_hours: 1 }, A.token);
    await apiFetch('POST', `/invites/${inv.code}/join`, {}, B.token);
    const conv = await apiFetch('POST', '/dms', { user_id: B.id }, A.token);
    check('setup/a conversation exists between them', !!conv?.id, JSON.stringify(conv));

    // ---- CONTROL: the socket path delivers, so this harness can see frames.
    section('Control: the WebSocket send path still delivers a DirectMessage');
    {
        const wsA = await connectWs(A.token);
        const wsB = await connectWs(B.token);
        await sleep(300);
        const waiter = waitForMessage(wsB, 'DirectMessage');
        send(wsA, 'DirectMessage', { to_user_id: B.id, content: 'enc:control-over-the-socket' });
        const frame = await waiter;
        check('control/B receives a DirectMessage sent over the socket',
            frame?.payload?.content === 'enc:control-over-the-socket', JSON.stringify(frame).slice(0, 200));
        wsA.close(); wsB.close();
        await sleep(200);
    }

    // ---- The thing under test: a REST send reaches an open recipient.
    section('REST send: the recipient with a socket open gets the frame');
    let restMessageId = null;
    {
        const wsB = await connectWs(B.token);
        await sleep(300);
        const waiter = waitForMessage(wsB, 'DirectMessage');
        const before = sql(`SELECT updated_at FROM dm_conversations WHERE id = '${conv.id}';`);
        await sleep(1100);  // make the NOW() bump visible at second resolution
        const posted = await apiFetch('POST', `/dms/${conv.id}/messages`, { content: 'enc:over-rest' }, A.token);
        restMessageId = posted?.id ?? null;
        const frame = await waiter;
        check('rest/B receives a DirectMessage for a message sent over REST',
            frame?.payload?.content === 'enc:over-rest', JSON.stringify(frame).slice(0, 220));
        check('rest/the frame names the row the server stored',
            !!restMessageId && frame?.payload?.message_id === restMessageId,
            `frame=${frame?.payload?.message_id} stored=${restMessageId}`);
        check('rest/the frame names the conversation and the sender',
            frame?.payload?.conversation_id === conv.id && frame?.payload?.sender?.id === A.id,
            `conv=${frame?.payload?.conversation_id} sender=${JSON.stringify(frame?.payload?.sender)}`);
        const after = sql(`SELECT updated_at FROM dm_conversations WHERE id = '${conv.id}';`);
        check('rest/the conversation moved to the top of their list (updated_at bumped)',
            !!before && !!after && after !== before, `${before} -> ${after}`);
        wsB.close();
        await sleep(200);
    }

    // ---- The sender's OTHER sessions see it too.
    section('REST send: the sender other sessions get the echo');
    {
        const wsA2 = await connectWs(A.token);
        await sleep(300);
        const waiter = waitForMessage(wsA2, 'DirectMessage');
        await apiFetch('POST', `/dms/${conv.id}/messages`, { content: 'enc:echo-to-my-other-tab' }, A.token);
        const frame = await waiter;
        check('echo/A other session renders the message A sent from Notes',
            frame?.payload?.content === 'enc:echo-to-my-other-tab', JSON.stringify(frame).slice(0, 200));
        wsA2.close();
        await sleep(200);
    }

    // ---- Nobody home: the frame parks and is handed over on reconnect.
    section('REST send: with nobody home the frame parks for the delivery socket');
    {
        // B has no socket at all here.
        await apiFetch('POST', `/dms/${conv.id}/messages`, { content: 'enc:parked-while-away' }, A.token);
        await sleep(300);
        const wsB = await connectDeliveryWs(B.token);
        const c = collect(wsB, 'DirectMessage');
        await sleep(1500);
        c.stop();
        check('park/the parked frame is handed to B delivery socket on connect',
            c.got.some(m => m.payload?.content === 'enc:parked-while-away'),
            `frames=${c.got.length}: ${c.got.map(m => m.payload?.content).join(', ')}`);
        wsB.close();
        await sleep(200);
    }

    // ---- A note to yourself: ONE frame, and nothing parked for you.
    section('REST send: a note to yourself is delivered once, not twice');
    {
        const selfConv = await apiFetch('POST', '/dms', { user_id: A.id }, A.token);
        const wsA = await connectWs(A.token);
        await sleep(300);
        const c = collect(wsA, 'DirectMessage');
        await apiFetch('POST', `/dms/${selfConv.id}/messages`, { content: 'enc:note-to-self-once' }, A.token);
        await sleep(1500);
        c.stop();
        const mine = c.got.filter(m => m.payload?.content === 'enc:note-to-self-once');
        check('self/exactly one frame for a message you sent to yourself', mine.length === 1,
            `frames=${mine.length}`);
        wsA.close();
        await sleep(200);
        // ...and none of it was parked: a delivery socket opening now must find
        // nothing waiting for that message.
        const wsA2 = await connectDeliveryWs(A.token);
        const c2 = collect(wsA2, 'DirectMessage');
        await sleep(1200);
        c2.stop();
        check('self/nothing was parked-and-woken for your own message',
            !c2.got.some(m => m.payload?.content === 'enc:note-to-self-once'),
            `frames=${c2.got.length}`);
        wsA2.close();
        await sleep(200);
    }

    // ---- The HTTP contract did not change.
    section('Regression: the route still answers as it always did');
    {
        const msgs = await apiFetch('GET', `/dms/${conv.id}/messages`, null, B.token);
        check('regression/every REST-sent message is stored and readable',
            ['enc:over-rest', 'enc:echo-to-my-other-tab', 'enc:parked-while-away'].every(c => msgs.some(m => m.content === c)),
            `count=${msgs.length}`);
        let refused = null;
        try { await apiFetch('POST', `/dms/${conv.id}/messages`, { content: '' }, A.token); }
        catch (e) { refused = String(e.message); }
        check('regression/an empty message is still refused with 400', /400/.test(refused || ''), refused);
        let tooLong = null;
        try { await apiFetch('POST', `/dms/${conv.id}/messages`, { content: 'x'.repeat(8001) }, A.token); }
        catch (e) { tooLong = String(e.message); }
        check('regression/over 8000 bytes is still refused with 413', /413/.test(tooLong || ''), tooLong);
    }

    section('Summary');
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) {
        console.log('FAILED:');
        for (const f of failed) console.log(`  - ${f.stage} (${f.detail || ''})`);
        process.exit(1);
    }
    process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
