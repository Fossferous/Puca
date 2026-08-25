// Live acceptance matrix for per-channel role permission overwrites
// (migrations/033, src/permissions.rs resolver). Pure HTTP + WS against a
// locally running backend (:3000) — no browser.
//
// Users are inserted directly via psql and driven with locally-minted HS256
// JWTs (same technique as prior live tests; JWT_SECRET from .env), so the SRP
// login flow stays out of scope.
//
// Prereqs: native Postgres up, ./target/debug/sovereign.exe (or release) up.
// Usage: node tests/perm-matrix-live.mjs
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
// WebSocket: Node >=22 global (no 'ws' package needed at repo root)

// BASE and PGDB must point at the SAME instance: the harness inserts users
// straight into PGDB and the backend at BASE looks them up. Pointing them at
// different databases makes every authenticated call 401 (user row not found
// during the token_version check) — which reads exactly like a permission bug.
const BASE = process.env.API || 'http://localhost:3000';
const PGDB = process.env.PGDB || 'puca';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const JWT_SECRET = 'puca_super_secret_key_change_in_production';

const VIEW = 1 << 0, SEND = 1 << 1, CREATE_TASKS = 1 << 23, COMPLETE_TASKS = 1 << 24, MANAGE_TASKS = 1 << 25;

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
    if (!ok) failures++;
};
const psql = (sql) => execFileSync(PSQL,
    ['-U', 'postgres', '-h', 'localhost', '-d', PGDB, '-q', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();
// First non-empty line only (strips any trailing "INSERT 0 1" command tag).
const psql1 = (sql) => psql(sql).split(/\r?\n/).filter(Boolean)[0] ?? '';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mintJwt = (sub, username) => {
    const head = b64u({ alg: 'HS256', typ: 'JWT' });
    const body = b64u({ sub, username, exp: Math.floor(Date.now() / 1000) + 3600 });
    const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
};

const api = (token) => async (method, path, body) => {
    const res = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.clone().json(); } catch { /* non-JSON body */ }
    return { status: res.status, json, text: json ? '' : await res.text() };
};

// --- setup: two fresh users straight into the DB, JWTs minted locally -------
const stamp = Date.now().toString(36);
const ownerName = `pmowner_${stamp}`, memberName = `pmmember_${stamp}`;
const ownerId = Number(psql1(`INSERT INTO users (username, salt, verifier) VALUES ('${ownerName}', '\\x00', '\\x00') RETURNING id`));
const memberId = Number(psql1(`INSERT INTO users (username, salt, verifier) VALUES ('${memberName}', '\\x00', '\\x00') RETURNING id`));
const owner = api(mintJwt(ownerId, ownerName));
const member = api(mintJwt(memberId, memberName));
console.log(`# owner=${ownerName}(${ownerId}) member=${memberName}(${memberId})`);

const srv = await owner('POST', '/servers', { name: `PermMatrix ${stamp}` });
const serverId = srv.json?.id;
check('owner creates server', srv.status === 200 && !!serverId, JSON.stringify(srv));
// Join through an INVITE, not a bare /join. Since the 2026-07-24 hardening
// ("a server UUID is not a secret"), a private server refuses a direct join
// with 403 — which silently broke this whole suite at setup: every later
// assertion failed because the member was never in the server. The failure
// looked like 16 permission regressions and was really one dead harness.
const invite = await owner('POST', `/servers/${serverId}/invites`, { max_uses: 5, expires_in_hours: 1 });
const inviteCode = invite.json?.code;
check('owner creates invite', invite.status === 200 && !!inviteCode, JSON.stringify(invite));
const joined = await member('POST', `/invites/${inviteCode}/join`);
check('member joins via invite', joined.status === 200 || joined.status === 409, JSON.stringify(joined));
const chan = await owner('POST', `/servers/${serverId}/channels`,
    { name: 'feature-requests', channel_type: 0, has_checklist: true });
const channelId = chan.json?.id;
check('owner creates checklist channel', chan.status === 200 && !!channelId, JSON.stringify(chan));

const roles = await owner('GET', `/servers/${serverId}/roles`);
const everyone = (roles.json || []).find(r => r.is_default);
check('found @everyone role', !!everyone, JSON.stringify(roles.json));
const everyoneId = everyone?.id;

// Member WS: capture ChannelPermsChanged + room-eviction signals.
const wsEvents = [];
const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?token=${mintJwt(memberId, memberName)}`);
ws.onerror = () => { };
await new Promise((res) => { ws.onopen = res; setTimeout(res, 3000); });
// The timeout above resolves whether or not the socket opened. Every
// "member received X" and "member did NOT receive Y" check downstream is
// meaningless against a dead socket — and the negative ones would report green.
check('ws member socket actually opened', ws.readyState === WebSocket.OPEN,
    `readyState=${ws.readyState}`);
ws.onmessage = (ev) => { try { wsEvents.push(JSON.parse(ev.data.toString())); } catch { } };
ws.send(JSON.stringify({ type: 'JoinRoom', payload: { room_id: `channel_${channelId}` } }));
await new Promise(r => setTimeout(r, 400));

// --- (a) baseline: default perms after backfill/DEFAULT_MEMBER --------------
let r = await member('GET', `/servers/${serverId}/channels`);
const baselineChan = (r.json || []).find(c => c.id === channelId);
check('a1 member sees channel in list', !!baselineChan);
check('a2 my_permissions present on channel', typeof baselineChan?.my_permissions === 'number');
r = await member('POST', `/channels/${channelId}/tasks`, { description: 'member idea 1' });
const memberTaskId = r.json?.id;
check('a3 member creates task (CREATE_TASKS default)', r.status === 200 && !!memberTaskId, JSON.stringify(r));
const ot = await owner('POST', `/channels/${channelId}/tasks`, { description: 'owner task' });
const ownerTaskId = ot.json?.id;
r = await member('PATCH', `/tasks/${memberTaskId}`, { is_completed: true });
check('a4 member completes task (COMPLETE_TASKS default)', r.status === 200, JSON.stringify(r));
await member('PATCH', `/tasks/${memberTaskId}`, { is_completed: false });

// --- (b) feature-request mode: deny COMPLETE|MANAGE for @everyone -----------
r = await owner('PUT', `/channels/${channelId}/overwrites/${everyoneId}`,
    { allow: 0, deny: COMPLETE_TASKS | MANAGE_TASKS });
check('b0 owner PUTs deny COMPLETE|MANAGE overwrite', r.status === 200, JSON.stringify(r));
r = await member('POST', `/channels/${channelId}/tasks`, { description: 'member idea 2' });
const idea2 = r.json?.id;
check('b1 member can still add tasks', r.status === 200, JSON.stringify(r));
r = await member('PATCH', `/tasks/${memberTaskId}`, { is_completed: true });
check('b2 member CANNOT complete any task (403)', r.status === 403, `got ${r.status}`);
r = await member('PATCH', `/tasks/${idea2}`, { description: 'member idea 2 (edited)' });
check('b3 member edits OWN task description', r.status === 200, JSON.stringify(r));
r = await member('PATCH', `/tasks/${ownerTaskId}`, { description: 'defaced' });
check('b4 member CANNOT edit owner task (403)', r.status === 403, `got ${r.status}`);
r = await member('DELETE', `/tasks/${ownerTaskId}`);
check('b5 member CANNOT delete owner task (403)', r.status === 403, `got ${r.status}`);
r = await member('DELETE', `/tasks/${idea2}`);
check('b6 member deletes OWN task', r.status === 200 || r.status === 204, `got ${r.status}`);
// owner (ADMINISTRATOR bypass) unaffected:
r = await owner('PATCH', `/tasks/${memberTaskId}`, { is_completed: true });
check('b7 owner still completes tasks (admin bypass)', r.status === 200, JSON.stringify(r));

// --- (c) read-only: deny SEND, keep VIEW ------------------------------------
r = await owner('PUT', `/channels/${channelId}/overwrites/${everyoneId}`,
    { allow: 0, deny: SEND | COMPLETE_TASKS | MANAGE_TASKS });
check('c0 owner sets read-only overwrite', r.status === 200, JSON.stringify(r));
r = await member('GET', `/channels/${channelId}/messages?limit=10`);
check('c1 member still reads messages', r.status === 200, `got ${r.status}`);
r = await member('POST', `/channels/${channelId}/messages`, { content: 'should be blocked' });
check('c2 member cannot send (403)', r.status === 403, `got ${r.status}`);

// --- (d) hidden: deny VIEW ---------------------------------------------------
wsEvents.length = 0;
// Losing VIEW must rotate the channel key, like any other revocation. The
// server's member_generation is what drives that: clients compare it against
// the generation the current epoch was minted for and re-key when they differ.
// Until this bump existed, a revoked member kept a valid copy of the CK — and
// of the SFU media key derived from it — for content produced afterwards.
const genBefore = Number(psql1(`SELECT member_generation FROM servers WHERE id = '${serverId}'`));
r = await owner('PUT', `/channels/${channelId}/overwrites/${everyoneId}`,
    { allow: 0, deny: VIEW });
check('d0 owner sets VIEW deny', r.status === 200, JSON.stringify(r));
const genAfter = Number(psql1(`SELECT member_generation FROM servers WHERE id = '${serverId}'`));
check('d0b revoking VIEW bumps member_generation (forces key rotation)',
    genAfter > genBefore, `before=${genBefore} after=${genAfter}`);
await new Promise(res => setTimeout(res, 600));
r = await member('GET', `/servers/${serverId}/channels`);
// `!(r.json || []).some(...)` alone passes when the REQUEST failed — a 401 or a
// 500 yields no json, hence no match, hence green. Demand a real list first.
check('d1 channel gone from member list',
    r.status === 200 && Array.isArray(r.json) && !r.json.some(c => c.id === channelId),
    `status=${r.status} json=${JSON.stringify(r.json)}`);
r = await member('GET', `/channels/${channelId}/messages?limit=10`);
check('d2 messages 404 (existence hidden)', r.status === 404, `got ${r.status}`);
r = await member('GET', `/channels/${channelId}/tasks`);
check('d3 tasks 404', r.status === 404, `got ${r.status}`);
r = await member('GET', `/channels/${channelId}/keys`);
check('d4 channel-key fetch denied', r.status === 404 || r.status === 403, `got ${r.status}`);
r = await member('GET', `/channels/${channelId}/member-keys`);
check('d5 member-keys denied', r.status === 404 || r.status === 403, `got ${r.status}`);
r = await member('GET', `/servers/${serverId}/unread`);
check('d6 unread counts omit hidden channel',
    r.status === 200 && Array.isArray(r.json?.channels)
        && !r.json.channels.some(c => c.channel_id === channelId),
    `status=${r.status} json=${JSON.stringify(r.json)}`);
r = await owner('GET', `/channels/${channelId}/member-keys`);
check('d7 owner member-keys exclude VIEW-denied member', r.status === 200 && !(r.json || []).some(m => m.user_id === memberId), JSON.stringify(r.json));
const gotPermsChanged = wsEvents.some(e => e.type === 'ChannelPermsChanged' && e.payload?.server_id === serverId);
check('d8 member WS got ChannelPermsChanged', gotPermsChanged);
const gotRoomLeft = wsEvents.some(e => e.type === 'RoomLeft' && e.payload?.room_id === `channel_${channelId}`);
check('d9 member evicted from channel room (RoomLeft)', gotRoomLeft, JSON.stringify(wsEvents.map(e => e.type)));
// evicted = no more live ChecklistUpdate. An absence is only evidence if the
// event would otherwise have fired AND the member could still have heard it,
// so assert both positive controls before believing the negative.
wsEvents.length = 0;
const taskPost = await owner('POST', `/channels/${channelId}/tasks`, { description: 'secret task' });
await new Promise(res => setTimeout(res, 600));
check('d10-control the task that should have broadcast was actually created',
    taskPost.status >= 200 && taskPost.status < 300, JSON.stringify(taskPost));
check('d10-control member socket still open to receive it',
    ws.readyState === WebSocket.OPEN, `readyState=${ws.readyState}`);
check('d10 no ChecklistUpdate reaches evicted member', !wsEvents.some(e => e.type === 'ChecklistUpdate'));

// --- (e) removal restores access --------------------------------------------
r = await owner('DELETE', `/channels/${channelId}/overwrites/${everyoneId}`);
check('e0 owner deletes overwrite', r.status === 204 || r.status === 200, `got ${r.status}`);
r = await member('GET', `/servers/${serverId}/channels`);
check('e1 channel visible to member again', (r.json || []).some(c => c.id === channelId));
r = await member('GET', `/channels/${channelId}/tasks`);
check('e2 member lists tasks again', r.status === 200, `got ${r.status}`);

// --- (f) overwrite endpoint hardening ----------------------------------------
r = await member('PUT', `/channels/${channelId}/overwrites/${everyoneId}`, { allow: VIEW, deny: 0 });
check('f1 non-manager cannot PUT overwrites (403)', r.status === 403, `got ${r.status}`);
r = await owner('PUT', `/channels/${channelId}/overwrites/${everyoneId}`, { allow: 1 << 22, deny: 0 });
check('f2 ADMINISTRATOR bit rejected (400)', r.status === 400, `got ${r.status}`);
r = await owner('PUT', `/channels/${channelId}/overwrites/${everyoneId}`, { allow: VIEW, deny: VIEW });
check('f3 allow∩deny overlap rejected (400)', r.status === 400, `got ${r.status}`);

ws.close();
psql(`DELETE FROM servers WHERE id = '${serverId}'`);
psql(`DELETE FROM users WHERE id IN (${ownerId}, ${memberId})`);
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
