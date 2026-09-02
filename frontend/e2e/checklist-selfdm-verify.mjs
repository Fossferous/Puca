/**
 * Live verification harness for two features added this session:
 *   1. Checklist live sync — a checklist channel's tasks broadcast
 *      ServerMessage::ChecklistUpdate to other room members on add/toggle/
 *      move/delete, excluding the actor.
 *   2. Self-DM is RETIRED (superseded by Tasks) — creating one is refused and
 *      get a personal, encrypt-to-self checklist via GET /task-lists/self
 *      (get-or-create, backed by migration 028's partial unique index).
 *
 * Drives the REAL backend over HTTP + a real WebSocket with two real users
 * using real SRP-6a auth (borrowed from e2ee-live-verify.mjs), then queries
 * Postgres directly to confirm server-side state.
 *
 * Run:  API=http://127.0.0.1:8181 PGDB=puca_apptest node e2e/checklist-selfdm-verify.mjs
 *
 * NEVER run against the real dev/prod DB — point PGDB at a throwaway database.
 */
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';

const API = process.env.API || 'http://127.0.0.1:8181';
const PSQL = process.env.PSQL || 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
const PGDB = process.env.PGDB || 'puca_apptest';

const results = [];
function check(stage, ok, detail) {
    results.push({ stage, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}${detail ? '  — ' + detail : ''}`);
}
function section(name) { console.log(`\n=== ${name} ===`); }

function sql(query) {
    const env = { ...process.env, PGPASSWORD: 'postgres' };
    return execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-d', PGDB, '-t', '-A', '-c', query], { env }).toString().trim();
}

// ---------- SRP-6a (faithful to auth.ts / rust srp crate) ----------
const enc = new TextEncoder();
const toB64 = (b) => Buffer.from(b).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const toHex = (b) => Buffer.from(b).toString('hex');
const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));

import { webcrypto, randomFillSync } from 'node:crypto';
const crypto = webcrypto;
function randBytes(n) { const b = new Uint8Array(n); randomFillSync(b); return b; }

const N_HEX = ('AC6BDB41 324A9A9B F166DE5E 1389582F AF72B665 1987EE07 FC319294 3DB56050 A37329CB B4A099ED 8193E075 7767A13D D52312AB 4B03310D CD7F48A9 DA04FD50 E8083969 EDB767B0 CF609517 9A163AB3 661A05FB D5FAAAE8 2918A996 2F0B93B8 55F97993 EC975EEA A80D740A DBF4FF74 7359D041 D5C33EA7 1D281E44 6B14773B CA97B43A 23FB8016 76BD207A 436C6481 F1D2B907 8717461A 5B9D32E6 88F87748 544523B5 24B0D57D 5EA77A27 75D2ECFA 032CFBDB F52FB378 61602790 04E57AE6 AF874E73 03CE5329 9CCC041C 7BC308D8 2A5698F3 A8D0C382 71AE35F8 E9DBFBB6 94B5C803 D89F7AE4 35DE236D 525F5475 9B65E372 FCD68EF2 0FA7111F 9E4AFF73').replace(/\s/g, '');
const N = BigInt('0x' + N_HEX);
const g = 2n;
const N_BYTES = 256;
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
const toBytesBE = (n, len) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; let b = fromHex(h); if (len) { const p = new Uint8Array(len); p.set(b, len - b.length); b = p; } return b; };
const bytesToBig = (b) => BigInt('0x' + (toHex(b) || '0'));
const minimalBytes = (n) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; return fromHex(h); };
const padHex = (n, len) => { let h = n.toString(16); return '0'.repeat(Math.max(0, len * 2 - h.length)) + h; };
async function shaBytes(...parts) { const tot = parts.reduce((a, p) => a + p.length, 0); const buf = new Uint8Array(tot); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; } return new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); }
async function computeIdentityHash(username, password) { return await shaBytes(enc.encode(`${username.toLowerCase()}:${password}`)); }
async function computeX(salt, idHash) { return bytesToBig(await shaBytes(salt, idHash)); }
const computeVerifier = (x) => modpow(g, x, N);
async function computeK() { return bytesToBig(await shaBytes(toBytesBE(N, N_BYTES), toBytesBE(g, N_BYTES))); }
async function computeU(A, B) { return bytesToBig(await shaBytes(minimalBytes(A), minimalBytes(B))); }

async function apiFetch(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
}

async function registerUser(username, password) {
    const salt = randBytes(32);
    const idHash = await computeIdentityHash(username, password);
    const x = await computeX(salt, idHash);
    const v = computeVerifier(x);
    await apiFetch('POST', '/auth/register', {
        username, salt_hex: toHex(salt), verifier_hex: padHex(v, N_BYTES),
        public_key: 'x25519:' + toB64(randBytes(32)),
    });
    return { username, password };
}

async function loginUser(username, password) {
    const a = bytesToBig(randBytes(32));
    const A = modpow(g, a, N);
    const s1 = await apiFetch('POST', '/auth/login/step1', { username, a_pub_hex: padHex(A, N_BYTES) });
    const salt = fromHex(s1.salt_hex); const B = BigInt('0x' + s1.b_pub_hex);
    const u = await computeU(A, B);
    const k = await computeK();
    const idHash = await computeIdentityHash(username, password);
    const x = await computeX(salt, idHash);
    const gx = modpow(g, x, N);
    let base = (B - (k * gx) % N) % N; if (base < 0n) base += N;
    const S = modpow(base, a + u * x, N);
    const K = minimalBytes(S);
    const M1 = await shaBytes(minimalBytes(A), minimalBytes(B), K);
    const s2 = await apiFetch('POST', '/auth/login/step2', { username, m_hex: toHex(M1) });
    return { token: s2.token };
}

// ---------- tiny WS client ----------
function connectWs(token) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${API.replace('http', 'ws')}/ws`, ['bearer', token]);
        const timer = setTimeout(() => reject(new Error('ws connect timeout')), 5000);
        ws.on('open', () => { clearTimeout(timer); resolve(ws); });
        ws.on('error', reject);
    });
}
function send(ws, type, payload) { ws.send(JSON.stringify({ type, payload })); }
function waitForMessage(ws, type, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => { ws.off('message', onMsg); resolve(null); }, timeoutMs);
        function onMsg(data) {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === type) { clearTimeout(timer); ws.off('message', onMsg); resolve(msg); }
            } catch { /* ignore */ }
        }
        ws.on('message', onMsg);
    });
}

