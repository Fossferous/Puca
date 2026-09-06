// Live regression for the SOCIAL half of the 2026-09-06 re-audit of Puca 0.9.4
// (fix-args-095 clusters r2-6-L6-01, r2-6-L6-02, r2-1-L1-01, r2-1-L1-02,
// r2-1-L1-03, r2-1-L1-04, C07, C08, C27, C20, C22, C17, C18). The channel /
// voice / clip / parked-frame half lives in its sibling file.
//
// The re-audit found no content route open to a non-member; what it found was
// the relationship layer not keeping up with the block/kick/ban/revoke events
// that are supposed to end a relationship: invites outliving their banned
// author, a block that left the friendship and the presence fan-out intact,
// two id-space oracles, a device revocation that left an unattested socket
// alive, and two moderator routes that resolved ids the caller may not VIEW.
// This file asserts the FIXED behaviour for each, and keeps every probe's
// positive control — an entitled caller succeeding on the same route and
// fixture — so a guard that refuses everyone cannot pass.
//
// Which checks FAIL on an unfixed 0.9.4 backend (the probes in the audit bundle
// reproduce each one; every other check in this file already held there):
//   invitesFollowCreator:   "empty body: expires_at is ~168 h out" and "...the
//                           stored row agrees" (0.9.4 minted eternal codes),
//                           "expires_in_hours 0: expires_at is null", "audit-log
//                           carries the invite create rows", "list_invites
//                           carries creator_id and creator username", "audit-log
//                           carries the invite delete row", "A's invite row is
//                           gone after the BAN", "a non-member joining with the
//                           banned creator's code -> 404", "...and the alt is NOT
//                           a member", "...and reads nothing from the server",
//                           the KICK and LEAVE row/404 pairs, and the two
//                           integrity checks at the end.
//   blockDissolvesFriendship: "friends row is gone after the block", "V's
//                           /friends omits A", "A's /friends omits V", "A's
//                           /friends/V/status no longer says is_friend:true",
//                           "unblock does not restore the friends row", "...nor
//                           the listing", both "pending request rows ... are
//                           gone" checks and their incoming-list twins.
//   blockHidesPresence:     "blocked A receives NO UserOnline{V}", "blocked A
//                           receives NO UserOffline{V}", "blocked A: GET
//                           /servers/:id/members shows V offline", "...
//                           members-with-roles agrees", "blocked A: GET
//                           /users/search reports V offline", and the mirror
//                           "blocker V sees A offline" (0.9.4's REST presence
//                           readers had no block term at all).
//   friendRequestOracles:   "A -> V (V blocked A) answers exactly like the
//                           success" (0.9.4: 403), "...and a pending row WAS
//                           written", "...and V appears in A's outgoing list",
//                           "a REPEAT A -> V answers exactly like a repeat of
//                           the control", "A's /friends/V/status reads
//                           request_sent", "a request to a tombstoned account
//                           answers exactly like a nonexistent id" (0.9.4:
//                           201), "...and no friend_requests row names the
//                           tombstone", "...and the outgoing list never renders
//                           deleted#<id>", "integrity: exactly two request
//                           rows". (The V-side checks - incoming silent,
//                           request_received false, accept/reject 404 - held on
//                           0.9.4 vacuously: the 403 wrote nothing. The first
//                           fix, 201-and-write-nothing, fails every sender-side
//                           check above except the 201 itself: review
//                           finding 11.)
//   keyRouteGates:          "stranger: public-key -> 404", "stranger:
//                           signing-key -> 404", all three "tombstone -> 404"
//                           checks, all three "id + 2^32 -> 404" key checks,
//                           "self + 2^32: dm-keys -> 404", "self - 2^32:
//                           dm-keys -> 404", "id + 2^32: dm-keys -> 404 for the
//                           entitled self". (The "blocked server-mate -> 200"
//                           identity-key checks hold on 0.9.4; they pin the
//                           corrected rule against the first cut of C08, which
//                           refused a blocked pair: review findings 1/6/7/10.)
//   dmKeysBlock:            "blocked B: dm-keys for V answers exactly like a
//                           stranger" and "blocker V: dm-keys for B answers
//                           exactly like a stranger" (the identity-key 200s
//                           beside them are the same positive control).
//   revokeDeviceKillsSocket: "unattested conn2 is CLOSED after the revoke",
//                           "...and conn2 received no fan-out after the revoke".
//   voiceMoveSourceView:    "VIEW-denied actor, target IN the hidden room,
//                           nonexistent destination -> 409 (not 404)", "ORACLE
//                           CLOSED", "exact hidden channel as destination -> the
//                           same 409", "channel_id null -> the same 409",
//                           "a visible destination -> the same 409" (0.9.4
//                           moved the target), "...and V is still in the hidden
//                           room", "...and no voice_disconnect audit row names A".
//   reportViewScope:        "a message in a channel A cannot VIEW -> 400",
//                           "ORACLE CLOSED", "...and no report row was planted".
//   migrationResetGate:     nothing — it asserts the env default stays closed.
//
// Prereqs: a backend on API (default http://127.0.0.1:3000) running against a
// THROWAWAY database that PGDB/PGPORT point at, with ALLOW_MIGRATION_PASSWORD_RESET
// unset; Node >= 22 (global WebSocket); psql at PSQL. Runtime ~40 s: one
// backend, sequential scenarios, fresh users per scenario.
//
// This file inserts users, sessions and devices directly into PGDB and leaves
// servers, invites and messages behind. It must NEVER run against a real database.
//
// Usage: API=http://127.0.0.1:3000 PGDB=puca_sec_test PGPORT=5433 node tests/reaudit-0906-social-live.mjs
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import {
    mkUser, mkServer, mkChannel, joinViaInvite, denyView, ws,
    check, section, done, psql, psql1, sleep, BITS, RUN,
    api, mintJwt, BASE,
} from './probe-lib.mjs';

const refused = (r) => r.status === 403 || r.status === 404;
const noLeak = (r, marker) => !r.text.includes(marker);
const row = (sql) => psql1(sql);
const sameAnswer = (a, b) => a.status === b.status && a.text === b.text;
const TWO32 = 4294967296;
// A user id that no serial on a throwaway database will ever reach, and that
// is still inside INT4 so it exercises "missing", not "out of range".
const NEVER_ID = 2100000000;
const HOUR = 3600e3;

// Poll a socket until it reports CLOSED (readyState 3) or ms elapse.
const waitClosed = async (w, ms = 5000) => {
    const t0 = Date.now();
    while (w.sock.readyState !== 3 && Date.now() - t0 < ms) await sleep(100);
    return w.sock.readyState;
};

