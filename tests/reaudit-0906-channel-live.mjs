// Live regression for the CHANNEL / VOICE / CLIP / PARKED-FRAME half of the
// 2026-09-06 re-audit of Puca 0.9.4 (fix-args-095 clusters C13, C09,
// r2-3-L3-01 (server half), C10, C11, r2-4-L4-03, r2-4-L4-02, C34, C04,
// r2-5-L5-01, r2-4-L4-01, C16). The relationship / key-route / moderator half
// lives in its sibling, reaudit-0906-social-live.mjs.
//
// The re-audit found no content route open to a non-member. What it found was
// the boundary being decided in one place and not another: a VIEW deny that a
// MANAGE_CHANNELS holder walked through, WS arms (LeaveRoom, the voice-room
// ChatMessage branch) that skipped the gates their REST siblings apply, frames
// parked or fanned out against a snapshot that a kick, deny or block had since
// invalidated, a file-offer arm that ignored the hide-presence toggle, and two
// read paths (reactions, clip views) that checked one of two required bits.
// This file asserts the FIXED behaviour for each, and keeps every probe's
// positive control - an entitled caller succeeding on the same route and the
// same fixture - so a guard that refuses everyone cannot pass.
//
// Which checks FAIL on an unfixed 0.9.4 backend (the probes in the audit bundle
// reproduce each one; every other check in this file already held there):
//   manageChannelsBoundByDeny (C13):
//       "manager M: GET messages on the @everyone-denied channel -> 404",
//       "manager M: GET /keys on it -> 404, no wrapped key", "manager R: GET
//       messages on the role-denied channel -> 404", "member-keys for the
//       hidden channel omits M and R", "member-keys for the per-role channel
//       omits R", "manager M: JoinRoom channel_<hidden> refused", "channel list
//       hides the denied channel from M".
//   leaveRoomGate (C09):
//       "non-member LeaveRoom injects no UserLeft{A} into the voice room",
//       "...and none into the text room", "a member NOT in the room injects no
//       UserLeft{N}".
//   leaveEmitsStreamStopped (r2-3-L3-01):
//       "LeaveRoom without StopStream: V receives StreamStopped(A)".
//   voiceChatMessageGate (C10):
//       "SEND-denied member: voice ChatMessage reaches no occupant (and is not
//       echoed)", "timed-out member: voice ChatMessage reaches no occupant".
//   clipEntitlement (C16, r2-4-L4-01, C11):
//       "X: GET /clips/:id -> 200 with target_channel_id and
//       target_channel_name null" and "X: /clips/pending lists the clip with
//       the target redacted" (0.9.4 named the hidden channel to X), "kicked
//       proposer receives NO ClipVoteUpdate", "...NO ClipResolved",
//       "VIEW-denied X3: delivery socket receives NO parked ClipPending".
//       The first cut of C16 refused X outright (no doorbell, 404 on GET and
//       vote, no ClipResolved), which deadlocked every proposal in that call
//       (review finding 9): the doorbell / vote / ClipResolved checks for X
//       are the positive controls that pin the corrected rule; they hold on
//       0.9.4 and FAIL on that intermediate tree.
//   parkedFramesRecheckBlocks (r2-4-L4-03):
//       "post-block parked FileOffered is NOT delivered to the blocker",
//       "...no 'reached them' note goes back to the blocked sender", "mirror:
//       sender-side block also drops the parked offer", "post-block parked
//       DirectMessage is NOT drained into the delivery socket".
//   hiddenPresenceOffer (r2-4-L4-02):
//       "hidden V: sender's observable is byte-identical offline vs online",
//       "hidden V logging in produces NO 'reached them' note".
//   markServerReadScope (C34):
//       "no read-state row for the hidden channel".
//   reactionsHistoryBit (C04):
//       "history-denied member: GET reactions refused like GET messages",
//       "...POST reaction refused", "...DELETE reaction refused (row intact)".
//   clipChannelIdHidden (r2-5-L5-01):
//       "join response shows clip_channel_id null to the VIEW-denied joiner",
//       "GET /servers shows clip_channel_id null to the VIEW-denied member".
//
// Prereqs: a backend on API (default http://127.0.0.1:3000) running against a
// THROWAWAY database that PGDB/PGPORT point at; Node >= 22 (global WebSocket);
// psql at PSQL. Runtime ~1 minute: one backend, sequential scenarios, fresh
// users per scenario, ONE 8.5 s presence-log wait shared by the three clip
// proposals.
//
// This file inserts users and key rows directly into PGDB and leaves servers,
// channels, messages, transfers and clip proposals behind. It must NEVER run
// against a real database.
//
// Usage: API=http://127.0.0.1:3000 PGDB=puca_sec_test PGPORT=5433 node tests/reaudit-0906-channel-live.mjs
import { randomUUID } from 'node:crypto';
import {
    mkUser, mkServer, mkChannel, joinViaInvite, denyView, ws,
    check, section, done, psql, psql1, sleep, BITS, RUN,
} from './probe-lib.mjs';

const refused = (r) => r.status === 403 || r.status === 404;
const noLeak = (r, marker) => !r.text.includes(marker);
const row = (sql) => psql1(sql);
const typesFrom = (w, from) => w.frames.slice(from).map(f => f.type).join(',');
const has = (w, pred, from = 0) => w.frames.slice(from).some(pred);

// A role created through the API (so it is positioned and coloured exactly as
// production makes one), then assigned to a member. Throws on a fixture
// failure: a silently missing role reads as a permission regression.
const mkRole = async (S, name, permissions) => {
    const r = await S.owner.api('POST', `/servers/${S.id}/roles`, { name: `${name}_${RUN}`.slice(0, 30), permissions });
    if (r.status !== 200 || !r.json?.id) throw new Error(`mkRole ${name} failed ${r.status} ${r.text}`);
    return r.json.id;
};
const assignRole = async (S, user, roleId) => {
    const r = await S.owner.api('PUT', `/servers/${S.id}/members/${user.id}/roles/${roleId}`);
    if (r.status !== 200 && r.status !== 204) throw new Error(`assignRole failed ${r.status} ${r.text}`);
};
// Deny a bit mask on a channel for ONE role (VIEW by default).
const denyForRole = async (S, channelId, roleId, deny = BITS.VIEW_CHANNEL) => {
    const r = await S.owner.api('PUT', `/channels/${channelId}/overwrites/${roleId}`, { allow: 0, deny });
    if (r.status !== 200) throw new Error(`deny overwrite failed ${r.status} ${r.text}`);
};
// Open a visible socket and join a voice room; the RoomJoined is a fixture check.
const joinVoice = async (user, channelId, label) => {
    const w = await ws(user);
    w.send('JoinRoom', { room_id: `voice_${channelId}` });
    const j = await w.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === `voice_${channelId}`, 3000);
    check(`fixture: ${label} joined voice_${channelId}`, !!j, JSON.stringify(w.frames).slice(0, 200));
    return w;
};
const seedKey = (channelId, recipient, sender, wrapped) =>
    psql(`INSERT INTO channel_keys (channel_id, epoch, recipient_id, wrapped_key, sender_public_key, member_generation, sender_user_id) VALUES (${channelId}, 1, ${recipient}, '${wrapped}', 'pk-owner', 0, ${sender}) ON CONFLICT DO NOTHING`);

