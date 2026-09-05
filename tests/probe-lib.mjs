// Shared harness for the live authorization suites (boundary-audit-live.mjs and
// any later probe that wants the same fixtures). Pure HTTP + WS against a
// locally running backend, users inserted straight into Postgres and driven with
// locally minted HS256 JWTs — the same technique as perm-matrix-live.mjs, so
// the SRP login flow stays out of scope.
//
// NEVER point this at a real database: mkUser inserts users directly and the
// fixtures leave servers, channels and messages behind.
//
// BASE and PGDB must name the SAME instance: the backend at BASE looks up the
// users this file inserts into PGDB. Pointing them at different databases makes
// every authenticated call 401 (user row not found during the token_version
// check), which reads exactly like a permission bug.
//
// Usage from a suite:
//   import { mkUser, mkServer, mkChannel, joinViaInvite, denyView, ws, check, done, BITS } from './probe-lib.mjs'
//   API=http://127.0.0.1:3000 PGDB=puca_sec_test PGPORT=5433 node tests/<suite>.mjs
//
// Wire facts (verified against src/):
//   JWT: HS256, claims {sub, username, tv, exp}. No session id => accepted as a
//        legacy token (no token_sessions row required).
//   WS:  new WebSocket('ws://host/ws', ['bearer', jwt]); frames are
//        {type: 'VariantName', payload: {...}} both ways (serde tag/content).
//        '/ws?mode=delivery' opens a DELIVERY socket: invisible for presence,
//        and the only kind the parked-notification queue drains into.
//   Rooms: 'channel_<id>' (text, needs VIEW) and 'voice_<id>' (needs VIEW+CONNECT).
//   PUT /channels/:cid/overwrites/:role_id  body {allow, deny} (bit masks).
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';

// 127.0.0.1 rather than localhost: the backend binds an IPv4 loopback and Node's
// WebSocket does not fall back from ::1 the way fetch does.
export const BASE = process.env.API || 'http://127.0.0.1:3000';
export const PGDB = process.env.PGDB || 'puca';
export const PGPORT = process.env.PGPORT || '5432';
export const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
export const JWT_SECRET = process.env.JWT_SECRET || 'puca_super_secret_key_change_in_production';

// src/permissions.rs bit layout.
export const BITS = {
    VIEW_CHANNEL: 1 << 0, SEND_MESSAGES: 1 << 1, READ_MESSAGE_HISTORY: 1 << 2, MANAGE_MESSAGES: 1 << 3,
    ATTACH_FILES: 1 << 4, EMBED_LINKS: 1 << 5, ADD_REACTIONS: 1 << 6, USE_EXTERNAL_EMOJIS: 1 << 7,
    CONNECT: 1 << 8, SPEAK: 1 << 9, VIDEO: 1 << 10, STREAM: 1 << 11, MUTE_MEMBERS: 1 << 12,
    DEAFEN_MEMBERS: 1 << 13, MOVE_MEMBERS: 1 << 14, USE_VOICE_ACTIVITY: 1 << 15, PRIORITY_SPEAKER: 1 << 16,
    MANAGE_CHANNELS: 1 << 17, MANAGE_ROLES: 1 << 18, MANAGE_SERVER: 1 << 19, KICK_MEMBERS: 1 << 20,
    BAN_MEMBERS: 1 << 21, ADMINISTRATOR: 1 << 22, CREATE_TASKS: 1 << 23, COMPLETE_TASKS: 1 << 24,
    MANAGE_TASKS: 1 << 25, CREATE_CLIPS: 1 << 26, CREATE_INVITE: 1 << 27,
};

let failures = 0, passes = 0;
export const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(extra).slice(0, 400)}`);
    if (ok) passes++; else failures++;
};
export const section = (title) => console.log(`\n=== ${title} ===`);
export const done = () => {
    console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${passes} passed)`);
    process.exit(failures ? 1 : 0);
};

