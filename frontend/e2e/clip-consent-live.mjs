// Live proof of the Clips consent protocol (docs/CLIPS.md, Phase 2a) against a
// real backend + a THROWAWAY database. The Rust unit tests pin the pieces
// (union_approvers, the presence log, frame shapes, the consent stamp); only
// executing the routes proves the pieces are WIRED — the query column names,
// the route order (/clips/pending before /clips/:id), the multipart field
// loop, the migration actually applying, the doorbell landing on a delivery
// socket, and the reaper ticking.
//
// Actors: A owns the server (clipper), B and C approve, D/E/F are members used
// as extra proposers (the 5-per-5-min rate limit and the decline ladder are
// per user, so one clipper cannot drive every case), X is a stranger.
//
// Run the backend from a scratch CWD (it writes ./uploads) with:
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/puca_e2e_clips
//   PORT=3001 CLIP_PROPOSAL_TTL_SECS=6 CLIP_MAX_USER_BYTES=1000
//   CLIP_SWEEP_INTERVAL_SECS=5 CLIP_RETENTION_DAYS=1
// then:
//   API=http://127.0.0.1:3001 PGPORT=5433 PGDATABASE=puca_e2e_clips \
//   UPLOADS_DIR=<that cwd>/uploads node frontend/e2e/clip-consent-live.mjs
//
// Not covered here (needs fault injection the live server has no seam for):
// the INSERT-failure path in send_message that deletes the just-consumed
// clip's parts. Read message_handlers.rs for it.
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import WebSocket from 'ws';

const API = process.env.API || 'http://127.0.0.1:3001';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const DB = process.env.PGDATABASE || 'puca_e2e_clips';
const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT || '5433';
const PGUSER = process.env.PGUSER || 'postgres';
const UPLOADS_DIR = process.env.UPLOADS_DIR || null;
const TTL_MS = Number(process.env.CLIP_TTL_MS || 6000);
const CLIP_QUOTA = Number(process.env.CLIP_QUOTA_BYTES || 1000);
// The presence log pads a window by 2 s and the shortest clip is 5 s, so a
// proposer must have been in the room for > 7 s before a 5 s window is
// inside their own presence.
const PRESENCE_MS = 8000;

if (DB === 'puca' && !process.env.I_KNOW_THIS_IS_NOT_PROD) {
    console.error('Refusing to run against a database named "puca" — use a throwaway cluster.');
    process.exit(2);
}

const psql = (sql) => execFileSync(PSQL, ['-U', PGUSER, '-h', PGHOST, '-p', PGPORT, '-d', DB, '-t', '-A', '-q', '-c', sql],
    { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' } }).toString().trim();

let fail = 0, pass = 0;
const ck = (n, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`);
    if (ok) pass++; else fail++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const secret = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).find(l => l.startsWith('JWT_SECRET=')).slice('JWT_SECRET='.length).trim();
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const mint = (sub, username) => {
    const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'HS256' }));
    const now = Math.floor(Date.now() / 1000);
    const p = b64u(JSON.stringify({ sub, username, exp: now + 3600, tv: 0, sst: now }));
    const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${sig}`;
};

async function api(method, path, body, token, extraHeaders) {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            ...(body instanceof FormData || typeof body === 'string' ? {} : { 'Content-Type': 'application/json' }),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(extraHeaders || {}),
        },
        body: body === undefined || body === null ? undefined
            : (body instanceof FormData || typeof body === 'string') ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, text };
}

// ---- users --------------------------------------------------------------------
const RUN = Date.now().toString(36);
const mkUser = (tag) => {
    const username = `clip${tag}_${RUN}`;
    const id = Number(psql(`INSERT INTO users (username, salt, verifier) VALUES ('${username}', '\\x00', '\\x00') RETURNING id`));
    return { id, username, token: mint(id, username), tag };
};
const A = mkUser('A'), B = mkUser('B'), C = mkUser('C'), D = mkUser('D'), E = mkUser('E'), F = mkUser('F'), X = mkUser('X');
console.log(`A=${A.id} B=${B.id} C=${C.id} D=${D.id} E=${E.id} F=${F.id} X=${X.id}`);

// ---- servers + channels ---------------------------------------------------------
const srv = await api('POST', '/servers', { name: `clips-${RUN}` }, A.token);
if (srv.status >= 300) { console.error('SETUP FAIL: create server', srv.status, srv.text); process.exit(2); }
const S = srv.body.id;
const inv = await api('POST', `/servers/${S}/invites`, {}, A.token);
for (const u of [B, C, D, E, F]) {
    const j = await api('POST', `/invites/${inv.body.code}/join`, {}, u.token);
    if (j.status >= 300) { console.error('SETUP FAIL: join', u.tag, j.status, j.text); process.exit(2); }
}
const mkChan = async (name, type) => {
    const r = await api('POST', `/servers/${S}/channels`, { name, channel_type: type }, A.token);
    if (r.status >= 300) { console.error('SETUP FAIL: channel', name, r.status, r.text); process.exit(2); }
    return r.body.id;
};
const T1 = await mkChan('clips-text-1', 0);
const T2 = await mkChan('clips-text-2', 0);
const V1 = await mkChan('clips-voice-1', 1);
const V2 = await mkChan('clips-voice-2', 1);
const srv2 = await api('POST', '/servers', { name: `clips-other-${RUN}` }, A.token);
const S2 = srv2.body.id;
const T3 = (await api('POST', `/servers/${S2}/channels`, { name: 'other-text', channel_type: 0 }, A.token)).body.id;
// E is a member of BOTH servers, so a cross-server target reaches the
// same-server rule (400) instead of stopping at "not a member" (403).
{
    const inv2 = await api('POST', `/servers/${S2}/invites`, {}, A.token);
    const j = await api('POST', `/invites/${inv2.body.code}/join`, {}, E.token);
    if (j.status >= 300) { console.error('SETUP FAIL: E join S2', j.status, j.text); process.exit(2); }
}
console.log(`S=${S} T1=${T1} T2=${T2} V1=${V1} V2=${V2}  S2=${S2} T3=${T3}\n`);