// ---------------------------------------------------------------------------
// r2-6-L6-01 + r2-6-L6-02: an invite outlived its creator's kick/ban/leave
// (nothing but the MANAGE_SERVER delete route ever removed one), an empty body
// minted an eternal unlimited code, and neither creation nor deletion was audit
// logged while list_invites withheld the stored creator_id. Now migration 062's
// trigger deletes a creator's invites with their server_members row, an absent
// expires_in_hours means one week (0 means never), and both invite mutations
// are audited with the creator surfaced in the list. On 0.9.4 the banned
// author's code still admits a non-member.
// ---------------------------------------------------------------------------
async function invitesFollowCreator() {
    section('r2-6-L6-01/02: invites die with their creator; one-week default; audited and attributed');
    const O = mkUser('ivo'), A = mkUser('iva'), A2 = mkUser('iva2'), K = mkUser('ivk'), K2 = mkUser('ivk2'), L = mkUser('ivl'), L2 = mkUser('ivl2'), CTRL = mkUser('ivc'), CTRL2 = mkUser('ivc2');
    const S = await mkServer(O);
    const C = await mkChannel(S, 'general');
    check('fixture: server S is private', ['f', 'false'].includes(row(`SELECT COALESCE(is_public,false) FROM servers WHERE id='${S.id}'`)));
    await joinViaInvite(S, A); await joinViaInvite(S, K); await joinViaInvite(S, L);
    // The audit log pages at 50 by default; ask for the cap so a busy fixture
    // cannot push the invite rows off the first page.
    const auditLog = () => O.api('GET', `/servers/${S.id}/audit-log?limit=100`);

    // Control: the join route admits a non-member holding an entitled code.
    const ownerInv = await O.api('POST', `/servers/${S.id}/invites`, { max_uses: 50, expires_in_hours: 1 });
    check('control: owner mints an invite -> 200', ownerInv.status === 200 && !!ownerInv.json?.code, ownerInv.status + ' ' + ownerInv.text);
    const OWNER_CODE = ownerInv.json.code;
    let r = await CTRL.api('POST', `/invites/${OWNER_CODE}/join`);
    check('control: a non-member joins via the owner code -> 200', r.status === 200 && row(`SELECT count(*) FROM server_members WHERE server_id='${S.id}' AND user_id=${CTRL.id}`) === '1', r.status + ' ' + r.text);

    // A (ordinary member, CREATE_INVITE via @everyone) mints with an empty body.
    const auditBefore = await auditLog();
    const inviteRows = (resp) => (Array.isArray(resp.json) ? resp.json : []).filter(e => /invite/i.test(String(e.action_type || '')));
    check('fixture: audit-log readable by the owner', auditBefore.status === 200 && Array.isArray(auditBefore.json), auditBefore.status + ' ' + auditBefore.text.slice(0, 100));
    const before = inviteRows(auditBefore).length;
    const mint = await A.api('POST', `/servers/${S.id}/invites`, {});
    check('control: ordinary member A mints an invite with an empty body -> 200', mint.status === 200 && !!mint.json?.code, mint.status + ' ' + mint.text);
    const CODE = mint.json.code;
    const exp = Date.parse(String(mint.json?.expires_at || ''));
    const hoursOut = (exp - Date.now()) / HOUR;
    check('empty body: expires_at is ~168 h out (no longer eternal)', Number.isFinite(exp) && hoursOut > 167.5 && hoursOut < 168.5, `expires_at=${mint.json?.expires_at} hours=${hoursOut.toFixed(2)}`);
    check('...and the stored row agrees', row(`SELECT (expires_at IS NOT NULL)::text FROM server_invites WHERE code='${CODE}'`) === 'true');
    const never = await A.api('POST', `/servers/${S.id}/invites`, { expires_in_hours: 0 });
    check('expires_in_hours 0: expires_at is null (never)', never.status === 200 && never.json?.expires_at === null, never.status + ' ' + never.text);
    const NEVER_CODE = never.json?.code;
    const one = await A.api('POST', `/servers/${S.id}/invites`, { expires_in_hours: 1 });
    const oneExp = (Date.parse(String(one.json?.expires_at || '')) - Date.now()) / HOUR;
    check('control: an explicit expires_in_hours is honoured (~1 h)', one.status === 200 && oneExp > 0.5 && oneExp < 1.5, one.status + ' ' + one.text);

    // r2-6-L6-02: audited on create, attributed in the list, audited on delete.
    const afterMint = await auditLog();
    const created = inviteRows(afterMint);
    check('audit-log carries the invite create rows, actor = A', created.length >= before + 3 && created.some(e => Number(e.actor_id) === A.id), JSON.stringify(created).slice(0, 300));
    const list = await O.api('GET', `/servers/${S.id}/invites`);
    const mine = (Array.isArray(list.json) ? list.json : []).find(i => i.code === CODE);
    check('control: owner lists invites and sees A\'s code', list.status === 200 && !!mine, list.status + ' ' + list.text.slice(0, 200));
    const nameKey = mine ? Object.keys(mine).find(k => /creator/i.test(k) && /name/i.test(k)) : undefined;
    check('list_invites carries creator_id and creator username', !!mine && Number(mine.creator_id) === A.id && !!nameKey && mine[nameKey] === A.username, JSON.stringify(mine));
    r = await A.api('GET', `/servers/${S.id}/invites`);
    check('control: an ordinary member still cannot list invites (403)', r.status === 403, r.status + ' ' + r.text);
    const del = await O.api('DELETE', `/servers/${S.id}/invites/${NEVER_CODE}`);
    check('control: owner deletes the never-expiring code -> 200', del.status === 200, del.status + ' ' + del.text);
    const afterDel = inviteRows(await auditLog());
    check('audit-log carries the invite delete row, actor = owner', afterDel.length >= created.length + 1 && afterDel.some(e => Number(e.actor_id) === O.id && /delet|revok|remov/i.test(String(e.action_type))), JSON.stringify(afterDel).slice(0, 300));

    // r2-6-L6-01: the ban. A's invite must go with A's membership; the owner's
    // must survive it (the trigger is keyed on the creator, not the server).
    const ban = await O.api('POST', `/servers/${S.id}/bans/${A.id}`, { reason: 'probe' });
    check('fixture: owner bans A (member row gone)', ban.status === 200 && row(`SELECT count(*) FROM server_members WHERE server_id='${S.id}' AND user_id=${A.id}`) === '0', ban.status + ' ' + ban.text);
    check('A\'s invite row is gone after the BAN (migration 062 trigger)', row(`SELECT count(*) FROM server_invites WHERE server_id='${S.id}' AND creator_id=${A.id}`) === '0');
    check('control: the owner\'s invite survived the ban', row(`SELECT count(*) FROM server_invites WHERE code='${OWNER_CODE}'`) === '1');
    r = await A2.api('POST', `/invites/${CODE}/join`);
    check('a non-member joining with the banned creator\'s code -> 404 (invite gone)', r.status === 404, r.status + ' ' + r.text);
    check('...and the alt is NOT a member', row(`SELECT count(*) FROM server_members WHERE server_id='${S.id}' AND user_id=${A2.id}`) === '0');
    r = await A2.api('GET', `/servers/${S.id}/channels`);
    check('...and reads nothing from the server', refused(r), r.status);
    r = await CTRL2.api('POST', `/invites/${OWNER_CODE}/join`);
    check('control: the owner\'s code still admits a non-member after the ban -> 200', r.status === 200 && row(`SELECT count(*) FROM server_members WHERE server_id='${S.id}' AND user_id=${CTRL2.id}`) === '1', r.status + ' ' + r.text);

    // The other two ways a creator leaves server_members.
    const kInv = await K.api('POST', `/servers/${S.id}/invites`, {});
    check('fixture: K mints an invite', kInv.status === 200 && !!kInv.json?.code, kInv.status + ' ' + kInv.text);
    const kick = await O.api('POST', `/servers/${S.id}/kick/${K.id}`, { reason: 'probe' });
    check('fixture: owner kicks K', kick.status === 200, kick.status + ' ' + kick.text);
    check('K\'s invite row is gone after the KICK', row(`SELECT count(*) FROM server_invites WHERE code='${kInv.json?.code}'`) === '0');
    r = await K2.api('POST', `/invites/${kInv.json?.code}/join`);
    check('...and the kicked creator\'s code -> 404', r.status === 404, r.status + ' ' + r.text);
    const lInv = await L.api('POST', `/servers/${S.id}/invites`, {});
    check('fixture: L mints an invite', lInv.status === 200 && !!lInv.json?.code, lInv.status + ' ' + lInv.text);
    const leave = await L.api('POST', `/servers/${S.id}/leave`);
    check('fixture: L leaves', leave.status === 200 || leave.status === 204, leave.status + ' ' + leave.text);
    check('L\'s invite row is gone after the LEAVE', row(`SELECT count(*) FROM server_invites WHERE code='${lInv.json?.code}'`) === '0');
    r = await L2.api('POST', `/invites/${lInv.json?.code}/join`);
    check('...and the departed creator\'s code -> 404', r.status === 404, r.status + ' ' + r.text);
    check('integrity: none of the three alts holds a member row', row(`SELECT count(*) FROM server_members WHERE server_id='${S.id}' AND user_id IN (${A2.id}, ${K2.id}, ${L2.id})`) === '0');
    r = await A2.api('GET', `/channels/${C}/messages`);
    check('...and the general channel is refused to the alt', refused(r), r.status);
}

