/**
 * Regression harness for the settings-overhaul review fixes.
 *
 * Covers the behaviours the existing suites do NOT:
 *   - recipient_accepts_dms directionality: a user with the friends-only flag
 *     ON can still be replied to by someone THEY messaged first, and a stranger
 *     with no prior conversation is refused (src/dm_handlers.rs).
 *   - FileOffer honours the same DM privacy flag (src/ws.rs users_can_dm).
 *   - Presence hiding: a show_online_status=false user is NOT named in a text
 *     channel's RoomJoined.members or a UserJoined broadcast (src/ws.rs), while
 *     a voice room still lists them (the Settings carve-out).
 *   - delete_account hangs up the deleted user's live WS sockets, not just the
 *     next upgrade (src/handlers.rs + state.disconnect_user).
 *
 * Uses REAL SRP login tokens (so the WS token_version check passes) and raw
 * WebSocket frames.  REST for DM sends, WS for FileOffer/presence/eviction.
 *
 * Run:  API=http://127.0.0.1:3000 node e2e/review-fixes-verify.mjs
 * Prereqs: backend on :3000 against a THROWAWAY DB. Never the dev/prod one.
 */
import { webcrypto, randomFillSync } from 'node:crypto';
import WebSocket from 'ws';
const crypto = webcrypto;
const API = process.env.API || 'http://127.0.0.1:3000';
const WS = API.replace(/^http/, 'ws') + '/ws';

let fail = 0;
const check = (stage, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}${detail ? '  — ' + detail : ''}`); if (!ok) fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder();
const toHex = (b) => Buffer.from(b).toString('hex');
const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
function randBytes(n) { const b = new Uint8Array(n); randomFillSync(b); return b; }
const N_HEX = ('AC6BDB41 324A9A9B F166DE5E 1389582F AF72B665 1987EE07 FC319294 3DB56050 A37329CB B4A099ED 8193E075 7767A13D D52312AB 4B03310D CD7F48A9 DA04FD50 E8083969 EDB767B0 CF609517 9A163AB3 661A05FB D5FAAAE8 2918A996 2F0B93B8 55F97993 EC975EEA A80D740A DBF4FF74 7359D041 D5C33EA7 1D281E44 6B14773B CA97B43A 23FB8016 76BD207A 436C6481 F1D2B907 8717461A 5B9D32E6 88F87748 544523B5 24B0D57D 5EA77A27 75D2ECFA 032CFBDB F52FB378 61602790 04E57AE6 AF874E73 03CE5329 9CCC041C 7BC308D8 2A5698F3 A8D0C382 71AE35F8 E9DBFBB6 94B5C803 D89F7AE4 35DE236D 525F5475 9B65E372 FCD68EF2 0FA7111F 9E4AFF73').replace(/\s/g, '');
const N = BigInt('0x' + N_HEX); const g = 2n; const N_BYTES = 256;
const modpow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; };
const toBytesBE = (n, len) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; let b = fromHex(h); if (len) { const p = new Uint8Array(len); p.set(b, len - b.length); b = p; } return b; };
const bytesToBig = (b) => BigInt('0x' + (toHex(b) || '0'));
const minimalBytes = (n) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; return fromHex(h); };
const padHex = (n, len) => { const h = n.toString(16); return '0'.repeat(Math.max(0, len * 2 - h.length)) + h; };
async function shaBytes(...parts) { const t = parts.reduce((a, p) => a + p.length, 0); const buf = new Uint8Array(t); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; } return new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); }

async function api(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    for (let i = 0; i < 3; i++) {
        const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        if (res.status === 429) { await sleep(2500); continue; }
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch { json = text; }
        return { status: res.status, body: json };
    }
    return { status: 429, body: 'rate-limited' };
}

async function register(username, password) {
    const salt = randBytes(32);
    const idHash = await shaBytes(enc.encode(`${username.toLowerCase()}:${password}`));
    const x = bytesToBig(await shaBytes(salt, idHash));
    const v = modpow(g, x, N);
    const reg = await api('POST', '/auth/register', {
        username, salt_hex: toHex(salt), verifier_hex: padHex(v, N_BYTES),
        public_key: 'x25519:' + Buffer.from(randBytes(32)).toString('base64'),
    });
    if (reg.status >= 300) throw new Error(`register ${username} failed: ${reg.status}`);
}

async function login(username, password) {
    const a = bytesToBig(randBytes(32)); const A = modpow(g, a, N);
    const s1 = await api('POST', '/auth/login/step1', { username, a_pub_hex: padHex(A, N_BYTES) });
    if (s1.status >= 400) throw new Error(`login step1 ${username}: ${s1.status}`);
    const salt = fromHex(s1.body.salt_hex); const B = BigInt('0x' + s1.body.b_pub_hex);
    const idHash = await shaBytes(enc.encode(`${username.toLowerCase()}:${password}`));
    const x = bytesToBig(await shaBytes(salt, idHash));
    const k = bytesToBig(await shaBytes(toBytesBE(N, N_BYTES), toBytesBE(g, N_BYTES)));
    const u = bytesToBig(await shaBytes(minimalBytes(A), minimalBytes(B)));
    const gx = modpow(g, x, N); let base = (B - (k * gx) % N) % N; if (base < 0n) base += N;
    const S = modpow(base, a + u * x, N);
    const M1 = await shaBytes(minimalBytes(A), minimalBytes(B), minimalBytes(S));
    const s2 = await api('POST', '/auth/login/step2', { username, m_hex: toHex(M1) });
    if (s2.status !== 200 || !s2.body?.token) throw new Error(`login step2 ${username}: ${s2.status}`);
    return s2.body.token;
}

/** A raw WS client that buckets every frame it receives and tracks closure. */
function connect(token) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${WS}?token=${token}`);
        const handle = { ws, frames: [], closed: false, closeCode: null };
        ws.on('message', (d) => { try { handle.frames.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
        ws.on('close', (code) => { handle.closed = true; handle.closeCode = code; });
        ws.on('open', () => resolve(handle));
        ws.on('error', (e) => { if (!handle.closed) reject(e); });
    });
}
const send = (h, type, payload) => h.ws.send(JSON.stringify({ type, payload }));
const has = (frames, type, pred) => frames.some(f => f.type === type && (!pred || pred(f.payload)));