// ---- ws helpers -----------------------------------------------------------------
const connect = (u, opts = {}) => new Promise((res, rej) => {
    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws${opts.delivery ? '?mode=delivery' : ''}`, ['bearer', u.token]);
    ws.inbox = [];
    ws.on('message', (d) => { try { ws.inbox.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
    ws.on('open', () => res(ws));
    ws.on('error', rej);
});
const send = (ws, type, payload) => ws.send(JSON.stringify({ type, payload }));
const closeWs = (ws) => new Promise(r => { ws.once('close', r); ws.close(); });
const waitFor = async (ws, pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const hit = ws.inbox.find(pred);
        if (hit) return hit;
        await sleep(50);
    }
    return null;
};
const clipFrames = (ws) => ws.inbox.filter(m => typeof m.type === 'string' && m.type.startsWith('Clip'));
const drain = (ws) => { ws.inbox.length = 0; };
const join = (ws, chan) => send(ws, 'JoinRoom', { room_id: `voice_${chan}` });
const leave = (ws, chan) => send(ws, 'LeaveRoom', { room_id: `voice_${chan}` });

const propose = (u, voice, over = {}) => api('POST', `/channels/${voice}/clips`,
    { target_channel_id: T1, duration_ms: 5000, ended_ago_ms: 0, declared_participants: [], ...over }, u.token);
const vote = (u, id, approve) => api('POST', `/clips/${id}/vote`, { approve }, u.token);
const getClip = (u, id) => api('GET', `/clips/${id}`, null, u.token);
const cancel = (u, id) => api('DELETE', `/clips/${id}`, null, u.token);
const approverIds = (r) => (r.body?.approvers || []).map(a => a.id);
const noNames = (frames) => {
    const s = JSON.stringify(frames);
    return !/username|voter|"by"|display_name/.test(s) && !s.includes(A.username);
};
const uploadPart = async (u, clipId, idx, bytes, order = 'kind-first') => {
    const fd = new FormData();
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    if (order === 'kind-first') {
        fd.append('kind', 'clip');
        if (clipId !== undefined) fd.append('clip_id', clipId);
        if (idx !== undefined) fd.append('part_index', String(idx));
        fd.append('file', blob, 'clip.part');
    } else {
        fd.append('file', blob, 'clip.part');
        fd.append('kind', 'clip');
        fd.append('clip_id', clipId);
        fd.append('part_index', String(idx));
    }
    return api('POST', '/upload', fd, u.token);
};
const uploadPlain = async (u, bytes, name = 'note.bin') => {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
    return api('POST', '/upload', fd, u.token);
};
const fileRow = (id) => psql(`SELECT kind, COALESCE(clip_id::text,''), COALESCE(clip_part_index::text,''), stored_name FROM uploaded_files WHERE id = '${id}'::uuid`).split('|');
const onDisk = (stored) => UPLOADS_DIR ? existsSync(pjoin(UPLOADS_DIR, stored)) : null;

const sockets = [];
let d, e, f, tDEF;
try {
    // ---- t0: A, B (two sockets), C join V1 -----------------------------------------
    const a = await connect(A), b = await connect(B), b2 = await connect(B), c = await connect(C);
    sockets.push(a, b, c);
    join(a, V1); join(b, V1); join(c, V1); join(b2, V1);
    await sleep(300);
    // (3b) B's SECOND connection streams, stops, leaves — the span must not close.
    send(b2, 'StartStream', { room_id: `voice_${V1}` });
    await sleep(200);
    send(b2, 'StopStream', { room_id: `voice_${V1}` });
    await sleep(200);
    leave(b2, V1);
    await sleep(200);
    await closeWs(b2);
    const tJoin = Date.now();

    // ---- (1) server settings --------------------------------------------------------
    {
        const r0 = await api('PATCH', `/servers/${S}/settings`, { clips_enabled: true }, B.token);
        ck('settings: non-owner PATCH is 403', r0.status === 403, `status=${r0.status}`);
        // S1 (0.8.118+): clips cannot be turned on without a pinned text channel —
        // this harness predated the rule and enabled first, which now 400s.
        const r1u = await api('PATCH', `/servers/${S}/settings`, { clips_enabled: true, clip_max_seconds: 120 }, A.token);
        ck('settings: enabling clips with no pinned channel → 400 (S1)', r1u.status === 400, `status=${r1u.status} ${r1u.text}`);
        const r1 = await api('PATCH', `/servers/${S}/settings`, { clips_enabled: true, clip_max_seconds: 120, clip_channel_id: T1 }, A.token);
        ck('settings: owner PATCH 200', r1.status === 200, `status=${r1.status} ${r1.text}`);
        const list = await api('GET', '/servers', null, A.token);
        const me = (list.body || []).find(s => s.id === S);
        ck('settings: read back clips_enabled=true, clip_max_seconds=120, clip_channel_id=T1',
            me?.clips_enabled === true && me?.clip_max_seconds === 120 && me?.clip_channel_id === T1,
            JSON.stringify({ e: me?.clips_enabled, m: me?.clip_max_seconds, c: me?.clip_channel_id }));
        const other = (list.body || []).find(s => s.id === S2);
        ck('settings: untouched server reads clips_enabled=false, clip_max_seconds=120 (default)',
            other?.clips_enabled === false && other?.clip_max_seconds === 120, JSON.stringify({ e: other?.clips_enabled, m: other?.clip_max_seconds }));
        // is_public: never returned by any read endpoint until 2026-08-19, which made
        // the settings modal seed its toggle from `?? false` and every Save silently
        // un-publish a public server. The read-back is the whole point.
        const pub = await api('PATCH', `/servers/${S}/settings`, { is_public: true }, A.token);
        const mePub = ((await api('GET', '/servers', null, A.token)).body || []).find(s => s.id === S);
        ck('settings: is_public round-trips through GET /servers', pub.status === 200 && mePub?.is_public === true, `${pub.status} is_public=${mePub?.is_public}`);
        await api('PATCH', `/servers/${S}/settings`, { is_public: false }, A.token);
        const mePriv = ((await api('GET', '/servers', null, A.token)).body || []).find(s => s.id === S);
        ck('settings: ...and back to private', mePriv?.is_public === false, `is_public=${mePriv?.is_public}`);
        const lo = await api('PATCH', `/servers/${S}/settings`, { clip_max_seconds: 30 }, A.token);
        const hi = await api('PATCH', `/servers/${S}/settings`, { clip_max_seconds: 601 }, A.token);
        ck('settings: clip_max_seconds 30 / 601 → 400', lo.status === 400 && hi.status === 400, `${lo.status}/${hi.status}`);
        const xs = await api('PATCH', `/servers/${S}/settings`, { clip_channel_id: T3 }, A.token);
        const vc = await api('PATCH', `/servers/${S}/settings`, { clip_channel_id: V1 }, A.token);
        ck('settings: pin to other-server channel / voice channel → 400', xs.status === 400 && vc.status === 400, `${xs.status}/${vc.status}`);
        const pin = await api('PATCH', `/servers/${S}/settings`, { clip_channel_id: T1 }, A.token);
        const me2 = ((await api('GET', '/servers', null, A.token)).body || []).find(s => s.id === S);
        ck('settings: pin to own text channel 200 + read back', pin.status === 200 && me2?.clip_channel_id === T1, `${pin.status} pin=${me2?.clip_channel_id}`);
        // The pin is enforced (before the log, before the rate limiter).
        const pinned = await propose(A, V1, { target_channel_id: T2 });
        ck('propose: pinned server refuses another target with 403', pinned.status === 403, `status=${pinned.status} ${pinned.text}`);
        // S1: clearing the pin while clips are ON is refused and the pin is kept
        // (before the rule this cleared it, and every later proposal here relies on it).
        const clear = await api('PATCH', `/servers/${S}/settings`, { clip_channel_id: 0 }, A.token);
        const me3 = ((await api('GET', '/servers', null, A.token)).body || []).find(s => s.id === S);
        ck('settings: clip_channel_id 0 while enabled → 400, pin kept (S1)', clear.status === 400 && me3?.clip_channel_id === T1, `${clear.status} pin=${me3?.clip_channel_id}`);
    }

    // presence: everybody has been in V1 long enough for a 5 s window
    await sleep(Math.max(0, PRESENCE_MS - (Date.now() - tJoin)));

    // ---- (2) clips off → 409, on → 201 --------------------------------------------
    let clipA1;
    {
        await api('PATCH', `/servers/${S}/settings`, { clips_enabled: false }, A.token);
        const off = await propose(A, V1);
        ck('propose: clips_enabled=false → 409', off.status === 409, `status=${off.status} ${off.text}`);
        await api('PATCH', `/servers/${S}/settings`, { clips_enabled: true }, A.token);
        drain(a); drain(b); drain(c);
        const on = await propose(A, V1);
        ck('propose: 201 with clips on', on.status === 201, `status=${on.status} ${on.text}`);
        clipA1 = on.body?.clip_id;
        // (3b) B is still an approver although its second socket streamed, stopped and left > 8 s ago
        ck('approvers: exactly {B, C} (B kept through the second socket\'s StopStream + LeaveRoom)',
            same(approverIds(on), [B.id, C.id]), JSON.stringify(approverIds(on)));
        ck('approvers: names + online flags go to the proposer', (on.body.approvers || []).every(x => typeof x.username === 'string' && x.online === true), JSON.stringify(on.body.approvers));
        ck('propose: solo=false, resolved=false, expires_in_ms ≤ TTL', on.body.solo === false && on.body.resolved === false && on.body.expires_in_ms <= TTL_MS && on.body.expires_in_ms > 0, JSON.stringify({ solo: on.body.solo, e: on.body.expires_in_ms }));
        const pb = await waitFor(b, m => m.type === 'ClipProposed' && m.payload?.clip_id === clipA1);
        const pc = await waitFor(c, m => m.type === 'ClipProposed' && m.payload?.clip_id === clipA1);
        ck('doorbell: B and C receive ClipProposed', !!pb && !!pc, JSON.stringify(pb?.payload));
        ck('doorbell: ClipProposed carries only clip_id + expires_in_ms', pb && same(Object.keys(pb.payload), ['clip_id', 'expires_in_ms']), JSON.stringify(Object.keys(pb?.payload || {})));
        ck('doorbell: the proposer gets no ClipProposed', !a.inbox.some(m => m.type === 'ClipProposed'));

        const gb = await getClip(B, clipA1);
        ck('GET /clips/:id as approver: reduced view (no approvers list, my_vote=pending, you.*)',
            gb.status === 200 && gb.body.approvers === undefined && gb.body.my_vote === 'pending' && gb.body.approver_count === 2
            && gb.body.you && gb.body.you.still_in_call === true && gb.body.you.had_camera === false && gb.body.proposer?.id === A.id,
            `${gb.status} ${gb.text}`);
        ck('GET /clips/:id as approver: duration is the REAL clip length (not the padded window), ended_ago echoes', gb.body?.duration_ms === 5000 && gb.body?.ended_ago_ms >= 0 && gb.body?.ended_ago_ms < 3000, `d=${gb.body?.duration_ms} e=${gb.body?.ended_ago_ms}`);
        const ga = await getClip(A, clipA1);
        ck('GET /clips/:id as proposer: full view with approvers + no my_vote', ga.status === 200 && Array.isArray(ga.body.approvers) && ga.body.approvers.length === 2 && ga.body.my_vote === undefined && ga.body.you === undefined, `${ga.status}`);
        const gx = await getClip(X, clipA1);
        ck('GET /clips/:id as stranger: 404', gx.status === 404, `status=${gx.status}`);
        const pendB = await api('GET', '/clips/pending', null, B.token);
        const pendA = await api('GET', '/clips/pending', null, A.token);
        const pendX = await api('GET', '/clips/pending', null, X.token);
        ck('GET /clips/pending: approver sees it, proposer sees it (with names), stranger sees none',
            pendB.body?.proposals?.[0]?.clip_id === clipA1 && pendB.body?.proposals?.[0]?.approvers === undefined
            && pendA.body?.proposals?.[0]?.clip_id === clipA1 && Array.isArray(pendA.body?.proposals?.[0]?.approvers)
            && pendX.body?.proposals?.length === 0,
            `${pendB.status}/${pendA.status}/${pendX.status}`);
        const vx = await vote(X, clipA1, true);
        const va = await vote(A, clipA1, true);
        ck('vote: stranger and proposer both get 404 (no oracle)', vx.status === 404 && va.status === 404, `${vx.status}/${va.status}`);
        const one = await propose(A, V1);
        ck('propose: second live proposal by the same user → 409', one.status === 409, `status=${one.status} ${one.text}`);

        // (8) cancel
        drain(b); drain(c);
        const cx = await cancel(B, clipA1);
        ck('cancel: non-proposer → 404', cx.status === 404, `status=${cx.status}`);
        const cc = await cancel(A, clipA1);
        ck('cancel: proposer → 204', cc.status === 204, `status=${cc.status}`);
        const rb = await waitFor(b, m => m.type === 'ClipResolved' && m.payload?.clip_id === clipA1);
        const rc = await waitFor(c, m => m.type === 'ClipResolved' && m.payload?.clip_id === clipA1);
        ck('cancel: approvers receive ClipResolved{closed} (never "cancelled")', rb?.payload?.outcome === 'closed' && rc?.payload?.outcome === 'closed', JSON.stringify([rb?.payload, rc?.payload]));
        const g404 = await getClip(B, clipA1);
        const c404 = await cancel(A, clipA1);
        ck('cancel: afterwards GET 404 and a second DELETE 404', g404.status === 404 && c404.status === 404, `${g404.status}/${c404.status}`);
    }

    // ---- (3) C leaves, then A clips: C is still an approver ---------------------------
    let tCLeft;
    {
        leave(c, V1);
        await sleep(250);
        tCLeft = Date.now();
        drain(b); drain(c);
        const r = await propose(A, V1);
        ck('presence: C left before the Clip but was in the window → approvers exactly {B, C}', r.status === 201 && same(approverIds(r), [B.id, C.id]), `${r.status} ${JSON.stringify(approverIds(r))}`);
        ck('provenance: both are log hits → in_window=true on every ApproverView', (r.body?.approvers || []).length === 2 && (r.body?.approvers || []).every(a => a.in_window === true), JSON.stringify(r.body?.approvers));
        const gc = await getClip(C, r.body?.clip_id);
        ck('GET as C: still_in_call=false after leaving', gc.status === 200 && gc.body?.you?.still_in_call === false, `${gc.status} ${JSON.stringify(gc.body?.you)}`);
        ck('GET as C: you.in_window=true (the log saw C in the window)', gc.body?.you?.in_window === true, JSON.stringify(gc.body?.you));
        await cancel(A, r.body?.clip_id);
    }
    // let C's span fall out of any later 5 s window
    await closeWs(c);
    await sleep(Math.max(0, PRESENCE_MS - (Date.now() - tCLeft)));

    // ---- (4) union adds only; declared offline co-member gets a parked ClipPending -----
    let clipA3;
    {
        const d0 = await connect(D); sockets.push(d0);
        drain(b); drain(d0);
        const r = await propose(A, V1, { declared_participants: [C.id, D.id, X.id, 999999999] });
        clipA3 = r.body?.clip_id;
        ck('union: declared co-members added (C offline, D never in room), stranger + unknown dropped → {B, C, D}',
            r.status === 201 && same(approverIds(r), [B.id, C.id, D.id]), `${r.status} ${JSON.stringify(approverIds(r))} ${r.text}`);
        {
            const byId = Object.fromEntries((r.body?.approvers || []).map(a => [a.id, a]));
            ck('provenance: B is a log hit (in_window=true); C and D are declared-only (in_window=false)',
                byId[B.id]?.in_window === true && byId[C.id]?.in_window === false && byId[D.id]?.in_window === false, JSON.stringify(r.body?.approvers));
            const gd = await getClip(D, r.body?.clip_id);
            ck('GET as D: you.in_window=false — the approver is told the server did not see them', gd.status === 200 && gd.body?.you?.in_window === false, `${gd.status} ${JSON.stringify(gd.body?.you)}`);
        }
        const pd = await waitFor(d0, m => m.type === 'ClipProposed' && m.payload?.clip_id === clipA3);
        ck('union: D (declared, not in room) is prompted live', !!pd);
        // C is offline: the doorbell is parked as a CONTENT-FREE ClipPending for the delivery socket.
        const cDel = await connect(C, { delivery: true });
        const parked = await waitFor(cDel, m => m.type === 'ClipPending' && m.payload?.clip_id === clipA3);
        ck('doorbell: offline approver gets ClipPending on the delivery socket', !!parked, JSON.stringify(cDel.inbox.map(m => m.type)));
        ck('doorbell: ClipPending is content-free (clip_id only)', parked && same(Object.keys(parked.payload), ['clip_id']), JSON.stringify(parked?.payload));
        ck('doorbell: no ClipProposed was parked (only the content-free frame)', !cDel.inbox.some(m => m.type === 'ClipProposed'));
        await closeWs(cDel);
        drain(b); drain(d0);
        await cancel(A, clipA3);
        const rd = await waitFor(d0, m => m.type === 'ClipResolved' && m.payload?.clip_id === clipA3);
        ck('union: declared approver gets closed on cancel', rd?.payload?.outcome === 'closed', JSON.stringify(rd?.payload));
        await closeWs(d0);
    }

    // C comes back (visible socket) and rejoins V1 — a NEW span, so it overlaps A's next window.
    const c2 = await connect(C); sockets.push(c2);
    join(c2, V1);
    await sleep(300);

    // ---- (5) approve → resolve; approver-facing frames carry no names -----------------
    let P; // A's approved proposal, approvers {B, C}
    {
        drain(a); drain(b); drain(c2);
        const r = await propose(A, V1);
        P = r.body?.clip_id;
        ck('approve: proposal with approvers {B, C}', r.status === 201 && same(approverIds(r), [B.id, C.id]), `${r.status} ${JSON.stringify(approverIds(r))}`);
        // D, E, F join V1 NOW (after the window is fixed) — they are proposers later.
        d = await connect(D); e = await connect(E); f = await connect(F);
        sockets.push(d, e, f);
        join(d, V1); join(e, V1); join(f, V1);
        tDEF = Date.now();

        const v1 = await vote(B, P, true);
        ck('vote: B approve → 200 {state:pending, 1/2}', v1.status === 200 && v1.body?.state === 'pending' && v1.body?.approved_count === 1 && v1.body?.total === 2, `${v1.status} ${v1.text}`);
        const vu = await waitFor(a, m => m.type === 'ClipVoteUpdate' && m.payload?.clip_id === P);
        ck('vote: proposer receives ClipVoteUpdate{1,2}', vu?.payload?.approved_count === 1 && vu?.payload?.total === 2, JSON.stringify(vu?.payload));
        await sleep(200);
        ck('vote: the other approver (C) receives NO ClipVoteUpdate', !c2.inbox.some(m => m.type === 'ClipVoteUpdate'), JSON.stringify(c2.inbox.map(m => m.type)));
        const again = await vote(B, P, true);
        ck('vote: voting twice → 409 (a vote is final)', again.status === 409, `status=${again.status}`);
        const vd = await vote(D, P, true);
        ck('vote: a room member who is not an approver → 404', vd.status === 404, `status=${vd.status}`);
        const gA = await getClip(A, P);
        ck('GET as proposer mid-vote: approved_count 1, approved=false', gA.body?.approved_count === 1 && gA.body?.approved === false, `${gA.text}`);
        const v2 = await vote(C, P, true);
        ck('vote: C approve → 200 {state:approved, 2/2}', v2.status === 200 && v2.body?.state === 'approved' && v2.body?.approved_count === 2, `${v2.status} ${v2.text}`);
        const ra = await waitFor(a, m => m.type === 'ClipResolved' && m.payload?.clip_id === P);
        const rb = await waitFor(b, m => m.type === 'ClipResolved' && m.payload?.clip_id === P);
        const rc = await waitFor(c2, m => m.type === 'ClipResolved' && m.payload?.clip_id === P);
        ck('resolve: everyone receives ClipResolved{approved}', ra?.payload?.outcome === 'approved' && rb?.payload?.outcome === 'approved' && rc?.payload?.outcome === 'approved', JSON.stringify([ra?.payload, rb?.payload, rc?.payload]));
        ck('resolve: approver-facing Clip* frames carry no names / voter fields', noNames(clipFrames(b)) && noNames(clipFrames(c2)), JSON.stringify(clipFrames(b)));
        const gA2 = await getClip(A, P);
        ck('resolve: proposal is approved + TTL extended for the upload (expires_in_ms > TTL)', gA2.body?.approved === true && gA2.body?.resolved === true && gA2.body?.expires_in_ms > TTL_MS, `${gA2.text}`);
        const late = await vote(C, P, false);
        ck('vote after resolution → 409 (already answered)', late.status === 409, `status=${late.status}`);
    }

    // ---- (12) upload gating ------------------------------------------------------------
    let id0, id1, stored0, stored1;
    {
        const bytes = (n, fill) => new Uint8Array(n).fill(fill);
        const other = await uploadPart(B, P, 0, bytes(100, 1));
        ck('upload: kind=clip under someone else\'s approved clip → 403', other.status === 403, `${other.status} ${other.text}`);
        const unknown = await uploadPart(A, randomUUID(), 0, bytes(100, 1));
        ck('upload: unknown clip_id → 403 (not 404 — no oracle, no body read)', unknown.status === 403, `${unknown.status} ${unknown.text}`);
        const noIdx = await uploadPart(A, P, undefined, bytes(100, 1));
        ck('upload: kind=clip without part_index → 400', noIdx.status === 400, `${noIdx.status} ${noIdx.text}`);
        const noId = await uploadPart(A, undefined, 0, bytes(100, 1));
        ck('upload: kind=clip without clip_id → 400', noId.status === 400, `${noId.status} ${noId.text}`);
        const big = await uploadPart(A, P, 64, bytes(100, 1));
        const neg = await uploadPart(A, P, -1, bytes(100, 1));
        ck('upload: part_index 64 / -1 → 413', big.status === 413 && neg.status === 413, `${big.status}/${neg.status}`);
        const p0 = await uploadPart(A, P, 0, bytes(100, 7));
        ck('upload: owner, approved, part 0 → 200', p0.status === 200 && typeof p0.body?.id === 'string', `${p0.status} ${p0.text}`);
        id0 = p0.body?.id;
        const row0 = fileRow(id0);
        ck('upload: row is kind=clip with clip_id + clip_part_index=0', row0[0] === 'clip' && row0[1] === P && row0[2] === '0', JSON.stringify(row0));
        stored0 = row0[3];
        ck('upload: part is on disk', UPLOADS_DIR === null || onDisk(stored0) === true, `${stored0}`);
        const p0b = await uploadPart(A, P, 0, bytes(100, 7));
        ck('upload: same (clip_id, part_index) again → same id (idempotent)', p0b.status === 200 && p0b.body?.id === id0, `${p0b.status} ${p0b.body?.id} vs ${id0}`);
        const p1 = await uploadPart(A, P, 1, bytes(100, 8));
        id1 = p1.body?.id; stored1 = fileRow(id1)[3];
        ck('upload: part 1 → 200, distinct id', p1.status === 200 && id1 && id1 !== id0, `${p1.status}`);
        const after = await uploadPart(A, P, 2, bytes(100, 9), 'file-first');
        ck('upload: kind=clip AFTER the file field → 400 (fail closed)', after.status === 400, `${after.status} ${after.text}`);
        const legacy = await uploadPlain(A, bytes(100, 3));
        const lrow = legacy.status === 200 ? fileRow(legacy.body.id) : [];
        ck('upload: legacy single-field upload → 200, kind=attachment, no clip fields', legacy.status === 200 && lrow[0] === 'attachment' && lrow[1] === '' && lrow[2] === '', `${legacy.status} ${JSON.stringify(lrow)}`);
        const served = await api('GET', `/files/${id0}`, null, A.token);
        ck('upload: a clip part is served by GET /files/:id', served.status === 200, `status=${served.status}`);
        const cnt = Number(psql(`SELECT COUNT(*) FROM uploaded_files WHERE clip_id = '${P}'::uuid`));
        ck('upload: exactly 2 part rows under the clip', cnt === 2, `count=${cnt}`);

        // (13) quota separation: CLIP_MAX_USER_BYTES is tiny for this run.
        const over = await uploadPart(A, P, 3, bytes(CLIP_QUOTA, 5));
        ck('quota: clip part past CLIP_MAX_USER_BYTES → 507 with clip wording', over.status === 507 && /clip/i.test(over.text), `${over.status} ${over.text}`);
        const still = await uploadPlain(A, bytes(CLIP_QUOTA, 4));
        ck('quota: an attachment of the same size still uploads (separate bucket)', still.status === 200, `${still.status} ${still.text}`);
        const cnt2 = Number(psql(`SELECT COUNT(*) FROM uploaded_files WHERE clip_id = '${P}'::uuid`));
        ck('quota: the refused part left no row', cnt2 === 2, `count=${cnt2}`);
    }

    // ---- gate BEFORE the body: a PENDING clip (D's) with a truncated body → 403 not 400 ------
    await sleep(Math.max(0, PRESENCE_MS - (Date.now() - tDEF)));
    let clipD1;
    {
        drain(a); drain(b);
        const r = await propose(D, V1);
        clipD1 = r.body?.clip_id;
        ck('D proposes (pending; approvers include A, B, C, E, F)', r.status === 201 && [A.id, B.id, C.id, E.id, F.id].every(x => approverIds(r).includes(x)), `${r.status} ${JSON.stringify(approverIds(r))} ${r.text}`);
        const boundary = '----clipe2e' + RUN;
        const head = [
            `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nclip\r\n`,
            `--${boundary}\r\nContent-Disposition: form-data; name="clip_id"\r\n\r\n${clipD1}\r\n`,
            `--${boundary}\r\nContent-Disposition: form-data; name="part_index"\r\n\r\n0\r\n`,
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.part"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ].join('');
        // Deliberately NO closing boundary: if the server read the file body
        // first it would answer 400 "Failed to read file"; the gate answers 403.
        const truncated = head + 'x'.repeat(4096);
        const t0 = Date.now();
        const g = await api('POST', '/upload', truncated, D.token, { 'Content-Type': `multipart/form-data; boundary=${boundary}` });
        ck('upload: PENDING clip, truncated body → 403 "not approved" (gate ran BEFORE the body)', g.status === 403 && /approved/i.test(g.text), `${g.status} ${g.text} in ${Date.now() - t0} ms`);
        // Positive control for the oracle: the same truncated body under the APPROVED clip is a 400 (body read, incomplete).
        const head2 = head.replace(clipD1, P).replace('name="part_index"\r\n\r\n0', 'name="part_index"\r\n\r\n5');
        const g2 = await api('POST', '/upload', head2 + 'x'.repeat(4096), A.token, { 'Content-Type': `multipart/form-data; boundary=${boundary}` });
        ck('upload: (control) approved clip, truncated body → 400 (the body WAS read)', g2.status === 400, `${g2.status} ${g2.text}`);
        // half-approved: A approves D's proposal, D tries to post → 403
        const va = await vote(A, clipD1, true);
        ck('half-approved: A approves D\'s proposal (pending)', va.status === 200 && va.body?.state === 'pending', `${va.status} ${va.text}`);
        const half = await api('POST', `/channels/${T1}/messages`, { content: 'clip', clip_id: clipD1 }, D.token);
        ck('post: half-approved clip → 403', half.status === 403, `${half.status} ${half.text}`);
        const gd = await getClip(D, clipD1);
        ck('post: the refused post did not consume the proposal', gd.status === 200 && gd.body?.approved_count === 1, `${gd.status}`);
        await cancel(D, clipD1);
    }

    // ---- (11) stamping ------------------------------------------------------------------
    let clipMsgId, plainMsgId;
    {
        const wrong = await api('POST', `/channels/${T2}/messages`, { content: 'clip', clip_id: P }, A.token);
        ck('post: wrong channel → 403', wrong.status === 403, `${wrong.status} ${wrong.text}`);
        const stillLive = await getClip(A, P);
        ck('post: proposal still usable after the wrong-channel refusal', stillLive.status === 200 && stillLive.body?.approved === true, `${stillLive.status}`);
        const forgedBy = await api('POST', `/channels/${T1}/messages`, { content: 'clip', clip_id: P, clip_consent: { approver_count: 99, forged: true } }, B.token);
        ck('post: someone else posting under my approved clip → 403', forgedBy.status === 403, `${forgedBy.status} ${forgedBy.text}`);
        const notMine = await api('POST', `/channels/${T1}/messages`, { content: 'clip', clip_id: randomUUID() }, A.token);
        ck('post: unknown clip_id → 409', notMine.status === 409, `${notMine.status} ${notMine.text}`);
        // B watches the text channel: the LIVE frame must carry the stamp (a
        // freshly posted clip renders its badge without a refetch), and a plain
        // message's frame must not even have the key.
        send(b, 'JoinRoom', { room_id: `channel_${T1}` });
        await sleep(300);
        drain(b);
        const href = 'sovereign-clip:v1?AAAA';
        const posted = await api('POST', `/channels/${T1}/messages`,
            { content: `[Clip 0:05](${href})`, clip_id: P, clip_consent: { approver_count: 99, part_file_ids: ['forged'], solo: true, names: ['x'] } }, A.token);
        ck('post: approved clip → 201', posted.status === 201 || posted.status === 200, `${posted.status} ${posted.text}`);
        clipMsgId = posted.body?.id;
        const cc = posted.body?.clip_consent;
        ck('stamp: server-authored {proposal_id, approver_count:2, part_file_ids:[p0,p1], solo:false} — forged body ignored',
            cc && cc.proposal_id === P && cc.approver_count === 2 && JSON.stringify(cc.part_file_ids) === JSON.stringify([id0, id1]) && cc.solo === false
            && same(Object.keys(cc), ['proposal_id', 'approver_count', 'part_file_ids', 'solo']),
            JSON.stringify(cc));
        const twice = await api('POST', `/channels/${T1}/messages`, { content: 'again', clip_id: P }, A.token);
        ck('post: second post with the same clip_id → 409 (consumed)', twice.status === 409, `${twice.status} ${twice.text}`);
        const gone = await getClip(A, P);
        ck('post: proposal is gone after posting (GET 404)', gone.status === 404, `${gone.status}`);
        const liveClip = await waitFor(b, m => m.type === 'ChatMessage' && m.payload?.message_id === clipMsgId);
        ck('live: ChatMessage frame for the clip post carries the same clip_consent', !!liveClip && JSON.stringify(liveClip.payload.clip_consent) === JSON.stringify(cc), JSON.stringify(liveClip?.payload?.clip_consent));
        const plain = await api('POST', `/channels/${T1}/messages`, { content: 'hello' }, A.token);
        plainMsgId = plain.body?.id;
        const livePlain = await waitFor(b, m => m.type === 'ChatMessage' && m.payload?.message_id === plainMsgId);
        ck('live: a plain message frame has NO clip_consent key (byte-identical to before)', !!livePlain && !Object.prototype.hasOwnProperty.call(livePlain.payload, 'clip_consent'), JSON.stringify(Object.keys(livePlain?.payload || {})));
        ck('post: plain message response has NO clip_consent key', (plain.status === 201 || plain.status === 200) && !Object.prototype.hasOwnProperty.call(plain.body || {}, 'clip_consent'), `${plain.status} ${plain.text}`);
        const list = await api('GET', `/channels/${T1}/messages`, null, B.token);
        const rows = Array.isArray(list.body) ? list.body : (list.body?.messages || []);
        const mClip = rows.find(m => m.id === clipMsgId), mPlain = rows.find(m => m.id === plainMsgId);
        ck('GET messages: clip message carries the same clip_consent; plain message has no key',
            mClip && JSON.stringify(mClip.clip_consent) === JSON.stringify(cc) && mPlain && !Object.prototype.hasOwnProperty.call(mPlain, 'clip_consent'),
            JSON.stringify({ clip: mClip?.clip_consent, plainHas: mPlain ? Object.keys(mPlain).includes('clip_consent') : 'missing' }));
        const ed = await api('PATCH', `/channels/${T1}/messages/${clipMsgId}`, { content: 'edited' }, A.token);
        ck('edit: clip message → 400', ed.status === 400, `${ed.status} ${ed.text}`);
        const edPlain = await api('PATCH', `/channels/${T1}/messages/${plainMsgId}`, { content: 'edited' }, A.token);
        ck('edit: (control) plain message edits fine', edPlain.status < 300, `${edPlain.status} ${edPlain.text}`);
        // delete removes the parts
        const del = await api('DELETE', `/channels/${T1}/messages/${clipMsgId}`, null, A.token);
        ck('delete: clip message → 2xx', del.status < 300, `${del.status} ${del.text}`);
        const left = Number(psql(`SELECT COUNT(*) FROM uploaded_files WHERE clip_id = '${P}'::uuid`));
        ck('delete: part rows removed', left === 0, `count=${left}`);
        ck('delete: part blobs removed from disk', UPLOADS_DIR === null || (onDisk(stored0) === false && onDisk(stored1) === false), `${stored0} ${stored1}`);
        const served = await api('GET', `/files/${id0}`, null, A.token);
        ck('delete: GET /files/:id of a part → 404', served.status === 404, `status=${served.status}`);
    }

    // ---- (6) decline → proposer declined, others closed; ladder ------------------------
    {
        drain(a); drain(b); drain(c2); drain(d);
        const r = await propose(A, V1);
        const id = r.body?.clip_id;
        ck('decline: proposal created (approvers B, C, D, E, F)', r.status === 201 && approverIds(r).length === 5, `${r.status} ${JSON.stringify(approverIds(r))}`);
        const v = await vote(B, id, false);
        ck('decline: B declines → 200 {state:declined}', v.status === 200 && v.body?.state === 'declined', `${v.status} ${v.text}`);
        const ra = await waitFor(a, m => m.type === 'ClipResolved' && m.payload?.clip_id === id);
        const rc = await waitFor(c2, m => m.type === 'ClipResolved' && m.payload?.clip_id === id);
        const rd = await waitFor(d, m => m.type === 'ClipResolved' && m.payload?.clip_id === id);
        ck('decline: proposer gets declined; other approvers get closed', ra?.payload?.outcome === 'declined' && rc?.payload?.outcome === 'closed' && rd?.payload?.outcome === 'closed', JSON.stringify([ra?.payload, rc?.payload, rd?.payload]));
        ck('decline: no approver ever sees the word "declined"', !JSON.stringify(clipFrames(c2).concat(clipFrames(d), clipFrames(b))).includes('declined'));
        const g = await getClip(A, id), gb = await getClip(B, id), vb = await vote(C, id, true);
        ck('decline: afterwards GET 404 for everyone and a late vote 404', g.status === 404 && gb.status === 404 && vb.status === 404, `${g.status}/${gb.status}/${vb.status}`);
        // (15a) the decline ladder: A is refused on V1 for 30 s
        const again = await propose(A, V1);
        ck('ladder: proposer refused with 429 rate_limited after a decline (retry ≤ 30 s)',
            again.status === 429 && again.body?.error === 'rate_limited' && again.body?.retry_after_ms > 0 && again.body?.retry_after_ms <= 30_000, `${again.status} ${again.text}`);
    }

    // ---- (7) expiry (before the reaper) -------------------------------------------------
    let clipD2;
    const tExpiryStart = Date.now();
    {
        drain(d); drain(b);
        const r = await propose(D, V1);
        clipD2 = r.body?.clip_id;
        ck('expiry: D proposes', r.status === 201, `${r.status} ${r.text}`);
        await sleep(TTL_MS + 800);
        const gd = await getClip(D, clipD2), gb = await getClip(B, clipD2), vb = await vote(B, clipD2, true);
        ck('expiry: after TTL, GET 404 for proposer and approver, vote 404 — before any sweep', gd.status === 404 && gb.status === 404 && vb.status === 404, `${gd.status}/${gb.status}/${vb.status}`);
        const pend = await api('GET', '/clips/pending', null, B.token);
        ck('expiry: /clips/pending no longer lists it', !(pend.body?.proposals || []).some(p => p.clip_id === clipD2));
        const next = await propose(D, V1);
        ck('expiry: an expired proposal does not count as "one live" — D can propose again', next.status === 201, `${next.status} ${next.text}`);
        await cancel(D, next.body?.clip_id);
    }

    // ---- (9) proposer disconnect → cancelled ----------------------------------------------
    {
        drain(b);
        const r = await propose(F, V1);
        const id = r.body?.clip_id;
        ck('disconnect: F proposes', r.status === 201, `${r.status} ${r.text}`);
        await closeWs(f);
        const rb = await waitFor(b, m => m.type === 'ClipResolved' && m.payload?.clip_id === id, 4000);
        ck('disconnect: approvers get closed when the proposer\'s last connection drops', rb?.payload?.outcome === 'closed', JSON.stringify(rb?.payload));
        const gb = await getClip(B, id);
        ck('disconnect: GET 404 afterwards', gb.status === 404, `${gb.status}`);
    }

    // ---- (10) denials, each paired with its positive -----------------------------------
    {
        const neg = await propose(E, V1, { ended_ago_ms: -1 });
        const huge = await propose(E, V1, { ended_ago_ms: 600_001 });
        ck('bounds: ended_ago_ms -1 → 422 (u64), 600001 → 400', neg.status === 422 && huge.status === 400, `${neg.status}/${huge.status} ${huge.text}`);
        const short = await propose(E, V1, { duration_ms: 4000 });
        const long = await propose(E, V1, { duration_ms: 121_000 });
        ck('bounds: duration 4 s → 400, 121 s (> server max 120) → 400', short.status === 400 && long.status === 400, `${short.status}/${long.status}`);
        const tv = await propose(E, V1, { target_channel_id: V1 });
        const tx = await propose(E, V1, { target_channel_id: T3 });
        const tn = await propose(E, V1, { target_channel_id: 999999999 });
        // S1: the pin is checked BEFORE any target lookup, so on a pinned server every
        // other target is a flat 403 — the type/server/existence validation of a
        // target now lives on the PIN setting (checked in section 1), not here.
        ck('target: voice channel / other-server channel / unknown → all 403 (pin enforced first, S1)', tv.status === 403 && tx.status === 403 && tn.status === 403, `${tv.status}/${tx.status}/${tn.status} ${tx.text}`);
        const txX = await propose(D, V1, { target_channel_id: T3 });
        ck('target: other-server channel the proposer cannot see → 403/404 (no cross-server oracle)', txX.status === 403 || txX.status === 404, `${txX.status} ${txX.text}`);
        const strangerP = await propose(X, V1);
        ck('propose: non-member → 403/404', strangerP.status === 403 || strangerP.status === 404, `${strangerP.status}`);
        const notIn = await propose(A, V2);
        ck('propose: not in that voice room → 409', notIn.status === 409, `${notIn.status} ${notIn.text}`);
        // window before the proposer's own join
        const early = await propose(E, V1, { ended_ago_ms: 20_000 });
        ck('window: before the proposer\'s own join → 409 window_predates_log + earliest_ms', early.status === 409 && early.body?.error === 'window_predates_log' && typeof early.body?.earliest_ms === 'number', `${early.status} ${early.text}`);
        const okE = await propose(E, V1);
        ck('window: (control) same clip ending now → 201', okE.status === 201, `${okE.status} ${okE.text}`);
        await cancel(E, okE.body?.clip_id);
        // CREATE_CLIPS revoked on @everyone → 403 (owner A is not affected; E is a plain member)
        psql(`UPDATE server_roles SET permissions = permissions & ~67108864 WHERE server_id = '${S}' AND is_default = true`);
        const noPerm = await propose(E, V1);
        ck('permission: CREATE_CLIPS revoked on @everyone → 403', noPerm.status === 403 && /Create Clips/i.test(noPerm.text), `${noPerm.status} ${noPerm.text}`);
        psql(`UPDATE server_roles SET permissions = permissions | 67108864 WHERE server_id = '${S}' AND is_default = true`);
        const back = await propose(E, V1);
        ck('permission: (control) restored → 201', back.status === 201, `${back.status} ${back.text}`);
        await cancel(E, back.body?.clip_id);
    }

    // ---- solo: an empty log is a 409, attestation makes it a solo clip --------------------
    let soloMsgId, soloPartId;
    {
        leave(e, V1);
        await sleep(200);
        join(e, V2);
        await sleep(200);
        const tV2 = Date.now();
        const empty = await propose(E, V2);
        ck('solo: fresh room, window predates the join → 409 window_predates_log (NOT a solo approval)', empty.status === 409 && empty.body?.error === 'window_predates_log', `${empty.status} ${empty.text}`);
        await sleep(Math.max(0, PRESENCE_MS - (Date.now() - tV2)));
        const solo = await propose(E, V2);
        ck('solo: alone for the whole window → 201 solo=true, resolved+approved, no approvers', solo.status === 201 && solo.body?.solo === true && solo.body?.approved === true && solo.body?.resolved === true && (solo.body?.approvers || []).length === 0, `${solo.status} ${solo.text}`);
        const sid = solo.body?.clip_id;
        const part = await uploadPart(E, sid, 0, new Uint8Array(100).fill(2));
        soloPartId = part.body?.id;
        ck('solo: part upload accepted (already approved)', part.status === 200, `${part.status} ${part.text}`);
        const posted = await api('POST', `/channels/${T1}/messages`, { content: '[Clip 0:05](sovereign-clip:v1?BBBB)', clip_id: sid }, E.token);
        soloMsgId = posted.body?.id;
        const cc = posted.body?.clip_consent;
        ck('solo: stamped {approver_count:0, solo:true, part_file_ids:[part]}', cc && cc.approver_count === 0 && cc.solo === true && JSON.stringify(cc.part_file_ids) === JSON.stringify([soloPartId]), JSON.stringify(cc));
        // (15b) the 5-per-5-min limiter, without any decline in the way: E has spent
        // 409(predates), 201, 201, 409(predates), 201(solo) = 5 counted attempts.
        const sixth = await propose(E, V2);
        ck('rate: 6th proposal inside the window → 429 rate_limited with retry_after_ms > 30 s (not the ladder)',
            sixth.status === 429 && sixth.body?.error === 'rate_limited' && sixth.body?.retry_after_ms > 30_000, `${sixth.status} ${sixth.text}`);
    }

    // ---- (16) id oracle ---------------------------------------------------------------------
    {
        const r = await propose(D, V1);
        const id = r.body?.clip_id;
        const unknown = await getClip(A, randomUUID());
        const strangerG = await getClip(X, id);
        const strangerC = await cancel(X, id);
        const strangerV = await vote(X, id, true);
        ck('oracle: unknown id and someone else\'s real id are byte-identical 404s (GET/DELETE/vote)',
            unknown.status === 404 && strangerG.status === 404 && strangerC.status === 404 && strangerV.status === 404
            && unknown.text === strangerG.text && strangerG.text === strangerC.text && strangerC.text === strangerV.text,
            JSON.stringify([unknown.text, strangerG.text, strangerC.text, strangerV.text]));
        await cancel(D, id);
    }

    // ---- (14) sweeper: orphans + retention; attachments and referenced parts survive ---------
    if (UPLOADS_DIR) {
        const mk = (kind, clipId, ago, name) => {
            const id = randomUUID();
            const stored = `${id}.bin`;
            writeFileSync(pjoin(UPLOADS_DIR, stored), Buffer.alloc(16, 1));
            psql(`INSERT INTO uploaded_files (id, uploader_id, original_name, stored_name, mime_type, size_bytes, kind, clip_id, clip_part_index, created_at)
                  VALUES ('${id}'::uuid, ${A.id}, '${name}', '${stored}', 'application/octet-stream', 16, '${kind}', ${clipId ? `'${clipId}'::uuid` : 'NULL'}, ${clipId ? 0 : 'NULL'}, NOW() - INTERVAL '${ago}')`);
            return { id, stored };
        };
        const orphan = mk('clip', randomUUID(), '3 hours', 'orphan.part');
        const oldClip = mk('clip', randomUUID(), '2 days', 'old.part');
        const oldAtt = mk('attachment', null, '2 days', 'old.png');
        // The posted solo clip's part: referenced by a message, older than the orphan grace, younger than retention.
        psql(`UPDATE uploaded_files SET created_at = NOW() - INTERVAL '3 hours' WHERE id = '${soloPartId}'::uuid`);
        const exists = (id) => psql(`SELECT COUNT(*) FROM uploaded_files WHERE id = '${id}'::uuid`) === '1';
        // wait for at least one sweep tick (interval 5 s in this run)
        const end = Date.now() + 15_000;
        while (Date.now() < end && (exists(orphan.id) || exists(oldClip.id))) await sleep(500);
        ck('sweep: orphan clip part (3 h, unreferenced) deleted — row and blob', !exists(orphan.id) && !onDisk(orphan.stored), `row=${exists(orphan.id)} disk=${onDisk(orphan.stored)}`);
        ck('sweep: retention (CLIP_RETENTION_DAYS=1) deleted the 2-day-old clip part', !exists(oldClip.id) && !onDisk(oldClip.stored));
        ck('sweep: 2-day-old ATTACHMENT survives both predicates', exists(oldAtt.id) && onDisk(oldAtt.stored) === true);
        ck('sweep: referenced 3 h-old part of the posted solo clip survives the orphan sweep', exists(soloPartId));
        ck('sweep: the posted solo clip message is still there for the mobile walk', (await api('GET', `/channels/${T1}/messages`, null, A.token)).text.includes(soloMsgId));
    } else {
        console.log('SKIP  sweep cases (set UPLOADS_DIR to the server CWD/uploads)');
    }

    // ---- reaper: the expired proposal's ClipResolved{expired} reaches the proposer ---------
    {
        const remaining = Math.max(0, 66_000 - (Date.now() - tExpiryStart));
        const rd = await waitFor(d, m => m.type === 'ClipResolved' && m.payload?.clip_id === clipD2, remaining);
        const rb = await waitFor(b, m => m.type === 'ClipResolved' && m.payload?.clip_id === clipD2, 1000);
        ck('reaper: proposer receives ClipResolved{expired} within one 60 s tick; approvers get closed', rd?.payload?.outcome === 'expired' && rb?.payload?.outcome === 'closed', JSON.stringify([rd?.payload, rb?.payload]));
    }
} finally {
    for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
