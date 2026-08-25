/**
 * Device enrolment + WebSocket attestation, against a REAL backend.
 *
 * What this is actually for: the unit tests prove the crypto agrees with itself,
 * but they cannot prove that migration 044 applies, that the server recomputes a
 * device id the same way the client derives it, or — the load-bearing one — that
 * an UNATTESTED connection is genuinely not addressable as a device.
 *
 * That last property is the reason the file exists. `send_signal_to_user` already
 * fails by SILENTLY DROPPING, so a test that merely asserts "no error was thrown"
 * would pass whether or not the gate works. Every assertion here is on an
 * OBSERVED outcome: a row that came back, a socket that dropped, a device that
 * did or did not appear in the list.
 *
 * Needs a backend against a THROWAWAY database (never dev, never prod):
 *   DATABASE_URL=postgres://…/puca_e2e_devices PORT=3001 ./target/debug/puca
 *   API=http://127.0.0.1:3001 JWT_SECRET=… node e2e/device-attest.mjs
 */
import { webcrypto } from 'node:crypto';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ed25519, x25519 } from '../node_modules/@noble/curves/ed25519.js';
import { sha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hkdf } from '../node_modules/@noble/hashes/hkdf.js';

const crypto = webcrypto;
/** psql, not a node driver — `pg` is not a dependency of this project and a
 *  test is not a good reason to add one. Override with PSQL if it is elsewhere. */
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const API = process.env.API || 'http://127.0.0.1:3001';
const WS_URL = API.replace(/^http/, 'ws') + '/ws';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL;