// ---------------------------------------------------------------------------
// r2-1-L1-01: block_user inserted the blocked_users row and left the friends
// row (and any pending friend_requests) in place, so every friendship-derived
// capability — friends list, friendship status, presence audience, dm-keys —
// survived the block. Now the block deletes both, mirroring remove_friend, and
// an unblock does not bring them back. On 0.9.4 the friends row survives.
// ---------------------------------------------------------------------------
async function blockDissolvesFriendship() {
    section('r2-1-L1-01: a block dissolves the friendship and any pending request');
    const A = mkUser('bfa'), V = mkUser('bfv'), F = mkUser('bff');
    const friendsRow = (x, y) => row(`SELECT count(*) FROM friends WHERE (user1_id=${x} AND user2_id=${y}) OR (user1_id=${y} AND user2_id=${x})`);
    const pendingRows = (x, y) => row(`SELECT count(*) FROM friend_requests WHERE ((sender_id=${x} AND receiver_id=${y}) OR (sender_id=${y} AND receiver_id=${x})) AND status='pending'`);
    const lists = async (who, other) => { const r = await who.api('GET', '/friends'); return r.status === 200 && Array.isArray(r.json) && r.json.some(f => f.id === other.id); };

    // Friendship through the real flow: V requests, A accepts. F is V's other
    // friend and the positive control for every "gone" assertion below.
    let r = await V.api('POST', '/friends/request', { user_id: A.id });
    check('fixture: V requests A', r.status === 201, r.status + ' ' + r.text);
    r = await A.api('GET', '/friends/requests/incoming');
    const req = (Array.isArray(r.json) ? r.json : []).find(x => x.sender_id === V.id);
    check('fixture: A sees the incoming request', !!req, r.status + ' ' + r.text.slice(0, 160));
    r = await A.api('POST', `/friends/requests/${req?.id}/accept`);
    check('fixture: A accepts (friends row exists)', r.status === 200 && friendsRow(A.id, V.id) === '1', r.status + ' ' + r.text);
    psql(`INSERT INTO friends (user1_id, user2_id) VALUES (${Math.min(V.id, F.id)}, ${Math.max(V.id, F.id)})`);
    check('control: V lists both A and F as friends before the block', await lists(V, A) && await lists(V, F));
    r = await A.api('GET', `/friends/${V.id}/status`);
    check('control: A sees is_friend:true before the block', r.status === 200 && r.json?.is_friend === true, r.status + ' ' + r.text);

    const blk = await V.api('POST', `/users/${A.id}/block`);
    check('fixture: V blocks A -> 200', blk.status === 200 && row(`SELECT count(*) FROM blocked_users WHERE blocker_id=${V.id} AND blocked_id=${A.id}`) === '1', blk.status + ' ' + blk.text);
    check('friends row is gone after the block', friendsRow(A.id, V.id) === '0');
    check('control: V\'s OTHER friendship (F) is untouched', friendsRow(V.id, F.id) === '1');
    check('V\'s /friends omits A', !(await lists(V, A)));
    check('control: V\'s /friends still lists F', await lists(V, F));
    check('A\'s /friends omits V', !(await lists(A, V)));
    r = await A.api('GET', `/friends/${V.id}/status`);
    check('A\'s /friends/V/status no longer says is_friend:true', r.status !== 200 || r.json?.is_friend !== true, r.status + ' ' + r.text);

    // Unblock restores nothing: the friendship was ended, not suspended.
    const un = await V.api('DELETE', `/users/${A.id}/block`);
    check('fixture: V unblocks A -> 200', un.status === 200, un.status + ' ' + un.text);
    check('unblock does not restore the friends row', friendsRow(A.id, V.id) === '0');
    check('...nor the listing', !(await lists(V, A)) && !(await lists(A, V)));

    // Pending requests, both directions, each on a fresh pair.
    const A2 = mkUser('bfa2'), V2 = mkUser('bfv2');
    r = await A2.api('POST', '/friends/request', { user_id: V2.id });
    check('fixture: A2 -> V2 request pending', r.status === 201 && pendingRows(A2.id, V2.id) === '1', r.status + ' ' + r.text);
    r = await V2.api('POST', `/users/${A2.id}/block`);
    check('fixture: V2 blocks A2', r.status === 200, r.status + ' ' + r.text);
    check('pending request rows (blocked -> blocker) are gone after the block', pendingRows(A2.id, V2.id) === '0');
    r = await V2.api('GET', '/friends/requests/incoming');
    check('...and V2\'s incoming list omits A2', r.status === 200 && !(Array.isArray(r.json) && r.json.some(x => x.sender_id === A2.id)), r.status + ' ' + r.text.slice(0, 160));
    const A3 = mkUser('bfa3'), V3 = mkUser('bfv3');
    r = await V3.api('POST', '/friends/request', { user_id: A3.id });
    check('fixture: V3 -> A3 request pending', r.status === 201 && pendingRows(A3.id, V3.id) === '1', r.status + ' ' + r.text);
    r = await V3.api('POST', `/users/${A3.id}/block`);
    check('fixture: V3 blocks A3', r.status === 200, r.status + ' ' + r.text);
    check('pending request rows (blocker -> blocked) are gone after the block', pendingRows(A3.id, V3.id) === '0');
    r = await A3.api('GET', '/friends/requests/incoming');
    check('...and A3\'s incoming list omits V3', r.status === 200 && !(Array.isArray(r.json) && r.json.some(x => x.sender_id === V3.id)), r.status + ' ' + r.text.slice(0, 160));
}

