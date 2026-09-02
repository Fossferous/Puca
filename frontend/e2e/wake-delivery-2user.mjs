// Protocol-level proof for the wake layer's server half and the delivery-
// session semantics (0.8.67):
//
//  1. A `mode=delivery` session is PRESENCE-INVISIBLE: the friend list must
//     not show a user online whose only connection is their phone's
//     background socket. (Shipping this unmarked made every Android user
//     permanently "online".)
//  2. A DM sent while a user has NO session is PARKED and drained into their
//     next delivery session — the doorbell's other half. A drain is a take:
//     reconnecting must not replay it.
//  3. A VISIBLE session never receives the parked queue (it would
//     double-render an open chat).
//  4. `kill_device_sessions` reaches a delivery socket via its CLAIMED device
//     id — the revoke fix for a lost phone.
//  5. Session-cap policy (0.8.68): one delivery socket per claimed device, and
//     at the cap a delivery ghost is evicted before any visible client — the
//     fix for wake-driven socket churn hanging up the desktop that was hosting
//     a remote-control session.
//
// Prereqs: backend on :3000 against a THROWAWAY database (FCM vars unset —
// the queue must work with the doorbell off), two users who are FRIENDS or
// server-mates. Usage: node e2e/wake-delivery-2user.mjs
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const API = process.env.API || 'http://127.0.0.1:3000';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const DB = process.env.PGDATABASE || 'puca_e2e';
const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT || '55432';
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', PGHOST, '-p', PGPORT, '-d', DB, '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' } }).toString().trim();

let fail = 0;
const ck = (n, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`);
    if (!ok) fail++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const secret = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).find(l => l.startsWith('JWT_SECRET=')).slice('JWT_SECRET='.length).trim();
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const mint = (sub, username) => {
    const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'HS256' }));
    const p = b64u(JSON.stringify({ sub, username, exp: Math.floor(Date.now() / 1000) + 3600 }));
    const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${sig}`;
};

async function api(method, path, body, token) {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body == null ? undefined : JSON.stringify(body),
    });
    let parsed = null;
    const text = await res.text();
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
}

// Two server-mates (any server), A will message B.
const row = psql(`SELECT u1.id, u1.username, u2.id, u2.username
    FROM users u1 JOIN users u2 ON u2.id > u1.id
    JOIN server_members m1 ON m1.user_id = u1.id
    JOIN server_members m2 ON m2.user_id = u2.id AND m2.server_id = m1.server_id
    WHERE u1.username NOT LIKE 'deleted%' AND u2.username NOT LIKE 'deleted%'
    ORDER BY u1.id DESC LIMIT 1`).split('|');
if (row.length < 4 || !row[0]) { console.error('SETUP FAIL: need two server-mates'); process.exit(2); }
const [aId, aName, bId, bName] = [Number(row[0]), row[1], Number(row[2]), row[3]];
const aT = mint(aId, aName), bT = mint(bId, bName);
console.log(`A=${aName}(${aId})  B=${bName}(${bId})\n`);

// The token rides the subprotocol (a query-string token is refused since 0.9.1); `extra` keeps its leading '&' from the old form.
const wsUrl = (_token, extra = '') => `${API.replace(/^http/, 'ws')}/ws${extra ? '?' + extra.replace(/^&/, '') : ''}`;
const connect = (token, extra) => new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl(token, extra), ['bearer', token]);
    ws.on('open', () => res(ws));
    ws.on('error', rej);
});
const collect = (ws, bucket) => ws.on('message', d => { try { bucket.push(JSON.parse(d.toString())); } catch { /**/ } });
const send = (ws, type, payload) => ws.send(JSON.stringify({ type, payload }));

// ---- 1. Presence invisibility ---------------------------------------------
{
    const bDelivery = await connect(bT, '&mode=delivery');
    await sleep(400);
    // Friends list / member presence: ask the server for B's server members
    // and find B's is_online as A sees it.
    const conv = psql(`SELECT server_id FROM server_members WHERE user_id = ${bId} LIMIT 1`);
    const members = await api('GET', `/servers/${conv}/members`, null, aT);
    const b = Array.isArray(members.body) ? members.body.find(m => (m.id ?? m.user_id) === bId) : null;
    ck('a delivery-only session does NOT read as online', b ? b.is_online === false : false,
        b ? `is_online=${b.is_online}` : `members fetch status=${members.status}`);

    // POSITIVE CONTROL: a visible session flips it.
    const bVisible = await connect(bT, '');
    await sleep(400);
    const members2 = await api('GET', `/servers/${conv}/members`, null, aT);
    const b2 = Array.isArray(members2.body) ? members2.body.find(m => (m.id ?? m.user_id) === bId) : null;
    ck('a visible session DOES read as online (positive control)', b2 ? b2.is_online === true : false,
        b2 ? `is_online=${b2.is_online}` : `status=${members2.status}`);
    bVisible.close(); bDelivery.close();
    await sleep(400);
}

