// Protocol-level proof for moderator voice moves and voice disconnects.
//
// This exists because the pure front-end rules (src/tests/voiceMove.test.ts)
// were 10/10 green while the backend move was returning 404 for EVERY request:
// the destination lookup selected a column named `channel_type`, which the
// schema calls `type`, and `.unwrap_or(None)` turned the query error into
// "channel not found". Nothing short of executing the query could catch that,
// so this harness executes it.
//
// Covers: a real move (B is told to join the destination), a disconnect
// (B is told the room is gone), and the three refusals — non-moderator,
// self-move, and dragging someone OUT of the AFK channel.
//
// Prereqs: backend on :3000 against a THROWAWAY database, Postgres up, and at
// least two users who are members of a server the first one OWNS.
// Usage: node e2e/voice-move-2user.mjs
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const API = process.env.API || 'http://127.0.0.1:3000';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const DB = process.env.PGDATABASE || 'puca';
// Host/port are configurable so this can point at a THROWAWAY cluster — which
// is the only way it should ever be run. `initdb` into a scratch directory and
// start it on a spare port; no admin rights and no risk to the dev database.
const PGHOST = process.env.PGHOST || 'localhost';
const PGPORT = process.env.PGPORT || '5432';
const PGUSER = process.env.PGUSER || 'postgres';
const psql = (sql) => execFileSync(PSQL, ['-U', PGUSER, '-h', PGHOST, '-p', PGPORT, '-d', DB, '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' } }).toString().trim();

let fail = 0;
const ck = (n, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`);
    if (!ok) fail++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Mint HS256 JWTs directly (per the local-testing setup).
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
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
    });
    let parsed = null;
    const text = await res.text();
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
}

// A owns the server; B is a member of it. Both are needed: the handler is
// server-scoped, and B must legitimately be able to join the voice channels.
const row = psql(`SELECT s.id, u1.id, u1.username, u2.id, u2.username
    FROM servers s
    JOIN users u1 ON u1.id = s.owner_id
    JOIN server_members m2 ON m2.server_id = s.id AND m2.user_id <> u1.id
    JOIN users u2 ON u2.id = m2.user_id
    ORDER BY s.id DESC LIMIT 1`).split('|');
if (row.length < 5 || !row[0]) {
    console.error('SETUP FAIL: need a server with an owner and at least one other member.');
    process.exit(2);
}
const [srvId, aId, aName, bId, bName] = [row[0], Number(row[1]), row[2], Number(row[3]), row[4]];
// What the moved user should see the mover called: display name if set, else
// username — resolved the same way the handler does.
const aLabel = psql(`SELECT COALESCE(display_name, username) FROM users WHERE id = ${aId}`);
const aT = mint(aId, aName);
const bT = mint(bId, bName);
console.log(`server=${srvId}  A(owner)=${aName}(${aId})  B=${bName}(${bId})\n`);

const connect = (id, name) => new Promise((res, rej) => {
    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws`, ['bearer', mint(id, name)]);
    ws.on('open', () => res(ws));
    ws.on('error', rej);
});
const send = (ws, type, payload) => ws.send(JSON.stringify({ type, payload }));
const collect = (ws, bucket) => ws.on('message', (d) => {
    try { bucket.push(JSON.parse(d.toString())); } catch { /* ignore */ }
});

// --- Fixtures: two voice channels, plus whatever AFK channel exists ---------
const src = await api('POST', `/servers/${srvId}/channels`, { name: `e2e-move-src-${Date.now().toString(36)}`, channel_type: 1 }, aT);
const dst = await api('POST', `/servers/${srvId}/channels`, { name: `e2e-move-dst-${Date.now().toString(36)}`, channel_type: 1 }, aT);
if (src.status >= 300 || dst.status >= 300) {
    console.error('SETUP FAIL: could not create voice channels', src.status, dst.status);
    process.exit(2);
}
const srcId = src.body.id, dstId = dst.body.id;
const chans = await api('GET', `/servers/${srvId}/channels`, null, aT);
const afk = (chans.body || []).find(c => c.channel_type === 1 && c.is_afk);
console.log(`src=${srcId} dst=${dstId} afk=${afk ? afk.id : '(none)'}\n`);

const cleanup = async () => {
    await api('DELETE', `/channels/${srcId}`, null, aT);
    await api('DELETE', `/channels/${dstId}`, null, aT);
};