// ---------------------------------------------------------------------------
// C13: layer_overwrite_rows re-inserted VIEW_CHANNEL for any base holding
// MANAGE_CHANNELS after the overwrites were applied, so a VIEW deny (on
// @everyone or on a role the member holds) was inert for a Manage Channels
// holder, and the shared viewer resolver wrapped epoch keys for them. Now only
// ADMINISTRATOR (and the owner) override a deny; a denied manager gets the same
// 404 as anyone else and is absent from the key-wrapping viewer set. On 0.9.4
// M and R read both hidden channels and appear in member-keys.
// ---------------------------------------------------------------------------
async function manageChannelsBoundByDeny() {
    section('C13: a VIEW deny binds a MANAGE_CHANNELS holder; only ADMINISTRATOR overrides it');
    const O = mkUser('mco'), M = mkUser('mcm'), R = mkUser('mcr'), AD = mkUser('mcad'), P = mkUser('mcp');
    const S = await mkServer(O);
    const HID = await mkChannel(S, 'hidden');       // @everyone denied
    const PER = await mkChannel(S, 'per-role');     // denied for a role R alone holds
    const OPEN = await mkChannel(S, 'open');        // no deny: MANAGE_CHANNELS keeps VIEW
    for (const u of [M, R, AD, P]) await joinViaInvite(S, u);
    const MGR = await mkRole(S, 'mgr', BITS.MANAGE_CHANNELS);
    const ADM = await mkRole(S, 'adm', BITS.ADMINISTRATOR);
    const RDENY = await mkRole(S, 'rdeny', 0);
    await assignRole(S, M, MGR); await assignRole(S, R, MGR); await assignRole(S, AD, ADM); await assignRole(S, R, RDENY);
    check('fixture: M and R hold MANAGE_CHANNELS through a role, AD holds ADMINISTRATOR',
        row(`SELECT count(*) FROM member_roles WHERE server_id='${S.id}' AND role_id=${MGR}`) === '2'
        && row(`SELECT count(*) FROM member_roles WHERE server_id='${S.id}' AND user_id=${AD.id} AND role_id=${ADM}`) === '1');
    for (const [c, tag] of [[HID, 'HID'], [PER, 'PER'], [OPEN, 'OPEN']]) {
        const m = await O.api('POST', `/channels/${c}/messages`, { content: `enc:v2:C13-${tag}-${RUN}` });
        if (m.status !== 200) throw new Error('seed message failed ' + m.status + ' ' + m.text);
    }
    // Key rows for the manager and the owner, so a 200 on /keys would leak.
    seedKey(HID, M.id, O.id, 'WRAPPED-FOR-MANAGER'); seedKey(HID, O.id, O.id, 'WRAPPED-FOR-OWNER');
    await denyView(S, HID);
    await denyForRole(S, PER, RDENY);
    await sleep(300);

    // Controls: MANAGE_CHANNELS with no deny keeps VIEW; the per-role deny hits only R.
    let r = await M.api('GET', `/channels/${OPEN}/messages`);
    check('control: manager M reads the undenied channel (MANAGE_CHANNELS keeps VIEW without a deny)', r.status === 200 && r.text.includes(`C13-OPEN-${RUN}`), r.status);
    r = await M.api('GET', `/channels/${PER}/messages`);
    check('control: manager M (not in the denied role) reads the per-role channel', r.status === 200 && r.text.includes(`C13-PER-${RUN}`), r.status);
    r = await P.api('GET', `/channels/${PER}/messages`);
    check('control: plain member P reads the per-role channel', r.status === 200, r.status);
    r = await AD.api('GET', `/channels/${HID}/messages`);
    check('control: ADMINISTRATOR role keeps VIEW under the @everyone deny', r.status === 200 && r.text.includes(`C13-HID-${RUN}`), r.status + ' ' + r.text.slice(0, 80));
    r = await O.api('GET', `/channels/${HID}/keys`);
    check('control: owner reads keys on the hidden channel', r.status === 200 && r.text.includes('WRAPPED-FOR-OWNER'), r.status + ' ' + r.text.slice(0, 120));

    // The fix.
    r = await M.api('GET', `/channels/${HID}/messages`);
    check('manager M: GET messages on the @everyone-denied channel -> 404', r.status === 404 && noLeak(r, `C13-HID`), r.status + ' ' + r.text.slice(0, 80));
    r = await M.api('GET', `/channels/${HID}/keys`);
    check('manager M: GET /keys on it -> 404, no wrapped key', r.status === 404 && noLeak(r, 'WRAPPED'), r.status + ' ' + r.text.slice(0, 80));
    r = await R.api('GET', `/channels/${PER}/messages`);
    check('manager R: GET messages on the role-denied channel -> 404', r.status === 404 && noLeak(r, `C13-PER`), r.status + ' ' + r.text.slice(0, 80));
    r = await R.api('GET', `/channels/${HID}/messages`);
    check('manager R: the @everyone deny binds too -> 404', r.status === 404, r.status);
    r = await M.api('GET', `/servers/${S.id}/channels`);
    check('channel list hides the denied channel from M', r.status === 200 && !JSON.stringify(r.json).includes(`"id":${HID}`) && JSON.stringify(r.json).includes(`"id":${OPEN}`), r.text.slice(0, 160));

    // The key-wrapping viewer set, read by an entitled non-owner (AD) and the owner.
    const ids = (resp) => (Array.isArray(resp.json) ? resp.json : []).map(k => Number(k.user_id));
    let mk = await AD.api('GET', `/channels/${HID}/member-keys`);
    check('control: administrator lists member-keys for the hidden channel and is in it with the owner', mk.status === 200 && ids(mk).includes(AD.id) && ids(mk).includes(O.id), mk.status + ' ' + mk.text.slice(0, 160));
    check('member-keys for the hidden channel omits M and R', mk.status === 200 && !ids(mk).includes(M.id) && !ids(mk).includes(R.id), JSON.stringify(ids(mk)));
    mk = await O.api('GET', `/channels/${HID}/member-keys`);
    check('...and the owner\'s view agrees', mk.status === 200 && !ids(mk).includes(M.id) && !ids(mk).includes(R.id) && ids(mk).includes(AD.id), JSON.stringify(ids(mk)));
    mk = await O.api('GET', `/channels/${PER}/member-keys`);
    check('control: member-keys for the per-role channel lists M and P', mk.status === 200 && ids(mk).includes(M.id) && ids(mk).includes(P.id), JSON.stringify(ids(mk)));
    check('member-keys for the per-role channel omits R', mk.status === 200 && !ids(mk).includes(R.id), JSON.stringify(ids(mk)));

    // Live room: the same resolver gates JoinRoom.
    const w = await ws(M);
    w.send('JoinRoom', { room_id: `channel_${OPEN}` });
    check('control: manager M joins the undenied channel room', !!(await w.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === `channel_${OPEN}`)), typesFrom(w, 0));
    const n = w.frames.length;
    w.send('JoinRoom', { room_id: `channel_${HID}` }); await sleep(600);
    check('manager M: JoinRoom channel_<hidden> refused', !has(w, f => f.type === 'RoomJoined' && f.payload?.room_id === `channel_${HID}`, n), typesFrom(w, n));
    w.close();
}