// ---------------------------------------------------------------------------
// r2-1-L1-02: presence_audience UNIONed shared-server members and friends with
// no blocked_users predicate, so a blocked co-member kept receiving the
// blocker's UserOnline/UserOffline frames on an idle socket. Now the audience
// excludes a block in either direction - and so do the three REST presence
// readers the stock client polls (GET /servers/:id/members every 10 s,
// members-with-roles, /users/search): gating only the push side merely moved
// the leak to the poll (review findings 2/12/15). Fail closed: a block-lookup
// error reports everyone offline. On 0.9.4 A receives both frames and every
// REST reader reports V online to A.
// ---------------------------------------------------------------------------
async function blockHidesPresence() {
    section('r2-1-L1-02: a blocked co-member receives no presence for the blocker - frames or REST');
    const O = mkUser('pro'), V = mkUser('prv'), A = mkUser('pra'), M = mkUser('prm'), N = mkUser('prn');
    const S = await mkServer(O);
    await joinViaInvite(S, V); await joinViaInvite(S, A); await joinViaInvite(S, M);
    psql(`UPDATE users SET show_online_status = true WHERE id = ${V.id}`);
    const online = (uid) => (f) => f.type === 'UserOnline' && f.payload?.user?.id === uid;
    const offline = (uid) => (f) => f.type === 'UserOffline' && f.payload?.user_id === uid;
    // The REST presence readers: `uid`'s is_online as `viewer` sees it, or
    // undefined when uid is not in the response at all (so a missing row can
    // never pass as "offline"; every check below compares against a boolean).
    const restOnline = async (viewer, path, uid = V.id) => {
        const r = await viewer.api('GET', path);
        const hit = (Array.isArray(r.json) ? r.json : []).find(m => Number(m.id) === uid);
        return r.status === 200 && hit ? hit.is_online : undefined;
    };
    const MEMBERS = `/servers/${S.id}/members`, ROLES = `/servers/${S.id}/members-with-roles`;
    const SEARCH = `/users/search?q=${encodeURIComponent(V.username)}`;

    // Before the block: A is an ordinary co-member and IS in the audience.
    let om = await ws(M), oa = await ws(A), on = await ws(N);
    await sleep(500);
    let ov = await ws(V);
    const preM = await om.waitFor(online(V.id), 2500), preA = await oa.waitFor(online(V.id), 2500);
    check('control (pre-block): co-members M and A both receive UserOnline{V}', !!preM && !!preA, JSON.stringify(oa.frames.map(f => f.type)));
    check('control: a non-member N receives no UserOnline{V}', !on.frames.some(online(V.id)));
    check('control (pre-block): GET /servers/:id/members reports V online to A and to M', (await restOnline(A, MEMBERS)) === true && (await restOnline(M, MEMBERS)) === true);
    check('control (pre-block): members-with-roles and /users/search report V online to A', (await restOnline(A, ROLES)) === true && (await restOnline(A, SEARCH)) === true);
    ov.close();
    check('control (pre-block): M receives UserOffline{V}', !!(await om.waitFor(offline(V.id), 4000)), JSON.stringify(om.frames.map(f => f.type)));
    await sleep(500);
    check('control (pre-block): A receives UserOffline{V}', oa.frames.some(offline(V.id)), JSON.stringify(oa.frames.map(f => f.type)));
    om.close(); oa.close(); on.close();
    await sleep(800);

    const blk = await V.api('POST', `/users/${A.id}/block`);
    check('fixture: V blocks A -> 200', blk.status === 200, blk.status + ' ' + blk.text);
    om = await ws(M); oa = await ws(A); on = await ws(N);
    await sleep(500);
    ov = await ws(V);
    check('control: entitled co-member M receives UserOnline{V} after the block', !!(await om.waitFor(online(V.id), 2500)), JSON.stringify(om.frames.map(f => f.type)));
    await sleep(500);
    check('blocked A receives NO UserOnline{V}', !oa.frames.some(online(V.id)), JSON.stringify(oa.frames).slice(0, 300));
    check('control: non-member N still receives nothing', !on.frames.some(online(V.id)));
    // The REST readers, while V is demonstrably online (M just saw the frame).
    check('control: entitled co-member M sees V online on GET /servers/:id/members after the block', (await restOnline(M, MEMBERS)) === true);
    check('blocked A: GET /servers/:id/members shows V offline', (await restOnline(A, MEMBERS)) === false);
    check('blocked A: members-with-roles agrees (V offline)', (await restOnline(A, ROLES)) === false);
    check('control: M sees V online on members-with-roles', (await restOnline(M, ROLES)) === true);
    check('blocked A: GET /users/search reports V offline', (await restOnline(A, SEARCH)) === false);
    check('control: M\'s /users/search still reports V online', (await restOnline(M, SEARCH)) === true);
    // Either direction: the blocker does not see the blocked account either.
    check('control: M sees A online on GET /servers/:id/members (A\'s socket is visible)', (await restOnline(M, MEMBERS, A.id)) === true);
    check('mirror: blocker V sees blocked A offline on GET /servers/:id/members', (await restOnline(V, MEMBERS, A.id)) === false);
    ov.close();
    check('control: M receives UserOffline{V}', !!(await om.waitFor(offline(V.id), 4000)), JSON.stringify(om.frames.map(f => f.type)));
    await sleep(500);
    check('blocked A receives NO UserOffline{V}', !oa.frames.some(offline(V.id)), JSON.stringify(oa.frames).slice(0, 300));
    om.close(); oa.close(); on.close();
}

// ---------------------------------------------------------------------------
// r2-1-L1-03 + r2-1-L1-04: POST /friends/request answered 403 "You cannot send
// a friend request to this user" iff a block existed (a one-bit block oracle,
// GET /blocked resolving the caller's own direction), and its existence probe
// omitted deleted_at so a tombstoned account was a valid target whose
// deleted#<id> name came back through /friends/requests/outgoing. The first
// fix answered 201 and wrote nothing, which only moved the oracle one request
// later (review finding 11): a real request answers 409 on repeat, lists in
// /friends/requests/outgoing and reads request_sent; the discarded one did
// none of that. Now a request across a block is WRITTEN and is a real pending
// request from the SENDER's side, and does not exist from the RECIPIENT's
// side (absent from incoming, request_received false, accept / reject answer
// the 404 a never-issued id gets); a tombstone answers exactly like a
// never-issued id. On 0.9.4: 403, and 201.
// ---------------------------------------------------------------------------
async function friendRequestOracles() {
    section('r2-1-L1-03/04: friend requests are neither a block oracle nor a tombstone oracle');
    const A = mkUser('fra'), V = mkUser('frv'), W = mkUser('frw'), D = mkUser('frd');
    const request = (to) => A.api('POST', '/friends/request', { user_id: to });
    const pending = (to) => row(`SELECT count(*) FROM friend_requests WHERE sender_id=${A.id} AND receiver_id=${to}`);
    const requestIdFor = (to) => row(`SELECT id FROM friend_requests WHERE sender_id=${A.id} AND receiver_id=${to} AND status='pending'`);
    const outgoing = async () => { const r = await A.api('GET', '/friends/requests/outgoing'); return Array.isArray(r.json) ? r.json : []; };
    const outgoingHas = async (to) => (await outgoing()).some(x => x.receiver_id === to);
    const friendsRow = () => row(`SELECT count(*) FROM friends WHERE user1_id=${Math.min(A.id, V.id)} AND user2_id=${Math.max(A.id, V.id)}`);

    // Control: the success shape from an unblocked live target, and the shape
    // of a REPEAT (409) - the repeat is what the first fix leaked on.
    const ctl = await request(W.id);
    check('control: A -> W (no block) -> 201 and a pending row', ctl.status === 201 && pending(W.id) === '1', ctl.status + ' ' + ctl.text);
    check('control: W appears in A\'s outgoing list', await outgoingHas(W.id));
    const ctlRepeat = await request(W.id);
    check('control: a repeat A -> W -> 409 "Friend request already pending"', ctlRepeat.status === 409 && /already pending/i.test(ctlRepeat.text), ctlRepeat.status + ' ' + ctlRepeat.text);
    let r = await A.api('GET', `/friends/${W.id}/status`);
    check('control: A\'s /friends/W/status reads request_sent:true with the row id', r.status === 200 && r.json?.request_sent === true && String(r.json?.request_id) === requestIdFor(W.id), r.status + ' ' + r.text);
    r = await W.api('GET', `/friends/${A.id}/status`);
    check('control: W\'s /friends/A/status reads request_received:true with the same id', r.status === 200 && r.json?.request_received === true && String(r.json?.request_id) === requestIdFor(W.id), r.status + ' ' + r.text);

    // r2-1-L1-03: from A's side the request to V is real in every respect...
    r = await V.api('POST', `/users/${A.id}/block`);
    check('fixture: V blocks A', r.status === 200, r.status + ' ' + r.text);
    r = await A.api('GET', '/blocked');
    check('fixture: A\'s own block list does not carry V (the block is V -> A)', r.status === 200 && Array.isArray(r.json) && !r.json.some(b => (b.user_id ?? b.blocked_id ?? b.id) === V.id), r.status + ' ' + r.text.slice(0, 120));
    const blocked = await request(V.id);
    check('A -> V (V blocked A) answers exactly like the success', sameAnswer(blocked, ctl), `${blocked.status} ${blocked.text} | control ${ctl.status} ${ctl.text}`);
    check('...and a pending row WAS written for it (the request is real from A\'s side)', pending(V.id) === '1');
    const hiddenId = requestIdFor(V.id);
    check('...and V appears in A\'s outgoing list exactly like W (id, receiver, username)', /^\d+$/.test(hiddenId) && (await outgoing()).some(x => x.receiver_id === V.id && String(x.id) === hiddenId && x.receiver_username === V.username), JSON.stringify(await outgoing()).slice(0, 200));
    const blockedRepeat = await request(V.id);
    check('a REPEAT A -> V answers exactly like a repeat of the control (409, same body)', sameAnswer(blockedRepeat, ctlRepeat), `${blockedRepeat.status} ${blockedRepeat.text} | control ${ctlRepeat.status} ${ctlRepeat.text}`);
    check('...and the repeat wrote no second row', pending(V.id) === '1');
    r = await A.api('GET', `/friends/${V.id}/status`);
    check('A\'s /friends/V/status reads request_sent:true with the row id', r.status === 200 && r.json?.request_sent === true && String(r.json?.request_id) === hiddenId, r.status + ' ' + r.text);
    // ...and does not exist from V's side.
    r = await V.api('GET', '/friends/requests/incoming');
    check('V\'s incoming list is silent', r.status === 200 && !(Array.isArray(r.json) && r.json.some(x => x.sender_id === A.id)) && noLeak(r, `"id":${hiddenId},`), r.status + ' ' + r.text.slice(0, 160));
    r = await V.api('GET', `/friends/${A.id}/status`);
    check('V\'s /friends/A/status reads request_received:false, request_id:null', r.status === 200 && r.json?.is_friend === false && r.json?.request_received === false && r.json?.request_id === null, r.status + ' ' + r.text);
    const ghostAccept = await V.api('POST', `/friends/requests/${NEVER_ID}/accept`);
    check('reference: V accepting a never-issued request id -> 404', ghostAccept.status === 404, ghostAccept.status + ' ' + ghostAccept.text);
    const hiddenAccept = await V.api('POST', `/friends/requests/${hiddenId}/accept`);
    check('V accepting the hidden request\'s (guessable) id answers exactly like the never-issued id', sameAnswer(hiddenAccept, ghostAccept), `${hiddenAccept.status} ${hiddenAccept.text} | ghost ${ghostAccept.status} ${ghostAccept.text}`);
    check('...and no friendship was created, the row still pending', friendsRow() === '0' && pending(V.id) === '1' && requestIdFor(V.id) === hiddenId);
    const ghostReject = await V.api('POST', `/friends/requests/${NEVER_ID}/reject`);
    const hiddenReject = await V.api('POST', `/friends/requests/${hiddenId}/reject`);
    check('V rejecting it answers exactly like the never-issued id (404), and the row survives', ghostReject.status === 404 && sameAnswer(hiddenReject, ghostReject) && requestIdFor(V.id) === hiddenId, `${hiddenReject.status} ${hiddenReject.text} | ghost ${ghostReject.status} ${ghostReject.text}`);

    // r2-1-L1-04: tombstone D exactly as delete_account anonymises it.
    psql(`UPDATE users SET username='deleted#'||id, display_name=NULL, public_key=NULL, account_sign_pub=NULL, deleted_at=NOW(), token_version=token_version+1 WHERE id=${D.id}`);
    const ghost = await request(NEVER_ID);
    check('control: a never-issued id -> 404', ghost.status === 404, ghost.status + ' ' + ghost.text);
    const tomb = await request(D.id);
    check('a request to a tombstoned account answers exactly like a nonexistent id', sameAnswer(tomb, ghost), `${tomb.status} ${tomb.text} | ghost ${ghost.status} ${ghost.text}`);
    check('...and no friend_requests row names the tombstone', pending(D.id) === '0');
    check('...and the outgoing list never renders deleted#<id>', !(await outgoingHas(D.id)));
    const wide = await request(W.id + TWO32);
    check('id + 2^32 answers exactly like a nonexistent id (no i32 wrap)', sameAnswer(wide, ghost), `${wide.status} ${wide.text}`);
    check('integrity: exactly two request rows were written in this scenario (A -> W, A -> V)', row(`SELECT count(*) FROM friend_requests WHERE sender_id=${A.id}`) === '2' && pending(W.id) === '1' && pending(V.id) === '1');
}