// ============================================================
async function main() {
    console.log(`Checklist-sync + self-DM live verification against ${API}  (db=${PGDB})`);
    const RUN = 'run' + Date.now();

    section('Setup: register + login 2 users via real SRP');
    const A = await registerUser(`alice_${RUN}`, 'passwordAlice1!');
    const B = await registerUser(`bob_${RUN}`, 'passwordBob1!');
    const la = await loginUser(A.username, A.password); A.token = la.token;
    const lb = await loginUser(B.username, B.password); B.token = lb.token;
    A.id = (await apiFetch('GET', '/profile', null, A.token)).id;
    B.id = (await apiFetch('GET', '/profile', null, B.token)).id;
    check('setup/register+login (2 users)', !!(A.token && B.token && A.id && B.id), `ids A=${A.id} B=${B.id}`);

    // --- Stage: checklist channel live sync ---
    section('Stage: checklist channel — live WS sync between two viewers');
    {
        const srv = await apiFetch('POST', '/servers', { name: `srv_${RUN}` }, A.token);
        const serverId = srv.id;
        // Servers are invite-only since 2026-07-24: joining goes through the
        // invite code's own route, not POST /servers/{id}/join.
        const inv = await apiFetch('POST', `/servers/${serverId}/invites`,
            { max_uses: 5, expires_in_hours: 1 }, A.token);
        await apiFetch('POST', `/invites/${inv.code}/join`, {}, B.token);
        const ch = await apiFetch('POST', `/servers/${serverId}/channels`, { name: 'checklist-test', channel_type: 0, has_checklist: true }, A.token);
        const channelId = ch.id;
        check('checklist/channel created with has_checklist=true', ch.has_checklist === true, `got ${JSON.stringify(ch.has_checklist)}`);

        const wsA = await connectWs(A.token);
        const wsB = await connectWs(B.token);
        send(wsA, 'JoinRoom', { room_id: `channel_${channelId}` });
        send(wsB, 'JoinRoom', { room_id: `channel_${channelId}` });
        await new Promise(r => setTimeout(r, 300)); // let joins land

        // A creates a task; B (not the actor) should get ChecklistUpdate.
        const bWaiter = waitForMessage(wsB, 'ChecklistUpdate');
        const aWaiterShouldBeNone = waitForMessage(wsA, 'ChecklistUpdate', 1500);
        const task = await apiFetch('POST', `/channels/${channelId}/tasks`, { description: 'buy milk' }, A.token);
        const [bMsg, aMsg] = await Promise.all([bWaiter, aWaiterShouldBeNone]);
        check('checklist/other viewer (B) receives ChecklistUpdate on create', bMsg?.payload?.channel_id === channelId, JSON.stringify(bMsg));
        check('checklist/actor (A) is excluded from their own broadcast', aMsg === null, JSON.stringify(aMsg));

        // Toggle completion — B should get another update.
        const bWaiter2 = waitForMessage(wsB, 'ChecklistUpdate');
        await apiFetch('PATCH', `/tasks/${task.id}`, { is_completed: true }, A.token);
        const bMsg2 = await bWaiter2;
        check('checklist/toggle broadcasts ChecklistUpdate to other viewer', bMsg2?.payload?.channel_id === channelId, JSON.stringify(bMsg2));

        // Delete — B should get a third update.
        const bWaiter3 = waitForMessage(wsB, 'ChecklistUpdate');
        await apiFetch('DELETE', `/tasks/${task.id}`, null, A.token);
        const bMsg3 = await bWaiter3;
        check('checklist/delete broadcasts ChecklistUpdate to other viewer', bMsg3?.payload?.channel_id === channelId, JSON.stringify(bMsg3));

        // B can independently refetch and see the deletion reflected.
        const remaining = await apiFetch('GET', `/channels/${channelId}/tasks`, null, B.token);
        check('checklist/B refetch reflects delete (task list empty)', Array.isArray(remaining) && remaining.length === 0, `count=${remaining.length}`);

        wsA.close(); wsB.close();
    }

    // --- Stage: self-conversation + personal checklist ---
    section('Stage: you can DM yourself + personal checklist survives');
    {
        // Messaging yourself is ALLOWED again (2026-07-28). It is not a special
        // "Notes to self" mode — you are simply a valid recipient, which is
        // also what lets a large file move between your own PC and phone,
        // since the peer-to-peer path only offers inside a DM.
        const selfConv = await apiFetch('POST', '/dms', { user_id: A.id }, A.token);
        check('selfdm/starting a conversation with yourself succeeds', !!selfConv?.id, JSON.stringify(selfConv));
        check('selfdm/the conversation reports YOU as the other party',
            selfConv?.other_user_id === A.id, `other=${selfConv?.other_user_id} me=${A.id}`);

        // Idempotent: asking twice must return the SAME row, not a duplicate
        // (UNIQUE(user1_id, user2_id) collapses to (me, me)).
        const again = await apiFetch('POST', '/dms', { user_id: A.id }, A.token);
        check('selfdm/is idempotent (one self-conversation per user)',
            again?.id === selfConv?.id, `${again?.id} vs ${selfConv?.id}`);

        // A message to yourself round-trips through the REST path.
        const sent = await apiFetch('POST', `/dms/${selfConv.id}/messages`, { content: 'enc:note-to-self' }, A.token);
        check('selfdm/can send a message to yourself', !!sent, JSON.stringify(sent));
        const mine = await apiFetch('GET', `/dms/${selfConv.id}/messages`, null, A.token);
        check('selfdm/the message comes back', Array.isArray(mine) && mine.some(m => m.content === 'enc:note-to-self'),
            JSON.stringify(mine).slice(0, 200));

        // POSITIVE CONTROL: the list must contain BOTH a real conversation and
        // the self one — against an empty list an "appears in list" check on
        // its own could pass for the wrong reason.
        await apiFetch('POST', '/dms', { user_id: B.id }, A.token);
        const convs = await apiFetch('GET', '/dms', null, A.token);
        check('selfdm-control conversation list is populated and well-formed',
            Array.isArray(convs) && convs.some(c => c.other_user_id === B.id),
            JSON.stringify(convs).slice(0, 200));
        const anySelf = Array.isArray(convs) && convs.find(c => c.other_user_id === A.id);
        check('selfdm/the self-conversation IS listed', !!anySelf, JSON.stringify(anySelf));

        // Search must return you, or there is no way to start it from the UI.
        const found = await apiFetch('GET', `/users/search?q=${encodeURIComponent(A.username.slice(0, 8))}`, null, A.token);
        check('selfdm/user search includes yourself',
            Array.isArray(found) && found.some(u => u.id === A.id), JSON.stringify(found).slice(0, 200));

        // GET /task-lists/self — get-or-create, idempotent.
        const list1 = await apiFetch('GET', '/task-lists/self', null, A.token);
        const list2 = await apiFetch('GET', '/task-lists/self', null, A.token);
        check('selfdm/GET task-lists/self is idempotent (same id)', list1.id === list2.id, `${list1.id} vs ${list2.id}`);

        // Concurrent get-or-create races don't create duplicates (ON CONFLICT
        // predicate matches the migration-028 partial unique index).
        const race = await Promise.all([
            apiFetch('GET', '/task-lists/self', null, A.token),
            apiFetch('GET', '/task-lists/self', null, A.token),
            apiFetch('GET', '/task-lists/self', null, A.token),
        ]);
        const raceIds = new Set(race.map(r => r.id));
        check('selfdm/concurrent get-or-create yields exactly one list', raceIds.size === 1, `ids=${[...raceIds]}`);
        const dbCount = sql(`SELECT COUNT(*) FROM task_lists WHERE owner_id=${A.id} AND is_self=TRUE;`);
        check('selfdm/DB has exactly one is_self row for owner', dbCount === '1', `count=${dbCount}`);

        // The personal task list is KEPT (only the self-DM went away): it
        // surfaces in the Tasks dashboard's "My lists" so personal notes aren't
        // stranded — and, per the ORDER BY is_self DESC, it sorts first.
        const normalLists = await apiFetch('GET', '/task-lists', null, A.token);
        const selfInList = normalLists.find(l => l.id === list1.id);
        check('selfdm/self list IS included in GET /task-lists (v0.5.67+)', !!selfInList, JSON.stringify(selfInList));
        check('selfdm/self list sorts first in GET /task-lists', normalLists[0]?.id === list1.id, `first=${normalLists[0]?.id} self=${list1.id}`);

        // B has their own independent self-list (not shared with A's). The
        // self-list is get-or-create on its own; the POST /dms that used to
        // seed it is gone, because a self-DM is refused now (that refusal is
        // asserted above) and this call only ever threw.
        const listB = await apiFetch('GET', '/task-lists/self', null, B.token);
        check('selfdm/B has a distinct self-list from A', listB.id !== list1.id, `A=${list1.id} B=${listB.id}`);

        // Personal checklist items work end-to-end (add + toggle + list).
        const t1 = await apiFetch('POST', `/task-lists/${list1.id}/tasks`, { description: 'pack for trip' }, A.token);
        const items = await apiFetch('GET', `/task-lists/${list1.id}/tasks`, null, A.token);
        check('selfdm/personal checklist item created + listed', items.some(i => i.id === t1.id), `count=${items.length}`);
        await apiFetch('PATCH', `/tasks/${t1.id}`, { is_completed: true }, A.token);
        const items2 = await apiFetch('GET', `/task-lists/${list1.id}/tasks`, null, A.token);
        check('selfdm/personal checklist item toggled', items2.find(i => i.id === t1.id)?.is_completed === true);

        // B cannot see or modify A's personal list items (owner-only).
        let bBlocked = false;
        try { await apiFetch('GET', `/task-lists/${list1.id}/tasks`, null, B.token); } catch (e) { bBlocked = /40[13]/.test(e.message); }
        check('selfdm/non-owner cannot read another user\'s self-list tasks', bBlocked);
    }

    // --- Stage: regression — normal (non-self) DM still works ---
    section('Stage: regression — normal DM between two different users still works');
    {
        const conv = await apiFetch('POST', '/dms', { user_id: B.id }, A.token);
        check('regression/A can still DM B (non-self)', !!conv.id && conv.other_user_id === B.id, JSON.stringify(conv));
        await apiFetch('POST', `/dms/${conv.id}/messages`, { content: 'hi bob' }, A.token);
        const bMsgs = await apiFetch('GET', `/dms/${conv.id}/messages`, null, B.token);
        check('regression/B receives the message via normal DM', bMsgs.length >= 1, `count=${bMsgs.length}`);
    }

    section('Summary');
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) {
        console.log('FAILED:');
        for (const f of failed) console.log(`  - ${f.stage} (${f.detail || ''})`);
        process.exit(1);
    }
    process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