// ---------------------------------------------------------------------------
// C09: the LeaveRoom arm resolved nothing and broadcast UserLeft{caller} into
// any room id named, so a non-member could inject presence frames into a
// private call. Now a LeaveRoom for a room the connection is not in does
// nothing: no broadcast and no error frame. On 0.9.4 V receives UserLeft{A}
// for both the voice and the text room.
// ---------------------------------------------------------------------------
async function leaveRoomGate() {
    section('C09: LeaveRoom acts only for a room the connection is actually in');
    const O = mkUser('lro'), V = mkUser('lrv'), V2 = mkUser('lrv2'), N = mkUser('lrn'), A = mkUser('lra');
    const S = await mkServer(O);
    const Cv = await mkChannel(S, 'vc', 1);
    const T = await mkChannel(S, 'txt', 0);
    const Cv2 = await mkChannel(S, 'vc2', 1);
    await joinViaInvite(S, V); await joinViaInvite(S, V2); await joinViaInvite(S, N);
    const voiceRoom = `voice_${Cv}`, textRoom = `channel_${T}`;

    const vSock = await joinVoice(V, Cv, 'V');
    const v2Sock = await joinVoice(V2, Cv, 'V2');
    check('fixture: V sees UserJoined{V2} (broadcast path alive)', !!(await vSock.waitFor(f => f.type === 'UserJoined' && f.payload?.room_id === voiceRoom && f.payload?.user?.id === V2.id, 2000)), typesFrom(vSock, 0));
    // Control: a real occupant leaving is announced.
    v2Sock.send('LeaveRoom', { room_id: voiceRoom });
    check('control: an occupant\'s LeaveRoom broadcasts UserLeft{V2} to V', !!(await vSock.waitFor(f => f.type === 'UserLeft' && f.payload?.room_id === voiceRoom && f.payload?.user_id === V2.id, 2000)), typesFrom(vSock, 0));

    // Non-member A: refused the join, then "leaves".
    check('fixture: A is not a member', row(`SELECT count(*) FROM server_members WHERE server_id='${S.id}' AND user_id=${A.id}`) === '0');
    const aSock = await ws(A);
    aSock.send('JoinRoom', { room_id: voiceRoom });
    const aErr = await aSock.waitFor(f => f.type === 'Error', 1500);
    check('fixture: A\'s JoinRoom is refused (Error, no RoomJoined)', !!aErr && !has(aSock, f => f.type === 'RoomJoined'), typesFrom(aSock, 0));
    let vMark = vSock.frames.length, aMark = aSock.frames.length;
    aSock.send('LeaveRoom', { room_id: voiceRoom }); await sleep(1200);
    check('non-member LeaveRoom injects no UserLeft{A} into the voice room', !has(vSock, f => f.type === 'UserLeft' && f.payload?.user_id === A.id, vMark), typesFrom(vSock, vMark));
    check('...and A gets no Error frame for it (no oracle)', !has(aSock, f => f.type === 'Error', aMark), typesFrom(aSock, aMark));

    // A member who never joined the room.
    const nSock = await ws(N);
    vMark = vSock.frames.length; const nMark = nSock.frames.length;
    nSock.send('LeaveRoom', { room_id: voiceRoom }); await sleep(1200);
    check('a member NOT in the room injects no UserLeft{N}', !has(vSock, f => f.type === 'UserLeft' && f.payload?.user_id === N.id, vMark), typesFrom(vSock, vMark));
    check('...and gets no Error frame', !has(nSock, f => f.type === 'Error', nMark), typesFrom(nSock, nMark));

    // Text room variant.
    vSock.send('JoinRoom', { room_id: textRoom });
    check('fixture: V joins the text room', !!(await vSock.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === textRoom, 2000)));
    vMark = vSock.frames.length;
    aSock.send('LeaveRoom', { room_id: textRoom }); await sleep(1200);
    check('...and none into the text room', !has(vSock, f => f.type === 'UserLeft' && f.payload?.room_id === textRoom && f.payload?.user_id === A.id, vMark), typesFrom(vSock, vMark));

    // No reply-side oracle: A's answer is the same for a live, a dead and a
    // garbage room id, and never an Error.
    vSock.send('JoinRoom', { room_id: `voice_${Cv2}` }); await vSock.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === `voice_${Cv2}`, 2000);
    const reply = async (room_id) => { const b = aSock.frames.length; aSock.send('LeaveRoom', { room_id }); await sleep(500); return typesFrom(aSock, b); };
    const live = await reply(`voice_${Cv2}`), dead = await reply('voice_888888'), garbage = await reply('voice_zzz_777');
    check('A\'s reply is identical for live / dead / garbage room ids and carries no Error', live === dead && dead === garbage && !/Error/.test(live), `live=${live} dead=${dead} garbage=${garbage}`);
    const roster = await V.api('GET', `/servers/${S.id}/voice-users`);
    // V moved to voice_<Cv2> a few lines up (a socket holds one voice room), so that is where the roster must still show them.
    check('integrity: V is still in the voice roster', roster.status === 200 && (roster.json?.voice_users || []).some(u => u.user_id === V.id && u.room_id === `voice_${Cv2}`), roster.text.slice(0, 200));
    vSock.close(); v2Sock.close(); aSock.close(); nSock.close();
}

// ---------------------------------------------------------------------------
// r2-3-L3-01 (server half): the clean LeaveRoom arm broadcast UserLeft but
// never StreamStopped, while the stock client only tears a mesh peer down on
// StreamStopped - so a member who left without StopStream kept receiving the
// call's P2P media, invisible to every roster and beyond every later eviction.
// Now a voluntary LeaveRoom emits the same over-complete StreamStopped
// retraction eviction sends. On 0.9.4 V receives UserLeft(A) and nothing else.
// ---------------------------------------------------------------------------
async function leaveEmitsStreamStopped() {
    section('r2-3-L3-01: a voluntary LeaveRoom retracts the leaver\'s media (StreamStopped)');
    const O = mkUser('sso'), V = mkUser('ssv'), A = mkUser('ssa'), B = mkUser('ssb');
    const S = await mkServer(O);
    const C = await mkChannel(S, `voice_${RUN}`, 1);
    const room = `voice_${C}`;
    await joinViaInvite(S, V); await joinViaInvite(S, A); await joinViaInvite(S, B);
    const stopped = (w, uid, from = 0) => has(w, f => f.type === 'StreamStopped' && f.payload?.room_id === room && Number(f.payload?.streamer_id) === uid, from);

    const Vs = await joinVoice(V, C, 'V');
    const As = await joinVoice(A, C, 'A');
    check('control: V receives StreamStarted(A) on A\'s join (roster/media signal route works)', !!(await Vs.waitFor(f => f.type === 'StreamStarted' && f.payload?.room_id === room && Number(f.payload?.streamer?.id) === A.id, 2000)), typesFrom(Vs, 0));
    const Bs = await joinVoice(B, C, 'B');
    check('control fixture: V receives StreamStarted(B)', !!(await Vs.waitFor(f => f.type === 'StreamStarted' && Number(f.payload?.streamer?.id) === B.id, 2000)));
    // Control: the legitimate teardown signal is observable by V.
    Bs.send('StopStream', { room_id: room });
    check('control: V receives StreamStopped(B) when B sends StopStream', !!(await Vs.waitFor(f => f.type === 'StreamStopped' && Number(f.payload?.streamer_id) === B.id, 2000)), typesFrom(Vs, 0));
    Bs.send('LeaveRoom', { room_id: room }); await Vs.waitFor(f => f.type === 'UserLeft' && f.payload?.user_id === B.id, 2000);

    // The fix: A leaves WITHOUT StopStream.
    const mark = Vs.frames.length;
    As.send('LeaveRoom', { room_id: room });
    check('fixture: A\'s own socket gets RoomLeft', !!(await As.waitFor(f => f.type === 'RoomLeft' && f.payload?.room_id === room, 2000)));
    check('V receives UserLeft(A)', !!(await Vs.waitFor(f => f.type === 'UserLeft' && f.payload?.room_id === room && f.payload?.user_id === A.id, 2500)), typesFrom(Vs, mark));
    await Vs.waitFor(f => f.type === 'StreamStopped' && Number(f.payload?.streamer_id) === A.id && Vs.frames.indexOf(f) >= mark, 2500);
    check('LeaveRoom without StopStream: V receives StreamStopped(A)', stopped(Vs, A.id, mark), typesFrom(Vs, mark));
    const roster = await V.api('GET', `/servers/${S.id}/voice-users`);
    check('integrity: A is out of the voice roster, V remains', roster.status === 200 && !(roster.json?.voice_users || []).some(u => u.user_id === A.id) && (roster.json?.voice_users || []).some(u => u.user_id === V.id), roster.text.slice(0, 200));
    Vs.close(); As.close(); Bs.close();
}

