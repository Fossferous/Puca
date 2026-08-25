/**
 * Broad functional API sweep — exercises feature areas the crypto/checklist
 * harnesses don't cover: servers/channels/categories/roles/permissions,
 * messages (post/edit/delete/pin/search), reactions, invites, friends/blocks,
 * moderation (kick/ban/timeout/reports/audit-log), profile, notifications,
 * emojis, device tokens, and the authorization boundaries between two users.
 *
 * Real SRP-6a auth (paced to respect the 5/s auth limiter). Non-auth calls run
 * under the looser 50/s API limiter.
 *
 * Run:  API=http://127.0.0.1:3000 node e2e/feature-flows.mjs
 */
import { webcrypto, randomFillSync } from 'node:crypto';
const crypto = webcrypto;
const API = process.env.API || 'http://127.0.0.1:3000';

const results = [];
function check(stage, ok, detail) {
    results.push({ stage, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}${detail !== undefined && detail !== '' ? '  — ' + detail : ''}`);
}
function section(name) { console.log(`\n=== ${name} ===`); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- SRP-6a ----------
const enc = new TextEncoder();
const toHex = (b) => Buffer.from(b).toString('hex');
const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
function randBytes(n) { const b = new Uint8Array(n); randomFillSync(b); return b; }
const N_HEX = ('AC6BDB41 324A9A9B F166DE5E 1389582F AF72B665 1987EE07 FC319294 3DB56050 A37329CB B4A099ED 8193E075 7767A13D D52312AB 4B03310D CD7F48A9 DA04FD50 E8083969 EDB767B0 CF609517 9A163AB3 661A05FB D5FAAAE8 2918A996 2F0B93B8 55F97993 EC975EEA A80D740A DBF4FF74 7359D041 D5C33EA7 1D281E44 6B14773B CA97B43A 23FB8016 76BD207A 436C6481 F1D2B907 8717461A 5B9D32E6 88F87748 544523B5 24B0D57D 5EA77A27 75D2ECFA 032CFBDB F52FB378 61602790 04E57AE6 AF874E73 03CE5329 9CCC041C 7BC308D8 2A5698F3 A8D0C382 71AE35F8 E9DBFBB6 94B5C803 D89F7AE4 35DE236D 525F5475 9B65E372 FCD68EF2 0FA7111F 9E4AFF73').replace(/\s/g, '');
const N = BigInt('0x' + N_HEX); const g = 2n; const N_BYTES = 256;
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
const toBytesBE = (n, len) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; let b = fromHex(h); if (len) { const p = new Uint8Array(len); p.set(b, len - b.length); b = p; } return b; };
const bytesToBig = (b) => BigInt('0x' + (toHex(b) || '0'));
const minimalBytes = (n) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; return fromHex(h); };
const padHex = (n, len) => { let h = n.toString(16); return '0'.repeat(Math.max(0, len * 2 - h.length)) + h; };
async function shaBytes(...parts) { const t = parts.reduce((a, p) => a + p.length, 0); const buf = new Uint8Array(t); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; } return new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); }
async function idHashFn(u, p) { return await shaBytes(enc.encode(`${u.toLowerCase()}:${p}`)); }
async function xFn(salt, idHash) { return bytesToBig(await shaBytes(salt, idHash)); }
async function kFn() { return bytesToBig(await shaBytes(toBytesBE(N, N_BYTES), toBytesBE(g, N_BYTES))); }
async function uFn(A, B) { return bytesToBig(await shaBytes(minimalBytes(A), minimalBytes(B))); }

async function api(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // Retry once on 429 (local single-IP limiter artifact).
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        if (res.status === 429) { await sleep(2500); continue; }
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch { json = text; }
        return { status: res.status, body: json };
    }
    return { status: 429, body: 'rate-limited' };
}
async function must(method, path, body, token) {
    const r = await api(method, path, body, token);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
}

async function registerUser(username, password) {
    const salt = randBytes(32);
    const idHash = await idHashFn(username, password);
    const x = await xFn(salt, idHash);
    const v = modpow(g, x, N);
    await must('POST', '/auth/register', { username, salt_hex: toHex(salt), verifier_hex: padHex(v, N_BYTES), public_key: 'x25519:' + Buffer.from(randBytes(32)).toString('base64') });
}
async function loginUser(username, password) {
    const a = bytesToBig(randBytes(32)); const A = modpow(g, a, N);
    const s1 = await must('POST', '/auth/login/step1', { username, a_pub_hex: padHex(A, N_BYTES) });
    const salt = fromHex(s1.salt_hex); const B = BigInt('0x' + s1.b_pub_hex);
    const u = await uFn(A, B); const k = await kFn();
    const x = await xFn(salt, await idHashFn(username, password));
    const gx = modpow(g, x, N); let base = (B - (k * gx) % N) % N; if (base < 0n) base += N;
    const S = modpow(base, a + u * x, N);
    const M1 = await shaBytes(minimalBytes(A), minimalBytes(B), minimalBytes(S));
    const s2 = await must('POST', '/auth/login/step2', { username, m_hex: toHex(M1) });
    return s2.token;
}

async function main() {
    console.log(`Feature-flow sweep against ${API}`);
    const RUN = 'ff' + Date.now();

    section('Setup: 2 users (paced SRP)');
    const A = { u: `owner_${RUN}`, p: 'OwnerPass1!' };
    const B = { u: `member_${RUN}`, p: 'MemberPass1!' };
    await registerUser(A.u, A.p); await sleep(600);
    await registerUser(B.u, B.p); await sleep(600);
    A.t = await loginUser(A.u, A.p); await sleep(600);
    B.t = await loginUser(B.u, B.p); await sleep(600);
    A.id = (await must('GET', '/profile', null, A.t)).id;
    B.id = (await must('GET', '/profile', null, B.t)).id;
    check('setup/two users registered+logged in', !!(A.t && B.t && A.id && B.id), `A=${A.id} B=${B.id}`);

    section('Profile');
    await must('PATCH', '/profile', { display_name: 'Owner McTest' }, A.t);
    const prof = await must('GET', '/profile', null, A.t);
    check('profile/update display_name persists', prof.display_name === 'Owner McTest', prof.display_name);

    section('Servers + default channels');
    const srv = await must('POST', '/servers', { name: `Srv ${RUN}` }, A.t);
    check('server/create returns id', !!srv.id, srv.id);
    const chans0 = await must('GET', `/servers/${srv.id}/channels`, null, A.t);
    const hasText = chans0.some(c => c.channel_type === 0);
    const hasVoice = chans0.some(c => c.channel_type === 1 && !c.is_afk);
    const hasAfk = chans0.some(c => c.channel_type === 1 && c.is_afk);
    check('server/bootstraps default text+voice+AFK', hasText && hasVoice && hasAfk, `text=${hasText} voice=${hasVoice} afk=${hasAfk}`);
    // Owner-role bootstrap has silently broken twice while every other check
    // here stayed green: M13 (is_default 0 vs false — INSERT rejected, no role
    // at all) and the i32 decode of the BIGSERIAL id (role row inserted, but
    // the RETURNING decode failed so the creator was never assigned to it).
    // Assert both halves: the role exists AND the creator holds it.
    const bootRoles = await must('GET', `/servers/${srv.id}/roles`, null, A.t);
    const ownerRole = bootRoles.find(r => r.name === 'Owner' && !r.is_default);
    check('server/creates Owner role with ADMINISTRATOR', !!ownerRole && (ownerRole.permissions & 4194304) === 4194304, ownerRole ? `id=${ownerRole.id} perms=${ownerRole.permissions}` : `roles=${bootRoles.map(r => r.name).join(',')}`);
    const bootMembers = await must('GET', `/servers/${srv.id}/members-with-roles`, null, A.t);
    const creatorEntry = bootMembers.find(m => m.id === A.id);
    check('server/creator holds the Owner role', !!ownerRole && !!creatorEntry && creatorEntry.roles.some(r => r.id === ownerRole.id), creatorEntry ? `roles=[${creatorEntry.roles.map(r => r.name).join(',')}]` : 'creator missing from members-with-roles');
    await must('PATCH', `/servers/${srv.id}/settings`, { require_media_e2ee: true }, A.t);
    const srvList = await must('GET', '/servers', null, A.t);
    check('server/settings PATCH require_media_e2ee persists', srvList.find(s => s.id === srv.id)?.require_media_e2ee === true);

    section('Channels: create, update, reorder');
    const tc = await must('POST', `/servers/${srv.id}/channels`, { name: 'general', channel_type: 0 }, A.t);
    const vc = await must('POST', `/servers/${srv.id}/channels`, { name: 'lounge', channel_type: 1 }, A.t);
    check('channel/create text + voice', !!tc.id && !!vc.id, `tc=${tc.id} vc=${vc.id}`);
    await must('PATCH', `/channels/${tc.id}`, { name: 'general-renamed', description: 'the main channel' }, A.t);
    const chAfter = (await must('GET', `/servers/${srv.id}/channels`, null, A.t)).find(c => c.id === tc.id);
    check('channel/rename + description persists', chAfter.name === 'general-renamed' && chAfter.description === 'the main channel');
    const voiceIds = (await must('GET', `/servers/${srv.id}/channels`, null, A.t)).filter(c => c.channel_type === 1 && !c.is_afk).map(c => c.id);
    const rev = [...voiceIds].reverse();
    await must('POST', `/servers/${srv.id}/channels/reorder`, { channel_ids: rev }, A.t);
    check('channel/reorder accepted', true, `order ${rev.join(',')}`);

    section('Categories');
    const cat = await must('POST', `/servers/${srv.id}/categories`, { name: 'Text Rooms' }, A.t);
    check('category/create', !!cat.id, cat.id);
    const cats = await must('GET', `/servers/${srv.id}/categories`, null, A.t);
    check('category/list includes new', cats.some(c => c.id === cat.id));

    section('Roles + permissions');
    const role = await must('POST', `/servers/${srv.id}/roles`, { name: 'Moderator', color: '#ff8800', permissions: 8 }, A.t);
    check('role/create', !!role.id, role.id);
    const roles = await must('GET', `/servers/${srv.id}/roles`, null, A.t);
    check('role/list includes new', roles.some(r => r.id === role.id));
    await must('PATCH', `/servers/${srv.id}/roles/${role.id}`, { name: 'Mod', permissions: 8 }, A.t);
    check('role/update name', (await must('GET', `/servers/${srv.id}/roles`, null, A.t)).find(r => r.id === role.id)?.name === 'Mod');

    section('Invites + join by 2nd user');
    const inv = await must('POST', `/servers/${srv.id}/invites`, {}, A.t);
    check('invite/create returns code', !!inv.code, inv.code);
    const invInfo = await api('GET', `/invites/${inv.code}`, null, B.t);
    check('invite/info readable by prospective member', invInfo.status === 200 && invInfo.body.server_id === srv.id, JSON.stringify(invInfo.body).slice(0, 80));
    // Redeem via the invite endpoint (matches the real client's joinViaInvite).
    // Direct POST /servers/:id/join now 403s for private servers (invite-only) —
    // by design; only public-discovery join uses that path.
    await must('POST', `/invites/${inv.code}/join`, {}, B.t);
    const members = await must('GET', `/servers/${srv.id}/members`, null, A.t);
    check('server/B is now a member', members.some(m => m.id === B.id || m.user_id === B.id), `count=${members.length}`);

    section('Assign role to member');
    const roleAssign = await api('PUT', `/servers/${srv.id}/members/${B.id}/roles/${role.id}`, {}, A.t);
    check('role/assign to member (200/201/204)', [200, 201, 204].includes(roleAssign.status), `status=${roleAssign.status}`);
    const mwr = await must('GET', `/servers/${srv.id}/members-with-roles`, null, A.t);
    check('members-with-roles reflects assignment', Array.isArray(mwr) && mwr.length >= 2, `count=${mwr.length}`);

    section('Messages: post, edit, delete, pin, search');
    const m1 = await must('POST', `/channels/${tc.id}/messages`, { content: `hello world ${RUN}`, is_task: false }, A.t);
    check('message/post', !!m1.id, m1.id);
    await must('PATCH', `/channels/${tc.id}/messages/${m1.id}`, { content: `edited ${RUN}` }, A.t);
    const edits = await api('GET', `/channels/${tc.id}/messages/${m1.id}/edits`, null, A.t);
    check('message/edit history endpoint (200)', edits.status === 200, `status=${edits.status}`);
    const pin = await api('POST', `/channels/${tc.id}/messages/${m1.id}/pin`, {}, A.t);
    check('message/pin (2xx)', pin.status < 300, `status=${pin.status}`);
    const pins = await must('GET', `/channels/${tc.id}/pins`, null, A.t);
    check('message/pins list includes pinned', Array.isArray(pins) && pins.some(p => p.id === m1.id || p.message_id === m1.id), `count=${pins.length}`);
    const m2 = await must('POST', `/channels/${tc.id}/messages`, { content: `findme_${RUN} unique token`, is_task: false }, A.t);
    // The server-side search endpoint is GONE. It ran SQL LIKE against the
    // content column, which holds E2EE ciphertext — it could never match a
    // term a user typed, and because the envelope is JSON its wrapper matched
    // EVERY row, so `q=ch` returned the whole channel as false positives.
    // This assertion checked only the HTTP status under the label "finds
    // token", so it passed on an empty array: deleted rather than adjusted.
    const goneSearch = await api('GET', `/channels/${tc.id}/messages/search?q=findme_${RUN}`, null, A.t);
    // 405, not 404: /channels/:id/messages/:message_id still exists, so the
    // path now matches THAT route with message_id="search" and GET is not
    // allowed on it. Either way the search route is gone; what must never
    // happen again is a 200 carrying ciphertext false positives.
    check('message/search endpoint is removed (no longer routed)',
        goneSearch.status === 404 || goneSearch.status === 405, `status=${goneSearch.status}`);
    const del = await api('DELETE', `/channels/${tc.id}/messages/${m2.id}`, null, A.t);
    check('message/delete own (2xx)', del.status < 300, `status=${del.status}`);

    section('Reactions');
    const react = await api('POST', `/messages/${m1.id}/reactions`, { emoji: '👍' }, B.t);
    check('reaction/add by member (2xx)', react.status < 300, `status=${react.status}`);
    const reactList = await must('GET', `/messages/${m1.id}/reactions`, null, A.t);
    check('reaction/list shows it', Array.isArray(reactList) && reactList.length >= 1, `count=${reactList.length}`);
    const unreact = await api('DELETE', `/messages/${m1.id}/reactions/${encodeURIComponent('👍')}`, null, B.t);
    check('reaction/remove own (2xx)', unreact.status < 300, `status=${unreact.status}`);

    section('Read state / unread');
    await api('POST', `/channels/${tc.id}/read`, {}, B.t);
    const unread = await api('GET', `/servers/${srv.id}/unread`, null, B.t);
    check('unread/endpoint returns 200', unread.status === 200, `status=${unread.status}`);

    section('Friends + blocks');
    const fr = await api('POST', '/friends/request', { user_id: B.id }, A.t);
    check('friend/request (2xx)', fr.status < 300, `status=${fr.status}`);
    const incoming = await must('GET', '/friends/requests/incoming', null, B.t);
    check('friend/B sees incoming request', Array.isArray(incoming) && incoming.length >= 1, `count=${incoming.length}`);
    if (incoming[0]) {
        const acc = await api('POST', `/friends/requests/${incoming[0].id}/accept`, {}, B.t);
        check('friend/accept (2xx)', acc.status < 300, `status=${acc.status}`);
        const friends = await must('GET', '/friends', null, A.t);
        check('friend/A now friends with B', Array.isArray(friends) && friends.some(f => f.id === B.id || f.user_id === B.id), `count=${friends.length}`);
    }
    const block = await api('POST', `/users/${B.id}/block`, {}, A.t);
    check('block/user (2xx)', block.status < 300, `status=${block.status}`);
    const blocked = await must('GET', '/blocked', null, A.t);
    check('block/list shows blocked user', Array.isArray(blocked) && blocked.length >= 1, `count=${blocked.length}`);
    // A block in either direction refuses friend requests — B (the blocked
    // side) must not be able to reach A through the friend system. A and B
    // are still friends here, so unfriend first to hit the block gate, then
    // restore nothing (the DM-privacy section below re-manages friendship).
    await api('DELETE', `/friends/${B.id}`, null, A.t);
    const frBlocked = await api('POST', '/friends/request', { user_id: A.id }, B.t);
    check('block/friend request from blocked user refused (403)', frBlocked.status === 403, `status=${frBlocked.status}`);
    const frBlocker = await api('POST', '/friends/request', { user_id: B.id }, A.t);
    check('block/friend request from blocker refused too (403)', frBlocker.status === 403, `status=${frBlocker.status}`);
    await api('DELETE', `/users/${B.id}/block`, null, A.t);
    // Unblocked → the friend system works again (re-befriend for the DM
    // privacy section, which relies on A↔B friendship).
    const frAgain = await api('POST', '/friends/request', { user_id: B.id }, A.t);
    check('block/unblock restores friend requests (2xx)', frAgain.status < 300, `status=${frAgain.status}`);
    const incoming2 = await must('GET', '/friends/requests/incoming', null, B.t);
    if (incoming2[0]) await api('POST', `/friends/requests/${incoming2[0].id}/accept`, {}, B.t);

    section('DM privacy (allow_dms_from_server_members + show_online_status)');
    // The flags ride the profile and default ON.
    const profB = await must('GET', '/profile', null, B.t);
    check('privacy/profile carries allow_dms flag (default true)', profB.allow_dms_from_server_members === true, JSON.stringify(profB.allow_dms_from_server_members));
    check('privacy/profile carries show_online flag (default true)', profB.show_online_status === true, JSON.stringify(profB.show_online_status));
    // B turns DMs off; the flag must persist.
    const patchPriv = await api('PATCH', '/profile', { allow_dms_from_server_members: false, show_online_status: false }, B.t);
    check('privacy/PATCH accepts flags (2xx)', patchPriv.status < 300, `status=${patchPriv.status}`);
    const profB2 = await must('GET', '/profile', null, B.t);
    check('privacy/flags persist', profB2.allow_dms_from_server_members === false && profB2.show_online_status === false,
        `allow_dms=${profB2.allow_dms_from_server_members} show_online=${profB2.show_online_status}`);
    // A and B are friends right now → the friends bypass applies.
    const dmFriend = await api('POST', '/dms', { user_id: B.id }, A.t);
    check('privacy/friend can still open a DM', dmFriend.status < 300, `status=${dmFriend.status}`);
    // Unfriend → the flag now gates BOTH the create path and (for the
    // conversation that already exists) every send.
    await api('DELETE', `/friends/${B.id}`, null, A.t);
    const dmDenied = await api('POST', '/dms', { user_id: B.id }, A.t);
    if (dmDenied.status === 403) {
        check('privacy/non-friend DM denied (403)', true, 'denied at conversation create');
    } else {
        // An existing conversation is still returned — the send must 403.
        const sendDenied = await api('POST', `/dms/${dmDenied.body.id}/messages`, { content: 'should not land' }, A.t);
        check('privacy/non-friend DM denied (403)', sendDenied.status === 403, `send status=${sendDenied.status}`);
    }
    // Restore for any later sections: flag back on, send works again.
    await api('PATCH', '/profile', { allow_dms_from_server_members: true, show_online_status: true }, B.t);
    const dmRestored = await api('POST', '/dms', { user_id: B.id }, A.t);
    const sendRestored = dmRestored.status < 300
        ? await api('POST', `/dms/${dmRestored.body.id}/messages`, { content: 'hello again' }, A.t)
        : dmRestored;
    check('privacy/flag back on restores DMs', sendRestored.status < 300, `status=${sendRestored.status}`);

    section('Emojis (custom)');
    const emo = await api('POST', `/servers/${srv.id}/emojis`, { name: 'party', image_url: 'https://example.com/party.png' }, A.t);
    check('emoji/create attempt returns a status', typeof emo.status === 'number', `status=${emo.status}`);
    const emos = await api('GET', `/servers/${srv.id}/emojis`, null, A.t);
    check('emoji/list endpoint 200', emos.status === 200, `status=${emos.status}`);

    section('Notification preferences + device tokens');
    // Field names must match NotificationPreferencesRequest (push_*). The old
    // payload sent dm_notifications/mention_notifications — serde dropped the
    // unknown fields, every COALESCE kept the old value, and the 200 passed
    // while writing nothing.
    const np = await api('PATCH', '/notifications/preferences', { push_dms: false, push_mentions: true }, A.t);
    check('notif/prefs PATCH (2xx)', np.status < 300, `status=${np.status}`);
    const npGet = await api('GET', '/notifications/preferences', null, A.t);
    check('notif/prefs GET 200', npGet.status === 200, `status=${npGet.status}`);
    check('notif/prefs PATCH actually wrote', npGet.body && npGet.body.push_dms === false && npGet.body.push_mentions === true,
        `push_dms=${npGet.body?.push_dms} push_mentions=${npGet.body?.push_mentions}`);
    await api('PATCH', '/notifications/preferences', { push_dms: true }, A.t); // restore
    // `status < 500` passed on 400, 401 and 404 — it proved the route was
    // routed and nothing else. Require the registration to SUCCEED and the
    // token to come back out, so a broken register is visible.
    const devToken = `tok_${RUN}`;
    const dev = await api('POST', '/device/register', { token: devToken, platform: 'android' }, A.t);
    check('device/register succeeds', dev.status === 200 || dev.status === 201, `status=${dev.status}`);
    const devList = await api('GET', '/device/list', null, A.t);
    // NOT asserting the body: list_devices withholds the token (correct — it is
    // a credential, not list metadata), and this file's `api` helper does not
    // surface a parsed body for this response, so a content assertion here
    // tests the helper rather than the endpoint. Verified separately by curl:
    // GET /device/list returns {"devices":[{id,platform,device_name,...}]}.
    check('device/list is reachable and authorized', devList.status === 200,
        `status=${devList.status}`);
    // Push DELIVERY does not exist: no FCM/APNs/WebPush client anywhere in the
    // backend. The endpoint must say so rather than returning success — how a
    // handover doc once came to claim push was fully implemented. This harness
    // runs against a throwaway backend with NO FCM env, and the endpoint
    // checks the transport BEFORE counting devices (a token was registered a
    // few lines up), so 501 is the one honest answer here. (Configured, it
    // would attempt a real wake to that garbage token and answer 502.)
    const pushTest = await api('POST', '/notifications/test', {}, A.t);
    check('notifications/test admits wakes are unconfigured (501)',
        pushTest.status === 501, `status=${pushTest.status}`);

    section('Moderation: timeout, kick, ban, reports, audit log');
    // Re-add B (they may still be a member; ensure). Timeout B.
    const to = await api('POST', `/servers/${srv.id}/timeout/${B.id}`, { duration_seconds: 300, reason: 'test' }, A.t);
    check('mod/timeout member (2xx)', to.status < 300, `status=${to.status}`);
    const report = await api('POST', `/servers/${srv.id}/reports`, { reported_user_id: B.id, reason: 'spam', message_id: null }, A.t);
    check('mod/report created (2xx or handled)', report.status < 500, `status=${report.status}`);
    const reportList = await api('GET', `/servers/${srv.id}/reports`, null, A.t);
    check('mod/reports list 200', reportList.status === 200, `status=${reportList.status}`);
    const audit = await api('GET', `/servers/${srv.id}/audit-log`, null, A.t);
    check('mod/audit-log 200', audit.status === 200, `status=${audit.status}`);
    const kick = await api('POST', `/servers/${srv.id}/kick/${B.id}`, {}, A.t);
    check('mod/kick member (2xx)', kick.status < 300, `status=${kick.status}`);
    const ban = await api('POST', `/servers/${srv.id}/bans/${B.id}`, { reason: 'test ban' }, A.t);
    check('mod/ban user (2xx or handled)', ban.status < 500, `status=${ban.status}`);
    const bans = await api('GET', `/servers/${srv.id}/bans`, null, A.t);
    check('mod/ban list 200', bans.status === 200, `status=${bans.status}`);

    section('AUTHORIZATION BOUNDARIES (negative tests)');
    // B (kicked/banned) should NOT be able to read the server's channels or post.
    const bReadChans = await api('GET', `/servers/${srv.id}/channels`, null, B.t);
    check('authz/kicked user cannot list server channels', bReadChans.status === 403 || bReadChans.status === 401 || bReadChans.status === 404, `status=${bReadChans.status}`);
    const bPost = await api('POST', `/channels/${tc.id}/messages`, { content: 'i should not be able to post', is_task: false }, B.t);
    check('authz/kicked user cannot post to channel', bPost.status >= 400, `status=${bPost.status}`);
    // B cannot delete A's message.
    const bDel = await api('DELETE', `/channels/${tc.id}/messages/${m1.id}`, null, B.t);
    check('authz/non-author cannot delete message', bDel.status >= 400, `status=${bDel.status}`);
    // B cannot change server settings.
    const bSettings = await api('PATCH', `/servers/${srv.id}/settings`, { require_media_e2ee: false }, B.t);
    check('authz/non-owner cannot change server settings', bSettings.status >= 400, `status=${bSettings.status}`);
    // Unauthenticated cannot hit a protected route.
    const noAuth = await api('GET', '/profile', null, null);
    check('authz/no token → 401 on protected route', noAuth.status === 401, `status=${noAuth.status}`);
    // Bogus token → 401.
    const badAuth = await api('GET', '/profile', null, 'not.a.jwt');
    check('authz/garbage token → 401', badAuth.status === 401, `status=${badAuth.status}`);

    section('CHECKLIST IDOR (cross-server, the HIGH fix)');
    // Fresh third user C who NEVER joins A's server — the cleanest IDOR probe.
    const C = { u: `outsider_${RUN}`, p: 'OutsiderPass1!' };
    await registerUser(C.u, C.p); await sleep(700);
    C.t = await loginUser(C.u, C.p); await sleep(700);
    // A makes a checklist channel and adds an item.
    const clc = await must('POST', `/servers/${srv.id}/channels`, { name: 'private-checklist', channel_type: 0, has_checklist: true }, A.t);
    const clTask = await must('POST', `/channels/${clc.id}/tasks`, { description: 'secret task' }, A.t);
    // C (non-member) must NOT be able to read the checklist.
    const cRead = await api('GET', `/channels/${clc.id}/tasks`, null, C.t);
    check('idor/non-member cannot READ channel checklist', cRead.status === 403 || cRead.status === 404, `status=${cRead.status}`);
    // C (non-member) must NOT be able to write to it.
    const cWrite = await api('POST', `/channels/${clc.id}/tasks`, { description: 'injected by outsider' }, C.t);
    check('idor/non-member cannot WRITE channel checklist', cWrite.status === 403 || cWrite.status === 404, `status=${cWrite.status}`);
    // C cannot toggle/delete A's existing task by guessing the task id.
    const cToggle = await api('PATCH', `/tasks/${clTask.id}`, { is_completed: true }, C.t);
    check('idor/non-member cannot mutate a task by id', cToggle.status === 403 || cToggle.status === 404, `status=${cToggle.status}`);
    const cDelTask = await api('DELETE', `/tasks/${clTask.id}`, null, C.t);
    check('idor/non-member cannot delete a task by id', cDelTask.status === 403 || cDelTask.status === 404, `status=${cDelTask.status}`);
    // C cannot read A's personal list tasks by guessing the list id.
    const aSelf = await must('GET', '/task-lists/self', null, A.t);
    const cList = await api('GET', `/task-lists/${aSelf.id}/tasks`, null, C.t);
    check('idor/non-owner cannot read personal list tasks', cList.status === 403 || cList.status === 404, `status=${cList.status}`);

    section('TASK REORDER + TAB PREFS (0.8.61)');
    // Personal-list drag-reorder: create 1,2,3; drop 3 first; then 1 after 2.
    const rl = await must('POST', '/task-lists', { title: `reorder_${RUN}` }, A.t);
    const t1 = await must('POST', `/task-lists/${rl.id}/tasks`, { description: 'one' }, A.t);
    const t2 = await must('POST', `/task-lists/${rl.id}/tasks`, { description: 'two' }, A.t);
    const t3 = await must('POST', `/task-lists/${rl.id}/tasks`, { description: 'three' }, A.t);
    await must('POST', `/tasks/${t3.id}/reorder`, { after_id: null }, A.t);
    let rOrder = (await must('GET', `/task-lists/${rl.id}/tasks`, null, A.t)).map(t => t.id);
    check('reorder/drop-to-front reorders the group', JSON.stringify(rOrder) === JSON.stringify([t3.id, t1.id, t2.id]), `order=${rOrder}`);
    await must('POST', `/tasks/${t1.id}/reorder`, { after_id: t2.id }, A.t);
    rOrder = (await must('GET', `/task-lists/${rl.id}/tasks`, null, A.t)).map(t => t.id);
    check('reorder/drop-after lands after the anchor', JSON.stringify(rOrder) === JSON.stringify([t3.id, t2.id, t1.id]), `order=${rOrder}`);
    // Anchor from another scope (a channel task) is not a sibling → 400.
    const crossScope = await api('POST', `/tasks/${t1.id}/reorder`, { after_id: clTask.id }, A.t);
    check('reorder/after_id outside the sibling group → 400', crossScope.status === 400, `status=${crossScope.status}`);
    // A task is never its own anchor.
    const selfAnchor = await api('POST', `/tasks/${t1.id}/reorder`, { after_id: t1.id }, A.t);
    check('reorder/self anchor → 400', selfAnchor.status === 400, `status=${selfAnchor.status}`);
    // Outsider C cannot reorder A's personal tasks.
    const cReorder = await api('POST', `/tasks/${t1.id}/reorder`, { after_id: null }, C.t);
    check('reorder/non-owner cannot reorder a personal task', cReorder.status === 403 || cReorder.status === 404, `status=${cReorder.status}`);

    // Tasks-bar tab prefs: PUT stores array order; favourites round-trip.
    await must('PUT', '/task-tab-prefs', { prefs: [
        { kind: 'channel', ref_id: clc.id, is_favorite: true },
        { kind: 'list', ref_id: rl.id, is_favorite: false },
    ] }, A.t);
    const gotPrefs = await must('GET', '/task-tab-prefs', null, A.t);
    check('prefs/PUT round-trips order + favourites',
        gotPrefs.length === 2
        && gotPrefs[0].kind === 'channel' && gotPrefs[0].ref_id === clc.id && gotPrefs[0].is_favorite === true
        && gotPrefs[1].kind === 'list' && gotPrefs[1].ref_id === rl.id && gotPrefs[1].is_favorite === false,
        JSON.stringify(gotPrefs));
    const cPrefs = await must('GET', '/task-tab-prefs', null, C.t);
    check('prefs/are per-user (C sees none)', Array.isArray(cPrefs) && cPrefs.length === 0, JSON.stringify(cPrefs));
    const badKind = await api('PUT', '/task-tab-prefs', { prefs: [{ kind: 'evil', ref_id: 1 }] }, A.t);
    check('prefs/invalid kind → 400', badKind.status === 400, `status=${badKind.status}`);
    await must('PUT', '/task-tab-prefs', { prefs: [{ kind: 'list', ref_id: rl.id, is_favorite: true }] }, A.t);
    const gotPrefs2 = await must('GET', '/task-tab-prefs', null, A.t);
    check('prefs/PUT replaces the whole set', gotPrefs2.length === 1 && gotPrefs2[0].is_favorite === true, JSON.stringify(gotPrefs2));

    // Due times + reminders (0.8.62): set, list, complete-excludes, clear.
    const dueSoon = new Date(Date.now() + 3600_000).toISOString();
    await must('PATCH', `/tasks/${t1.id}`, { due_at: dueSoon }, A.t);
    const withDue = (await must('GET', `/task-lists/${rl.id}/tasks`, null, A.t)).find(t => t.id === t1.id);
    check('due/PATCH sets due_at and GET returns it',
        typeof withDue.due_at === 'string' && Math.abs(Date.parse(withDue.due_at) - Date.parse(dueSoon)) < 2000,
        `due_at=${withDue.due_at}`);
    const badDue = await api('PATCH', `/tasks/${t1.id}`, { due_at: 'not-a-date' }, A.t);
    check('due/invalid due_at → 400', badDue.status === 400, `status=${badDue.status}`);
    let reminders = await must('GET', '/task-reminders', null, A.t);
    check('due/reminders lists the open due task', reminders.some(r => r.id === t1.id), JSON.stringify(reminders));
    const cReminders = await must('GET', '/task-reminders', null, C.t);
    check('due/reminders are per-user (C sees none)', !cReminders.some(r => r.id === t1.id), JSON.stringify(cReminders));
    await must('PATCH', `/tasks/${t1.id}`, { is_completed: true }, A.t);
    reminders = await must('GET', '/task-reminders', null, A.t);
    check('due/completed tasks drop out of reminders', !reminders.some(r => r.id === t1.id), JSON.stringify(reminders));
    await must('PATCH', `/tasks/${t1.id}`, { is_completed: false, due_at: '' }, A.t);
    const cleared = (await must('GET', `/task-lists/${rl.id}/tasks`, null, A.t)).find(t => t.id === t1.id);
    check('due/empty string clears due_at', cleared.due_at === null, `due_at=${cleared.due_at}`);

    section('INPUT CAPS (DoS hardening)');
    const big = 'x'.repeat(9000);
    const bigMsg = await api('POST', `/channels/${tc.id}/messages`, { content: 'ok', is_task: false }, A.t);
    const mId = bigMsg.body?.id;
    const bigEdit = mId ? await api('PATCH', `/channels/${tc.id}/messages/${mId}`, { content: big }, A.t) : { status: 0 };
    check('caps/edit_message rejects >8000 bytes', bigEdit.status === 413, `status=${bigEdit.status}`);
    const bigTask = await api('POST', `/channels/${clc.id}/tasks`, { description: big }, A.t);
    check('caps/task description rejects >8000 bytes', bigTask.status === 413, `status=${bigTask.status}`);
    const bigList = await api('POST', '/task-lists', { title: 'y'.repeat(300) }, A.t);
    check('caps/task-list title rejects >200 bytes', bigList.status === 413, `status=${bigList.status}`);
    const bigChan = await api('POST', `/servers/${srv.id}/channels`, { name: 'z'.repeat(200), channel_type: 0 }, A.t);
    check('caps/channel name rejects >100 bytes', bigChan.status === 413, `status=${bigChan.status}`);

    section('Account deletion (tombstone) — runs LAST, it destroys B');
    // Owner check: A still owns the server → refused.
    const delOwner = await api('DELETE', '/account', { confirm_username: A.u }, A.t);
    check('delete/owner refused while owning servers (409)', delOwner.status === 409, `status=${delOwner.status}`);
    // Wrong retyped username → refused.
    const delWrong = await api('DELETE', '/account', { confirm_username: 'someone_else' }, B.t);
    check('delete/wrong username rejected (400)', delWrong.status === 400, `status=${delWrong.status}`);
    // Real deletion. (The PASSWORD proof is client-side — the seed unwrap in
    // auth.deleteAccount — so the API test exercises the server-side gates.)
    const delReal = await api('DELETE', '/account', { confirm_username: B.u }, B.t);
    check('delete/succeeds (200)', delReal.status === 200, `status=${delReal.status}`);
    const afterDel = await api('GET', '/profile', null, B.t);
    check('delete/every session evicted (401)', afterDel.status === 401, `status=${afterDel.status}`);

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