export const psql = (sql) => execFileSync(PSQL,
    ['-U', 'postgres', '-h', '127.0.0.1', '-p', PGPORT, '-d', PGDB, '-q', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();
// First non-empty line only (strips any trailing "INSERT 0 1" command tag).
export const psql1 = (sql) => psql(sql).split(/\r?\n/).filter(Boolean)[0] ?? '';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const mintJwt = (sub, username, tv = 0, extra = {}) => {
    const head = b64u({ alg: 'HS256', typ: 'JWT' });
    const body = b64u({ sub, username, tv, exp: Math.floor(Date.now() / 1000) + 3600, ...extra });
    const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
};

// api(token)(method, path, body?, headers?) -> {status, json, text, headers}
export const api = (token) => async (method, path, body, headers = {}) => {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
        },
        body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
};

export const RUN = randomUUID().slice(0, 8);

// A fresh user inserted directly (no SRP), with a minted token and an api()
// bound to it. The per-process counter lets one suite reuse a tag ("owner",
// "member") in every scenario without tripping the UNIQUE(username) index.
let userSeq = 0;
export const mkUser = (tag) => {
    const username = `ba_${tag}_${RUN}_${++userSeq}`.slice(0, 40);
    const id = parseInt(psql1(`INSERT INTO users (username, salt, verifier, key_version, token_version) VALUES ('${username}', '\\x00', '\\x00', 3, 0) RETURNING id`), 10);
    if (!Number.isInteger(id)) throw new Error('mkUser: INSERT returned no id — is PGDB the backend\'s database?');
    const token = mintJwt(id, username);
    return { id, username, token, api: api(token) };
};

// Owner creates a server through the API (so the default @everyone role and the
// owner role exist exactly as production makes them); returns {id, everyoneRoleId, owner}.
export const mkServer = async (owner, name = `srv_${RUN}`) => {
    const r = await owner.api('POST', '/servers', { name });
    if (r.status !== 200 || !r.json?.id) throw new Error('mkServer failed ' + r.status + ' ' + r.text);
    const everyoneRoleId = parseInt(psql1(`SELECT id FROM server_roles WHERE server_id = '${r.json.id}' AND is_default = true`), 10);
    return { id: r.json.id, everyoneRoleId, owner };
};

// Owner creates a channel; channel_type 0 = text, 1 = voice (channel_handlers.rs).
export const mkChannel = async (server, name = `ch_${RUN}`, channel_type = 0, extra = {}) => {
    const r = await server.owner.api('POST', `/servers/${server.id}/channels`, { name, channel_type, ...extra });
    if (r.status !== 200 || !r.json?.id) throw new Error('mkChannel failed ' + r.status + ' ' + r.text);
    return r.json.id;
};

// Member joins via an owner-minted invite. A bare /join is refused for private
// servers since the 2026-07-24 hardening, and a fixture that silently failed
// here once read as sixteen permission regressions (perm-matrix-live.mjs).
export const joinViaInvite = async (server, member) => {
    const inv = await server.owner.api('POST', `/servers/${server.id}/invites`, { max_uses: 50, expires_in_hours: 1 });
    if (inv.status !== 200 || !inv.json?.code) throw new Error('invite failed ' + inv.status + ' ' + inv.text);
    const j = await member.api('POST', `/invites/${inv.json.code}/join`);
    if (j.status !== 200 && j.status !== 409) throw new Error('join failed ' + j.status + ' ' + j.text);
    return j;
};

// Deny VIEW on a channel for a role (default @everyone; the owner is exempt as
// ADMINISTRATOR). Also bumps member_generation and runs the eviction sweep.
export const denyView = async (server, channelId, roleId = server.everyoneRoleId, extraDeny = 0) => {
    const r = await server.owner.api('PUT', `/channels/${channelId}/overwrites/${roleId}`, { allow: 0, deny: BITS.VIEW_CHANNEL | extraDeny });
    if (r.status !== 200) throw new Error('denyView failed ' + r.status + ' ' + r.text);
    return r;
};
export const clearOverwrite = async (server, channelId, roleId = server.everyoneRoleId) =>
    server.owner.api('DELETE', `/channels/${channelId}/overwrites/${roleId}`);

// Open an authenticated WebSocket; resolves to {sock, frames, send, waitFor, settle, close}.
// {delivery: true} opens a '/ws?mode=delivery' socket instead of a visible one.
export const ws = (user, { settleMs = 300, delivery = false } = {}) => new Promise((resolve, reject) => {
    const url = BASE.replace(/^http/, 'ws') + '/ws' + (delivery ? '?mode=delivery' : '');
    const sock = new WebSocket(url, ['bearer', user.token]);
    const frames = [];
    const waiters = [];
    sock.addEventListener('message', (ev) => {
        let f; try { f = JSON.parse(String(ev.data)); } catch { f = { type: 'RAW', payload: String(ev.data) }; }
        frames.push(f);
        for (const w of waiters.slice()) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.res(f); }
    });
    sock.addEventListener('error', (e) => reject(new Error('ws error ' + (e.message || ''))));
    sock.addEventListener('open', () => resolve({
        sock, frames,
        send: (type, payload) => sock.send(JSON.stringify(payload === undefined ? { type } : { type, payload })),
        // Resolve with the first frame (already received or future) matching pred, or null after ms.
        waitFor: (pred, ms = 1500) => {
            const hit = frames.find(pred);
            if (hit) return Promise.resolve(hit);
            return new Promise((res) => {
                const t = setTimeout(() => { const i = waiters.findIndex(w => w.res === res); if (i >= 0) waiters.splice(i, 1); res(null); }, ms);
                waiters.push({ pred, res, t });
            });
        },
        settle: () => new Promise(r => setTimeout(r, settleMs)),
        close: () => { try { sock.close(); } catch { /* ignore */ } },
    }));
});

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
