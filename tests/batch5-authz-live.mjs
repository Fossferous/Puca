// Live acceptance for the Batch 5 authz-mirror fixes (2026-08-10 audit).
//
// Every check drives the exact abuse the fix closes AND asserts the legitimate
// use of the same endpoint still works — a guard that 403s everyone would pass
// a one-sided test. Each security assertion FAILS against the code as it
// shipped in v0.8.47 (revert-check the guard to confirm).
//
// Covers:
//   M-c  create_emoji accepting a file_id the caller does not own (blob IDOR)
//   M-d  a blocked user still reacting to the blocker's DM
//   M-a  leave_server not rotating the channel key / evicting (member_generation)
//
// Same minted-JWT harness as audit-fixes-live.mjs.
// Prereqs: backend on :3000 against a THROWAWAY db (PGDB + PGPORT must match it).
// Usage: PGDB=puca_sec_test PGPORT=5433 node tests/batch5-authz-live.mjs
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.API || 'http://localhost:3000';
const PGDB = process.env.PGDB || 'puca';
const PGPORT = process.env.PGPORT || '5432';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const JWT_SECRET = 'puca_super_secret_key_change_in_production';

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
    if (!ok) failures++;
};
const psql = (sql) => execFileSync(PSQL,
    ['-U', 'postgres', '-h', 'localhost', '-p', PGPORT, '-d', PGDB, '-q', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();
const psql1 = (sql) => psql(sql).split(/\r?\n/).filter(Boolean)[0] ?? '';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mintJwt = (sub, username, tv = 0) => {
    const head = b64u({ alg: 'HS256', typ: 'JWT' });
    const body = b64u({ sub, username, tv, exp: Math.floor(Date.now() / 1000) + 3600 });
    const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
};
const api = async (method, path, body, token) => {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: (body === undefined || body === null || method === 'GET') ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
};

const RUN = Math.random().toString(36).slice(2, 8);
const mkUser = (name) => {
    const u = `b5_${name}_${RUN}`;
    const id = psql1(`INSERT INTO users (username, salt, verifier, key_version, token_version)
                      VALUES ('${u}', '\\x00', '\\x00', 3, 0) RETURNING id`);
    return { id: parseInt(id, 10), username: u, t: mintJwt(parseInt(id, 10), u) };
};
const mkServer = (ownerId, label) => {
    const sid = randomUUID();
    psql(`INSERT INTO servers (id, name, owner_id) VALUES ('${sid}', '${label}-${RUN}', ${ownerId})`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${sid}', ${ownerId})`);
    const rid = psql1(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
                       VALUES ('${sid}', 'Owner', '#F1C40F', 4194304, 100, false) RETURNING id`);
    psql(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('${sid}', ${ownerId}, ${rid})`);
    const cid = psql1(`INSERT INTO channels (name, type, position, server_id) VALUES ('general', 0, 0, '${sid}') RETURNING id`);
    return { id: sid, roleId: parseInt(rid, 10), channelId: parseInt(cid, 10) };
};
const mkFile = (uploaderId) => {
    const fid = randomUUID();
    psql(`INSERT INTO uploaded_files (id, uploader_id, original_name, stored_name, mime_type, size_bytes)
          VALUES ('${fid}', ${uploaderId}, 'x.png', '${fid}.png', 'image/png', 128)`);
    return fid;
};

const A = mkUser('a');           // attacker
const V = mkUser('v');           // victim
const srvA = mkServer(A.id, 'attacker');

console.log(`\n=== M-c: create_emoji must reject a file the caller does not own ===`);
{
    const victimFile = mkFile(V.id);
    const r = await api('POST', `/servers/${srvA.id}/emojis`,
        { name: `steal_${RUN}`, file_id: victimFile }, A.t);
    check('create_emoji refuses a foreign file_id', r.status === 403, `status=${r.status}`);
    const rows = psql1(`SELECT count(*) FROM server_emojis WHERE server_id = '${srvA.id}' AND file_id = '${victimFile}'`);
    check('no emoji row was written for the foreign file', rows === '0', `rows=${rows}`);

    const ownFile = mkFile(A.id);
    const ok = await api('POST', `/servers/${srvA.id}/emojis`,
        { name: `mine_${RUN}`, file_id: ownFile }, A.t);
    check('create_emoji still accepts the caller\'s own file', ok.status < 300, `status=${ok.status}`);
}

console.log(`\n=== M-d: a blocked user must not react to the blocker's DM ===`);
{
    // A and V share a DM; V sends a message. Baseline: A can react.
    const convo = randomUUID();
    psql(`INSERT INTO dm_conversations (id, user1_id, user2_id) VALUES ('${convo}', ${A.id}, ${V.id})`);
    const okMsg = randomUUID();
    psql(`INSERT INTO dm_messages (id, conversation_id, sender_id, content) VALUES ('${okMsg}', '${convo}', ${V.id}, 'hi')`);
    const okReact = await api('POST', `/messages/${okMsg}/reactions`, { emoji: '👍' }, A.t);
    check('reaction works on an un-blocked DM', okReact.status < 300, `status=${okReact.status}`);

    // V blocks A. A must no longer be able to react.
    psql(`INSERT INTO blocked_users (blocker_id, blocked_id) VALUES (${V.id}, ${A.id})`);
    const blkMsg = randomUUID();
    psql(`INSERT INTO dm_messages (id, conversation_id, sender_id, content) VALUES ('${blkMsg}', '${convo}', ${V.id}, 'later')`);
    const r = await api('POST', `/messages/${blkMsg}/reactions`, { emoji: '👍' }, A.t);
    check('reaction refused once blocked', r.status === 403, `status=${r.status}`);
    const wrote = psql1(`SELECT count(*) FROM message_reactions WHERE message_id = '${blkMsg}' AND user_id = ${A.id}`);
    check('no reaction row was written while blocked', wrote === '0', `rows=${wrote}`);
}

console.log(`\n=== M-a: leave_server force-evicts the leaver from a live voice room ===`);
{
    // NOTE: member_generation is NOT a valid probe here — migration 015's
    // trigger bumps it on the server_members DELETE itself, so it rises whether
    // or not the evict path runs (it stayed green with the guard removed). The
    // real, distinguishing effect is the live WS eviction: the leaver's socket
    // must receive a RoomLeft for the voice room it was sitting in. Without the
    // broadcast_perms_changed_and_evict call, that RoomLeft never arrives.
    const srvV = mkServer(V.id, 'leavesrv');
    // @everyone default role granting VIEW_CHANNEL(1)+CONNECT(256) so a plain
    // member M is allowed to JoinRoom the voice room.
    psql(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
          VALUES ('${srvV.id}', 'everyone', '#99AAB5', 257, 0, true)`);
    const M = mkUser('m');
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${srvV.id}', ${M.id})`);
    const voiceRoom = `voice_${srvV.channelId}`;

    const ws = new WebSocket(`ws://127.0.0.1:3000/ws`, ['bearer', M.t]);
    let gotRoomLeft = false;
    ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data.toString()); } catch { return; }
        if (m.type === 'RoomLeft' && m.payload?.room_id === voiceRoom) gotRoomLeft = true;
    });
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    ws.send(JSON.stringify({ type: 'JoinRoom', payload: { room_id: voiceRoom } }));
    await new Promise(r => setTimeout(r, 700)); // let the join register server-side

    const r = await api('POST', `/servers/${srvV.id}/leave`, null, M.t);
    check('leave_server succeeds', r.status < 300, `status=${r.status}`);

    // Wait up to 2s for the eviction RoomLeft.
    for (let i = 0; i < 20 && !gotRoomLeft; i++) await new Promise(r => setTimeout(r, 100));
    ws.close();
    check('leaver received RoomLeft (force-evicted from live voice room)', gotRoomLeft, 'no RoomLeft within 2s');

    const stillMember = psql1(`SELECT count(*) FROM server_members WHERE server_id = '${srvV.id}' AND user_id = ${M.id}`);
    check('leaver is removed from server_members', stillMember === '0', `rows=${stillMember}`);
}