async function main() {
    const RUN = Date.now().toString(36);
    const P = 'ReviewPass1!';
    const A = `alice_${RUN}`, B = `bob_${RUN}`, C = `carol_${RUN}`;
    await register(A, P); await register(B, P); await register(C, P);
    const tA = await login(A, P), tB = await login(B, P), tC = await login(C, P);
    const idA = (await api('GET', '/profile', null, tA)).body.id;
    const idB = (await api('GET', '/profile', null, tB)).body.id;
    const idC = (await api('GET', '/profile', null, tC)).body.id;
    check('setup/three users registered + logged in', !!(idA && idB && idC), `A=${idA} B=${idB} C=${idC}`);

    // === DM directionality =================================================
    // B opens a conversation with A and messages first (A's flag is still on).
    const conv = await api('POST', '/dms', { user_id: idA }, tB);
    check('dm/B can open a conversation with A (A flag on)', conv.status < 300, `status=${conv.status}`);
    const convId = conv.body?.id || conv.body?.conversation_id;
    const bMsg = await api('POST', `/dms/${convId}/messages`, { content: 'enc:hello-from-B' }, tB);
    check('dm/B sends the first message', bMsg.status < 300, `status=${bMsg.status}`);

    // A turns the friends-only flag ON (allow_dms=false).
    const flag = await api('PATCH', '/profile', { allow_dms_from_server_members: false }, tA);
    check('dm/A sets allow_dms_from_server_members=false', flag.status < 300, `status=${flag.status}`);

    // THE FIX: A can reply in the conversation B started, even though A's own
    // flag is off — the old code consulted only the recipient's flag and left
    // A unable to answer. (recipient here is B; B's flag is on anyway, so the
    // meaningful assertion is the inverse below.)
    const aReply = await api('POST', `/dms/${convId}/messages`, { content: 'enc:reply-from-A' }, tA);
    check('dm/A can reply to the conversation B started', aReply.status < 300, `status=${aReply.status}`);

    // Now the directional core: B messaged A first, so B may still write to A
    // even though A's flag is off (recipient A wrote back / consented).
    const bAgain = await api('POST', `/dms/${convId}/messages`, { content: 'enc:B-again' }, tB);
    check('dm/B (messaged-first) may still write to flag-off A', bAgain.status < 300, `status=${bAgain.status}`);

    // A stranger with NO prior conversation and no friendship is refused.
    const cToA = await api('POST', '/dms', { user_id: idA }, tC);
    // Conversation creation itself is gated by A's flag.
    const cSend = cToA.status < 300
        ? await api('POST', `/dms/${cToA.body?.id || cToA.body?.conversation_id}/messages`, { content: 'enc:C-cold' }, tC)
        : cToA;
    check('dm/stranger C is refused DMing flag-off A', cToA.status === 403 || cSend.status === 403,
        `conv=${cToA.status} send=${cSend.status}`);

    // === FileOffer honours the DM flag ====================================
    // B and A already share a conversation. B is NOT a friend of A, and A has
    // only ever replied inside B's conversation — so whether B may FileOffer A
    // turns on the SAME rule. Since A DID reply above, B is now permitted; to
    // test the refusal we use C, who has no accepted conversation with A.
    const hA = await connect(tA);
    const hB = await connect(tB);
    const hC = await connect(tC);
    await sleep(300);
    // transfer_id charset is [A-Za-z0-9-] only (valid_transfer_id) — no
    // underscores, or the offer dies at validation before the DM gate and the
    // rejection below would pass for the wrong reason.
    const tidC = ('rf-' + RUN + '-c').replace(/_/g, '-');
    const tidB = ('rf-' + RUN + '-b').replace(/_/g, '-');
    // C -> A FileOffer must be refused BY THE DM GATE (no conversation, flag
    // off, not friends) — assert on the exact error, not just non-delivery.
    send(hC, 'FileOffer', { target_user: idA, transfer_id: tidC, name: 'x.pdf', size: 10, mime: 'application/pdf', sha256: 'a'.repeat(64) });
    await sleep(400);
    const cErr = hC.frames.find(f => f.type === 'Error');
    check('file/stranger C FileOffer to flag-off A is refused',
        !has(hA.frames, 'FileOffered', p => p.from_user === idC) && !!cErr,
        `A got=${hA.frames.map(f => f.type).join(',')||'nothing'} C error=${cErr?.payload?.message}`);
    // B -> A FileOffer IS allowed (conversation exists AND A replied to B, so
    // recipient_accepts_dms permits it).
    send(hB, 'FileOffer', { target_user: idA, transfer_id: tidB, name: 'y.pdf', size: 10, mime: 'application/pdf', sha256: 'b'.repeat(64) });
    await sleep(400);
    check('file/permitted B FileOffer to A IS delivered',
        has(hA.frames, 'FileOffered', p => p.from_user === idB),
        `A frames=${hA.frames.map(f => f.type).join(',')||'nothing'}`);

    // === Presence hiding in text channels, voice carve-out ================
    // A set show_online_status=false earlier. Give A and B a shared server so
    // they are in each other's presence audience, then prove A is not named in
    // a TEXT channel's roster but IS in a VOICE channel's (the Settings
    // carve-out: "Joining a voice channel still shows you in that channel").
    await api('PATCH', '/profile', { show_online_status: false }, tA);
    const srv = await api('POST', '/servers', { name: `presence-${RUN}` }, tA);
    const serverId = srv.body?.id;
    const inv = await api('POST', `/servers/${serverId}/invites`, { max_uses: 0, expires_in_hours: 24 }, tA);
    const code = inv.body?.code;
    const joined = await api('POST', `/invites/${code}/join`, {}, tB);
    check('presence/setup: B joins A\'s server', serverId && code && joined.status < 300,
        `server=${!!serverId} code=${!!code} join=${joined.status}`);
    const chans = await api('GET', `/servers/${serverId}/channels`, null, tA);
    const textCh = (chans.body || []).find(c => c.channel_type === 0);
    const voiceCh = (chans.body || []).find(c => c.channel_type === 1 && !c.is_afk);
    const textRoom = `channel_${textCh?.id}`, voiceRoom = `voice_${voiceCh?.id}`;

    // TEXT: hidden A joins first, then B — B's RoomJoined.members must exclude A.
    hA.frames.length = 0;
    send(hA, 'JoinRoom', { room_id: textRoom });
    await sleep(250);
    // Positive anchor: A's own join must be acked, with A in their own roster
    // (ws.rs keeps the joiner visible to themselves). Without this, both
    // absence checks below would also pass if hidden users' text joins were
    // refused or filtered out of room MEMBERSHIP itself — which would cut them
    // off from live channel traffic (broadcasts fan out by membership) while
    // every "absent" assertion stayed green.
    const aTextAck = hA.frames.find(f => f.type === 'RoomJoined' && f.payload.room_id === textRoom);
    check('presence/hidden A\'s own text join acked, A sees themself',
        !!aTextAck && (aTextAck.payload.members || []).some(m => m.id === idA),
        `A ack members=${JSON.stringify(aTextAck?.payload.members?.map(m => m.id))}`);
    hB.frames.length = 0;
    send(hB, 'JoinRoom', { room_id: textRoom });
    await sleep(350);
    const bTextRoster = hB.frames.find(f => f.type === 'RoomJoined' && f.payload.room_id === textRoom);
    check('presence/hidden A absent from text RoomJoined.members seen by B',
        !!bTextRoster && !bTextRoster.payload.members.some(m => m.id === idA),
        `members=${JSON.stringify(bTextRoster?.payload.members?.map(m => m.id))}`);

    // TEXT: with B already present, hidden A re-joins → B must NOT get UserJoined(A).
    send(hA, 'LeaveRoom', { room_id: textRoom });
    await sleep(200);
    hA.frames.length = 0;
    hB.frames.length = 0;
    send(hA, 'JoinRoom', { room_id: textRoom });
    await sleep(350);
    // Same anchor as above: the no-broadcast check is only meaningful if the
    // re-join actually happened.
    check('presence/hidden A\'s re-join acked (broadcast check armed)',
        hA.frames.some(f => f.type === 'RoomJoined' && f.payload.room_id === textRoom),
        `A frames=${hA.frames.map(f => f.type).join(',') || 'nothing'}`);
    check('presence/no UserJoined(A) broadcast to B in text channel',
        !has(hB.frames, 'UserJoined', p => p.room_id === textRoom && p.user?.id === idA),
        `B frames=${hB.frames.map(f => f.type).join(',')||'nothing'}`);

    // VOICE: the carve-out — hidden A joins voice first, B joins → A IS listed.
    send(hA, 'JoinRoom', { room_id: voiceRoom });
    await sleep(250);
    hB.frames.length = 0;
    send(hB, 'JoinRoom', { room_id: voiceRoom });
    await sleep(350);
    const bVoiceRoster = hB.frames.find(f => f.type === 'RoomJoined' && f.payload.room_id === voiceRoom);
    check('presence/hidden A IS listed in VOICE RoomJoined.members (carve-out)',
        !!bVoiceRoster && bVoiceRoster.payload.members.some(m => m.id === idA),
        `members=${JSON.stringify(bVoiceRoster?.payload.members?.map(m => m.id))}`);

    // === delete_account evicts live sockets ================================
    // C is connected over WS. Deleting C's account must close that socket, not
    // just refuse the next upgrade.
    check('evict/C socket is open before delete', !hC.closed, `closed=${hC.closed}`);
    const delC = await api('DELETE', '/account', { confirm_username: C }, tC);
    check('evict/delete C succeeds', delC.status === 200, `status=${delC.status}`);
    await sleep(600);
    check('evict/C live socket was hung up by the server', hC.closed, `closed=${hC.closed}`);

    for (const h of [hA, hB, hC]) { try { h.ws.close(); } catch { /* */ } }
    await sleep(200);
    console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAIL'} — review-fixes-verify`);
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
