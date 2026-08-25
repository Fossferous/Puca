/**
 * Device-control SESSION routing, against a real backend.
 *
 * Two attested connections of ONE account (PC + phone), plus a third as the
 * intruder. Modelled on p2p-self-transfer.mjs, which solved the same
 * "route between two devices of the same user" problem for file transfer.
 *
 * The property this exists for: `DeviceSession::opposite_conn` returns None for
 * any socket that is not one of the session's two, and that None means REFUSE —
 * unlike FileTransfer::opposite_conn, whose None means "fall back to routing by
 * user id". A third device of the same account must not be able to signal or
 * inject into a session it is not part of. Since the failure mode is a SILENT
 * DROP, every check here asserts on what the peer actually RECEIVED, never on
 * the absence of an error.
 *
 * Needs a backend against a THROWAWAY database:
 *   API=http://127.0.0.1:3001 JWT_SECRET=… DATABASE_URL=…/puca_e2e_devices \
 *   node e2e/device-session-2conn.mjs
 */
import { webcrypto, createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ed25519, x25519 } from '../node_modules/@noble/curves/ed25519.js';
import { sha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hkdf } from '../node_modules/@noble/hashes/hkdf.js';

const crypto = webcrypto;
const API = process.env.API || 'http://127.0.0.1:3001';
const WS_URL = API.replace(/^http/, 'ws') + '/ws';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL;
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';