console.log(`\n=== M-b: StreamStarted must reach channel VIEWERS only, not every server member ===`);
{
    // A voice channel VIEW-denied to @everyone but allowed to a "viewers" role.
    // Streamer S and viewer VW hold that role; outsider O is a plain member.
    // Under the old presence_audience fan-out, O (shares the server with S)
    // received S's StreamStarted — a cross-channel voice-presence leak. Under
    // the viewer-scoped fan-out, only VW does.
    const owner = mkUser('own');
    const srv = mkServer(owner.id, 'scopesrv');
    const cid = srv.channelId;
    // @everyone default role: VIEW+CONNECT normally...
    const everyoneRole = parseInt(psql1(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
        VALUES ('${srv.id}', 'everyone', '#99AAB5', 257, 0, true) RETURNING id`), 10);
    // ...but DENY VIEW_CHANNEL(1) on THIS voice channel for @everyone.
    psql(`INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny)
          VALUES (${cid}, ${everyoneRole}, 0, 1)`);
    // "viewers" role that re-allows VIEW+CONNECT on this channel.
    const viewersRole = parseInt(psql1(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
        VALUES ('${srv.id}', 'viewers', '#3498DB', 0, 1, false) RETURNING id`), 10);
    psql(`INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny)
          VALUES (${cid}, ${viewersRole}, 257, 0)`);

    const S = mkUser('streamer');
    const VW = mkUser('viewer');
    const O = mkUser('outsider');
    for (const u of [S, VW, O]) psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${srv.id}', ${u.id})`);
    // S and VW get the viewers role; O stays plain @everyone (VIEW-denied here).
    psql(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('${srv.id}', ${S.id}, ${viewersRole})`);
    psql(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('${srv.id}', ${VW.id}, ${viewersRole})`);
    const voiceRoom = `voice_${cid}`;

    const openWs = async (user) => {
        const ws = new WebSocket(`ws://127.0.0.1:3000/ws`, ['bearer', user.t]);
        ws.__got = false;
        ws.addEventListener('message', (ev) => {
            let m; try { m = JSON.parse(ev.data.toString()); } catch { return; }
            if (m.type === 'StreamStarted' && m.payload?.room_id === voiceRoom
                && m.payload?.streamer?.id === S.id) ws.__got = true;
        });
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
        return ws;
    };
    const wsVW = await openWs(VW);
    const wsO = await openWs(O);
    // Join both as listeners first so they're live audience when S streams.
    // (VW may JoinRoom the voice room; O is VIEW-denied so its JoinRoom would be
    // rejected — but the leak we test is the fan-out reaching O regardless of
    // whether O is in the room, so O just stays connected.)
    await new Promise(r => setTimeout(r, 300));

    const wsS = await openWs(S);
    wsS.send(JSON.stringify({ type: 'JoinRoom', payload: { room_id: voiceRoom } })); // auto-emits StreamStarted
    await new Promise(r => setTimeout(r, 1000));
    wsVW.close(); wsO.close(); wsS.close();

    check('a channel viewer receives StreamStarted', wsVW.__got, 'viewer got nothing');
    check('a VIEW-denied member does NOT receive StreamStarted', !wsO.__got, 'outsider received the leak');
}