// ---------------------------------------------------------------------------
// C10: the voice-room branch of ChatMessage checked VIEW only - no
// SEND_MESSAGES, no member-timeout lookup - so a silenced member could still
// inject chat frames into a live call. Now it mirrors the text branch. On
// 0.9.4 both markers below reach the occupant.
// ---------------------------------------------------------------------------
async function voiceChatMessageGate() {
    section('C10: voice-room ChatMessage requires SEND_MESSAGES and honours timeouts');
    const O = mkUser('vco'), M1 = mkUser('vcm1'), M2 = mkUser('vcm2'), M3 = mkUser('vcm3');
    const S = await mkServer(O);
    const C = await mkChannel(S, 'call', 1);
    const T = await mkChannel(S, 'text', 0);
    const room = `voice_${C}`;
    for (const u of [M1, M2, M3]) await joinViaInvite(S, u);
    const NOSEND = await mkRole(S, 'nosend', 0);
    await assignRole(S, M2, NOSEND);
    await denyForRole(S, C, NOSEND, BITS.SEND_MESSAGES);
    const to = await O.api('POST', `/servers/${S.id}/timeout/${M3.id}`, { duration_seconds: 600, reason: 'probe' });
    check('fixture: owner times out M3', to.status === 200 && row(`SELECT count(*) FROM member_timeouts WHERE server_id='${S.id}' AND user_id=${M3.id} AND expires_at > (NOW() AT TIME ZONE 'UTC')`) === '1', to.status + ' ' + to.text);
    await sleep(300);

    const w1 = await joinVoice(M1, C, 'M1 (entitled)');
    const w2 = await joinVoice(M2, C, 'M2 (SEND denied on the voice channel)');
    const w3 = await joinVoice(M3, C, 'M3 (timed out)');
    for (const [w, who] of [[w1, 'M1'], [w2, 'M2'], [w3, 'M3']]) {
        w.send('JoinRoom', { room_id: `channel_${T}` });
        check(`fixture: ${who} also joins the text room`, !!(await w.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === `channel_${T}`, 2000)));
    }
    const chat = (w, roomId, marker) => w.send('ChatMessage', { room_id: roomId, content: `enc:v2:${marker}-${RUN}` });
    const isChat = (marker) => (f) => f.type === 'ChatMessage' && String(f.payload?.content).includes(`${marker}-${RUN}`);
    const carries = (w, marker, from) => has(w, isChat(marker), from);

    // Controls.
    let m2 = w2.frames.length, m3 = w3.frames.length;
    chat(w1, room, 'VOICE-OK');
    const okAt2 = await w2.waitFor(isChat('VOICE-OK'), 2000), okAt3 = await w3.waitFor(isChat('VOICE-OK'), 2000);
    check('control: an entitled member\'s voice ChatMessage reaches the other occupants', !!okAt2 && !!okAt3, typesFrom(w2, m2) + ' | ' + typesFrom(w3, m3));
    let m1 = w1.frames.length;
    chat(w2, `channel_${T}`, 'TEXT-M2');
    check('control: M2\'s SEND deny is scoped to the voice channel (text-room ChatMessage still delivered)', !!(await w1.waitFor(isChat('TEXT-M2'), 2000)), typesFrom(w1, m1));
    m1 = w1.frames.length; m3 = w3.frames.length;
    chat(w3, `channel_${T}`, 'TEXT-TIMEOUT');
    const tErr = await w3.waitFor(f => f.type === 'Error', 1500); await sleep(500);
    check('control: the timeout is real - the text branch refuses M3 with an Error', !!tErr && !carries(w1, 'TEXT-TIMEOUT', m1), typesFrom(w1, m1) + ' | ' + typesFrom(w3, m3));

    // The fix.
    m1 = w1.frames.length; m2 = w2.frames.length; m3 = w3.frames.length;
    chat(w2, room, 'VOICE-NOSEND'); await sleep(900);
    check('SEND-denied member: voice ChatMessage reaches no occupant (and is not echoed)', !carries(w1, 'VOICE-NOSEND', m1) && !carries(w3, 'VOICE-NOSEND', m3) && !carries(w2, 'VOICE-NOSEND', m2), typesFrom(w1, m1) + ' | ' + typesFrom(w2, m2));
    m1 = w1.frames.length; m2 = w2.frames.length; m3 = w3.frames.length;
    chat(w3, room, 'VOICE-TIMEOUT'); await sleep(900);
    check('timed-out member: voice ChatMessage reaches no occupant', !carries(w1, 'VOICE-TIMEOUT', m1) && !carries(w2, 'VOICE-TIMEOUT', m2) && !carries(w3, 'VOICE-TIMEOUT', m3), typesFrom(w1, m1) + ' | ' + typesFrom(w3, m3));
    // The room itself is intact: M1 still reaches everyone afterwards.
    m2 = w2.frames.length;
    chat(w1, room, 'VOICE-OK-2');
    check('control: the entitled member still reaches the room afterwards', !!(await w2.waitFor(isChat('VOICE-OK-2'), 2000)), typesFrom(w2, m2));
    w1.close(); w2.close(); w3.close();
}