// ---- 2 + 3. Park, drain, and visible-drop ---------------------------------
{
    // B fully offline. A DMs B -> the frame parks server-side.
    const a = await connect(aT, '');
    await sleep(300);
    send(a, 'DirectMessage', { to_user_id: bId, content: 'ciphertext-park-me' });
    await sleep(500);

    // The delivery session drains it...
    const bDel = await connect(bT, '&mode=delivery');
    const delInbox = [];
    collect(bDel, delInbox);
    await sleep(600);
    ck('the delivery session drains the parked DM',
        delInbox.some(m => m.type === 'DirectMessage'),
        JSON.stringify(delInbox.map(m => m.type)));
    bDel.close();
    await sleep(300);

    // ...exactly once: a reconnect must not replay it.
    const bDel2 = await connect(bT, '&mode=delivery');
    const delInbox2 = [];
    collect(bDel2, delInbox2);
    await sleep(600);
    ck('a drain is a take — reconnect replays nothing',
        !delInbox2.some(m => m.type === 'DirectMessage'),
        JSON.stringify(delInbox2.map(m => m.type)));
    bDel2.close();
    await sleep(300);

    // Park a second frame, then let a VISIBLE client connect: it must not
    // receive the frame (it repaints from REST) AND its arrival must DROP the
    // queue — the user is reading everything now, and a phone connecting
    // hours later must not notify for messages long read.
    send(a, 'DirectMessage', { to_user_id: bId, content: 'ciphertext-park-2' });
    await sleep(500);
    const bVisible = await connect(bT, '');
    const visInbox = [];
    collect(bVisible, visInbox);
    await sleep(600);
    ck('a VISIBLE session never receives the parked queue',
        !visInbox.some(m => m.type === 'DirectMessage'),
        JSON.stringify(visInbox.map(m => m.type)));
    bVisible.close();
    await sleep(400);
    const bDel3 = await connect(bT, '&mode=delivery');
    const delInbox3 = [];
    collect(bDel3, delInbox3);
    await sleep(600);
    ck('a visible connect DROPS the queue — stale notifications never fire later',
        !delInbox3.some(m => m.type === 'DirectMessage'),
        JSON.stringify(delInbox3.map(m => m.type)));
    bDel3.close();
    a.close();
    await sleep(300);
}

// ---- 4. Claimed-device kill + revoked-reconnect refusal --------------------
{
    // A real devices row, because the upgrade gate now fails CLOSED on a
    // claim it cannot verify — which is itself the first assertion.
    const unknown = await new Promise((res) => {
        const ws = new WebSocket(wsUrl(bT, '&mode=delivery&device=dev-does-not-exist'), ['bearer', bT]);
        ws.on('open', () => { ws.close(); res('open'); });
        ws.on('error', () => res('refused'));
    });
    ck('an UNKNOWN device claim is refused at upgrade (fail closed)', unknown === 'refused', unknown);

    psql(`INSERT INTO devices (id, user_id, device_pub, sign_pub, name, platform, auth_record, auth_sig)
          VALUES ('dev-e2e-kill', ${bId}, 'x25519:e2e${Date.now()}', 'ed25519:e2e${Date.now()}', 'e2e phone', 'android', '{}', 'sig')
          ON CONFLICT (id) DO UPDATE SET revoked_at = NULL, user_id = ${bId}`);

    const bDel = await connect(bT, '&mode=delivery&device=dev-e2e-kill');
    let closed = false;
    bDel.on('close', () => { closed = true; });
    await sleep(400);
    const revoke = await api('DELETE', `/devices/dev-e2e-kill`, null, bT);
    await sleep(700);
    ck('revoking the claimed device hangs up the delivery socket', closed, `revoke status=${revoke.status}`);

    // And the 5-second-reconnect hole is closed: the same claim is now refused.
    const again = await new Promise((res) => {
        const ws = new WebSocket(wsUrl(bT, '&mode=delivery&device=dev-e2e-kill'), ['bearer', bT]);
        ws.on('open', () => { ws.close(); res('open'); });
        ws.on('error', () => res('refused'));
    });
    ck('a REVOKED device cannot reconnect its delivery socket', again === 'refused', again);
    psql(`DELETE FROM devices WHERE id = 'dev-e2e-kill'`);
}

