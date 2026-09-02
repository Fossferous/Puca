// Live acceptance for the Batch 7 permission-bit enforcement (2026-08-10 audit).
//
// The role editor offered 13 permission checkboxes that NO handler ever read.
// This covers the ones with a real server-side chokepoint. Each check drives
// BOTH halves: a member DENIED the bit is refused, and a member who HOLDS it
// still succeeds — a gate that refused everyone would pass a one-sided test.
//
// Covers:
//   READ_MESSAGE_HISTORY (1<<2)  get_messages
//   ADD_REACTIONS        (1<<6)  add_reaction
//   CONNECT              (1<<8)  WS JoinRoom on a voice room  (+ SFU token path)
//   VIDEO                (1<<10) WS CameraStart
//   STREAM               (1<<11) WS ScreenShareStart   (NOT StartStream — that
//                                is voice presence, see the ws.rs comment)
//   ATTACH_FILES         (1<<4)  POST /upload naming a channel (X-Puca-Channel)
//
// Prereqs: backend on :3000 against a THROWAWAY db (PGDB + PGPORT must match).
// Usage: PGDB=puca_sec_test PGPORT=5433 node tests/batch7-permbits-live.mjs
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
const mintJwt = (sub, username) => {
    const head = b64u({ alg: 'HS256', typ: 'JWT' });
    const body = b64u({ sub, username, tv: 0, exp: Math.floor(Date.now() / 1000) + 3600 });
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

const P = {
    VIEW_CHANNEL: 1 << 0, SEND_MESSAGES: 1 << 1, READ_MESSAGE_HISTORY: 1 << 2, ATTACH_FILES: 1 << 4,
    ADD_REACTIONS: 1 << 6, CONNECT: 1 << 8, SPEAK: 1 << 9,
    VIDEO: 1 << 10, STREAM: 1 << 11,
    // Server-scoped (not channel-overwritable): create_invite resolves SERVER
    // permissions, so it is denied by NOT granting it, never by an overwrite.
    CREATE_INVITE: 1 << 27,
};
const ALL_MEMBER = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.ATTACH_FILES
    | P.ADD_REACTIONS | P.CONNECT | P.SPEAK | P.VIDEO | P.STREAM;

const RUN = Math.random().toString(36).slice(2, 8);
const mkUser = (name) => {
    const u = `b7_${name}_${RUN}`;
    const id = psql1(`INSERT INTO users (username, salt, verifier, key_version, token_version)
                      VALUES ('${u}', '\\x00', '\\x00', 3, 0) RETURNING id`);
    return { id: parseInt(id, 10), username: u, t: mintJwt(parseInt(id, 10), u) };
};

// One server, an @everyone role granting everything a member needs, and a
// per-channel overwrite used to DENY one bit at a time to a specific role.
const owner = mkUser('own');
const srvId = randomUUID();
psql(`INSERT INTO servers (id, name, owner_id) VALUES ('${srvId}', 'permbits-${RUN}', ${owner.id})`);
psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${srvId}', ${owner.id})`);
const everyoneRole = parseInt(psql1(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
    VALUES ('${srvId}', '@everyone', '#99AAB5', ${ALL_MEMBER}, 0, true) RETURNING id`), 10);
const textCh = parseInt(psql1(`INSERT INTO channels (name, type, position, server_id)
    VALUES ('general', 0, 0, '${srvId}') RETURNING id`), 10);
const voiceCh = parseInt(psql1(`INSERT INTO channels (name, type, position, server_id)
    VALUES ('voice', 1, 1, '${srvId}') RETURNING id`), 10);

// "allowed" holds every bit; "denied" gets one bit stripped per test via a
// role-scoped channel overwrite.
const allowed = mkUser('allowed');
const denied = mkUser('denied');
for (const u of [allowed, denied]) psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${srvId}', ${u.id})`);
// A dedicated role for the denied user so a deny overwrite hits only them.
const deniedRole = parseInt(psql1(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
    VALUES ('${srvId}', 'denied-${RUN}', '#888888', 0, 1, false) RETURNING id`), 10);
psql(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('${srvId}', ${denied.id}, ${deniedRole})`);

const denyBit = (channelId, bit) =>
    psql(`INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny)
          VALUES (${channelId}, ${deniedRole}, 0, ${bit})
          ON CONFLICT (channel_id, role_id) DO UPDATE SET deny = ${bit}, allow = 0`);
const clearDeny = (channelId) =>
    psql(`DELETE FROM channel_permission_overwrites WHERE channel_id = ${channelId} AND role_id = ${deniedRole}`);

const wsJoin = (user, roomId, extraMsg) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:3000/ws?token=${user.t}`);
    let err = null, joined = false;
    const done = () => { try { ws.close(); } catch { } resolve({ joined, err }); };
    ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data.toString()); } catch { return; }
        if (m.type === 'Error') err = m.payload?.message ?? 'error';
        if (m.type === 'RoomJoined' || m.type === 'UserJoined' || m.type === 'StreamStarted') joined = true;
    });
    ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'JoinRoom', payload: { room_id: roomId } }));
        if (extraMsg) setTimeout(() => ws.send(JSON.stringify(extraMsg)), 400);
        setTimeout(done, 1200);
    });
    ws.addEventListener('error', () => { err = 'socket error'; done(); });
});

console.log(`\n=== READ_MESSAGE_HISTORY (1<<2) — get_messages ===`);
{
    const msgId = randomUUID();
    psql(`INSERT INTO messages (id, channel_id, user_id, content) VALUES ('${msgId}', ${textCh}, ${owner.id}, 'history-${RUN}')`);
    const ok = await api('GET', `/channels/${textCh}/messages?limit=10`, null, allowed.t);
    check('member WITH history can read messages', ok.status === 200 && Array.isArray(ok.body) && ok.body.length > 0,
        `status=${ok.status} len=${Array.isArray(ok.body) ? ok.body.length : 'n/a'}`);

    denyBit(textCh, P.READ_MESSAGE_HISTORY);
    const no = await api('GET', `/channels/${textCh}/messages?limit=10`, null, denied.t);
    check('member DENIED history is refused', no.status === 403, `status=${no.status}`);
    check('refusal returns no message content', !(Array.isArray(no.body) && no.body.length > 0), JSON.stringify(no.body).slice(0, 80));
    clearDeny(textCh);
}

console.log(`\n=== ADD_REACTIONS (1<<6) — add_reaction ===`);
{
    const msgId = randomUUID();
    psql(`INSERT INTO messages (id, channel_id, user_id, content) VALUES ('${msgId}', ${textCh}, ${owner.id}, 'react-${RUN}')`);
    const ok = await api('POST', `/messages/${msgId}/reactions`, { emoji: '👍' }, allowed.t);
    check('member WITH add-reactions can react', ok.status < 300, `status=${ok.status}`);

    denyBit(textCh, P.ADD_REACTIONS);
    const no = await api('POST', `/messages/${msgId}/reactions`, { emoji: '🎉' }, denied.t);
    check('member DENIED add-reactions is refused', no.status === 403, `status=${no.status}`);
    const wrote = psql1(`SELECT count(*) FROM message_reactions WHERE message_id='${msgId}' AND user_id=${denied.id}`);
    check('no reaction row written for the denied member', wrote === '0', `rows=${wrote}`);
    clearDeny(textCh);
}

console.log(`\n=== CONNECT (1<<8) — voice JoinRoom + SFU token ===`);
{
    const room = `voice_${voiceCh}`;
    const ok = await wsJoin(allowed, room);
    check('member WITH connect joins the voice room', ok.joined && !ok.err, `err=${ok.err}`);

    denyBit(voiceCh, P.CONNECT);
    const no = await wsJoin(denied, room);
    check('member DENIED connect cannot join voice', !no.joined, `joined=${no.joined} err=${no.err}`);

    // SFU tier must enforce the same bit (both halves of the pair).
    psql(`UPDATE channels SET sfu_mode = true WHERE id = ${voiceCh}`);
    const tokNo = await api('GET', `/channels/${voiceCh}/sfu-token`, null, denied.t);
    check('SFU token refused without connect', tokNo.status === 404 || tokNo.status === 403, `status=${tokNo.status}`);
    clearDeny(voiceCh);
    const tokOk = await api('GET', `/channels/${voiceCh}/sfu-token`, null, allowed.t);
    check('SFU token still issued with connect', tokOk.status < 300 || tokOk.status === 503,
        `status=${tokOk.status} body=${JSON.stringify(tokOk.body).slice(0, 80)}`);
    psql(`UPDATE channels SET sfu_mode = false WHERE id = ${voiceCh}`);
}

console.log(`\n=== VIDEO (1<<10) — CameraStart ===`);
{
    const room = `voice_${voiceCh}`;
    denyBit(voiceCh, P.VIDEO);
    const no = await wsJoin(denied, room, { type: 'CameraStart', payload: { room_id: room } });
    check('member DENIED video cannot start camera', no.err !== null, `err=${no.err}`);
    check('but is still allowed into the voice room (only VIDEO was denied)', no.joined, `joined=${no.joined}`);
    clearDeny(voiceCh);
    const ok = await wsJoin(allowed, room, { type: 'CameraStart', payload: { room_id: room } });
    check('member WITH video can start camera', ok.err === null, `err=${ok.err}`);
}

console.log(`\n=== STREAM (1<<11) — ScreenShareStart ===`);
{
    const room = `voice_${voiceCh}`;
    denyBit(voiceCh, P.STREAM);
    const no = await wsJoin(denied, room, { type: 'ScreenShareStart', payload: { room_id: room, stream_id: null } });
    check('member DENIED stream cannot screen share', no.err !== null, `err=${no.err}`);
    check('but voice presence still works (StartStream is NOT gated on STREAM)', no.joined, `joined=${no.joined}`);
    clearDeny(voiceCh);
    const ok = await wsJoin(allowed, room, { type: 'ScreenShareStart', payload: { room_id: room, stream_id: null } });
    check('member WITH stream can screen share', ok.err === null, `err=${ok.err}`);
}

console.log(`\n=== ATTACH_FILES (1<<4) — POST /upload naming a channel ===`);
{
    // The stock client names the channel it is attaching to in a HEADER (a
    // field would be taken as the file body by an older server). No header =
    // not gated (avatars, emoji, sounds, DM attachments).
    const upload = async (user, channelId) => {
        const fd = new FormData();
        fd.append('file', new Blob([`attach-${RUN}`], { type: 'text/plain' }), 'a.txt');
        const res = await fetch(`${BASE}/upload`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${user.t}`, ...(channelId ? { 'X-Puca-Channel': String(channelId) } : {}) },
            body: fd,
        });
        const text = await res.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
        return { status: res.status, body };
    };
    // The browser sends a CORS preflight for a custom header; node fetch does
    // not. Ask the question the browser would, or a header missing from the
    // allow-list passes here and fails for every real client.
    const pre = await fetch(`${BASE}/upload`, { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, x-puca-channel' } });
    const allowHeaders = (pre.headers.get('access-control-allow-headers') || '').toLowerCase();
    check('preflight admits X-Puca-Channel', allowHeaders.includes('x-puca-channel'), `status=${pre.status} allow-headers=${allowHeaders}`);
    const ok = await upload(allowed, textCh);
    check('member WITH attach-files can upload for the channel', ok.status < 300, `status=${ok.status} ${JSON.stringify(ok.body).slice(0, 80)}`);
    denyBit(textCh, P.ATTACH_FILES);
    const no = await upload(denied, textCh);
    check('member DENIED attach-files is refused at the upload door', no.status === 403, `status=${no.status} ${JSON.stringify(no.body).slice(0, 80)}`);
    check('the refusal stored nothing', psql1(`SELECT COUNT(*) FROM uploaded_files WHERE uploader_id = ${denied.id}`) === '0');
    const bare = await upload(denied, null);
    check('an upload naming no channel is not gated', bare.status < 300, `status=${bare.status}`);
    const stranger = await upload(mkUser('stranger'), textCh);
    check('a non-member naming the channel is refused', stranger.status === 403, `status=${stranger.status}`);
    clearDeny(textCh);
}

console.log(`\n=== CREATE_INVITE (1<<27) — POST /servers/:id/invites ===`);
{
    // Server-scoped, so the deny is "absent from every role you hold", not an
    // overwrite. ALL_MEMBER (the @everyone grant above) deliberately omits the
    // bit, so `denied` holds it nowhere; `allowed` gets a role that carries it.
    const inviterRole = parseInt(psql1(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
        VALUES ('${srvId}', 'inviter-${RUN}', '#22aa22', ${P.CREATE_INVITE}, 2, false) RETURNING id`), 10);
    psql(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('${srvId}', ${allowed.id}, ${inviterRole})`);

    const no = await api('POST', `/servers/${srvId}/invites`, { max_uses: 0 }, denied.t);
    check('member WITHOUT create-invite is refused', no.status === 403, `status=${no.status}`);
    const leaked = psql1(`SELECT count(*) FROM server_invites WHERE server_id='${srvId}' AND creator_id=${denied.id}`);
    check('no invite row written for the refused member', leaked === '0', `rows=${leaked}`);

    const ok = await api('POST', `/servers/${srvId}/invites`, { max_uses: 0 }, allowed.t);
    check('member WITH create-invite still succeeds', ok.status < 300 && typeof ok.body?.code === 'string',
        `status=${ok.status} body=${JSON.stringify(ok.body).slice(0, 80)}`);

    // Expiry clamp: i32::MAX hours is ~245,000 years and used to overflow the
    // column on the way in. Clamped to a year, so the row must both EXIST and
    // carry a timestamp inside that year.
    const huge = await api('POST', `/servers/${srvId}/invites`, { max_uses: 0, expires_in_hours: 2147483647 }, allowed.t);
    check('an absurd expires_in_hours is accepted, not 500', huge.status < 300, `status=${huge.status}`);
    if (huge.status < 300 && huge.body?.code) {
        const within = psql1(`SELECT count(*) FROM server_invites
            WHERE code='${huge.body.code}' AND expires_at::timestamptz <= NOW() + INTERVAL '367 days'
              AND expires_at::timestamptz > NOW()`);
        check('the clamped expiry lands inside a year', within === '1', `rows=${within}`);
    }

    // ...and a negative one must not produce an invite that is born expired.
    const neg = await api('POST', `/servers/${srvId}/invites`, { max_uses: 0, expires_in_hours: -5 }, allowed.t);
    if (neg.status < 300 && neg.body?.code) {
        const live = psql1(`SELECT count(*) FROM server_invites
            WHERE code='${neg.body.code}' AND expires_at::timestamptz > NOW()`);
        check('a negative expires_in_hours is clamped forward, not born expired', live === '1', `rows=${live}`);
    } else {
        check('a negative expires_in_hours is handled', false, `status=${neg.status}`);
    }
}

console.log(`\n=== JoinRoom room-id namespace (L8-AUTHZ-5) ===`);
{
    // A room id that is neither channel_<id> nor voice_<id> used to fall
    // through and MINT a room, handing two clients who agreed on a made-up
    // string a server-mediated presence channel with a username roster.
    for (const bogus of [`made_up_${RUN}`, 'dm_1', 'CHANNEL_1', 'channel_']) {
        const r = await wsJoin(allowed, bogus);
        check(`JoinRoom refuses ${JSON.stringify(bogus)}`, !r.joined && r.err !== null,
            `joined=${r.joined} err=${r.err}`);
    }
    // Positive control for the harness itself: a REAL room still joins, so a
    // socket that simply never connected cannot make the four above pass.
    const real = await wsJoin(allowed, `channel_${textCh}`);
    check('a canonical channel room still joins', real.joined && !real.err, `err=${real.err}`);
}
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