console.log(`\n=== L8-AUTHZ-6 — the default-server auto-join endpoint is GONE ===`);
{
    // `GET /servers/default` took any valid JWT and inserted a server_members
    // row for a hardcoded well-known server id, with no invite and NO BAN
    // CHECK — while both real join paths check bans. A user banned from that
    // server rejoined by calling this. The route is deleted, so it must 404,
    // and calling it must not create a membership row.
    const banned = mkUser('defban');
    const before = psql1(`SELECT count(*) FROM server_members WHERE user_id = ${banned.id}`);
    const res = await api('GET', '/servers/default', null, banned.t);
    // 404 or 405: axum answers 405 when the path still matches a route for
    // another method. Either proves the auto-join handler is gone; the
    // membership assertion below is the real check.
    check('GET /servers/default is gone (404/405)', res.status === 404 || res.status === 405, `status=${res.status}`);
    const after = psql1(`SELECT count(*) FROM server_members WHERE user_id = ${banned.id}`);
    check('and it joined the caller to nothing', after === before, `before=${before} after=${after}`);

    // Positive control for the harness: the token really does authenticate, so
    // the 404 above is the ROUTE being absent and not a rejected credential.
    const alive = await api('GET', '/servers', null, banned.t);
    check('the same token is accepted on a route that exists', alive.status === 200,
        `status=${alive.status}`);
}
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