const results = [];
const check = (stage, ok, detail) => {
    results.push({ stage, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder();
const b64 = (b) => Buffer.from(b).toString('base64');
const b64url = (b) => Buffer.from(b).toString('base64url');

function canonicalJson(value) {
    const e = (v) => {
        if (v === null) return 'null';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'number') return JSON.stringify(v);
        if (typeof v === 'string') return JSON.stringify(v);
        if (Array.isArray(v)) return '[' + v.map(e).join(',') + ']';
        if (typeof v === 'object') {
            const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
            return '{' + keys.map(k => JSON.stringify(k) + ':' + e(v[k])).join(',') + '}';
        }
        throw new Error('unsupported');
    };
    return e(value);
}

const deviceId = (dp, sp) => b64url(sha256(Buffer.concat([
    Buffer.from(enc.encode('sovereign-device-v1')),
    Buffer.from(enc.encode(dp)),
    Buffer.from(enc.encode(sp)),
]))).slice(0, 21);

function mintJwt(userId, username) {
    const h = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const now = Math.floor(Date.now() / 1000);
    const p = b64url(Buffer.from(JSON.stringify({
        sub: userId, username, exp: now + 3600, tv: 0, sst: now,
    })));
    return `${h}.${p}.${createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
}

function newDevice() {
    const m = crypto.getRandomValues(new Uint8Array(64));
    const edSeed = m.slice(32);
    const device_pub = 'x25519:' + b64(x25519.getPublicKey(m.slice(0, 32)));
    const sign_pub = 'ed25519:' + b64(ed25519.getPublicKey(edSeed));
    return { edSeed, device_pub, sign_pub, id: deviceId(device_pub, sign_pub) };
}

async function api(path, opts, token) {
    const res = await fetch(API + path, {
        ...opts,
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            ...(opts?.headers || {}),
        },
    });
    const t = await res.text();
    let body; try { body = t ? JSON.parse(t) : null; } catch { body = t; }
    return { status: res.status, body };
}

function openSocket(token) {
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    const received = [];
    ws.addEventListener('message', ev => {
        try { received.push(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
    return {
        ws, received,
        open: () => new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', rej, { once: true });
        }),
        send: m => ws.send(JSON.stringify(m)),
        waitFor: async (type, ms = 2500) => {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                const hit = received.find(m => m.type === type);
                if (hit) return hit;
                await sleep(40);
            }
            return null;
        },
        /** Everything of this type received so far — for "did NOT arrive" checks. */
        all: type => received.filter(m => m.type === type),
    };
}

async function attest(sock, dev, userId) {
    const ch = await sock.waitFor('DeviceChallenge');
    if (!ch) return false;
    sock.send({
        type: 'DeviceAttest',
        payload: {
            device_id: dev.id,
            sig: b64(ed25519.sign(
                enc.encode(`sovereign-device-attest-v1|${ch.payload.nonce}|${userId}`), dev.edSeed)),
        },
    });
    return !!(await sock.waitFor('DeviceAttested'));
}

async function enrol(dev, name, userId, signSeed, token) {
    const rec = canonicalJson({
        typ: 'sovereign-device-auth-v1', v: 1, did: dev.id,
        dpub: dev.device_pub, spub: dev.sign_pub, name, plat: 'linux',
        uid: userId, ts: Math.floor(Date.now() / 1000),
    });
    return api('/devices', {
        method: 'POST',
        body: JSON.stringify({
            device_pub: dev.device_pub, sign_pub: dev.sign_pub, name, platform: 'linux',
            auth_record: rec, auth_sig: b64(ed25519.sign(enc.encode(rec), signSeed)),
        }),
    }, token);
}

async function main() {
    if (!DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(2); }
    if (/\/puca(\?|$)/.test(DATABASE_URL)) {
        console.error('Refusing to run against the dev database "puca".');
        process.exit(2);
    }
    const u = new URL(DATABASE_URL);
    const sql = (q) => execFileSync(PSQL, [
        '-U', decodeURIComponent(u.username), '-h', u.hostname, '-p', u.port || '5432',
        '-d', u.pathname.slice(1), '-t', '-A', '-q', '-c', q,
    ], { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }, encoding: 'utf8' }).trim();

    const username = 'sess_' + randomUUID().slice(0, 8);
    const userId = Number(sql(
        `INSERT INTO users (username, salt, verifier) VALUES ('${username}','\\x00','\\x00') RETURNING id`));
    const token = mintJwt(userId, username);
    const signSeed = hkdf(sha256, crypto.getRandomValues(new Uint8Array(32)), undefined,
        enc.encode('sovereign-account-sign-v1'), 32);

    const hostDev = newDevice();
    const ctlDev = newDevice();
    const thirdDev = newDevice();
    for (const [d, n] of [[hostDev, 'Host PC'], [ctlDev, 'Controller'], [thirdDev, 'Third']]) {
        const r = await enrol(d, n, userId, signSeed, token);
        if (r.status !== 200) { console.error('enrol failed', r); process.exit(1); }
    }
    check('setup: three devices enrolled', true, `uid=${userId}`);

    const host = openSocket(token); await host.open();
    const ctl = openSocket(token); await ctl.open();
    const third = openSocket(token); await third.open();
    check('all three connections attest',
        (await attest(host, hostDev, userId)) &&
        (await attest(ctl, ctlDev, userId)) &&
        (await attest(third, thirdDev, userId)));

    // --- handshake ---
    const sessionId = 'sess' + randomUUID().replace(/-/g, '').slice(0, 16);
    ctl.send({
        type: 'DeviceConnect',
        payload: { host_device: hostDev.id, session_id: sessionId, eph: 'x25519:AAA', proof: 'PROOF' },
    });
    const req = await host.waitFor('DeviceConnectRequested');
    check('host receives the connect request', req?.payload?.session_id === sessionId,
        `from_device=${req?.payload?.from_device}`);
    check('...and it names the CONTROLLER device, not the account',
        req?.payload?.from_device === ctlDev.id);
    check('the third device is NOT told about the session',
        third.all('DeviceConnectRequested').length === 0);

    host.send({
        type: 'DeviceConnectResponse',
        payload: { session_id: sessionId, accepted: true, eph: 'x25519:BBB', cap_w: 1920, cap_h: 1080 },
    });
    const ans = await ctl.waitFor('DeviceConnectAnswered');
    check('controller receives the acceptance', ans?.payload?.accepted === true,
        `cap=${ans?.payload?.cap_w}x${ans?.payload?.cap_h}`);

    // --- signalling + input ---
    ctl.send({ type: 'DeviceSignal', payload: { session_id: sessionId, payload: 'SDP-OFFER' } });
    const sig = await host.waitFor('DeviceSignalled');
    check('signalling reaches the host', sig?.payload?.payload === 'SDP-OFFER');

    host.send({ type: 'DeviceSignal', payload: { session_id: sessionId, payload: 'SDP-ANSWER' } });
    const sigBack = await ctl.waitFor('DeviceSignalled');
    check('signalling reaches the controller (bidirectional)',
        sigBack?.payload?.payload === 'SDP-ANSWER');

    ctl.send({ type: 'DeviceInput', payload: { session_id: sessionId, event: 'SEALED-NOOP' } });
    const inp = await host.waitFor('DeviceInputted');
    check('a sealed input event round-trips to the host',
        inp?.payload?.event === 'SEALED-NOOP');

    // --- THE LOAD-BEARING CHECKS ---
    third.send({ type: 'DeviceInput', payload: { session_id: sessionId, event: 'INTRUDER' } });
    third.send({ type: 'DeviceSignal', payload: { session_id: sessionId, payload: 'INTRUDER-SDP' } });
    await sleep(700);
    check('a THIRD device of the same account cannot inject',
        !host.all('DeviceInputted').some(m => m.payload?.event === 'INTRUDER'),
        'host never saw the intruder event');
    check('a THIRD device of the same account cannot signal',
        !host.all('DeviceSignalled').some(m => m.payload?.payload === 'INTRUDER-SDP'),
        'host never saw the intruder signal');

    // Input is one-way: a compromised host must not be able to drive its own
    // controller — the exact inversion this feature must never permit.
    host.send({ type: 'DeviceInput', payload: { session_id: sessionId, event: 'REVERSE' } });
    await sleep(500);
    check('the HOST cannot send input back to the controller',
        ctl.all('DeviceInputted').length === 0);

    // A stranger must not be able to kill a session by naming its id.
    third.send({ type: 'DeviceEnd', payload: { session_id: sessionId, reason: 'nope' } });
    await sleep(500);
    check('a THIRD device cannot end the session',
        ctl.all('DeviceEnded').length === 0 && host.all('DeviceEnded').length === 0);

    // ...but a real participant can.
    ctl.send({ type: 'DeviceEnd', payload: { session_id: sessionId, reason: 'done' } });
    const ended = await host.waitFor('DeviceEnded');
    check('a participant CAN end it, and the peer is told', ended?.payload?.reason === 'done');

    // After the end, the session is gone — input must no longer route.
    ctl.send({ type: 'DeviceInput', payload: { session_id: sessionId, event: 'AFTER-END' } });
    await sleep(500);
    check('input after the session ended does not route',
        !host.all('DeviceInputted').some(m => m.payload?.event === 'AFTER-END'));

    // --- offline host answers on the session id, not with silence ---
    const offlineId = 'sess' + randomUUID().replace(/-/g, '').slice(0, 16);
    ctl.send({
        type: 'DeviceConnect',
        payload: { host_device: thirdDev.id, session_id: offlineId, eph: 'x25519:AAA', proof: 'P' },
    });
    // thirdDev IS online, so use a device that is enrolled but has no socket.
    const ghost = newDevice();
    await enrol(ghost, 'Ghost', userId, signSeed, token);
    const ghostId = 'sess' + randomUUID().replace(/-/g, '').slice(0, 16);
    ctl.send({
        type: 'DeviceConnect',
        payload: { host_device: ghost.id, session_id: ghostId, eph: 'x25519:AAA', proof: 'P' },
    });
    const offline = await ctl.waitFor('DeviceEnded');
    check('connecting to an OFFLINE device answers with a reason',
        !!offline?.payload?.reason, offline?.payload?.reason);

    for (const s of [host, ctl, third]) { try { s.ws.close(); } catch { /* ignore */ } }
    sql(`DELETE FROM users WHERE id = ${userId}`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