try {
    // ---- Case 1: a real move ----------------------------------------------
    {
        const b = await connect(bId, bName);
        const inbox = [];
        collect(b, inbox);
        send(b, 'JoinRoom', { room_id: `voice_${srcId}` });
        await sleep(300);
        send(b, 'StartStream', { room_id: `voice_${srcId}` });
        await sleep(400);
        inbox.length = 0; // only look at what the move produces

        const res = await api('POST', `/servers/${srvId}/voice-move/${bId}`, { channel_id: dstId }, aT);
        ck('move returns 2xx', res.status < 300, `status=${res.status} body=${JSON.stringify(res.body)}`);
        await sleep(600);

        const moved = inbox.find(m => m.type === 'VoiceMoved');
        // THE regression assertion. A 404 here (the `channel_type` bug) leaves
        // inbox empty and this fails loudly instead of silently doing nothing.
        ck('B receives VoiceMoved', !!moved, moved ? '' : `inbox=${JSON.stringify(inbox.map(m => m.type))}`);
        if (moved) {
            ck('VoiceMoved names the destination', moved.payload?.channel_id === dstId, `got=${moved.payload?.channel_id}`);
            ck('VoiceMoved names the source', moved.payload?.from_channel_id === srcId, `got=${moved.payload?.from_channel_id}`);
            ck('VoiceMoved names the server', moved.payload?.server_id === srvId, `got=${moved.payload?.server_id}`);
            // The mover is named from the DATABASE (display name, else
            // username), NOT from the live WS session map — a moderator acting
            // without an open socket used to arrive as the literal string
            // "A moderator", which this asserts can no longer happen.
            ck('VoiceMoved names the mover', moved.payload?.moved_by === aLabel,
                `got=${moved.payload?.moved_by} want=${aLabel}`);
        }
        // A move must NOT carry RoomLeft — the client's RoomLeft handler clears
        // the current voice channel, which would race the switch. (ws::SelfNotice)
        ck('move sends no RoomLeft for the source room',
            !inbox.some(m => m.type === 'RoomLeft' && m.payload?.room_id === `voice_${srcId}`),
            JSON.stringify(inbox.map(m => m.type)));
        b.terminate();
        await sleep(300);
    }

    // ---- Case 2: disconnect ------------------------------------------------
    {
        const b = await connect(bId, bName);
        const inbox = [];
        collect(b, inbox);
        send(b, 'JoinRoom', { room_id: `voice_${srcId}` });
        await sleep(300);
        send(b, 'StartStream', { room_id: `voice_${srcId}` });
        await sleep(400);
        inbox.length = 0;

        const res = await api('POST', `/servers/${srvId}/voice-move/${bId}`, { channel_id: null }, aT);
        ck('disconnect returns 2xx', res.status < 300, `status=${res.status} body=${JSON.stringify(res.body)}`);
        await sleep(600);
        ck('B receives RoomLeft for the room they were in',
            inbox.some(m => m.type === 'RoomLeft' && m.payload?.room_id === `voice_${srcId}`),
            JSON.stringify(inbox.map(m => m.type)));
        // No timeout, no membership change: B may rejoin at once. This is the
        // whole difference from a server kick.
        const rejoinInbox = [];
        collect(b, rejoinInbox);
        send(b, 'JoinRoom', { room_id: `voice_${srcId}` });
        await sleep(500);
        ck('B can rejoin immediately after being disconnected',
            rejoinInbox.some(m => m.type === 'RoomJoined' && m.payload?.room_id === `voice_${srcId}`),
            JSON.stringify(rejoinInbox.map(m => m.type)));
        b.terminate();
        await sleep(300);
    }

    // ---- Case 3: refusals --------------------------------------------------
    {
        const b = await connect(bId, bName);
        send(b, 'JoinRoom', { room_id: `voice_${srcId}` });
        await sleep(300);
        send(b, 'StartStream', { room_id: `voice_${srcId}` });
        await sleep(400);

        // B holds no MOVE_MEMBERS, so B cannot move A (nor anyone).
        const byB = await api('POST', `/servers/${srvId}/voice-move/${aId}`, { channel_id: dstId }, bT);
        ck('non-moderator is refused (403)', byB.status === 403, `status=${byB.status}`);

        // Self-move is refused with a distinct code, not a permission error.
        const self = await api('POST', `/servers/${srvId}/voice-move/${aId}`, { channel_id: dstId }, aT);
        ck('self-move is refused (400)', self.status === 400, `status=${self.status}`);

        // Same channel is a no-op request, refused rather than silently accepted.
        const same = await api('POST', `/servers/${srvId}/voice-move/${bId}`, { channel_id: srcId }, aT);
        ck('move to the channel they are already in is refused (400)', same.status === 400, `status=${same.status}`);

        // A text channel is not a destination.
        const textChan = (chans.body || []).find(c => c.channel_type === 0);
        if (textChan) {
            const toText = await api('POST', `/servers/${srvId}/voice-move/${bId}`, { channel_id: textChan.id }, aT);
            ck('move into a TEXT channel is refused (400)', toText.status === 400, `status=${toText.status}`);
        }
        b.terminate();
        await sleep(300);
    }

    // ---- Case 4: nobody is dragged OUT of AFK ------------------------------
    if (afk) {
        const b = await connect(bId, bName);
        send(b, 'JoinRoom', { room_id: `voice_${afk.id}` });
        await sleep(300);
        send(b, 'StartStream', { room_id: `voice_${afk.id}` });
        await sleep(400);

        const out = await api('POST', `/servers/${srvId}/voice-move/${bId}`, { channel_id: dstId }, aT);
        ck('moving a member OUT of AFK is refused (403)', out.status === 403, `status=${out.status}`);

        // POSITIVE CONTROL for the rule above: the refusal must be about the
        // AFK SOURCE, not about the endpoint being broken for this member.
        // Disconnecting them from AFK is allowed and must still work.
        const disc = await api('POST', `/servers/${srvId}/voice-move/${bId}`, { channel_id: null }, aT);
        ck('disconnecting a member FROM AFK is still allowed (2xx)', disc.status < 300, `status=${disc.status}`);
        b.terminate();
        await sleep(300);
    } else {
        console.log('SKIP  AFK rules — this server has no AFK channel');
    }

    // ---- Case 5: not in voice at all --------------------------------------
    {
        const res = await api('POST', `/servers/${srvId}/voice-move/${bId}`, { channel_id: dstId }, aT);
        ck('moving a member who is not in voice is refused (409)', res.status === 409, `status=${res.status}`);
    }
} finally {
    await cleanup();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURE(S)'}`);
process.exit(fail === 0 ? 0 : 1);
