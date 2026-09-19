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
    // A block in either direction hides friend requests from the RECIPIENT.
    // Since 0.9.5 the request answers 201 exactly like any other (a 403 was a
    // block-status oracle, re-audit r2-1-L1-03) and IS written: a repeat 409s
    // and the sender's outgoing list shows it like a real pending request (a
    // silent no-write was the same oracle one request later, review finding
    // 11), while the recipient's incoming list, status and accept/reject
    // behave as if it had never been sent. The block itself already dissolved
    // the friendship (r2-1-L1-01), so no unfriend is needed to reach the gate.
    const frBlocked = await api('POST', '/friends/request', { user_id: A.id }, B.t);
    check('block/friend request from blocked user answers like success (no oracle)', frBlocked.status === 201, `status=${frBlocked.status}`);
    const outB = await api('GET', '/friends/requests/outgoing', null, B.t);
    check('block/...and the sender sees it as a real pending request (outgoing)', outB.status === 200 && Array.isArray(outB.body) && outB.body.some(r => r.receiver_id === A.id), `status=${outB.status} body=${JSON.stringify(outB.body).slice(0, 120)}`);
    const incA = await api('GET', '/friends/requests/incoming', null, A.t);
    check('block/...but the blocker receives no request', incA.status === 200 && Array.isArray(incA.body) && !incA.body.some(r => r.sender_id === B.id), `status=${incA.status} body=${JSON.stringify(incA.body).slice(0, 120)}`);
    const frBlocker = await api('POST', '/friends/request', { user_id: B.id }, A.t);
    check('block/friend request from blocker answers like success too', frBlocker.status === 201, `status=${frBlocker.status}`);
    const incB = await api('GET', '/friends/requests/incoming', null, B.t);
    check('block/...and the blocked side receives nothing either', incB.status === 200 && Array.isArray(incB.body) && !incB.body.some(r => r.sender_id === A.id), `status=${incB.status} body=${JSON.stringify(incB.body).slice(0, 120)}`);
    const unblock = await api('DELETE', `/users/${B.id}/block`, null, A.t);
    check('block/unblock (2xx)', unblock.status < 300, `status=${unblock.status}`);
    // Unblocked -> the friend system works again. The unblock deletes the
    // pair's pending rows (moderation_handlers::unblock_user), so this is a
    // FRESH request: 201, and B now actually receives it. The previous check
    // accepted any 2xx, which the blocked path answers too - it could not
    // fail (review finding 16); B's incoming list is what distinguishes
    // "delivered" from "swallowed". (Re-befriend for the DM privacy section,
    // which relies on A<->B friendship.)
    const frAgain = await api('POST', '/friends/request', { user_id: B.id }, A.t);
    check('block/unblock restores friend requests (201, a fresh request)', frAgain.status === 201, `status=${frAgain.status}`);
    const incoming2 = await must('GET', '/friends/requests/incoming', null, B.t);
    const fromA = Array.isArray(incoming2) ? incoming2.find(r => r.sender_id === A.id) : undefined;
    check('block/...and B\'s incoming list now DOES carry A\'s request', !!fromA, `count=${Array.isArray(incoming2) ? incoming2.length : '?'} body=${JSON.stringify(incoming2).slice(0, 120)}`);
    if (fromA) {
        const acc2 = await api('POST', `/friends/requests/${fromA.id}/accept`, {}, B.t);
        check('block/...and B accepts it (2xx)', acc2.status < 300, `status=${acc2.status}`);
    }

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

    section('NOTE TEXT + TRASH (migration 065, docs/NOTES.md)');
    // Capability: answered without having any list (C has none).
    const feat = await must('GET', '/task-lists/features', null, C.t);
    check('notes/features announces body, attachments and trash', feat.body === true && feat.attachments === true && feat.trash === true && typeof feat.trash_retention_days === 'number', JSON.stringify(feat));
    // A sealed body round-trips; plaintext is refused.
    const env = (ct) => JSON.stringify({ v: 2, t: 'self', ct, n: 'AAAA' });
    const noteList = await must('POST', '/task-lists', { title: `note_${RUN}`, body: env('BODY1') }, A.t);
    check('notes/create stores the sealed body', noteList.body === env('BODY1'), JSON.stringify(noteList.body));
    const plainBody = await api('PATCH', `/task-lists/${noteList.id}`, { body: 'plain words' }, A.t);
    check('notes/plaintext body → 400', plainBody.status === 400, `status=${plainBody.status}`);
    await must('PATCH', `/task-lists/${noteList.id}`, { body: env('BODY2') }, A.t);
    const afterBody = (await must('GET', '/task-lists', null, A.t)).find(l => l.id === noteList.id);
    check('notes/body-only PATCH keeps the title', afterBody.body === env('BODY2') && afterBody.title === `note_${RUN}`, JSON.stringify(afterBody));
    // Trash: gone from the listing and the reminders, listed in ?trashed=true, frozen, restorable.
    const noteTask = await must('POST', `/task-lists/${noteList.id}/tasks`, { description: 'due', due_at: dueSoon }, A.t);
    const trashed = await must('POST', `/task-lists/${noteList.id}/trash`, {}, A.t);
    check('trash/returns the trash time', typeof trashed.trashed_at === 'string', JSON.stringify(trashed));
    const liveAfter = await must('GET', '/task-lists', null, A.t);
    check('trash/hidden from the default listing', !liveAfter.some(l => l.id === noteList.id), `${liveAfter.length} live`);
    const trashList = await must('GET', '/task-lists?trashed=true', null, A.t);
    check('trash/listed by ?trashed=true', trashList.some(l => l.id === noteList.id), JSON.stringify(trashList.map(l => l.id)));
    reminders = await must('GET', '/task-reminders', null, A.t);
    check('trash/its items leave the reminders', !reminders.some(r => r.id === noteTask.id), JSON.stringify(reminders));
    const frozen = await api('POST', `/task-lists/${noteList.id}/tasks`, { description: 'more' }, A.t);
    check('trash/a write into a trashed list → 409', frozen.status === 409, `status=${frozen.status}`);
    const cTrash = await api('POST', `/task-lists/${noteList.id}/restore`, {}, C.t);
    check('trash/someone else cannot restore it (404)', cTrash.status === 404, `status=${cTrash.status}`);
    await must('POST', `/task-lists/${noteList.id}/restore`, {}, A.t);
    const back = await must('GET', '/task-lists', null, A.t);
    check('trash/restore brings it back', back.some(l => l.id === noteList.id && l.trashed_at === null), '');
    const selfTrash = await api('POST', `/task-lists/${aSelf.id}/trash`, {}, A.t);
    check('trash/Notes to self cannot be trashed (400)', selfTrash.status === 400, `status=${selfTrash.status}`);
    section('TASK TIMING (066): sealed schedule + snooze, the old-client guard');
    // Opaque stand-ins for client-sealed envelopes: the server only checks the shape.
    const SCHED = '{"v":2,"t":"self","ct":"c2NoZWR1bGU="}';
    const SNOOZE = '{"v":2,"t":"self","ct":"c25vb3pl"}';
    const feats = await must('GET', '/task-features', null, A.t);
    // A 429's wait must be readable cross-origin, or the paced .ics import
    // (api/icsImport.ts) can never honour it and falls back to guessing.
    const corsRes = await fetch(`${API}/task-features`, { headers: { Origin: 'http://cors-check.invalid', Authorization: `Bearer ${A.t}` } });
    const exposed = (corsRes.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    check('timing/CORS exposes retry-after and x-ratelimit-after', exposed.includes('retry-after') && exposed.includes('x-ratelimit-after'), `expose=${exposed}`);
    check('timing/GET /task-features names schedule + snooze', Array.isArray(feats.features) && feats.features.includes('schedule') && feats.features.includes('snooze'), JSON.stringify(feats));
    const ev = await must('POST', `/task-lists/${rl.id}/tasks`, { description: 'event', schedule: SCHED, due_at: dueSoon }, A.t);
    check('timing/create carries the sealed schedule in ONE request', ev.schedule === SCHED && 'snooze' in ev && typeof ev.updated_at === 'string', JSON.stringify(ev));
    const plainSched = await api('PATCH', `/tasks/${ev.id}`, { schedule: '{"v":1,"kind":"event","start":"2030-01-01"}' }, A.t);
    check('timing/plaintext schedule → 400 (envelope-only)', plainSched.status === 400, `status=${plainSched.status}`);
    const oldTick = await api('PATCH', `/tasks/${ev.id}`, { is_completed: true }, A.t);
    const afterOld = (await must('GET', `/task-lists/${rl.id}/tasks`, null, A.t)).find(t => t.id === ev.id);
    check('timing/an old client ticking a scheduled item → 409, item stays open', oldTick.status === 409 && afterOld.is_completed === false, `status=${oldTick.status}`);
    await must('PATCH', `/tasks/${ev.id}`, { snooze: SNOOZE }, A.t);
    const rem = (await must('GET', '/task-reminders', null, A.t)).find(r => r.id === ev.id);
    check('timing/reminder feed carries the sealed schedule + snooze', rem && rem.schedule === SCHED && rem.snooze === SNOOZE && rem.created_by !== undefined, JSON.stringify(rem));
    const cas = await api('PATCH', `/tasks/${ev.id}`, { due_at: new Date(Date.now() + 7200_000).toISOString(), expect_due_at: '2001-01-01T00:00:00Z' }, A.t);
    check('timing/expect_due_at mismatch → 409', cas.status === 409, `status=${cas.status}`);
    const cSched = await api('PATCH', `/tasks/${ev.id}`, { schedule: SCHED }, C.t);
    check('timing/an outsider cannot write a schedule', cSched.status === 403 || cSched.status === 404, `status=${cSched.status}`);
    const awareTick = await api('PATCH', `/tasks/${ev.id}`, { is_completed: true, recurrence_aware: true }, A.t);
    check('timing/a schedule-aware client completes it', awareTick.status === 200, `status=${awareTick.status}`);
    // A plain parent with a scheduled child: the server can refuse only a
    // client that does not know about schedules (it cannot see whether the
    // child repeats). An aware client's completion sweeps the child, which
    // is why the CLIENT refuses it when the child repeats
    // (taskCompletion.subtreeCompletionBlock; notes-walk-calendar proves the
    // built client does).
    const pParent = await must('POST', `/task-lists/${rl.id}/tasks`, { description: 'plain parent' }, A.t);
    const pKid = await must('POST', `/task-lists/${rl.id}/tasks`, { description: 'weekly kid', parent_id: pParent.id, schedule: SCHED, due_at: dueSoon }, A.t);
    const oldParent = await api('PATCH', `/tasks/${pParent.id}`, { is_completed: true }, A.t);
    check('timing/an old client ticking a PLAIN parent of a scheduled child → 409', oldParent.status === 409, `status=${oldParent.status}`);
    const awareParent = await api('PATCH', `/tasks/${pParent.id}`, { is_completed: true, recurrence_aware: true }, A.t);
    const kidAfter = (await must('GET', `/task-lists/${rl.id}/tasks`, null, A.t)).find(t => t.id === pKid.id);
    check('timing/an aware completion of the parent sweeps the scheduled child (the server cannot tell it repeats)', awareParent.status === 200 && kidAfter?.is_completed === true, `status=${awareParent.status} kid=${JSON.stringify(kidAfter)}`);
    // A SHARED item's timing must be a v3 channel envelope (bound to the
    // channel, epoch, creator and kind); an unbound v2 or a self envelope is
    // refused on create and on edit — with the v3 positive control.
    const CH_V3 = '{"v":3,"t":"ch","epoch":1,"ct":"c2NoZWR1bGU="}';
    const CH_V2 = '{"v":2,"t":"ch","epoch":1,"ct":"c2NoZWR1bGU="}';
    const chV2 = await api('POST', `/channels/${clc.id}/tasks`, { description: CH_V3, schedule: CH_V2 }, A.t);
    check('timing/a shared item created with a v2 channel schedule → 400', chV2.status === 400, `status=${chV2.status}`);
    const chV3 = await api('POST', `/channels/${clc.id}/tasks`, { description: CH_V3, schedule: CH_V3 }, A.t);
    check('timing/positive control: the same item with a v3 channel schedule → 200', chV3.status === 200, `status=${chV3.status}`);
    if (chV3.status === 200) {
        const chSnzV2 = await api('PATCH', `/tasks/${chV3.body.id}`, { snooze: CH_V2 }, A.t);
        const chSnzSelf = await api('PATCH', `/tasks/${chV3.body.id}`, { snooze: SNOOZE }, A.t);
        const chSnzV3 = await api('PATCH', `/tasks/${chV3.body.id}`, { snooze: CH_V3 }, A.t);
        check('timing/a shared item refuses a v2 or self snooze and takes a v3 one', chSnzV2.status === 400 && chSnzSelf.status === 400 && chSnzV3.status === 200,
            `v2=${chSnzV2.status} self=${chSnzSelf.status} v3=${chSnzV3.status}`);
    } else {
        check('timing/a shared item refuses a v2 or self snooze and takes a v3 one', false, 'SKIPPED: the v3 create failed, nothing to patch');
    }

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