// ---------------------------------------------------------------------------
// One clip fixture, three findings, one presence-log wait:
//   C16:        get_clip / list_pending re-checked only the VOICE channel,
//               handing a VIEW-denied-on-target approver the hidden text
//               channel's id and name. The first fix required VIEW on BOTH
//               channels, which turned a mandatory consent seat into one that
//               could never be granted - every proposal in that call expired
//               (review finding 9). The rule now: the voice channel gates
//               participation (doorbell, GET, /pending, vote, ClipResolved);
//               the target channel gates only what the view NAMES - its id
//               and name are both null for a caller who cannot VIEW it, and
//               the frames carry nothing to redact.
//   r2-4-L4-01: ClipProposed / ClipVoteUpdate / ClipResolved were fanned out
//               against the propose-time snapshot with no re-check, so a
//               kicked proposer kept receiving the tally over a socket the
//               kick left open. Now each recipient is re-checked at send time
//               against the voice channel.
//   C11:        a parked ClipPending was drained into the delivery socket with
//               no re-check (only MessageNotification had one). Now it is
//               dropped unless the recipient still views the clip's voice
//               channel.
// On 0.9.4 X is told the target's id and name, the kicked proposer gets the
// tally and the outcome, and X3's delivery socket gets the parked doorbell.
// ---------------------------------------------------------------------------
async function clipEntitlement() {
    section('C16 + r2-4-L4-01 + C11: clip participation follows the voice channel; a hidden target is redacted, not refused');
    const O = mkUser('clo');
    const S = await mkServer(O);
    const TNAME = `clips_target_${RUN}`;
    const T = await mkChannel(S, TNAME, 0);
    const C1 = await mkChannel(S, 'call-one', 1), C2 = await mkChannel(S, 'call-two', 1), C3 = await mkChannel(S, 'call-three', 1);
    const pin = await O.api('PATCH', `/servers/${S.id}/settings`, { clips_enabled: true, clip_channel_id: T });
    check('fixture: clips enabled and pinned to the text channel', pin.status === 200, pin.status + ' ' + pin.text);
    // Proposal 1: P1 proposes; Y views both channels, X is VIEW-denied on T.
    const P1 = mkUser('clp1'), Y = mkUser('cly'), X = mkUser('clx');
    // Proposal 2: P2 proposes, is kicked, V2 votes.
    const P2 = mkUser('clp2'), V2 = mkUser('clv2');
    // Proposal 3: P3 proposes alone with declared offline approvers X3, Y3.
    const P3 = mkUser('clp3'), X3 = mkUser('clx3'), Y3 = mkUser('cly3');
    for (const u of [P1, Y, X, P2, V2, P3, X3, Y3]) await joinViaInvite(S, u);
    const XDENY = await mkRole(S, 'xdeny', 0);
    await assignRole(S, X, XDENY);
    await denyForRole(S, T, XDENY);
    await sleep(300);
    let r = await X.api('GET', `/channels/${T}/messages`);
    check('fixture: X cannot VIEW the clips target channel (404)', r.status === 404, r.status + ' ' + r.text);
    r = await Y.api('GET', `/channels/${T}/messages`);
    check('fixture: Y can', r.status === 200, r.status);

    const wP1 = await joinVoice(P1, C1, 'proposer P1'), wY = await joinVoice(Y, C1, 'approver Y'), wX = await joinVoice(X, C1, 'approver X');
    const wP2 = await joinVoice(P2, C2, 'proposer P2'), wV2 = await joinVoice(V2, C2, 'approver V2');
    const wP3 = await joinVoice(P3, C3, 'proposer P3');
    // The proposer must have been present longer than duration + PAD (2 s) or
    // propose answers 409 window_predates_log.
    await sleep(8500);
    const propose = (u, c, declared) => u.api('POST', `/channels/${c}/clips`, { target_channel_id: T, duration_ms: 5000, ended_ago_ms: 0, declared_participants: declared });
    const approverIds = (resp) => (resp.json?.approvers || []).map(a => a.id);

    // ---- Proposal 1: C16 + approver-side fan-out mirror + proposer controls.
    const p1 = await propose(P1, C1, [Y.id, X.id]);
    check('fixture: P1 proposes -> 201 with X and Y as approvers', p1.status === 201 && approverIds(p1).includes(X.id) && approverIds(p1).includes(Y.id), p1.status + ' ' + p1.text.slice(0, 200));
    const clip1 = p1.json?.clip_id;
    check('control: Y receives the ClipProposed doorbell', !!(await wY.waitFor(f => f.type === 'ClipProposed' && f.payload?.clip_id === clip1, 2500)), typesFrom(wY, 0));
    const xBell = await wX.waitFor(f => f.type === 'ClipProposed' && f.payload?.clip_id === clip1, 2500);
    check('X (VIEW-denied on the target) receives the ClipProposed doorbell too (the seat is kept)', !!xBell, typesFrom(wX, 0));
    check('...and the doorbell names no channel (nothing to redact on the frame)', !!xBell && noLeak({ text: JSON.stringify(xBell) }, TNAME) && !JSON.stringify(xBell).includes(`"target_channel_id"`), JSON.stringify(xBell));
    r = await Y.api('GET', `/clips/${clip1}`);
    check('control: Y (views the target) reads GET /clips/:id with the target channel id AND name', r.status === 200 && r.json?.target_channel_id === T && r.json?.target_channel_name === TNAME, r.status + ' ' + r.text.slice(0, 200));
    r = await Y.api('GET', '/clips/pending');
    check('control: Y\'s /clips/pending lists the clip with the target named', r.status === 200 && (r.json?.proposals || []).some(p => p.clip_id === clip1 && p.target_channel_id === T && p.target_channel_name === TNAME), r.status + ' ' + r.text.slice(0, 200));
    r = await X.api('GET', `/clips/${clip1}`);
    check('X: GET /clips/:id -> 200 with target_channel_id and target_channel_name null (present, redacted)', r.status === 200 && r.json?.clip_id === clip1 && 'target_channel_id' in (r.json || {}) && 'target_channel_name' in (r.json || {}) && r.json?.target_channel_id === null && r.json?.target_channel_name === null && noLeak(r, TNAME) && noLeak(r, `"target_channel_id":${T}`), r.status + ' ' + r.text.slice(0, 200));
    check('...and the rest of X\'s view is intact (voice channel named, my_vote pending, 2 approvers, you)', r.json?.voice_channel_id === C1 && typeof r.json?.voice_channel_name === 'string' && r.json?.my_vote === 'pending' && r.json?.approver_count === 2 && !!r.json?.you, r.text.slice(0, 300));
    r = await X.api('GET', '/clips/pending');
    const xPending = (r.json?.proposals || []).find(p => p.clip_id === clip1);
    check('X: /clips/pending lists the clip with the target redacted', r.status === 200 && !!xPending && xPending.target_channel_id === null && xPending.target_channel_name === null && noLeak(r, TNAME) && noLeak(r, `"target_channel_id":${T}`), r.status + ' ' + r.text.slice(0, 200));
    let mP1 = wP1.frames.length;
    r = await Y.api('POST', `/clips/${clip1}/vote`, { approve: true });
    check('control: Y votes -> 200 pending (X still owes a vote)', r.status === 200 && r.json?.state === 'pending' && r.json?.approved_count === 1 && r.json?.total === 2, r.status + ' ' + r.text);
    const vu = await wP1.waitFor(f => f.type === 'ClipVoteUpdate' && f.payload?.clip_id === clip1, 2500);
    check('control: entitled proposer P1 receives ClipVoteUpdate {1 of 2}', !!vu && vu.payload?.approved_count === 1 && vu.payload?.total === 2, JSON.stringify(vu) + ' ' + typesFrom(wP1, mP1));
    const mY = wY.frames.length, mX = wX.frames.length; mP1 = wP1.frames.length;
    r = await X.api('POST', `/clips/${clip1}/vote`, { approve: true });
    check('X: vote -> 200 approved {2 of 2} (X\'s consent counted and completed the proposal)', r.status === 200 && r.json?.state === 'approved' && r.json?.approved_count === 2 && r.json?.total === 2, r.status + ' ' + r.text);
    const resolved = (outcome) => (f) => f.type === 'ClipResolved' && f.payload?.clip_id === clip1 && new RegExp(outcome, 'i').test(String(f.payload?.outcome));
    check('control: P1 receives ClipResolved{approved}', !!(await wP1.waitFor(resolved('approved'), 2500)), typesFrom(wP1, mP1));
    check('control: Y receives ClipResolved{approved}', !!(await wY.waitFor(resolved('approved'), 2500)), typesFrom(wY, mY));
    check('X receives ClipResolved{approved} (fan-out re-checks the voice channel only)', !!(await wX.waitFor(resolved('approved'), 2500)), typesFrom(wX, mX));
    check('...and no Clip* frame to X ever named the target', !has(wX, f => /^Clip/.test(String(f.type)) && (JSON.stringify(f).includes(TNAME) || JSON.stringify(f).includes(`"target_channel_id":${T}`))), JSON.stringify(wX.frames.filter(f => /^Clip/.test(String(f.type)))).slice(0, 300));

    // ---- Proposal 2: r2-4-L4-01, the kicked proposer.
    const p2 = await propose(P2, C2, [V2.id]);
    check('fixture: P2 proposes -> 201 with V2 as the approver', p2.status === 201 && approverIds(p2).includes(V2.id) && p2.json?.solo === false, p2.status + ' ' + p2.text.slice(0, 200));
    const clip2 = p2.json?.clip_id;
    const kick = await O.api('POST', `/servers/${S.id}/kick/${P2.id}`, { reason: 'probe' });
    check('fixture: owner kicks the proposer', kick.status === 200 && row(`SELECT count(*) FROM server_members WHERE server_id='${S.id}' AND user_id=${P2.id}`) === '0', kick.status + ' ' + kick.text);
    await sleep(600);
    r = await P2.api('GET', `/clips/${clip2}`);
    check('baseline: kicked proposer GET /clips/:id -> 404 (held on 0.9.4)', r.status === 404, r.status + ' ' + r.text);
    check('fixture: the kicked proposer\'s socket is still open', wP2.sock.readyState === 1, String(wP2.sock.readyState));
    const mP2 = wP2.frames.length, mV2 = wV2.frames.length;
    r = await V2.api('POST', `/clips/${clip2}/vote`, { approve: true });
    check('control: V2 votes -> 200 approved (the proposal survived the kick)', r.status === 200 && r.json?.state === 'approved', r.status + ' ' + r.text);
    check('control: approver V2 receives ClipResolved{approved} (fan-out ran)', !!(await wV2.waitFor(f => f.type === 'ClipResolved' && f.payload?.clip_id === clip2 && /approved/i.test(String(f.payload?.outcome)), 2500)), typesFrom(wV2, mV2));
    await sleep(800);
    check('kicked proposer receives NO ClipVoteUpdate', !has(wP2, f => f.type === 'ClipVoteUpdate' && f.payload?.clip_id === clip2, mP2), typesFrom(wP2, mP2));
    check('...NO ClipResolved', !has(wP2, f => f.type === 'ClipResolved' && f.payload?.clip_id === clip2, mP2), JSON.stringify(wP2.frames.slice(mP2)).slice(0, 300));

    // ---- Proposal 3: C11, the parked ClipPending.
    const p3 = await propose(P3, C3, [X3.id, Y3.id]);
    const offlineApprover = (uid) => (p3.json?.approvers || []).find(a => a.id === uid)?.online === false;
    check('fixture: P3 proposes -> 201 with X3 and Y3 as declared approvers, both reported offline (no session: the doorbell parks)', p3.status === 201 && offlineApprover(X3.id) && offlineApprover(Y3.id), p3.status + ' ' + p3.text.slice(0, 200));
    const clip3 = p3.json?.clip_id;
    const X3DENY = await mkRole(S, 'x3deny', 0);
    await assignRole(S, X3, X3DENY);
    await denyForRole(S, C3, X3DENY);
    await sleep(300);
    r = await X3.api('GET', `/clips/${clip3}`);
    check('fixture: X3 is now VIEW-denied on the clip\'s voice channel (GET /clips/:id 404)', r.status === 404, r.status + ' ' + r.text);
    const drained = async (u) => { const d = await ws(u, { delivery: true }); await sleep(1200); const hits = d.frames.filter(f => f.type === 'ClipPending' && f.payload?.clip_id === clip3); const all = typesFrom(d, 0); d.close(); return { hits, all }; };
    const y3 = await drained(Y3);
    check('control: entitled Y3\'s delivery socket receives the parked ClipPending', y3.hits.length === 1, y3.all);
    const x3 = await drained(X3);
    check('VIEW-denied X3: delivery socket receives NO parked ClipPending', x3.hits.length === 0, x3.all);
    r = await Y3.api('GET', `/clips/${clip3}`);
    check('control: Y3 reads the clip over REST', r.status === 200, r.status + ' ' + r.text.slice(0, 120));
    // The cancel control lives here now (proposal 1 ends approved): the
    // proposer's own cancel of a still-pending proposal is announced back.
    const mP3 = wP3.frames.length;
    r = await P3.api('DELETE', `/clips/${clip3}`);
    check('control: P3 cancels the pending proposal -> 204', r.status === 204, r.status + ' ' + r.text);
    check('control: P3 receives ClipResolved{cancelled}', !!(await wP3.waitFor(f => f.type === 'ClipResolved' && f.payload?.clip_id === clip3 && /cancel/i.test(String(f.payload?.outcome)), 2500)), typesFrom(wP3, mP3));
    for (const w of [wP1, wY, wX, wP2, wV2, wP3]) w.close();
}