// ---------------------------------------------------------------------------
// C08 + C27: GET /users/:id/public-key and /signing-key had no relationship
// gate, no deleted_at filter, and bound a Path<i64> as i32 while echoing the
// untruncated id, so any account could enumerate the id space (tombstones
// included) and alias row N as 2^32+N; get_user_dm_keys chose its self branch
// on the truncated id, so 2^32+me skipped the relationship gate. Now an id
// outside INT4 is 404 everywhere, the key routes need a relationship (self,
// friend, a shared server, or a peer who already wrote) and refuse tombstones.
// A block is deliberately NOT a refusal on the two identity-key routes: they
// are the sole source of the peer key for mesh voice E2EE, the DTLS pin and
// existing DM history, and a block evicts nobody from a shared call (review
// findings 1/6/7/10 - the first cut of C08 refused a blocked pair and so
// silently downgraded a blocked co-member's media to transport-only). Only
// dm-keys, the device census, is block-gated (C07, dmKeysBlock below). On
// 0.9.4 the stranger, the tombstone and every alias answer 200.
// ---------------------------------------------------------------------------
async function keyRouteGates() {
    section('C08/C27: public-key, signing-key and dm-keys are relationship-gated, tombstone-blind and width-safe');
    const V = mkUser('kgv'), M = mkUser('kgm'), B = mkUser('kgb'), T = mkUser('kgt'), MT = mkUser('kgmt');
    const vPub = randomBytes(32).toString('base64'), vSign = randomBytes(32).toString('base64');
    const mPub = randomBytes(32).toString('base64');
    psql(`UPDATE users SET public_key='${vPub}', account_sign_pub='${vSign}' WHERE id=${V.id}`);
    psql(`UPDATE users SET public_key='${mPub}' WHERE id=${M.id}`);
    psql(`UPDATE users SET public_key='${randomBytes(32).toString('base64')}', account_sign_pub='${randomBytes(32).toString('base64')}' WHERE id=${T.id}`);
    const SV = await mkServer(V); await joinViaInvite(SV, M);
    const ST = await mkServer(T); await joinViaInvite(ST, MT);
    check('fixture: B shares no server, friendship or DM with V', row(`SELECT (SELECT count(*) FROM server_members a JOIN server_members b ON a.server_id=b.server_id WHERE a.user_id=${B.id} AND b.user_id=${V.id}) + (SELECT count(*) FROM friends WHERE ${B.id} IN (user1_id,user2_id) AND ${V.id} IN (user1_id,user2_id)) + (SELECT count(*) FROM dm_conversations WHERE ${B.id} IN (user1_id,user2_id) AND ${V.id} IN (user1_id,user2_id))`) === '0');

    let r = await V.api('GET', `/users/${V.id}/public-key`);
    check('control: self public-key -> 200 with the stored key', r.status === 200 && r.json?.public_key === vPub, r.status + ' ' + r.text);
    r = await V.api('GET', `/users/${V.id}/signing-key`);
    check('control: self signing-key -> 200 with the stored key', r.status === 200 && r.json?.account_sign_pub === vSign, r.status + ' ' + r.text);
    r = await M.api('GET', `/users/${V.id}/public-key`);
    check('control: a server-mate reads V\'s public-key -> 200', r.status === 200 && r.json?.public_key === vPub, r.status + ' ' + r.text);
    r = await M.api('GET', `/users/${V.id}/signing-key`);
    check('control: a server-mate reads V\'s signing-key -> 200', r.status === 200 && r.json?.account_sign_pub === vSign, r.status + ' ' + r.text);

    // Positive control: a block does not withhold the identity keys, in
    // either direction (voice E2EE and DM history depend on them; the device
    // census - dm-keys - is the only key read a block refuses).
    r = await V.api('POST', `/users/${M.id}/block`);
    check('fixture: V blocks server-mate M', r.status === 200 && row(`SELECT count(*) FROM blocked_users WHERE blocker_id=${V.id} AND blocked_id=${M.id}`) === '1', r.status + ' ' + r.text);
    r = await M.api('GET', `/users/${V.id}/public-key`);
    check('blocked server-mate M still reads V\'s public-key -> 200 (identity keys are not block-gated)', r.status === 200 && r.json?.public_key === vPub, r.status + ' ' + r.text);
    r = await M.api('GET', `/users/${V.id}/signing-key`);
    check('blocked server-mate M still reads V\'s signing-key -> 200', r.status === 200 && r.json?.account_sign_pub === vSign, r.status + ' ' + r.text);
    r = await V.api('GET', `/users/${M.id}/public-key`);
    check('...and the blocker V still reads M\'s public-key -> 200 (either direction)', r.status === 200 && r.json?.public_key === mPub, r.status + ' ' + r.text);
    r = await V.api('DELETE', `/users/${M.id}/block`);
    check('fixture: V unblocks M', r.status === 200, r.status + ' ' + r.text);

    r = await B.api('GET', `/users/${V.id}/public-key`);
    check('stranger: public-key -> 404, no key in the body', r.status === 404 && noLeak(r, vPub), r.status + ' ' + r.text);
    r = await B.api('GET', `/users/${V.id}/signing-key`);
    check('stranger: signing-key -> 404, no key in the body', r.status === 404 && noLeak(r, vSign), r.status + ' ' + r.text);
    const missing = await B.api('GET', `/users/${NEVER_ID}/public-key`);
    check('stranger: a never-issued id -> 404 as well (no existence bit)', missing.status === 404, missing.status + ' ' + missing.text);

    // Tombstone: even the fellow server member gets 404.
    psql(`UPDATE users SET username='deleted#'||id, display_name=NULL, public_key=NULL, account_sign_pub=NULL, deleted_at=NOW(), token_version=token_version+1 WHERE id=${T.id}`);
    r = await MT.api('GET', `/users/${T.id}/public-key`);
    check('tombstone: public-key -> 404 even for a server-mate', r.status === 404, r.status + ' ' + r.text);
    r = await MT.api('GET', `/users/${T.id}/signing-key`);
    check('tombstone: signing-key -> 404 even for a server-mate', r.status === 404, r.status + ' ' + r.text);
    r = await B.api('GET', `/users/${T.id}/public-key`);
    check('tombstone: public-key -> 404 for a stranger', r.status === 404, r.status + ' ' + r.text);

    // Width: 2^32 + id must never alias the INT4 row, not even for the entitled.
    const alias = V.id + TWO32;
    r = await V.api('GET', `/users/${alias}/public-key`);
    check('id + 2^32: public-key -> 404 (no alias to row id)', r.status === 404 && noLeak(r, vPub), r.status + ' ' + r.text);
    r = await V.api('GET', `/users/${alias}/signing-key`);
    check('id + 2^32: signing-key -> 404', r.status === 404 && noLeak(r, vSign), r.status + ' ' + r.text);
    r = await M.api('GET', `/users/${alias}/public-key`);
    check('id + 2^32: public-key -> 404 for the server-mate too', r.status === 404 && noLeak(r, vPub), r.status + ' ' + r.text);
    // C27: the dm-keys self branch.
    const aSign = 'ASIGN_' + RUN;
    psql(`UPDATE users SET account_sign_pub='${aSign}' WHERE id=${B.id}`);
    psql(`INSERT INTO token_sessions (sid, user_id, dm_pubkey, dm_pubkey_sig, reads_up_to, headless, last_seen_at) VALUES ('${randomUUID()}', ${B.id}, 'ASESS_${RUN}', 'sig', 4, false, NOW())`);
    r = await B.api('GET', `/users/${B.id}/dm-keys`);
    check('control: self dm-keys -> 200 with own material', r.status === 200 && r.json?.user_id === B.id && r.json?.account_sign_pub === aSign, r.status + ' ' + r.text.slice(0, 200));
    r = await B.api('GET', `/users/${B.id + TWO32}/dm-keys`);
    check('self + 2^32: dm-keys -> 404 (self branch not reachable by truncation)', r.status === 404 && noLeak(r, aSign), r.status + ' ' + r.text.slice(0, 200));
    r = await B.api('GET', `/users/${B.id - TWO32}/dm-keys`);
    check('self - 2^32: dm-keys -> 404', r.status === 404 && noLeak(r, aSign), r.status + ' ' + r.text.slice(0, 200));
    r = await V.api('GET', `/users/${alias}/dm-keys`);
    check('id + 2^32: dm-keys -> 404 for the entitled self as well', r.status === 404, r.status + ' ' + r.text.slice(0, 200));
}