// ---- 5. Session-cap policy (0.8.68) ---------------------------------------
//
// The regression this section exists for: a phone's delivery socket is a
// permanent extra session, and `reconnectNow` drops and redials it on every
// wake. Under Doze the predecessor is not collected until the 75s idle reaper,
// so the sockets stacked — and the per-user cap evicted the OLDEST connection,
// which for a machine signed in all day is the DESKTOP hosting a remote-control
// session. The user lost sessions to a notification arriving.
{
    for (const id of ['dev-e2e-dedup-a', 'dev-e2e-dedup-b']) {
        psql(`INSERT INTO devices (id, user_id, device_pub, sign_pub, name, platform, auth_record, auth_sig)
              VALUES ('${id}', ${bId}, 'x25519:${id}${Date.now()}', 'ed25519:${id}${Date.now()}', 'e2e phone', 'android', '{}', 'sig')
              ON CONFLICT (id) DO UPDATE SET revoked_at = NULL, user_id = ${bId}`);
    }

    // 5a. One install, one delivery socket.
    const first = await connect(bT, '&mode=delivery&device=dev-e2e-dedup-a');
    let firstClosed = false;
    first.on('close', () => { firstClosed = true; });
    await sleep(400);
    const second = await connect(bT, '&mode=delivery&device=dev-e2e-dedup-a');
    let secondClosed = false;
    second.on('close', () => { secondClosed = true; });
    await sleep(700);
    ck('a redialing delivery socket supersedes its own predecessor',
        firstClosed && !secondClosed, `first closed=${firstClosed} second closed=${secondClosed}`);

    // 5b. POSITIVE CONTROL: the dedupe keys on the DEVICE, not on "is a
    // delivery socket" — a phone and a tablet are both entitled to one.
    const other = await connect(bT, '&mode=delivery&device=dev-e2e-dedup-b');
    let otherClosed = false;
    other.on('close', () => { otherClosed = true; });
    await sleep(700);
    ck('a DIFFERENT device keeps its own delivery socket',
        !otherClosed && !secondClosed, `other closed=${otherClosed} same-device closed=${secondClosed}`);
    second.close(); other.close();
    await sleep(400);
    psql(`DELETE FROM devices WHERE id IN ('dev-e2e-dedup-a','dev-e2e-dedup-b')`);

    // 5c. At the cap, a pocketed phone's socket is what gets dropped — never
    // a visible client. (Which visible client is spared when a device session
    // is live is pinned by the Rust unit tests, where a session can be built
    // without driving the whole DeviceConnect handshake.)
    // The ghost is opened AFTER three visible clients, never first: the old
    // code evicted index 0, so a ghost sitting at index 0 would be evicted by
    // the bug as well as by the fix, and this check would pass either way.
    const visible = [];
    const openVisible = async () => {
        const ws = await connect(bT, '');
        const rec = { ws, closed: false };
        ws.on('close', () => { rec.closed = true; });
        visible.push(rec);
        await sleep(120);
    };
    for (let i = 0; i < 3; i++) await openVisible();
    const ghost = await connect(bT, '&mode=delivery');
    let ghostClosed = false;
    ghost.on('close', () => { ghostClosed = true; });
    await sleep(300);
    for (let i = 0; i < 7; i++) await openVisible();
    await sleep(700);
    ck('at the cap the delivery ghost is evicted, not a visible client',
        ghostClosed && visible.every(v => !v.closed),
        `ghost closed=${ghostClosed} visible closed=${visible.filter(v => v.closed).length}/10`);
    ck('and the OLDEST visible client — the desktop — is spared (the regression)',
        !visible[0].closed, `oldest visible closed=${visible[0].closed}`);
    for (const v of visible) v.ws.close();
    ghost.close();
    await sleep(400);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURE(S)'}`);
process.exit(fail === 0 ? 0 : 1);