// ---------------------------------------------------------------------------
// r2-4-L4-03: deliver_parked_offers and the undelivered-frame drain re-ran no
// gate at delivery time, so a FileOffered or DirectMessage parked BEFORE a
// block reached the blocker afterwards (and pinged the blocked sender with a
// "reached them" note). Now both are dropped at drain when either party has
// blocked the other. On 0.9.4 the T2 offer and the blocked DM both arrive.
// ---------------------------------------------------------------------------
async function parkedFramesRecheckBlocks() {
    section('r2-4-L4-03: parked FileOffered / DirectMessage are re-checked against blocks at drain');
    const SHA = 'a'.repeat(64);
    const offer = (sock, target, transfer_id, name) => sock.send('FileOffer', { target_user: target, transfer_id, name, size: 0, mime: 'text/plain', sha256: SHA });
    const O = mkUser('pfo'), A = mkUser('pfa'), V = mkUser('pfv'), A2 = mkUser('pfa2'), V2 = mkUser('pfv2'), A3 = mkUser('pfa3'), V3 = mkUser('pfv3');
    // DM eligibility through a shared server (a block does not undo membership,
    // so the fixture cannot decay under the block-dissolves-friendship fix).
    const S = await mkServer(O);
    for (const u of [A, V, A2, V2, A3, V3]) await joinViaInvite(S, u);
    for (const [a, v, label] of [[A, V, 'A -> V'], [A2, V2, 'A2 -> V2']]) {
        const dm = await a.api('POST', '/dms', { user_id: v.id });
        check(`fixture: DM conversation ${label} opened`, dm.status === 200, dm.status + ' ' + dm.text.slice(0, 80));
    }

    // Control: an entitled pair, parked then delivered with the sender note.
    const aSock = await ws(A); await aSock.settle();
    const T1 = randomUUID();
    offer(aSock, V.id, T1, `CTRL-${RUN}`);
    const parked1 = await aSock.waitFor(f => f.type === 'FileParked' && f.payload?.transfer_id === T1, 2000);
    check('control: offer to an offline target parks (FileParked "app isn\'t connected")', !!parked1 && /isn't connected/i.test(parked1.payload?.reason || ''), JSON.stringify(parked1?.payload));
    let vSock = await ws(V);
    check('control: the target\'s next visible socket receives the parked FileOffered', !!(await vSock.waitFor(f => f.type === 'FileOffered' && f.payload?.transfer_id === T1 && f.payload?.from_user === A.id, 2500)), typesFrom(vSock, 0));
    check('control: the sender gets the "reached them" note', !!(await aSock.waitFor(f => f.type === 'FileParked' && f.payload?.transfer_id === T1 && /reached them/i.test(f.payload?.reason || ''), 2000)), typesFrom(aSock, 0));
    vSock.close(); await sleep(1200);

    // Blocker-side block after parking.
    const T2 = randomUUID();
    offer(aSock, V.id, T2, `ATK-${RUN}`);
    check('fixture: the second offer parks', !!(await aSock.waitFor(f => f.type === 'FileParked' && f.payload?.transfer_id === T2, 2000)));
    let b = await V.api('POST', `/users/${A.id}/block`);
    check('fixture: V blocks A -> 200', b.status === 200 && row(`SELECT count(*) FROM blocked_users WHERE blocker_id=${V.id} AND blocked_id=${A.id}`) === '1', b.status + ' ' + b.text);
    const aMark = aSock.frames.length;
    const T3 = randomUUID();
    offer(aSock, V.id, T3, `POST-${RUN}`);
    const refusedNew = await aSock.waitFor(f => f.type === 'Error', 2000); await sleep(300);
    check('control: the offer-time gate refuses a NEW offer after the block (held on 0.9.4)', !!refusedNew && !has(aSock, f => f.type === 'FileParked' && f.payload?.transfer_id === T3, aMark), typesFrom(aSock, aMark));
    const aMark2 = aSock.frames.length;
    vSock = await ws(V); await sleep(2500);
    check('post-block parked FileOffered is NOT delivered to the blocker', !has(vSock, f => f.type === 'FileOffered' && f.payload?.transfer_id === T2), typesFrom(vSock, 0));
    check('...no "reached them" note goes back to the blocked sender', !has(aSock, f => f.type === 'FileParked' && f.payload?.transfer_id === T2 && /reached them/i.test(f.payload?.reason || ''), aMark2), typesFrom(aSock, aMark2));
    vSock.close();

    // Mirror: the SENDER blocks after parking.
    const a2Sock = await ws(A2); await a2Sock.settle();
    const T4 = randomUUID();
    offer(a2Sock, V2.id, T4, `MIRROR-${RUN}`);
    check('fixture: the mirror offer parks', !!(await a2Sock.waitFor(f => f.type === 'FileParked' && f.payload?.transfer_id === T4, 2000)));
    b = await A2.api('POST', `/users/${V2.id}/block`);
    check('fixture: A2 (the sender) blocks V2 -> 200', b.status === 200, b.status + ' ' + b.text);
    const v2Sock = await ws(V2); await sleep(2500);
    check('mirror: sender-side block also drops the parked offer', !has(v2Sock, f => f.type === 'FileOffered' && f.payload?.transfer_id === T4), typesFrom(v2Sock, 0));
    v2Sock.close();

    // DM leg: a DirectMessage parked for a fully offline recipient. Both DMs
    // are sent 1.5 s after V3 closed a delivery socket, so the control proves
    // that gap is long enough for the session to unregister (a lagging
    // unregister would make send_to_user "succeed" into a dead channel, park
    // nothing, and let the attack check pass vacuously).
    const a3Sock = await ws(A3); await a3Sock.settle();
    const d0 = await ws(V3, { delivery: true }); d0.close(); await sleep(1500);
    a3Sock.send('DirectMessage', { to_user_id: V3.id, content: `enc:v2:PARKED-DM-OK-${RUN}` });
    check('fixture: the DM is persisted (echo to the sender)', !!(await a3Sock.waitFor(f => f.type === 'DirectMessage' && String(f.payload?.content).includes(`PARKED-DM-OK-${RUN}`), 2000)) && row(`SELECT count(*) FROM dm_messages WHERE content='enc:v2:PARKED-DM-OK-${RUN}'`) === '1');
    let d3 = await ws(V3, { delivery: true }); await sleep(1200);
    check('control: the recipient\'s delivery socket drains the parked DirectMessage', has(d3, f => f.type === 'DirectMessage' && String(f.payload?.content).includes(`PARKED-DM-OK-${RUN}`)), typesFrom(d3, 0));
    d3.close(); await sleep(1500);
    a3Sock.send('DirectMessage', { to_user_id: V3.id, content: `enc:v2:PARKED-DM-BLOCKED-${RUN}` });
    check('fixture: the second DM is persisted before the block', !!(await a3Sock.waitFor(f => f.type === 'DirectMessage' && String(f.payload?.content).includes(`PARKED-DM-BLOCKED-${RUN}`), 2000)));
    b = await V3.api('POST', `/users/${A3.id}/block`);
    check('fixture: V3 blocks A3 -> 200', b.status === 200, b.status + ' ' + b.text);
    d3 = await ws(V3, { delivery: true }); await sleep(1500);
    check('post-block parked DirectMessage is NOT drained into the delivery socket', !has(d3, f => f.type === 'DirectMessage' && String(f.payload?.content).includes(`PARKED-DM-BLOCKED-${RUN}`)), typesFrom(d3, 0));
    d3.close(); aSock.close(); a2Sock.close(); a3Sock.close();
}

// ---------------------------------------------------------------------------
// r2-4-L4-02: FileOffer's deliverability predicate was the bare
// is_user_visibly_online, blind to show_online_status, so the FileParked-vs-
// silence answer (and the connect-time "reached them" push) told a sender
// exactly when a hidden user was at a keyboard. Now a hidden target answers
// identically online or offline while the offer still reaches them; targets
// with the setting on keep the parked/delivered distinction. On 0.9.4 the two
// observables differ and the login note fires.
// ---------------------------------------------------------------------------
async function hiddenPresenceOffer() {
    section('r2-4-L4-02: FileOffer is not a presence oracle against a hidden user');
    const SHA = 'a'.repeat(64);
    const mkOffer = (target) => ({ target_user: target, transfer_id: randomUUID(), name: 'x', size: 1, mime: 'text/plain', sha256: SHA });
    // What the sender observes for ONE offer: frame types plus the parked
    // reason, in order, within a settle window.
    const observe = async (sock, o) => {
        const b = sock.frames.length;
        sock.send('FileOffer', o); await sleep(1500);
        return sock.frames.slice(b).filter(f => f.type !== 'FileParked' || f.payload?.transfer_id === o.transfer_id)
            .map(f => f.type + (f.type === 'FileParked' ? ':' + f.payload?.reason : '')).join('|');
    };
    const isOnline = async (viewer, S, uid) => ((await viewer.api('GET', `/servers/${S.id}/members`)).json || []).find(m => Number(m.id) === uid || Number(m.user_id) === uid)?.is_online;

    const O = mkUser('hpo'), A = mkUser('hpa'), V = mkUser('hpv'), A2 = mkUser('hpa2'), W = mkUser('hpw');
    const S = await mkServer(O);
    for (const u of [A, V, A2, W]) await joinViaInvite(S, u);
    let r = await V.api('PATCH', '/profile', { show_online_status: false });
    check('fixture: V hides presence (PATCH /profile 200)', r.status === 200, r.status + ' ' + r.text.slice(0, 80));
    r = await A.api('POST', '/dms', { user_id: V.id }); check('fixture: A opens a DM with V', r.status === 200, r.status);
    r = await A2.api('POST', '/dms', { user_id: W.id }); check('fixture: A2 opens a DM with W', r.status === 200, r.status);

    const aWs = await ws(A); await aWs.settle();
    // V fully offline.
    const o1 = mkOffer(V.id);
    const offline = await observe(aWs, o1);
    check('control: offer to the offline hidden target parks (FileParked)', /^FileParked:/.test(offline), offline);
    aWs.send('FileCancel', { transfer_id: o1.transfer_id });
    // V online in a visible client, still hidden.
    const vWs = await ws(V); await vWs.settle();
    check('control: /members still reports hidden V offline (toggle honoured on the sanctioned surface)', (await isOnline(A, S, V.id)) === false);
    const o2 = mkOffer(V.id);
    const online = await observe(aWs, o2);
    check('hidden V: sender\'s observable is byte-identical offline vs online', online === offline, `offline=${offline} | online=${online}`);
    check('...and the offer still reaches the online hidden target', !!(await vWs.waitFor(f => f.type === 'FileOffered' && f.payload?.transfer_id === o2.transfer_id, 2500)), typesFrom(vWs, 0));
    aWs.send('FileCancel', { transfer_id: o2.transfer_id });
    // The connect-time push: a parked offer must not become a login alarm.
    vWs.close(); await sleep(1500);
    const o3 = mkOffer(V.id);
    const again = await observe(aWs, o3);
    check('fixture: offer parks again once V is offline', /^FileParked:/.test(again), again);
    const aMark = aWs.frames.length;
    const vWs2 = await ws(V);
    const got3 = await vWs2.waitFor(f => f.type === 'FileOffered' && f.payload?.transfer_id === o3.transfer_id, 3000);
    await sleep(1500);
    check('control: the parked offer is delivered to hidden V on connect', !!got3, typesFrom(vWs2, 0));
    check('hidden V logging in produces NO "reached them" note to the sender', !has(aWs, f => f.type === 'FileParked' && /reached them/i.test(f.payload?.reason || ''), aMark), typesFrom(aWs, aMark));
    vWs2.close(); aWs.close();

    // Setting ON: the parked/delivered distinction remains.
    const a2Ws = await ws(A2); await a2Ws.settle();
    const o4 = mkOffer(W.id);
    const wOff = await observe(a2Ws, o4);
    check('control (setting on): offline W -> FileParked', /^FileParked:/.test(wOff), wOff);
    const a2Mark = a2Ws.frames.length;
    const wWs = await ws(W);
    check('control (setting on): W receives the parked offer on connect', !!(await wWs.waitFor(f => f.type === 'FileOffered' && f.payload?.transfer_id === o4.transfer_id, 2500)), typesFrom(wWs, 0));
    check('control (setting on): the sender gets the "reached them" note', !!(await a2Ws.waitFor(f => f.type === 'FileParked' && f.payload?.transfer_id === o4.transfer_id && /reached them/i.test(f.payload?.reason || ''), 2500)), typesFrom(a2Ws, a2Mark));
    const o5 = mkOffer(W.id);
    const wOn = await observe(a2Ws, o5);
    check('control (setting on): online W -> delivered silently, no FileParked', !/FileParked/.test(wOn) && !!(await wWs.waitFor(f => f.type === 'FileOffered' && f.payload?.transfer_id === o5.transfer_id, 1500)), wOn);
    check('control (setting on): the two observables DIFFER (distinction kept)', wOff !== wOn, `${wOff} | ${wOn}`);
    wWs.close(); a2Ws.close();
}

// ---------------------------------------------------------------------------
// C34: mark_server_read's INSERT...SELECT ran over every channel of the server
// with no VIEW predicate, writing a read-state row for a channel the caller
// cannot see (and later suppressing their unread badge for it). Now only
// viewable channels get a row. On 0.9.4 the hidden-channel row exists.
// ---------------------------------------------------------------------------
async function markServerReadScope() {
    section('C34: POST /servers/:id/read writes read state only for viewable channels');
    const O = mkUser('mso'), A = mkUser('msa'), N = mkUser('msn');
    const S = await mkServer(O);
    const C = await mkChannel(S, 'hidden');
    const P = await mkChannel(S, 'visible');
    await joinViaInvite(S, A);
    await denyView(S, C);
    for (let i = 0; i < 3; i++) await O.api('POST', `/channels/${C}/messages`, { content: `enc:v2:C34C-${i}` });
    await O.api('POST', `/channels/${P}/messages`, { content: 'enc:v2:C34P' });
    const chans = await A.api('GET', `/servers/${S.id}/channels`);
    const ids = (chans.json || []).map(c => c.id);
    check('fixture: A sees the visible channel and not the hidden one', ids.includes(P) && !ids.includes(C), JSON.stringify(ids));
    let r = await O.api('POST', `/servers/${S.id}/read`);
    check('control: owner marks the server read -> 200', r.status === 200, r.status + ' ' + r.text);
    check('control: owner (entitled) got a row for the hidden channel', row(`SELECT count(*) FROM channel_read_state WHERE user_id=${O.id} AND channel_id=${C}`) === '1');
    r = await A.api('POST', `/servers/${S.id}/read`);
    check('VIEW-denied member marks the server read -> 200 (uniform by design)', r.status === 200, r.status + ' ' + r.text);
    check('control: a row was written for the visible channel', row(`SELECT count(*) FROM channel_read_state WHERE user_id=${A.id} AND channel_id=${P}`) === '1');
    check('no read-state row for the hidden channel', row(`SELECT count(*) FROM channel_read_state WHERE user_id=${A.id} AND channel_id=${C}`) === '0');
    check('...and the response body leaks no channel id', noLeak(r, String(C)), r.text.slice(0, 100));
    r = await N.api('POST', `/servers/${S.id}/read`);
    check('non-member -> 403, zero rows', r.status === 403 && row(`SELECT count(*) FROM channel_read_state WHERE user_id=${N.id}`) === '0', r.status + ' ' + r.text);
}

// ---------------------------------------------------------------------------
// C04: the reaction routes resolved VIEW only, so a member the role editor had
// denied READ_MESSAGE_HISTORY - 403 on GET /messages - could still read the
// reactor roster of any backlog message and react to it. Now all three routes
// need the history bit, with the same refusal as GET /channels/:id/messages.
// On 0.9.4 GET is 200 with the roster, POST 201, DELETE 200.
// ---------------------------------------------------------------------------
async function reactionsHistoryBit() {
    section('C04: reaction routes honour READ_MESSAGE_HISTORY');
    const O = mkUser('rho'), M = mkUser('rhm'), H = mkUser('rhh'), X = mkUser('rhx');
    const S = await mkServer(O); const C = await mkChannel(S, 'nohist');
    await joinViaInvite(S, M); await joinViaInvite(S, H);
    const m1 = await O.api('POST', `/channels/${C}/messages`, { content: 'enc:v2:C04-BACKLOG' });
    check('fixture: owner posts the backlog message', m1.status === 200 && !!m1.json?.id, m1.status);
    const M1 = m1.json.id;
    let r = await O.api('POST', `/messages/${M1}/reactions`, { emoji: '🔥' });
    check('fixture: owner reacts', r.status === 201 || r.status === 200, r.status + ' ' + r.text);
    // Deny history for a role M alone holds; H keeps it.
    const NOHIST = await mkRole(S, 'nohist', 0);
    await assignRole(S, M, NOHIST);
    await denyForRole(S, C, NOHIST, BITS.READ_MESSAGE_HISTORY);
    await sleep(300);
    // A reaction row for M planted directly, so a DELETE that got through would
    // show. ASCII on purpose: an emoji inside a psql -c argument crosses the
    // Windows console code page and may not round-trip.
    const PLANTED = `planted-${RUN}`;
    psql(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ('${M1}', ${M.id}, '${PLANTED}') ON CONFLICT DO NOTHING`);
    const mRows = () => row(`SELECT count(*) FROM message_reactions WHERE message_id='${M1}' AND user_id=${M.id}`);
    check('fixture: exactly one planted reaction row for M', mRows() === '1');

    const roster = (resp) => (Array.isArray(resp.json) ? resp.json : []).flatMap(e => (e.users || []).map(u => u.id));
    r = await H.api('GET', `/messages/${M1}/reactions`);
    check('control: a history-holding member reads the roster (owner listed)', r.status === 200 && roster(r).includes(O.id), r.status + ' ' + r.text.slice(0, 160));
    r = await H.api('POST', `/messages/${M1}/reactions`, { emoji: '👍' });
    check('control: history-holding member reacts -> 201', r.status === 201, r.status + ' ' + r.text);
    r = await H.api('DELETE', `/messages/${M1}/reactions/${encodeURIComponent('👍')}`);
    check('control: history-holding member removes it -> 200', r.status === 200 && row(`SELECT count(*) FROM message_reactions WHERE message_id='${M1}' AND user_id=${H.id}`) === '0', r.status + ' ' + r.text);
    const msgs = await M.api('GET', `/channels/${C}/messages`);
    // /channels/:id has no GET route (405). VIEW is proven by the SHAPE of the
    // history refusal: a VIEW-denied member gets 404, a VIEW-holding one 403.
    check('fixture: M still holds VIEW on the channel (history denial is 403, not 404)', msgs.status === 403, msgs.status);
    check('baseline: history-denied M gets 403 on GET /messages (held on 0.9.4)', msgs.status === 403 && noLeak(msgs, 'C04-BACKLOG'), msgs.status + ' ' + msgs.text.slice(0, 80));

    const get = await M.api('GET', `/messages/${M1}/reactions`);
    check('history-denied member: GET reactions refused like GET messages', get.status === msgs.status && noLeak(get, O.username) && !roster(get).length, get.status + ' ' + get.text.slice(0, 160));
    const post = await M.api('POST', `/messages/${M1}/reactions`, { emoji: '🎉' });
    check('...POST reaction refused (no new row)', post.status === msgs.status && mRows() === '1', post.status + ' ' + post.text);
    const del = await M.api('DELETE', `/messages/${M1}/reactions/${encodeURIComponent(PLANTED)}`);
    check('...DELETE reaction refused (row intact)', del.status === msgs.status && mRows() === '1', del.status + ' ' + del.text);
    r = await X.api('GET', `/messages/${M1}/reactions`);
    check('non-member: GET reactions refused', refused(r) && !roster(r).length, r.status + ' ' + r.text.slice(0, 80));
}

// ---------------------------------------------------------------------------
// r2-5-L5-01: list_servers and join_via_invite echoed servers.clip_channel_id
// with no VIEW resolve, so a member VIEW-denied on the pinned clips channel got
// its id from GET /servers (and at first contact from the join response) while
// GET /servers/:id/channels refused to admit it existed. Now the field is null
// for a caller who cannot VIEW that channel. On 0.9.4 both echo C.
// ---------------------------------------------------------------------------
async function clipChannelIdHidden() {
    section('r2-5-L5-01: clip_channel_id is null to a member who cannot VIEW it');
    const O = mkUser('cco'), P = mkUser('ccp'), A = mkUser('cca'), N = mkUser('ccn');
    const S = await mkServer(O);
    const C = await mkChannel(S, 'staff', 0);
    await joinViaInvite(S, P);
    const ALLOW = await mkRole(S, 'staff', 0);
    await assignRole(S, P, ALLOW);
    let r = await O.api('PUT', `/channels/${C}/overwrites/${ALLOW}`, { allow: BITS.VIEW_CHANNEL, deny: 0 });
    check('fixture: role Staff ALLOWS VIEW on the channel', r.status === 200, r.status + ' ' + r.text);
    await denyView(S, C);
    const pin = await O.api('PATCH', `/servers/${S.id}/settings`, { clips_enabled: true, clip_max_seconds: 120, clip_channel_id: C });
    check('fixture: owner pins clips to the hidden channel -> 200 (a hidden pin is still accepted)', pin.status === 200 && parseInt(row(`SELECT clip_channel_id FROM servers WHERE id='${S.id}'`), 10) === C, pin.status + ' ' + pin.text);

    const rowFor = (resp) => (Array.isArray(resp.json) ? resp.json : []).find(s => String(s.id) === String(S.id));
    r = await O.api('GET', '/servers');
    check('control: the owner sees clip_channel_id == C', r.status === 200 && Number(rowFor(r)?.clip_channel_id) === C, JSON.stringify(rowFor(r)).slice(0, 200));
    r = await P.api('GET', '/servers');
    check('control: a member who can VIEW it (role allow) sees clip_channel_id == C', r.status === 200 && Number(rowFor(r)?.clip_channel_id) === C, JSON.stringify(rowFor(r)).slice(0, 200));
    const join = await joinViaInvite(S, A);
    check('join response shows clip_channel_id null to the VIEW-denied joiner', join.status === 200 && join.json?.clip_channel_id === null && noLeak(join, `"clip_channel_id":${C}`), JSON.stringify(join.json).slice(0, 200));
    r = await A.api('GET', `/servers/${S.id}/channels`);
    check('control: the channel list hides C from A', r.status === 200 && !(r.json || []).some(c => Number(c.id) === C), r.text.slice(0, 160));
    r = await A.api('GET', '/servers');
    check('GET /servers shows clip_channel_id null to the VIEW-denied member', r.status === 200 && !!rowFor(r) && rowFor(r).clip_channel_id === null, JSON.stringify(rowFor(r)).slice(0, 200));
    r = await A.api('GET', `/channels/${C}/messages`);
    check('...and the id would be live: A gets 404 on it', r.status === 404, r.status);
    r = await N.api('GET', '/servers');
    check('non-member: S is not listed at all', r.status === 200 && !rowFor(r), r.text.slice(0, 120));
}

await manageChannelsBoundByDeny();
await leaveRoomGate();
await leaveEmitsStreamStopped();
await voiceChatMessageGate();
await clipEntitlement();
await parkedFramesRecheckBlocks();
await hiddenPresenceOffer();
await markServerReadScope();
await reactionsHistoryBit();
await clipChannelIdHidden();
done();