// ---------------------------------------------------------------------------
// C07: GET /users/:id/dm-keys gated only on a conversation row plus
// users_share_context, neither of which a block retracts, so a blocked account
// kept a live device census of the blocker (every DM WRITE path already checked
// the block). Now the read refuses a blocked pair in either direction with the
// stranger's answer. The refusal is specific to the census: the identity keys
// on /public-key and /signing-key stay readable across the block (they carry
// mesh voice E2EE and the existing DM history for a pair that may still share
// a call - review findings 1/6/7/10), so the positive control here reads them
// on the same blocked pair. On 0.9.4 the blocked B still reads 200 with sessions.
// ---------------------------------------------------------------------------
async function dmKeysBlock() {
    section('C07: dm-keys is refused for a blocked pair, same shape as a stranger; identity keys are not');
    const V = mkUser('dkv'), B = mkUser('dkb'), W = mkUser('dkw'), T = mkUser('dkt');
    const vPub = randomBytes(32).toString('base64'), vSign = randomBytes(32).toString('base64');
    psql(`UPDATE users SET public_key='${vPub}', account_sign_pub='${vSign}' WHERE id=${V.id}`);
    const S = await mkServer(V); await joinViaInvite(S, B); await joinViaInvite(S, W);
    for (const u of [V, B]) psql(`INSERT INTO token_sessions (sid, user_id, dm_pubkey, dm_pubkey_sig, reads_up_to, headless, last_seen_at) VALUES ('${randomUUID()}', ${u.id}, 'dmpub_${u.id}_${RUN}', 'sig', 4, false, NOW())`);
    let r = await V.api('POST', '/dms', { user_id: B.id });
    check('fixture: V opens a DM with B', r.status === 200 && !!r.json?.id, r.status + ' ' + r.text.slice(0, 100));
    r = await V.api('POST', '/dms', { user_id: W.id });
    check('fixture: V opens a DM with W', r.status === 200, r.status + ' ' + r.text.slice(0, 100));
    const sessions = (resp) => Array.isArray(resp.json?.sessions) ? resp.json.sessions.length : -1;

    const bPre = await B.api('GET', `/users/${V.id}/dm-keys`);
    check('control: B (server-mate with a conversation) reads V\'s dm-keys -> 200 with a session', bPre.status === 200 && sessions(bPre) >= 1, bPre.status + ' ' + bPre.text.slice(0, 160));
    const vPre = await V.api('GET', `/users/${B.id}/dm-keys`);
    check('control: V reads B\'s dm-keys -> 200', vPre.status === 200 && sessions(vPre) >= 1, vPre.status + ' ' + vPre.text.slice(0, 160));
    const stranger = await T.api('GET', `/users/${V.id}/dm-keys`);
    check('reference: a stranger is refused (404)', stranger.status === 404, stranger.status + ' ' + stranger.text);

    r = await V.api('POST', `/users/${B.id}/block`);
    check('fixture: V blocks B', r.status === 200, r.status + ' ' + r.text);
    const bPost = await B.api('GET', `/users/${V.id}/dm-keys`);
    check('blocked B: dm-keys for V answers exactly like a stranger', sameAnswer(bPost, stranger) && noLeak(bPost, `dmpub_${V.id}_`), `${bPost.status} ${bPost.text.slice(0, 160)} | stranger ${stranger.status} ${stranger.text}`);
    const vPost = await V.api('GET', `/users/${B.id}/dm-keys`);
    check('blocker V: dm-keys for B answers exactly like a stranger', sameAnswer(vPost, stranger) && noLeak(vPost, `dmpub_${B.id}_`), `${vPost.status} ${vPost.text.slice(0, 160)}`);
    r = await B.api('GET', `/users/${V.id}/public-key`);
    check('control: blocked B still reads V\'s public-key -> 200 (only the census is block-gated)', r.status === 200 && r.json?.public_key === vPub, r.status + ' ' + r.text);
    r = await B.api('GET', `/users/${V.id}/signing-key`);
    check('control: blocked B still reads V\'s signing-key -> 200', r.status === 200 && r.json?.account_sign_pub === vSign, r.status + ' ' + r.text);
    const wPost = await W.api('GET', `/users/${V.id}/dm-keys`);
    check('control: unblocked server-mate W still reads V\'s dm-keys -> 200', wPost.status === 200 && sessions(wPost) >= 1, wPost.status + ' ' + wPost.text.slice(0, 160));
    // Discriminator: it was the block. Lift it and the read returns.
    r = await V.api('DELETE', `/users/${B.id}/block`);
    check('fixture: V unblocks B', r.status === 200, r.status + ' ' + r.text);
    r = await B.api('GET', `/users/${V.id}/dm-keys`);
    check('after the unblock B reads V\'s dm-keys again (the refusal was the block)', r.status === 200 && sessions(r) >= 1, r.status + ' ' + r.text.slice(0, 160));
}

