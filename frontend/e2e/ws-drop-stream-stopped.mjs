// Protocol-level proof for the server-side StreamStopped-on-unclean-disconnect
// fix: two raw WS clients join a voice room and StartStream; client B's socket
// is DESTROYED (no StopStream / LeaveRoom — a crash/reload) and client A must
// receive StreamStopped {room_id, streamer_id:B} (plus ScreenShareStopped,
// since B was also sharing). Case 2 checks the multi-device guard: when B's
// OTHER device also holds the stream, killing one must NOT emit StreamStopped.
// Case 3 checks the zombie/reconnect case: a dead connection's SHARE is
// released even though the user is still in the room on a newer connection,
// while their voice presence is INHERITED by that connection (releasing it
// would kill a live user's audio, permanently in an SFU room). Case 3b is the
// same shape with a 0.6.10+ client that re-claims on reconnect: nothing at all
// may be announced.
//
// Prereqs: backend on :3000 (with the fix), Postgres up, two users in the DB.
// Usage: node ws-stream-stopped-on-drop.mjs
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const PSQL = 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-d', 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

let fail = 0;
const ck = (n, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) fail++; };

// Mint HS256 JWTs directly (per the local-testing setup).
const secret = readFileSync('C:/Users/you/Testing/puca/.env', 'utf8')
    .split(/\r?\n/).find(l => l.startsWith('JWT_SECRET=')).slice('JWT_SECRET='.length).trim();
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const mint = (sub, username) => {
    const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'HS256' }));
    const p = b64u(JSON.stringify({ sub, username, exp: Math.floor(Date.now() / 1000) + 3600 }));
    const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${sig}`;
};

// Two friends (StreamStopped is presence-scoped: server-mates or friends).
const rows = psql(`SELECT u1.id, u1.username, u2.id, u2.username
    FROM users u1 JOIN users u2 ON u2.id > u1.id
    JOIN server_members m1 ON m1.user_id = u1.id
    JOIN server_members m2 ON m2.user_id = u2.id AND m2.server_id = m1.server_id
    ORDER BY u1.id DESC LIMIT 1`).split('|');
const [aId, aName, bId, bName] = [Number(rows[0]), rows[1], Number(rows[2]), rows[3]];
console.log(`A=${aName}(${aId})  B=${bName}(${bId})  (server-mates)`);

const ROOM = 'voice:wsdrop_' + Date.now().toString(36);
const connect = (id, name) => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://localhost:3000/ws?token=${mint(id, name)}`);
    ws.on('open', () => res(ws));
    ws.on('error', rej);
});
const send = (ws, type, payload) => ws.send(JSON.stringify({ type, payload }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Collect messages of the given types on a socket into a bucket. */
const collect = (ws, bucket) => ws.on('message', (d) => {
    try { bucket.push(JSON.parse(d.toString())); } catch { /* ignore */ }
});

// ---- Case 1: unclean drop of a streaming+sharing client --------------------
{
    const a = await connect(aId, aName);
    const b = await connect(bId, bName);
    const inbox = [];
    collect(a, inbox);
    send(a, 'JoinRoom', { room_id: ROOM });
    send(b, 'JoinRoom', { room_id: ROOM });
    await sleep(300);
    send(a, 'StartStream', { room_id: ROOM });
    send(b, 'StartStream', { room_id: ROOM });
    send(b, 'ScreenShareStart', { room_id: ROOM });
    await sleep(500);
    inbox.length = 0; // only look at post-drop traffic

    b.terminate(); // abrupt close — no StopStream/LeaveRoom, like a crash
    await sleep(1200);

    const ss = inbox.find(m => m.type === 'StreamStopped' && m.payload?.room_id === ROOM && m.payload?.streamer_id === bId);
    const sh = inbox.find(m => m.type === 'ScreenShareStopped' && m.payload?.room_id === ROOM && m.payload?.streamer_id === bId);
    ck('A receives StreamStopped after B\'s unclean drop', !!ss);
    ck('A receives ScreenShareStopped after B\'s unclean drop', !!sh);
    a.terminate();
}

// ---- Case 2: multi-device guard — the OTHER device is also streaming -------
// The real guard: B is in voice on two devices; one dies. The user still holds
// the stream on the survivor, so NOTHING may be announced.
//
// NOTE this case previously had only b1 StartStream while still asserting "no
// StreamStopped", which conflated ROOM MEMBERSHIP with MEDIA. Media is now
// tracked per connection, so a dying connection releases exactly its own —
// see Case 3, which is that conflation's actual bug.
{
    await sleep(300);
    const ROOM2 = ROOM + '_md';
    const a = await connect(aId, aName);
    const b1 = await connect(bId, bName);
    const b2 = await connect(bId, bName);
    const inbox = [];
    collect(a, inbox);
    send(a, 'JoinRoom', { room_id: ROOM2 });
    send(b1, 'JoinRoom', { room_id: ROOM2 });
    send(b2, 'JoinRoom', { room_id: ROOM2 });
    await sleep(300);
    send(b1, 'StartStream', { room_id: ROOM2 });
    send(b2, 'StartStream', { room_id: ROOM2 }); // BOTH devices are in voice
    await sleep(400);
    inbox.length = 0;

    b1.terminate(); // b2 still holds the stream → the user is still streaming
    await sleep(1200);

    const ss = inbox.find(m => m.type === 'StreamStopped' && m.payload?.room_id === ROOM2);
    ck("NO StreamStopped while B's other device still holds the stream", !ss);
    a.terminate(); b2.terminate();
}

// ---- Case 3: zombie connection after a RECONNECT, client does NOT re-claim -
// The bug this refactor closes. A client replays JoinRoom for every remembered
// room when its socket returns, so while the dead connection is being reaped
// the user is in the room TWICE. The dead connection's SHARE must still be
// released — otherwise the viewer's tile is frozen for the session AND
// room.screen_sharers keeps replaying a bogus ScreenShareStarted to everyone
// who joins the room afterwards.
//
// Voice presence is the exception, and this is the exact shape that makes it
// one: any client older than 0.6.10 replays JoinRoom but never StartStream, and
// a half-open socket puts the new connection in the room ~30 s BEFORE the
// zombie is reaped (client reconnects at 45 s, reap at 75 s). Announcing
// StreamStopped here drops a live user from every peer's roster and kills their
// audio — permanently in an SFU room. The claim must be inherited instead.
{
    await sleep(300);
    const ROOM3 = ROOM + '_zombie';
    const a = await connect(aId, aName);
    const bOld = await connect(bId, bName);
    const inbox = [];
    collect(a, inbox);
    send(a, 'JoinRoom', { room_id: ROOM3 });
    send(bOld, 'JoinRoom', { room_id: ROOM3 });
    await sleep(300);
    send(bOld, 'StartStream', { room_id: ROOM3 });
    send(bOld, 'ScreenShareStart', { room_id: ROOM3 });
    await sleep(400);

    // The reconnect: a NEW socket rejoins the same room before the old one is
    // reaped. It does NOT re-announce anything — a pre-0.6.10 client.
    const bNew = await connect(bId, bName);
    send(bNew, 'JoinRoom', { room_id: ROOM3 });
    await sleep(300);
    inbox.length = 0;

    bOld.terminate();
    await sleep(1500);

    const ss = inbox.find(m => m.type === 'StreamStopped' && m.payload?.room_id === ROOM3 && m.payload?.streamer_id === bId);
    const sh = inbox.find(m => m.type === 'ScreenShareStopped' && m.payload?.room_id === ROOM3 && m.payload?.streamer_id === bId);
    ck('zombie: NO StreamStopped — B is still in the room, audio must survive', !ss);
    ck('zombie: A receives ScreenShareStopped for the dead connection', !!sh);

    // The user is still in the room via the new connection, so they must NOT
    // be announced as having left it.
    const ul = inbox.find(m => m.type === 'UserLeft' && m.payload?.room_id === ROOM3 && m.payload?.user_id === bId);
    ck('zombie: NO UserLeft (still present on the new connection)', !ul);

    // The stale share must be gone from the room state, or JoinRoom replays a
    // bogus ScreenShareStarted to every later joiner. Voice presence, by
    // contrast, must still be there — that is what the roster is built from.
    const c = await connect(aId, aName);
    const inbox2 = [];
    collect(c, inbox2);
    send(c, 'JoinRoom', { room_id: ROOM3 });
    await sleep(700);
    const replay = inbox2.find(m => m.type === 'ScreenShareStarted' && m.payload?.room_id === ROOM3);
    ck('zombie: a later joiner gets NO replayed ScreenShareStarted', !replay);
    const voice = inbox2.find(m => m.type === 'StreamStarted' && m.payload?.room_id === ROOM3 && m.payload?.streamer?.id === bId);
    ck('zombie: a later joiner IS told B is in voice (inherited claim)', !!voice);

    // The inherited claim must still resolve: when the SURVIVING connection
    // goes, that is a real departure and peers must finally be told.
    inbox.length = 0;
    bNew.terminate();
    await sleep(1500);
    const ss2 = inbox.find(m => m.type === 'StreamStopped' && m.payload?.room_id === ROOM3 && m.payload?.streamer_id === bId);
    ck('zombie: StreamStopped DOES fire when the surviving connection dies', !!ss2);

    a.terminate(); c.terminate();
}

// ---- Case 3b: same reconnect, but the client DOES re-claim (0.6.10+) --------
// The updated client re-announces on `wsConnected`, so the fresh connection
// already holds both claims when the zombie is reaped. Nothing at all may be
// announced — not even the share — and the share must still be live for later
// joiners, because it genuinely is.
{
    await sleep(300);
    const ROOM3B = ROOM + '_zombie_reclaim';
    const a = await connect(aId, aName);
    const bOld = await connect(bId, bName);
    const inbox = [];
    collect(a, inbox);
    send(a, 'JoinRoom', { room_id: ROOM3B });
    send(bOld, 'JoinRoom', { room_id: ROOM3B });
    await sleep(300);
    send(bOld, 'StartStream', { room_id: ROOM3B });
    send(bOld, 'ScreenShareStart', { room_id: ROOM3B });
    await sleep(400);

    const bNew = await connect(bId, bName);
    send(bNew, 'JoinRoom', { room_id: ROOM3B });
    send(bNew, 'StartStream', { room_id: ROOM3B });      // the 0.6.10 re-claim
    send(bNew, 'ScreenShareStart', { room_id: ROOM3B });
    await sleep(400);
    inbox.length = 0;

    bOld.terminate();
    await sleep(1500);

    const ss = inbox.find(m => m.type === 'StreamStopped' && m.payload?.room_id === ROOM3B);
    const sh = inbox.find(m => m.type === 'ScreenShareStopped' && m.payload?.room_id === ROOM3B);
    ck('re-claim: NO StreamStopped (the new connection holds voice)', !ss);
    ck('re-claim: NO ScreenShareStopped (the new connection holds the share)', !sh);

    const c = await connect(aId, aName);
    const inbox2 = [];
    collect(c, inbox2);
    send(c, 'JoinRoom', { room_id: ROOM3B });
    await sleep(700);
    const replay = inbox2.find(m => m.type === 'ScreenShareStarted' && m.payload?.room_id === ROOM3B);
    ck('re-claim: a later joiner IS told about the still-live share', !!replay);

    a.terminate(); bNew.terminate(); c.terminate();
}

// ---- Case 4: EXPLICIT stop takes effect immediately ------------------------
// A stop must ALWAYS be announced and always clear the derived view, so state
// and event agree and a later joiner is never told a stale "is live".
//
// Deliberately NOT connection-scoped: the server cannot tell a live second
// device from a half-open socket awaiting reap (both are registered sessions),
// and scoping it per connection swallowed the stop for up to the ~90s idle
// timeout after any reconnect — the common case. The cost is the pre-existing
// limitation that two devices of one user in the SAME room share presence.
{
    await sleep(300);
    const ROOM4 = ROOM + '_stop';
    const a = await connect(aId, aName);
    const b1 = await connect(bId, bName);
    const b2 = await connect(bId, bName);
    const inbox = [];
    collect(a, inbox);
    send(a, 'JoinRoom', { room_id: ROOM4 });
    send(b1, 'JoinRoom', { room_id: ROOM4 });
    send(b2, 'JoinRoom', { room_id: ROOM4 });
    await sleep(300);
    send(b1, 'StartStream', { room_id: ROOM4 });
    send(b1, 'ScreenShareStart', { room_id: ROOM4 });
    await sleep(400);
    inbox.length = 0;

    send(b1, 'ScreenShareStop', { room_id: ROOM4 });
    await sleep(900);
    const sh = inbox.find(m => m.type === 'ScreenShareStopped' && m.payload?.room_id === ROOM4);
    ck('explicit stop: ScreenShareStopped is announced immediately', !!sh);

    // ...and the room no longer replays it to someone joining afterwards.
    const c = await connect(aId, aName);
    const inbox2 = [];
    collect(c, inbox2);
    send(c, 'JoinRoom', { room_id: ROOM4 });
    await sleep(700);
    const replay = inbox2.find(m => m.type === 'ScreenShareStarted' && m.payload?.room_id === ROOM4);
    ck('explicit stop: no stale ScreenShareStarted replayed to a later joiner', !replay);

    inbox.length = 0;
    send(b1, 'StopStream', { room_id: ROOM4 });
    await sleep(900);
    const ss = inbox.find(m => m.type === 'StreamStopped' && m.payload?.room_id === ROOM4);
    ck('explicit stop: StreamStopped is announced immediately', !!ss);

    a.terminate(); b1.terminate(); b2.terminate(); c.terminate();
}

// ---- Case 5: explicit stop is not blocked by a stale connection ------------
// Regression guard for the reconnect shape: a previous connection of the same
// user still holding a claim must never delay or suppress an explicit stop.
{
    await sleep(300);
    const ROOM5 = ROOM + '_stop_stale';
    const a = await connect(aId, aName);
    const bOld = await connect(bId, bName);
    const bNew = await connect(bId, bName);
    const inbox = [];
    collect(a, inbox);
    send(a, 'JoinRoom', { room_id: ROOM5 });
    send(bOld, 'JoinRoom', { room_id: ROOM5 });
    send(bNew, 'JoinRoom', { room_id: ROOM5 });
    await sleep(300);
    send(bOld, 'StartStream', { room_id: ROOM5 });
    send(bNew, 'StartStream', { room_id: ROOM5 }); // the reconnect re-announces
    await sleep(400);
    inbox.length = 0;

    send(bNew, 'StopStream', { room_id: ROOM5 });
    await sleep(1000);
    const ss = inbox.find(m => m.type === 'StreamStopped' && m.payload?.room_id === ROOM5);
    ck("explicit stop: an older connection's claim does not suppress it", !!ss);

    const c = await connect(aId, aName);
    const inbox2 = [];
    collect(c, inbox2);
    send(c, 'JoinRoom', { room_id: ROOM5 });
    await sleep(700);
    const replay = inbox2.find(m => m.type === 'StreamStarted' && m.payload?.room_id === ROOM5 && m.payload?.streamer?.id === bId);
    ck('explicit stop: no stale StreamStarted replayed after it', !replay);

    a.terminate(); bOld.terminate(); bNew.terminate(); c.terminate();
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