const results = [];
function check(stage, ok, detail) {
    results.push({ stage, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- helpers mirroring the client ----------
const enc = new TextEncoder();
const b64 = (b) => Buffer.from(b).toString('base64');
const b64url = (b) => Buffer.from(b).toString('base64url');

function canonicalJson(value) {
    const e = (v) => {
        if (v === null) return 'null';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) throw new Error('non-finite');
            return JSON.stringify(v);
        }
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

function deriveDeviceId(devicePub, signPub) {
    const buf = Buffer.concat([
        Buffer.from(enc.encode('sovereign-device-v1')),
        Buffer.from(enc.encode(devicePub)),
        Buffer.from(enc.encode(signPub)),
    ]);
    return b64url(sha256(buf)).slice(0, 21);
}

function mintJwt(userId, username) {
    const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(Buffer.from(JSON.stringify({
        sub: userId, username, exp: now + 3600, tv: 0, sst: now,
    })));
    const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${sig}`;
}

/** A fresh device keypair: 32-byte X25519 secret + 32-byte Ed25519 seed. */
function newDeviceKeys() {
    const material = crypto.getRandomValues(new Uint8Array(64));
    const xSec = material.slice(0, 32);
    const edSeed = material.slice(32);
    return {
        edSeed,
        device_pub: 'x25519:' + b64(x25519.getPublicKey(xSec)),
        sign_pub: 'ed25519:' + b64(ed25519.getPublicKey(edSeed)),
    };
}

/** The account signing key, derived exactly as e2ee.ts does. */
function accountSigningKey(seed) {
    return hkdf(sha256, seed, undefined, enc.encode('sovereign-account-sign-v1'), 32);
}

function attestationMessage(nonce, userId) {
    return `sovereign-device-attest-v1|${nonce}|${userId}`;
}

async function api(path, opts = {}, token) {
    const res = await fetch(API + path, {
        ...opts,
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(opts.headers || {}),
        },
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
}

/**
 * Open a socket and collect messages. Returns helpers so a test can assert on
 * what actually ARRIVED rather than on the absence of an exception.
 */
function openSocket(token) {
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    const received = [];
    let closed = false;
    ws.addEventListener('message', (ev) => {
        try { received.push(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
    ws.addEventListener('close', () => { closed = true; });
    return {
        ws,
        received,
        isClosed: () => closed,
        open: () => new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', rej, { once: true });
        }),
        send: (m) => ws.send(JSON.stringify(m)),
        waitFor: async (type, ms = 3000) => {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
                const hit = received.find(m => m.type === type);
                if (hit) return hit;
                await sleep(50);
            }
            return null;
        },
    };
}

// ---------- test ----------
async function main() {
    if (!DATABASE_URL) {
        console.error('DATABASE_URL is required (throwaway database only)');
        process.exit(2);
    }
    if (/\/puca(\?|$)/.test(DATABASE_URL)) {
        console.error('Refusing to run against the dev database "puca" — use a throwaway.');
        process.exit(2);
    }

    // Parse the URL so psql can be driven without echoing the password.
    const u = new URL(DATABASE_URL);
    const sql = (q) => execFileSync(
        PSQL,
        // -q suppresses the trailing command tag ("INSERT 0 1"), which would
        // otherwise be appended to the RETURNING value and parse as NaN.
        ['-U', decodeURIComponent(u.username), '-h', u.hostname, '-p', u.port || '5432',
            '-d', u.pathname.slice(1), '-t', '-A', '-q', '-c', q],
        { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }, encoding: 'utf8' },
    ).trim();

    // A user has to exist for the JWT to be accepted; SRP registration is not
    // what this file is testing, so insert directly.
    const username = 'devtest_' + randomUUID().slice(0, 8);
    const userId = Number(sql(
        `INSERT INTO users (username, salt, verifier) VALUES ('${username}', '\\x00', '\\x00') RETURNING id`,
    ));
    const token = mintJwt(userId, username);
    check('setup: user + token', Number.isInteger(userId), `uid=${userId}`);

    // The account seed this "client" holds. Every device of the account derives
    // the same signing key from it.
    const accountSeed = crypto.getRandomValues(new Uint8Array(32));
    const signSeed = accountSigningKey(accountSeed);

    // --- enrolment ---
    const keys = newDeviceKeys();
    const expectedId = deriveDeviceId(keys.device_pub, keys.sign_pub);
    const record = canonicalJson({
        typ: 'sovereign-device-auth-v1', v: 1,
        did: expectedId, dpub: keys.device_pub, spub: keys.sign_pub,
        name: 'E2E Box', plat: 'linux', uid: userId,
        ts: Math.floor(Date.now() / 1000),
    });
    const enrol = await api('/devices', {
        method: 'POST',
        body: JSON.stringify({
            device_pub: keys.device_pub,
            sign_pub: keys.sign_pub,
            name: 'E2E Box',
            platform: 'linux',
            auth_record: record,
            auth_sig: b64(ed25519.sign(enc.encode(record), signSeed)),
        }),
    }, token);
    check('enrol returns 200', enrol.status === 200, `status=${enrol.status}`);
    check('server derives the SAME device id as the client',
        enrol.body?.id === expectedId, `${enrol.body?.id} vs ${expectedId}`);

    // The server must not simply echo a client-chosen id.
    const squat = await api('/devices', {
        method: 'POST',
        body: JSON.stringify({
            device_pub: keys.device_pub, sign_pub: keys.sign_pub,
            name: 'Squatter', platform: 'linux',
            auth_record: record, auth_sig: 'AAAA',
        }),
    }, token);
    check('re-enrolling the same keys is idempotent (same id)',
        squat.status === 200 && squat.body?.id === expectedId,
        `status=${squat.status} id=${squat.body?.id}`);

    const bad = await api('/devices', {
        method: 'POST',
        body: JSON.stringify({
            device_pub: 'notprefixed', sign_pub: keys.sign_pub, name: 'x',
            platform: 'linux', auth_record: record, auth_sig: 'AAAA',
        }),
    }, token);
    check('malformed device_pub is refused', bad.status === 400, `status=${bad.status}`);

    const badPlatform = await api('/devices', {
        method: 'POST',
        body: JSON.stringify({
            device_pub: keys.device_pub, sign_pub: keys.sign_pub, name: 'x',
            platform: 'toaster', auth_record: record, auth_sig: 'AAAA',
        }),
    }, token);
    check('unknown platform is refused', badPlatform.status === 400, `status=${badPlatform.status}`);

    // --- attestation ---
    const sock = openSocket(token);
    await sock.open();
    const challenge = await sock.waitFor('DeviceChallenge');
    check('server issues a DeviceChallenge', !!challenge?.payload?.nonce);

    const nonce = challenge.payload.nonce;
    sock.send({
        type: 'DeviceAttest',
        payload: {
            device_id: expectedId,
            sig: b64(ed25519.sign(enc.encode(attestationMessage(nonce, userId)), keys.edSeed)),
        },
    });
    const attested = await sock.waitFor('DeviceAttested');
    check('valid attestation is accepted', attested?.payload?.device_id === expectedId,
        JSON.stringify(attested?.payload ?? null));

    const online = await api('/devices', {}, token);
    const listed = online.body?.devices?.find(d => d.id === expectedId);
    check('attested device reports online in the list', listed?.online === true,
        `online=${listed?.online}`);

    // --- THE LOAD-BEARING ONE: a bad signature must NOT attest ---
    const sock2 = openSocket(token);
    await sock2.open();
    const ch2 = await sock2.waitFor('DeviceChallenge');
    sock2.send({
        type: 'DeviceAttest',
        payload: { device_id: expectedId, sig: b64(new Uint8Array(64)) }, // all zeros
    });
    const wrong = await sock2.waitFor('DeviceAttested', 1200);
    check('a FORGED signature is not attested', wrong === null,
        wrong ? 'server accepted a zero signature!' : 'no DeviceAttested, as required');
    check('...and the socket stays usable (attestation is not fatal)',
        !sock2.isClosed(), 'still open');

    // A signature over the WRONG nonce (replay from the other socket) must fail:
    // this is what makes the nonce connection-scoped rather than decorative.
    const sock3 = openSocket(token);
    await sock3.open();
    await sock3.waitFor('DeviceChallenge');
    sock3.send({
        type: 'DeviceAttest',
        payload: {
            device_id: expectedId,
            // signed against sock1's nonce, replayed onto sock3
            sig: b64(ed25519.sign(enc.encode(attestationMessage(nonce, userId)), keys.edSeed)),
        },
    });
    const replayed = await sock3.waitFor('DeviceAttested', 1200);
    check('an attestation REPLAYED from another socket is refused', replayed === null,
        replayed ? 'server accepted a replayed attestation!' : 'refused, as required');

    // --- revocation actually hangs up ---
    const revoke = await api(`/devices/${encodeURIComponent(expectedId)}`, { method: 'DELETE' }, token);
    check('revoke returns 200', revoke.status === 200, `status=${revoke.status}`);

    await sleep(600);
    check('revoking DROPS the attested socket', sock.isClosed(),
        sock.isClosed() ? 'closed, as required' : 'socket still open — revocation was theatre');

    const after = await api('/devices', {}, token);
    check('revoked device disappears from the list',
        !after.body?.devices?.some(d => d.id === expectedId),
        `remaining=${after.body?.devices?.length ?? '?'}`);

    // Revoking twice must not 500 — retries are normal.
    const again = await api(`/devices/${encodeURIComponent(expectedId)}`, { method: 'DELETE' }, token);
    check('revoke is idempotent', again.status === 200, `status=${again.status}`);

    // A revoked device must not be able to attest again.
    const sock4 = openSocket(token);
    await sock4.open();
    const ch4 = await sock4.waitFor('DeviceChallenge');
    sock4.send({
        type: 'DeviceAttest',
        payload: {
            device_id: expectedId,
            sig: b64(ed25519.sign(enc.encode(attestationMessage(ch4.payload.nonce, userId)), keys.edSeed)),
        },
    });
    const zombie = await sock4.waitFor('DeviceAttested', 1200);
    check('a REVOKED device cannot attest again', zombie === null,
        zombie ? 'server re-attested a revoked device!' : 'refused, as required');

    for (const s of [sock, sock2, sock3, sock4]) { try { s.ws.close(); } catch { /* ignore */ } }
    sql(`DELETE FROM users WHERE id = ${userId}`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