// ---------------------------------------------------------------------------
// C20: revoke_device revoked token_sessions by (user, device) but killed live
// sockets only by attested/claimed device id, so a socket opened with the
// device-bound JWT that never attested stayed open and privileged until exp.
// Now the revoke kills every socket whose sid it revoked. On 0.9.4 conn2 stays
// OPEN and keeps receiving fan-out.
// ---------------------------------------------------------------------------
async function revokeDeviceKillsSocket() {
    section('C20: revoking a device closes its unattested socket too');
    const O = mkUser('rvo'), V = mkUser('rvv');
    const S = await mkServer(O); const C = await mkChannel(S, 'general'); await joinViaInvite(S, V);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const signPub = 'ed25519:' + spki.subarray(spki.length - 32).toString('base64');
    const D = 'dev_' + randomUUID().replace(/-/g, '').slice(0, 17);
    psql(`INSERT INTO devices (id, user_id, device_pub, sign_pub, name, platform, auth_record, auth_sig) VALUES ('${D}', ${V.id}, 'x25519:${randomUUID()}', '${signPub}', 'V laptop', 'windows', '{}', '')`);
    const SID = randomUUID();
    psql(`INSERT INTO token_sessions (sid, user_id, device_id) VALUES ('${SID}', ${V.id}, '${D}')`);
    const J = mintJwt(V.id, V.username, 0, { sid: SID });
    const Vapi = api(J);
    let r = await Vapi('GET', '/devices');
    const devs = Array.isArray(r.json) ? r.json : (r.json?.devices ?? []);
    check('fixture: the device-bound JWT authenticates and lists device D', r.status === 200 && devs.some(d => d.id === D), r.status + ' ' + r.text.slice(0, 160));

    const wO = await ws(O); wO.send('JoinRoom', { room_id: `channel_${C}` });
    check('fixture: owner observer joined the channel room', !!(await wO.waitFor(f => f.type === 'RoomJoined')));
    // conn1 attests (the kill path that already worked: positive control).
    const conn1 = await ws({ token: J });
    const chal = await conn1.waitFor(f => f.type === 'DeviceChallenge', 2500);
    check('fixture: conn1 received a DeviceChallenge', !!chal, JSON.stringify(conn1.frames).slice(0, 200));
    const sig = sign(null, Buffer.from(`sovereign-device-attest-v1|${chal?.payload?.nonce}|${V.id}`), privateKey).toString('base64');
    conn1.send('DeviceAttest', { device_id: D, sig });
    check('control: conn1 attested', !!(await conn1.waitFor(f => f.type === 'DeviceAttested', 2500)), JSON.stringify(conn1.frames).slice(0, 300));
    // conn2: same JWT, never attests, joins the room and is fully privileged.
    const conn2 = await ws({ token: J });
    await conn2.waitFor(f => f.type === 'DeviceChallenge', 2500);
    conn2.send('JoinRoom', { room_id: `channel_${C}` });
    check('control: unattested conn2 joined the channel room', !!(await conn2.waitFor(f => f.type === 'RoomJoined')), JSON.stringify(conn2.frames).slice(0, 200));
    const pre = `enc:v2:c20pre_${RUN}`;
    conn2.send('ChatMessage', { room_id: `channel_${C}`, content: pre });
    check('control: conn2 is privileged before the revoke (owner saw its message)', !!(await wO.waitFor(f => f.type === 'ChatMessage' && String(f.payload?.content).includes(pre), 2500)));
    check('fixture: the token_sessions row is device-bound and live', row(`SELECT device_id||'|'||(revoked_at IS NULL)::text FROM token_sessions WHERE sid='${SID}'`) === `${D}|true`);

    r = await Vapi('DELETE', `/devices/${D}`);
    check('control: V revokes device D -> 200 {revoked:true}', r.status === 200 && r.json?.revoked === true, r.status + ' ' + r.text);
    check('control: the sid row is revoked', row(`SELECT (revoked_at IS NOT NULL)::text FROM token_sessions WHERE sid='${SID}'`) === 'true');
    check('control: attested conn1 is CLOSED after the revoke', (await waitClosed(conn1)) === 3, 'readyState=' + conn1.sock.readyState);
    check('unattested conn2 is CLOSED after the revoke (readyState 3 within 5 s)', (await waitClosed(conn2)) === 3, 'readyState=' + conn2.sock.readyState);
    const rest = await Vapi('GET', '/devices');
    check('a fresh REST call with the revoked JWT -> 401', rest.status === 401, rest.status + ' ' + rest.text.slice(0, 100));
    conn2.frames.length = 0;
    const post = `enc:v2:c20post_${RUN}`;
    wO.send('ChatMessage', { room_id: `channel_${C}`, content: post });
    check('control: the owner\'s post reached the room (persisted)', !!(await wO.waitFor(f => f.type === 'ChatMessage' && String(f.payload?.content).includes(post), 2500)));
    await sleep(500);
    check('...and conn2 received no fan-out after the revoke', !conn2.frames.some(f => JSON.stringify(f).includes(post)), JSON.stringify(conn2.frames).slice(0, 200));
    const fresh = await new Promise((res) => {
        const sock = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws', ['bearer', J]);
        let settled = false; const fin = (v) => { if (!settled) { settled = true; try { sock.close(); } catch { /* ignore */ } res(v); } };
        sock.addEventListener('open', () => fin('open')); sock.addEventListener('error', () => fin('refused')); sock.addEventListener('close', () => fin('refused'));
        setTimeout(() => fin('refused'), 2500);
    });
    check('a fresh WS upgrade with the revoked JWT is refused', fresh === 'refused', fresh);
    wO.close(); conn1.close(); conn2.close();
}

// ---------------------------------------------------------------------------
// C22: POST /auth/reset-password-migration rewrites SRP material with no proof
// of identity when ALLOW_MIGRATION_PASSWORD_RESET is "true". The test rig runs
// with the flag unset; the assertion is only that the default stays closed and
// writes nothing. (Held on 0.9.4.)
// ---------------------------------------------------------------------------
async function migrationResetGate() {
    section('C22: reset-password-migration stays 403 with the env flag off');
    const V = mkUser('mrv');
    psql(`UPDATE users SET force_password_reset = TRUE WHERE id = ${V.id}`);
    const saltBefore = row(`SELECT encode(salt,'hex') FROM users WHERE id=${V.id}`);
    const r = await api(null)('POST', '/auth/reset-password-migration', { username: V.username, salt_hex: '11'.repeat(32), verifier_hex: 'ab'.repeat(256), srp_version: 1 });
    check('anonymous reset-password-migration for a force_password_reset account -> 403', r.status === 403, r.status + ' ' + r.text.slice(0, 120));
    check('...and the SRP salt is unchanged', row(`SELECT encode(salt,'hex') FROM users WHERE id=${V.id}`) === saltBefore);
    check('...and the flag was not consumed', row(`SELECT COALESCE(force_password_reset,false)::text FROM users WHERE id=${V.id}`) === 'true');
}

// ---------------------------------------------------------------------------
// C17: voice-move checked server-level MOVE_MEMBERS but never the ACTOR's VIEW
// on the source voice channel, so a moderator denied VIEW on a hidden voice
// channel could tell who was in it (404 destination-lookup vs 409 not-in-voice
// vs 400 already-there) and disconnect them. Now a source the actor cannot
// VIEW answers the same 409 as "not in a voice channel", whatever the body.
// On 0.9.4 the three probes answer 404 / 400 / 200.
// ---------------------------------------------------------------------------
async function voiceMoveSourceView() {
    section('C17: voice-move needs the actor\'s VIEW on the source channel');
    const O = mkUser('vmo'), V = mkUser('vmv'), V2 = mkUser('vmv2'), W = mkUser('vmw'), A = mkUser('vma');
    const S = await mkServer(O);
    const cVoice = await mkChannel(S, `hidden_voice_${RUN}`, 1);
    const cDest = await mkChannel(S, `dest_voice_${RUN}`, 1);
    for (const m of [V, V2, W, A]) await joinViaInvite(S, m);
    const role = await O.api('POST', `/servers/${S.id}/roles`, { name: `mods_${RUN}`, permissions: BITS.MOVE_MEMBERS });
    check('fixture: MOVE_MEMBERS role minted', role.status === 200 && !!role.json?.id, role.status + ' ' + role.text);
    const R = role.json.id;
    let r = await O.api('PUT', `/servers/${S.id}/members/${A.id}/roles/${R}`);
    check('fixture: role assigned to A', r.status === 200 || r.status === 204, r.status + ' ' + r.text);
    r = await O.api('PUT', `/channels/${cVoice}/overwrites/${R}`, { allow: 0, deny: BITS.VIEW_CHANNEL | BITS.CONNECT });
    check('fixture: A\'s role is denied VIEW+CONNECT on the hidden voice channel', r.status === 200, r.status + ' ' + r.text);
    const wA = await ws(A); wA.send('JoinRoom', { room_id: `voice_${cVoice}` }); await wA.settle();
    check('fixture: A cannot join the hidden voice room', !wA.frames.some(f => f.type === 'RoomJoined'), JSON.stringify(wA.frames).slice(0, 200));
    const wV = await ws(V), wV2 = await ws(V2);
    wV.send('JoinRoom', { room_id: `voice_${cVoice}` }); wV2.send('JoinRoom', { room_id: `voice_${cVoice}` });
    check('fixture: V and V2 joined the hidden voice room', !!(await wV.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === `voice_${cVoice}`, 2500)) && !!(await wV2.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === `voice_${cVoice}`, 2500)));
    await sleep(300);
    const move = (actor, uid, body) => actor.api('POST', `/servers/${S.id}/voice-move/${uid}`, body);
    const inRoom = async (uid) => { const vu = await O.api('GET', `/servers/${S.id}/voice-users`); return (vu.json?.voice_users || []).some(u => u.user_id === uid && u.room_id === `voice_${cVoice}`); };

    r = await move(O, V2.id, { channel_id: null });
    await sleep(300);
    check('control: the owner (VIEW on the source) disconnects V2 -> 200', r.status === 200 && !(await inRoom(V2.id)), r.status + ' ' + r.text);

    const notInVoice = await move(A, W.id, { channel_id: NEVER_ID });
    check('reference: a target NOT in voice -> 409 "not in a voice channel"', notInVoice.status === 409 && /not in a voice channel/i.test(notInVoice.text), notInVoice.status + ' ' + notInVoice.text);
    const probe = await move(A, V.id, { channel_id: NEVER_ID });
    check('VIEW-denied actor, target IN the hidden room, nonexistent destination -> 409 (not 404)', probe.status === 409 && /not in a voice channel/i.test(probe.text), probe.status + ' ' + probe.text);
    check('ORACLE CLOSED: in-hidden-room and not-in-voice answer byte-identically', sameAnswer(probe, notInVoice), `${probe.status} ${probe.text} | ${notInVoice.status} ${notInVoice.text}`);
    const exact = await move(A, V.id, { channel_id: Number(cVoice) });
    check('exact hidden channel as destination -> the same 409 (not 400 "already there")', sameAnswer(exact, notInVoice), exact.status + ' ' + exact.text);
    const evict = await move(A, V.id, { channel_id: null });
    check('channel_id null -> the same 409 (not 200)', sameAnswer(evict, notInVoice), evict.status + ' ' + evict.text);
    const toDest = await move(A, V.id, { channel_id: Number(cDest) });
    check('a visible destination -> the same 409 (source still unviewable)', sameAnswer(toDest, notInVoice), toDest.status + ' ' + toDest.text);
    await sleep(300);
    check('...and V is still in the hidden room', (await inRoom(V.id)) && !wV.frames.some(f => f.type === 'RoomLeft'), JSON.stringify(wV.frames.map(f => f.type)));
    check('...and no voice_disconnect audit row names A', row(`SELECT count(*) FROM audit_log WHERE server_id='${S.id}' AND action_type='voice_disconnect' AND actor_id=${A.id}`) === '0');

    // Same actor, VIEW restored: the route works.
    r = await O.api('DELETE', `/channels/${cVoice}/overwrites/${R}`);
    check('fixture: the deny overwrite is cleared (A can VIEW the source)', r.status === 200 || r.status === 204, r.status + ' ' + r.text);
    await sleep(300);
    r = await move(A, V.id, { channel_id: null });
    await sleep(300);
    check('control: with VIEW on the source, A disconnects V -> 200', r.status === 200 && !(await inRoom(V.id)), r.status + ' ' + r.text);
    wA.close(); wV.close(); wV2.close();
}

// ---------------------------------------------------------------------------
// C18: create_report scoped reported_message_id to the SERVER, so a member
// VIEW-denied on a channel got 200 {id} vs 400 for a message uuid in it — an
// existence oracle that also planted the id in the moderation queue. Now the
// lookup is VIEW-scoped: a hidden message answers exactly like a random uuid.
// On 0.9.4 the hidden message is a 200.
// ---------------------------------------------------------------------------
async function reportViewScope() {
    section('C18: reports resolve reported_message_id through the reporter\'s VIEW');
    const O = mkUser('rpo'), A = mkUser('rpa'), V = mkUser('rpv');
    const S = await mkServer(O); const HID = await mkChannel(S, `hidden_${RUN}`); const VIS = await mkChannel(S, `visible_${RUN}`);
    await joinViaInvite(S, A); await joinViaInvite(S, V);
    const h = await V.api('POST', `/channels/${HID}/messages`, { content: `enc:v2:HIDDEN_${RUN}` });
    const v = await A.api('POST', `/channels/${VIS}/messages`, { content: `enc:v2:VISIBLE_${RUN}` });
    check('fixture: a message in each channel', h.status === 200 && !!h.json?.id && v.status === 200 && !!v.json?.id);
    await denyView(S, HID); await sleep(300);
    let r = await A.api('GET', `/channels/${HID}/messages`);
    check('baseline: A is VIEW-denied on the hidden channel', refused(r), r.status);
    const report = (body) => A.api('POST', `/servers/${S.id}/reports`, { report_type: 'other', reason: 'probe', ...body });
    r = await report({ reported_message_id: v.json.id });
    check('control: reporting a message A can VIEW -> 200 {id}', r.status === 200 && Number.isInteger(r.json?.id), r.status + ' ' + r.text);
    const random = await report({ reported_message_id: randomUUID() });
    check('reference: a random uuid -> 400 "reported_message_id is not a message in this server"', random.status === 400 && random.text === 'reported_message_id is not a message in this server', random.status + ' ' + random.text);
    const hidden = await report({ reported_message_id: h.json.id });
    check('a message in a channel A cannot VIEW -> 400 "reported_message_id is not a message in this server"', hidden.status === 400 && hidden.text === 'reported_message_id is not a message in this server', hidden.status + ' ' + hidden.text);
    check('ORACLE CLOSED: hidden and random answer byte-identically', sameAnswer(hidden, random), `${hidden.status} ${hidden.text} | ${random.status} ${random.text}`);
    check('...and no report row was planted with the hidden id', row(`SELECT count(*) FROM reports WHERE server_id='${S.id}' AND reported_message_id='${h.json.id}'`) === '0');
    r = await O.api('POST', `/servers/${S.id}/reports`, { report_type: 'other', reason: 'probe', reported_message_id: h.json.id });
    check('control: the owner (VIEW on the hidden channel) reports the same message -> 200', r.status === 200 && Number.isInteger(r.json?.id), r.status + ' ' + r.text);
}

await invitesFollowCreator();
await blockDissolvesFriendship();
await blockHidesPresence();
await friendRequestOracles();
await keyRouteGates();
await dmKeysBlock();
await revokeDeviceKillsSocket();
await migrationResetGate();
await voiceMoveSourceView();
await reportViewScope();
done();
