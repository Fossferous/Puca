// Live regression for the 2026-09-05 "can a non-member read it" boundary audit
// of Puca 0.9.3 (audit-probes-0905, clusters C01 C02 C06 C07 C08 C09 C14 C16
// C17 C18 C19 C33, r2-1-L2G1-03, r2-2-L2-01/02, r2-6-L6-01).
//
// The audit found no route that hands content to a non-member, and a set of
// boundary defects around that line: presence oracles, existence oracles,
// revocation lag on live and parked frames, and self-service role changes. This
// file asserts the FIXED behaviour for every one of those, and keeps the core
// matrix (non-member / VIEW-denied member refused on every content route, live
// frames scoped, eviction on every access-reducing mutation) so it also stands
// as the regression for what already held.
//
// Every security assertion is paired with a positive control on the same
// fixture — an entitled caller succeeding on the same route — so a guard that
// refuses everyone cannot pass. Each security assertion FAILS against the 0.9.3
// backend (the probes that found them are in the audit bundle); the section
// comments say which.
//
// Prereqs: a backend on API (default http://127.0.0.1:3000) running against a
// THROWAWAY database that PGDB/PGPORT point at; Node >= 22 (global WebSocket);
// psql at PSQL. Runtime ~1 minute: one backend, sequential scenarios, fresh
// users per scenario, the clip fixture waits out the presence-log window.
//
// This file inserts users directly into PGDB and leaves servers, channels and
// messages behind. It must NEVER run against a real database.
//
// Usage: API=http://127.0.0.1:3000 PGDB=puca_sec_test PGPORT=5433 node tests/boundary-audit-live.mjs
import { randomUUID } from 'node:crypto';
import {
    mkUser, mkServer, mkChannel, joinViaInvite, denyView, ws,
    check, section, done, psql, psql1, sleep, BITS, RUN,
} from './probe-lib.mjs';

const refused = (r) => r.status === 403 || r.status === 404;
const noLeak = (r, marker) => !r.text.includes(marker);
const row = (sql) => psql1(sql);

// ---------------------------------------------------------------------------
// Core boundary matrix: three attacker positions against the message/channel/DM
// surface. All of this held on 0.9.3; it stays here so a regression in any
// content route is caught by the same run that checks the fixes.
// ---------------------------------------------------------------------------
async function boundaryMatrix() {
    section('Boundary matrix: VIEW-denied member, non-member, DM third party');
    const O = mkUser('own'), M = mkUser('mem'), X = mkUser('out');
    const S = await mkServer(O);
    const CPUB = await mkChannel(S, 'public');
    const CSEC = await mkChannel(S, 'secret', 0, { has_checklist: true });
    await joinViaInvite(S, M);

    // Member socket joined to the PUBLIC room before the deny.
    const mws = await ws(M);
    mws.send('JoinRoom', { room_id: `channel_${CPUB}` });
    check('fixture: member joins public room', !!(await mws.waitFor(f => f.type === 'RoomJoined')));

    // Seed the secret channel while M is still a viewer (so M's client could
    // plausibly hold the ids), then deny VIEW for @everyone.
    const m1 = await O.api('POST', `/channels/${CSEC}/messages`, { content: 'enc:v2:SECRET-MSG-1' });
    check('fixture: owner posts secret message', m1.status === 200 && !!m1.json?.id, m1.text);
    const MSG1 = m1.json.id;
    const e1 = await O.api('PATCH', `/channels/${CSEC}/messages/${MSG1}`, { content: 'enc:v2:SECRET-MSG-1-EDITED' });
    check('fixture: owner edits it (edit history exists)', e1.status === 200, e1.status + ' ' + e1.text.slice(0, 100));
    const p1 = await O.api('POST', `/channels/${CSEC}/messages/${MSG1}/pin`);
    check('fixture: owner pins it', p1.status === 200, p1.status + ' ' + p1.text.slice(0, 100));
    const r1 = await O.api('POST', `/messages/${MSG1}/reactions`, { emoji: '👍' });
    check('fixture: owner reacts', r1.status === 200 || r1.status === 201, r1.status + ' ' + r1.text.slice(0, 100));
    const t1 = await O.api('POST', `/channels/${CSEC}/tasks`, { description: 'enc:v2:SECRET-TASK-1', due_at: new Date(Date.now() + 3600e3).toISOString() });
    check('fixture: owner creates a task with a due time', t1.status === 200 && !!t1.json?.id, t1.status + ' ' + t1.text.slice(0, 120));
    const TASK1 = t1.json?.id;
    // Key rows straight into the table: publishing through the API needs the
    // owner's real identity key, which this rig never has.
    psql(`INSERT INTO channel_keys (channel_id, epoch, recipient_id, wrapped_key, sender_public_key, member_generation, sender_user_id) VALUES (${CSEC}, 1, ${O.id}, 'WRAPPED-FOR-OWNER', 'pk-owner', 0, ${O.id}) ON CONFLICT DO NOTHING`);
    psql(`INSERT INTO channel_keys (channel_id, epoch, recipient_id, wrapped_key, sender_public_key, member_generation, sender_user_id) VALUES (${CSEC}, 1, ${M.id}, 'WRAPPED-FOR-MEMBER', 'pk-owner', 0, ${O.id}) ON CONFLICT DO NOTHING`);

    await denyView(S, CSEC);
    await sleep(300);

    // Each attacker also owns a server, to try cross-channel addressing.
    const S2 = await mkServer(M, `mine_${M.id}`);
    const C2 = await mkChannel(S2, 'mine');
    const S3 = await mkServer(X, `theirs_${X.id}`);
    const C3 = await mkChannel(S3, 'theirs');

    let r = await O.api('GET', `/channels/${CSEC}/messages`);
    check('control: owner reads secret messages', r.status === 200 && r.text.includes('SECRET-MSG-1'), r.status);
    r = await M.api('GET', `/channels/${CPUB}/messages`);
    check('control: denied member still reads the PUBLIC channel', r.status === 200, r.status + ' ' + r.text.slice(0, 80));

    for (const [who, U] of [['denied member', M], ['non-member', X]]) {
        r = await U.api('GET', `/channels/${CSEC}/messages`); check(`${who}: GET messages refused`, refused(r) && noLeak(r, 'SECRET'), r.status);
        r = await U.api('GET', `/channels/${CSEC}/messages?before=${MSG1}&limit=50`); check(`${who}: GET messages?before=<id> refused`, refused(r) && noLeak(r, 'SECRET'), r.status);
        r = await U.api('GET', `/channels/${CSEC}/pins`); check(`${who}: GET pins refused`, refused(r) && noLeak(r, 'SECRET'), r.status);
        r = await U.api('GET', `/channels/${CSEC}/messages/${MSG1}/edits`); check(`${who}: GET edits refused`, refused(r) && noLeak(r, 'SECRET'), r.status);
        r = await U.api('GET', `/channels/${CSEC}/feed`); check(`${who}: GET feed refused`, refused(r) && noLeak(r, 'SECRET'), r.status);
        r = await U.api('GET', `/channels/${CSEC}/tasks`); check(`${who}: GET tasks refused`, refused(r) && noLeak(r, 'SECRET'), r.status);
        r = await U.api('GET', `/channels/${CSEC}/keys`); check(`${who}: GET keys refused`, refused(r) && noLeak(r, 'WRAPPED'), r.status);
        r = await U.api('GET', `/channels/${CSEC}/member-keys`); check(`${who}: GET member-keys refused`, refused(r), r.status);
        r = await U.api('GET', `/messages/${MSG1}/reactions`); check(`${who}: GET reactions by message id refused`, refused(r), r.status + ' ' + r.text.slice(0, 80));
        r = await U.api('POST', `/messages/${MSG1}/reactions`, { emoji: '🔥' }); check(`${who}: POST reaction by message id refused`, refused(r), r.status);
        r = await U.api('GET', `/channels/${CSEC}/sfu-token`); check(`${who}: sfu-token refused`, refused(r) || r.status === 400, r.status);
        r = await U.api('POST', `/channels/${CSEC}/messages`, { content: 'enc:v2:INTRUDER' }); check(`${who}: POST message refused`, refused(r), r.status);
        // C02: mark-read used to answer 200 for a VIEW-denied member. Now the VIEW gate.
        r = await U.api('POST', `/channels/${CSEC}/read`); check(`${who}: mark read refused`, refused(r), r.status);
        // Cross-channel addressing through a channel the attacker OWNS:
        const own = who === 'denied member' ? C2 : C3;
        r = await U.api('GET', `/channels/${own}/messages/${MSG1}/edits`); check(`${who}: edits via OWN channel path refused`, refused(r) && noLeak(r, 'SECRET'), r.status + ' ' + r.text.slice(0, 80));
        r = await U.api('POST', `/channels/${own}/messages/${MSG1}/pin`); check(`${who}: pin via OWN channel path refused`, refused(r), r.status);
        r = await U.api('DELETE', `/channels/${own}/messages/${MSG1}/pin`); check(`${who}: unpin via OWN channel path is a scoped no-op (pin row checked below)`, refused(r) || r.status === 200, r.status);
        r = await U.api('POST', `/channels/${own}/messages/${MSG1}/toggle-task`); check(`${who}: toggle-task via OWN channel path refused`, refused(r), r.status);
        r = await U.api('PATCH', `/channels/${own}/messages/${MSG1}`, { content: 'enc:v2:HIJACK' }); check(`${who}: edit via OWN channel path refused`, refused(r), r.status);
        r = await U.api('DELETE', `/channels/${own}/messages/${MSG1}`); check(`${who}: delete via OWN channel path refused`, refused(r), r.status);
        // A reply from the attacker's own channel pointing at the secret message
        // used to be stored verbatim; it is now a 400 (see replyScope below).
        r = await U.api('POST', `/channels/${own}/messages`, { content: 'enc:v2:REPLY-PROBE', reply_to_id: MSG1 });
        const list = await U.api('GET', `/channels/${own}/messages`);
        check(`${who}: reply_to a foreign message is refused (400) and leaks nothing`, r.status === 400 && noLeak(r, 'SECRET') && noLeak(list, 'SECRET'), `send=${r.status} ${r.text.slice(0, 80)}`);
        r = await U.api('PATCH', `/tasks/${TASK1}`, { description: 'enc:v2:HIJACK-TASK' }); check(`${who}: PATCH task by id refused`, refused(r), r.status);
        r = await U.api('POST', `/tasks/${TASK1}/move`, { direction: 'up' }); check(`${who}: move task by id refused`, refused(r), r.status);
        r = await U.api('POST', `/tasks/${TASK1}/reorder`, { after_id: null }); check(`${who}: reorder task by id refused`, refused(r), r.status);
        r = await U.api('DELETE', `/tasks/${TASK1}`); check(`${who}: delete task by id refused`, refused(r), r.status);
        r = await U.api('GET', '/task-reminders'); check(`${who}: task-reminders omit the secret task`, r.status === 200 && !JSON.stringify(r.json).includes(String(TASK1)), r.status + ' ' + r.text.slice(0, 120));
    }
    r = await M.api('GET', `/servers/${S.id}/channels`); check('denied member: channel list hides secret channel', r.status === 200 && !JSON.stringify(r.json).includes(`"id":${CSEC}`), r.text.slice(0, 160));
    r = await M.api('GET', `/servers/${S.id}/unread`); check('denied member: unread counts omit secret channel', r.status === 200 && !JSON.stringify(r.json).includes(`"${CSEC}"`) && !JSON.stringify(r.json).includes(`:${CSEC},`) && !JSON.stringify(r.json).includes(`channel_id":${CSEC}`), r.text.slice(0, 200));
    r = await M.api('GET', '/unread'); check('denied member: global unread omits secret channel', r.status === 200 && !JSON.stringify(r.json).includes(String(CSEC)), r.text.slice(0, 200));
    // Positive control for the two omission checks above: an empty payload would
    // pass them vacuously, so the PUBLIC channel must be present once it has an
    // unread message.
    await O.api('POST', `/channels/${CPUB}/messages`, { content: `enc:v2:UNREAD-CONTROL-${RUN}` });
    r = await M.api('GET', `/servers/${S.id}/unread`); check('control: unread counts DO carry the public channel', r.status === 200 && JSON.stringify(r.json).includes(String(CPUB)), r.text.slice(0, 200));
    r = await X.api('GET', `/servers/${S.id}/channels`); check('non-member: channel list refused', refused(r), r.status);
    r = await X.api('GET', `/servers/${S.id}/members`); check('non-member: member list refused', refused(r), r.status);
    r = await X.api('GET', `/servers/${S.id}/voice-users`); check('non-member: voice-users refused', refused(r), r.status);

    check('integrity: secret message still present and unedited by attackers', row(`SELECT content FROM messages WHERE id='${MSG1}'`) === 'enc:v2:SECRET-MSG-1-EDITED');
    check('integrity: secret task untouched', row(`SELECT description FROM channel_tasks WHERE id=${TASK1}`) === 'enc:v2:SECRET-TASK-1');
    check('integrity: pin still present exactly once', row(`SELECT count(*) FROM pinned_messages WHERE message_id='${MSG1}'`) === '1');

    // Live stream: the member (joined to public, denied on secret) sees only the public post.
    mws.frames.length = 0;
    await O.api('POST', `/channels/${CPUB}/messages`, { content: 'enc:v2:PUBLIC-LIVE' });
    await O.api('POST', `/channels/${CSEC}/messages`, { content: 'enc:v2:SECRET-LIVE' });
    const gotPub = await mws.waitFor(f => f.type === 'ChatMessage' && String(f.payload?.content).includes('PUBLIC-LIVE'), 2000);
    await sleep(700);
    check('control: member receives the public channel live message', !!gotPub, JSON.stringify(mws.frames.map(f => f.type)));
    check('denied member receives NO live frame carrying the secret message', !mws.frames.some(f => JSON.stringify(f).includes('SECRET-LIVE')), JSON.stringify(mws.frames).slice(0, 300));
    check('denied member receives NO MessageNotification for the secret channel', !mws.frames.some(f => f.type === 'MessageNotification' && f.payload?.channel_id === CSEC), JSON.stringify(mws.frames.filter(f => f.type === 'MessageNotification')).slice(0, 300));

    const ows = await ws(O); ows.send('JoinRoom', { room_id: `channel_${CSEC}` }); await ows.waitFor(f => f.type === 'RoomJoined');
    const xws = await ws(X); xws.send('ChatMessage', { room_id: `channel_${CSEC}`, content: `enc:v2:WS-INTRUDER-${RUN}` });
    const xerr = await xws.waitFor(f => f.type === 'Error', 1500);
    await sleep(500);
    check('non-member WS ChatMessage into secret room is refused with an Error frame', !!xerr, JSON.stringify(xws.frames).slice(0, 200));
    check('...and the owner socket in that room received nothing from it', !ows.frames.some(f => JSON.stringify(f).includes(`WS-INTRUDER-${RUN}`)), JSON.stringify(ows.frames).slice(0, 200));
    check('...and nothing was persisted', row(`SELECT count(*) FROM messages WHERE content LIKE '%WS-INTRUDER-${RUN}%'`) === '0');
    mws.send('ChatMessage', { room_id: `channel_${CSEC}`, content: `enc:v2:WS-DENIED-${RUN}` }); await sleep(500);
    check('denied member WS ChatMessage into secret room reaches nobody', !ows.frames.some(f => JSON.stringify(f).includes(`WS-DENIED-${RUN}`)) && row(`SELECT count(*) FROM messages WHERE content LIKE '%WS-DENIED-${RUN}%'`) === '0');
    xws.frames.length = 0; ows.frames.length = 0;
    xws.send('Typing', { room_id: `channel_${CSEC}` }); await sleep(400);
    check('non-member Typing into secret room is not relayed to the owner', !ows.frames.some(f => f.type === 'Typing' || f.type === 'UserTyping'), JSON.stringify(ows.frames).slice(0, 200));

    // DM third party. A, B and T share a server: since the C07 fix a DM to a
    // stranger is refused (see dmRelationship), so the fixture must give them
    // the relationship an ordinary correspondent has.
    const A = mkUser('dma'), B = mkUser('dmb'), T = mkUser('dmt');
    const SD = await mkServer(A, `dm_${RUN}`);
    await joinViaInvite(SD, B); await joinViaInvite(SD, T);
    const conv = await A.api('POST', '/dms', { user_id: B.id });
    check('fixture: A opens a DM with B', conv.status === 200 && !!conv.json?.id, conv.status + ' ' + conv.text.slice(0, 100));
    const CONV = conv.json.id;
    const dm1 = await A.api('POST', `/dms/${CONV}/messages`, { content: 'enc:v2:DM-SECRET-1' });
    check('fixture: A sends a DM', dm1.status === 200 && !!dm1.json?.id, dm1.status + ' ' + dm1.text.slice(0, 100));
    const DM1 = dm1.json.id;
    const dmr = await B.api('POST', `/messages/${DM1}/reactions`, { emoji: '👍' });
    check('control: B reacts to the DM message', dmr.status === 200 || dmr.status === 201, dmr.status + ' ' + dmr.text.slice(0, 80));
    r = await B.api('GET', `/dms/${CONV}/messages`); check('control: B reads the DM', r.status === 200 && r.text.includes('DM-SECRET-1'), r.status);
    // T has a conversation with A: "someone A talks to" is the closest legitimate position.
    const convTA = await T.api('POST', '/dms', { user_id: A.id }); check('fixture: T opens a DM with A', convTA.status === 200, convTA.status + ' ' + convTA.text.slice(0, 80));
    r = await T.api('GET', `/dms/${CONV}/messages`); check('third party: GET A-B messages refused', refused(r) && noLeak(r, 'DM-SECRET'), r.status);
    r = await T.api('POST', `/dms/${CONV}/messages`, { content: 'enc:v2:T-INTRUDER' }); check('third party: POST into A-B refused', refused(r), r.status);
    r = await T.api('GET', `/messages/${DM1}/reactions`); check('third party: GET reactions on the DM message refused', refused(r), r.status + ' ' + r.text.slice(0, 80));
    r = await T.api('POST', `/messages/${DM1}/reactions`, { emoji: '🔥' }); check('third party: POST reaction on the DM message refused', refused(r), r.status);
    r = await T.api('PATCH', `/dms/${CONV}/sign-attest`, { mac: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5QUJDREVGR0g=' }); check('third party: sign-attest on A-B refused', refused(r) || r.status === 400, r.status + ' ' + r.text.slice(0, 80));
    r = await T.api('GET', '/dms'); check('third party: /dms does not list A-B', r.status === 200 && !JSON.stringify(r.json).includes(CONV), r.text.slice(0, 200));
    check('integrity: A-B conversation has exactly one message', row(`SELECT count(*) FROM dm_messages WHERE conversation_id='${CONV}'`) === '1');
    const tws = await ws(T); tws.send('DirectMessage', { to_user_id: B.id, content: `enc:v2:T-TO-B-${RUN}` }); await sleep(600);
    check('third party WS DM to B lands in a T-B conversation, never A-B', row(`SELECT count(*) FROM dm_messages WHERE conversation_id='${CONV}'`) === '1' && row(`SELECT count(*) FROM dm_messages WHERE content='enc:v2:T-TO-B-${RUN}'`) === '1');

    mws.close(); ows.close(); xws.close(); tws.close();
}

// ---------------------------------------------------------------------------
// Eviction matrix: for each access-reducing mutation, a member sitting in the
// live room with keys must be evicted (RoomLeft), see no later frame, be refused
// on REST, and (on membership loss) lose their key rows. Held on 0.9.3; the
// sweep is being changed for the CONNECT fix, so it stays under test here.
// ---------------------------------------------------------------------------
async function evictionMatrix() {
    section('Eviction matrix: every access-reducing mutation evicts the live room member');
    async function scenario(name, setup, mutate, { expectKeyRowsGone }) {
        const O = mkUser('eo'), M = mkUser('em'); const S = await mkServer(O); const C = await mkChannel(S, 'c'); await joinViaInvite(S, M);
        const ctx = await setup({ O, M, S, C });
        psql(`INSERT INTO channel_keys (channel_id, epoch, recipient_id, wrapped_key, sender_public_key, member_generation, sender_user_id) VALUES (${C}, 1, ${M.id}, 'W', 'pk', 0, ${O.id})`);
        let r = await M.api('GET', `/channels/${C}/messages`); check(`${name}: control - member reads before`, r.status === 200, r.status + ' ' + r.text.slice(0, 80));
        const w = await ws(M); w.send('JoinRoom', { room_id: `channel_${C}` }); check(`${name}: control - member joined room`, !!(await w.waitFor(f => f.type === 'RoomJoined')));
        const gen0 = row(`SELECT member_generation FROM servers WHERE id='${S.id}'`);
        w.frames.length = 0;
        const mr = await mutate({ O, M, S, C, ...ctx }); check(`${name}: mutation accepted`, mr.status === 200 || mr.status === 204, mr.status + ' ' + mr.text.slice(0, 100));
        const left = await w.waitFor(f => f.type === 'RoomLeft' && f.payload?.room_id === `channel_${C}`, 2500);
        check(`${name}: member evicted from live room (RoomLeft)`, !!left, JSON.stringify(w.frames.map(f => f.type)));
        await O.api('POST', `/channels/${C}/messages`, { content: `enc:v2:AFTER-${name}` }); await sleep(700);
        check(`${name}: no live frame after mutation`, !w.frames.some(f => JSON.stringify(f).includes(`AFTER-${name}`)), JSON.stringify(w.frames).slice(0, 200));
        r = await M.api('GET', `/channels/${C}/messages`); check(`${name}: REST read refused after`, refused(r), r.status);
        r = await M.api('GET', `/channels/${C}/keys`); check(`${name}: key fetch refused after`, refused(r), r.status);
        check(`${name}: member_generation bumped`, row(`SELECT member_generation FROM servers WHERE id='${S.id}'`) !== gen0);
        if (expectKeyRowsGone) check(`${name}: member's channel_keys rows deleted`, row(`SELECT count(*) FROM channel_keys WHERE channel_id=${C} AND recipient_id=${M.id}`) === '0');
        w.send('JoinRoom', { room_id: `channel_${C}` }); await sleep(500);
        check(`${name}: re-JoinRoom refused`, !w.frames.some(f => f.type === 'RoomJoined'), JSON.stringify(w.frames.filter(f => f.type === 'RoomJoined' || f.type === 'Error')).slice(0, 200));
        w.close();
    }
    const none = async () => ({});
    await scenario('kick', none, ({ O, S, M }) => O.api('POST', `/servers/${S.id}/kick/${M.id}`, { reason: 'probe' }), { expectKeyRowsGone: true });
    await scenario('ban', none, ({ O, S, M }) => O.api('POST', `/servers/${S.id}/bans/${M.id}`, { reason: 'probe' }), { expectKeyRowsGone: true });
    await scenario('leave', none, ({ M, S }) => M.api('POST', `/servers/${S.id}/leave`), { expectKeyRowsGone: true });
    // VIEW held ONLY through a role's channel overwrite (@everyone denied).
    const roleSetup = async ({ O, M, S, C }) => {
        const role = await O.api('POST', `/servers/${S.id}/roles`, { name: 'viewers', permissions: 0 });
        const rid = role.json?.id; if (!rid) throw new Error('role create failed ' + role.status + ' ' + role.text);
        await denyView(S, C);
        const ow = await O.api('PUT', `/channels/${C}/overwrites/${rid}`, { allow: BITS.VIEW_CHANNEL, deny: 0 }); if (ow.status !== 200) throw new Error('allow overwrite failed ' + ow.text);
        const as = await O.api('PUT', `/servers/${S.id}/members/${M.id}/roles/${rid}`); if (as.status !== 200 && as.status !== 204) throw new Error('assign failed ' + as.status + ' ' + as.text);
        return { rid };
    };
    await scenario('remove_role', roleSetup, ({ O, S, M, rid }) => O.api('DELETE', `/servers/${S.id}/members/${M.id}/roles/${rid}`), { expectKeyRowsGone: false });
    await scenario('delete_role', roleSetup, ({ O, S, rid }) => O.api('DELETE', `/servers/${S.id}/roles/${rid}`), { expectKeyRowsGone: false });
    await scenario('delete_allow_overwrite', roleSetup, ({ O, C, rid }) => O.api('DELETE', `/channels/${C}/overwrites/${rid}`), { expectKeyRowsGone: false });
    await scenario('put_view_deny', none, ({ O, S, C }) => O.api('PUT', `/channels/${C}/overwrites/${S.everyoneRoleId}`, { allow: 0, deny: BITS.VIEW_CHANNEL }), { expectKeyRowsGone: false });
}

// ---------------------------------------------------------------------------
// F1 (C01): GET /servers/:sid/voice-users matched a channel's bare NAME as a
// room id, so a channel named `voice_<N>` in a self-owned server unmasked the
// live roster of channel N on any server. On 0.9.3 the attacker's list carries
// V1 and V2 under voice_<C_V>.
// ---------------------------------------------------------------------------
async function voiceUsersNameAlias() {
    section('F1: voice-users no longer matches channel NAMES as room ids (C01)');
    const ownerV = mkUser('vown'), V1 = mkUser('v1'), V2 = mkUser('v2'), A = mkUser('vatk');
    const Sv = await mkServer(ownerV);
    const cV = await mkChannel(Sv, `real_voice_${RUN}`, 1);
    const voiceRoom = `voice_${cV}`;
    await joinViaInvite(Sv, V1); await joinViaInvite(Sv, V2);
    const w1 = await ws(V1), w2 = await ws(V2);
    w1.send('JoinRoom', { room_id: voiceRoom }); w2.send('JoinRoom', { room_id: voiceRoom });
    const j1 = await w1.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === voiceRoom, 3000);
    const j2 = await w2.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === voiceRoom, 3000);
    check('fixture: V1 and V2 joined the voice room', !!j1 && !!j2, JSON.stringify(w1.frames.map(f => f.type)));
    await sleep(400);

    const pc = await ownerV.api('GET', `/servers/${Sv.id}/voice-users`);
    const pcUsers = pc.json?.voice_users || [];
    check('control: an entitled member sees V1 and V2 in voice_<C_V>', pc.status === 200
        && pcUsers.some(u => u.user_id === V1.id && u.room_id === voiceRoom)
        && pcUsers.some(u => u.user_id === V2.id && u.room_id === voiceRoom), pc.status + ' ' + JSON.stringify(pcUsers));

    check('fixture: attacker is NOT a member of the victim server', row(`SELECT count(*) FROM server_members WHERE server_id='${Sv.id}' AND user_id=${A.id}`) === '0');
    const Sa = await mkServer(A, `alias_${RUN}`);
    const alias = await A.api('POST', `/servers/${Sa.id}/channels`, { name: voiceRoom, channel_type: 1 });
    check('fixture: attacker names a channel in their own server literally "voice_<C_V>"', alias.status === 200 && !!alias.json?.id, alias.text);

    const leak = await A.api('GET', `/servers/${Sa.id}/voice-users`);
    const leakUsers = leak.json?.voice_users || [];
    check('attacker\'s voice-users answers 200 for their own server', leak.status === 200, leak.text);
    check('the alias channel unmasks NOTHING: no entry for room voice_<C_V>', !leakUsers.some(u => u.room_id === voiceRoom), JSON.stringify(leakUsers));
    check('...and neither victim appears under any room', !leakUsers.some(u => u.user_id === V1.id || u.user_id === V2.id), JSON.stringify(leakUsers));
    const direct = await A.api('GET', `/servers/${Sv.id}/voice-users`);
    check('non-member asking the victim server directly is refused', direct.status === 403, direct.status + ' ' + direct.text);
    w1.close(); w2.close();
}

// ---------------------------------------------------------------------------
// F2 (C09): voice-move resolved the target's voice room GLOBALLY before checking
// server scope, so from a self-owned server "403 on another server" vs "409 not
// in a voice channel" told whether ANY account was in a call. Now every target
// not in THIS server's voice gets the same 409, non-member or member elsewhere.
// ---------------------------------------------------------------------------
async function voiceMoveOracle() {
    section('F2: voice-move is not a cross-server presence oracle (C09)');
    const A = mkUser('mvatk'), V = mkUser('mvvic'), MA = mkUser('mvmem');
    const SA = await mkServer(A); const cA = await mkChannel(SA, 'vcA', 1);
    const SV = await mkServer(V); const cV = await mkChannel(SV, 'vcV', 1);
    await joinViaInvite(SA, MA);

    // Control: the owner disconnects an in-server member from THIS server's voice.
    const wMA = await ws(MA); wMA.send('JoinRoom', { room_id: `voice_${cA}` });
    check('control fixture: member MA joined SA voice', !!(await wMA.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === `voice_${cA}`, 2000)));
    const ctl = await A.api('POST', `/servers/${SA.id}/voice-move/${MA.id}`, { channel_id: null });
    check('control: owner disconnects an in-server member in SA voice -> 200', ctl.status === 200, ctl.status + ' ' + ctl.text);
    wMA.close(); await sleep(400);

    // Victim in voice on a server A is not a member of.
    const wV = await ws(V); wV.send('JoinRoom', { room_id: `voice_${cV}` });
    check('fixture: victim V joined SV voice', !!(await wV.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === `voice_${cV}`, 2000)));
    const inVoice = await A.api('POST', `/servers/${SA.id}/voice-move/${V.id}`, { channel_id: null });
    check('non-member target IN a call elsewhere -> 409 "not in a voice channel"', inVoice.status === 409 && /not in a voice channel/i.test(inVoice.text), inVoice.status + ' ' + inVoice.text);
    wV.close(); await sleep(600);
    const notVoice = await A.api('POST', `/servers/${SA.id}/voice-move/${V.id}`, { channel_id: null });
    check('non-member target NOT in a call -> 409 "not in a voice channel"', notVoice.status === 409 && /not in a voice channel/i.test(notVoice.text), notVoice.status + ' ' + notVoice.text);
    check('ORACLE CLOSED: in-call and not-in-call answers are byte-identical', inVoice.status === notVoice.status && inVoice.text === notVoice.text, `${inVoice.status} ${inVoice.text} | ${notVoice.status} ${notVoice.text}`);

    // A member of SA who is in a call on ANOTHER server is that server's presence.
    await joinViaInvite(SV, MA);
    const wMA2 = await ws(MA); wMA2.send('JoinRoom', { room_id: `voice_${cV}` });
    check('fixture: member MA joined SV voice', !!(await wMA2.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === `voice_${cV}`, 2000)));
    const elsewhere = await A.api('POST', `/servers/${SA.id}/voice-move/${MA.id}`, { channel_id: null });
    check('member target in a call on another server -> the same 409', elsewhere.status === 409 && elsewhere.text === notVoice.text, elsewhere.status + ' ' + elsewhere.text);
    check('...and was NOT disconnected from that call', !wMA2.frames.some(f => f.type === 'RoomLeft'), JSON.stringify(wMA2.frames.map(f => f.type)));
    const ghost = await A.api('POST', `/servers/${SA.id}/voice-move/999999`, { channel_id: null });
    check('nonexistent id -> the same 409', ghost.status === 409 && ghost.text === notVoice.text, ghost.status + ' ' + ghost.text);
    wMA2.close();
}

// ---------------------------------------------------------------------------
// F3 (r2-1-L2G1-03): the eviction sweep re-checked VIEW only while the voice
// join gate requires VIEW+CONNECT, so a CONNECT deny forbade future joins and
// left the present occupant in the call. On 0.9.3 the CONNECT-deny phase gets
// ChannelPermsChanged and no RoomLeft.
// ---------------------------------------------------------------------------
async function connectDenyEvicts() {
    section('F3: a CONNECT deny evicts a voice-room occupant (r2-1-L2G1-03)');
    const O = mkUser('cdo'), A = mkUser('cda'), V = mkUser('cdv');
    const S = await mkServer(O);
    const C = await mkChannel(S, `voice_${RUN}`, 1);
    const rr = await O.api('POST', `/servers/${S.id}/roles`, { name: `att_${RUN}`.slice(0, 30), permissions: BITS.VIEW_CHANNEL | BITS.CONNECT | BITS.SPEAK | BITS.SEND_MESSAGES });
    check('fixture: role R created', rr.status === 200 && !!rr.json?.id, rr.status + ' ' + rr.text);
    const R = rr.json.id;
    await joinViaInvite(S, A); await joinViaInvite(S, V);
    const asg = await O.api('PUT', `/servers/${S.id}/members/${A.id}/roles/${R}`);
    check('fixture: R assigned to A', asg.status === 200, asg.status + ' ' + asg.text);
    const voiceRoom = `voice_${C}`;

    const joinBoth = async () => {
        const vs = await ws(V); vs.send('JoinRoom', { room_id: voiceRoom });
        const vj = await vs.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === voiceRoom);
        const as = await ws(A); as.send('JoinRoom', { room_id: voiceRoom });
        const aj = await as.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === voiceRoom);
        const saw = await vs.waitFor(f => f.type === 'UserJoined' && f.payload?.room_id === voiceRoom && f.payload?.user?.id === A.id);
        check('fixture: V and A share the voice room (V sees UserJoined{A})', !!vj && !!aj && !!saw, JSON.stringify(vs.frames).slice(0, 300));
        return { vs, as };
    };

    // Positive control: the VIEW deny (the designed revocation) evicts.
    let { vs, as } = await joinBoth();
    let d = await O.api('PUT', `/channels/${C}/overwrites/${R}`, { allow: 0, deny: BITS.VIEW_CHANNEL });
    check('control: owner denies VIEW on R', d.status === 200, d.status + ' ' + d.text);
    check('control: A receives RoomLeft on the VIEW deny', !!(await as.waitFor(f => f.type === 'RoomLeft' && f.payload?.room_id === voiceRoom, 3000)), JSON.stringify(as.frames.map(f => f.type)));
    check('control: V receives UserLeft{A} on the VIEW deny', !!(await vs.waitFor(f => f.type === 'UserLeft' && f.payload?.room_id === voiceRoom && f.payload?.user_id === A.id, 3000)), JSON.stringify(vs.frames.map(f => f.type)));
    vs.close(); as.close();
    const clr = await O.api('DELETE', `/channels/${C}/overwrites/${R}`);
    check('reset: R overwrite cleared', clr.status === 200 || clr.status === 204, clr.status + ' ' + clr.text);
    await sleep(300);

    // The fix: CONNECT denied, VIEW kept.
    ({ vs, as } = await joinBoth());
    d = await O.api('PUT', `/channels/${C}/overwrites/${R}`, { allow: BITS.VIEW_CHANNEL, deny: BITS.CONNECT });
    check('owner denies CONNECT (VIEW allowed) on R', d.status === 200, d.status + ' ' + d.text);
    check('A receives RoomLeft on the CONNECT deny (evicted from the call)', !!(await as.waitFor(f => f.type === 'RoomLeft' && f.payload?.room_id === voiceRoom, 3000)), JSON.stringify(as.frames.map(f => f.type)));
    check('V receives UserLeft{A} on the CONNECT deny', !!(await vs.waitFor(f => f.type === 'UserLeft' && f.payload?.room_id === voiceRoom && f.payload?.user_id === A.id, 3000)), JSON.stringify(vs.frames.map(f => f.type)));
    // Discriminators: the deny is CONNECT-only, not a VIEW deny in disguise.
    const fresh = await ws(A); fresh.send('JoinRoom', { room_id: voiceRoom }); await fresh.settle();
    check('discriminator: a fresh voice JoinRoom is refused (CONNECT gone)', !fresh.frames.some(f => f.type === 'RoomJoined' && f.payload?.room_id === voiceRoom), JSON.stringify(fresh.frames).slice(0, 200));
    const text = await ws(A); text.send('JoinRoom', { room_id: `channel_${C}` });
    check('discriminator: the text room of the same channel still joins (VIEW retained)', !!(await text.waitFor(f => f.type === 'RoomJoined' && f.payload?.room_id === `channel_${C}`)), JSON.stringify(text.frames).slice(0, 200));
    vs.close(); as.close(); fresh.close(); text.close();
}

// ---------------------------------------------------------------------------
// F5 (C08): parked MessageNotification frames were drained into the next
// delivery socket with no re-authorization, telling a kicked or VIEW-denied
// member which channel got a message, when and from whom. On 0.9.3 both stale
// frames below arrive.
// ---------------------------------------------------------------------------
async function parkedNotifications() {
    section('F5: parked notifications are re-authorized at drain (C08)');
    const parkedFor = async (member, channelId) => {
        const d = await ws(member, { delivery: true }); await sleep(1200);
        const hits = d.frames.filter(f => f.type === 'MessageNotification' && f.payload?.channel_id === channelId);
        d.close(); return hits;
    };
    // Control: the queue itself works for an entitled offline member.
    const O1 = mkUser('pqo'), M1 = mkUser('pqm'); const S1 = await mkServer(O1); const C1 = await mkChannel(S1, 'open'); await joinViaInvite(S1, M1);
    await O1.api('POST', `/channels/${C1}/messages`, { content: 'enc:v2:PARKED-OK' });
    check('control: an entitled offline member receives the parked MessageNotification on a delivery socket', (await parkedFor(M1, C1)).length === 1);
    // Parked while entitled, then VIEW denied.
    const O2 = mkUser('pdo'), M2 = mkUser('pdm'); const S2 = await mkServer(O2); const C2 = await mkChannel(S2, 'secret'); await joinViaInvite(S2, M2);
    await O2.api('POST', `/channels/${C2}/messages`, { content: 'enc:v2:PARKED-SECRET' });
    await denyView(S2, C2); await sleep(300);
    const stale = await parkedFor(M2, C2);
    check('a MessageNotification parked before a VIEW deny is NOT delivered afterwards', stale.length === 0, 'stale frames: ' + JSON.stringify(stale).slice(0, 300));
    // Parked while a member, then KICKED.
    const O3 = mkUser('pko'), M3 = mkUser('pkm'); const S3 = await mkServer(O3); const C3 = await mkChannel(S3, 'k'); await joinViaInvite(S3, M3);
    await O3.api('POST', `/channels/${C3}/messages`, { content: 'enc:v2:PARKED-KICK' });
    const kick = await O3.api('POST', `/servers/${S3.id}/kick/${M3.id}`, { reason: 'probe' });
    check('fixture: owner kicks the offline member', kick.status === 200 && row(`SELECT count(*) FROM server_members WHERE server_id='${S3.id}' AND user_id=${M3.id}`) === '0', kick.status + ' ' + kick.text.slice(0, 80));
    const stale3 = await parkedFor(M3, C3);
    check('a MessageNotification parked before a KICK is NOT delivered afterwards', stale3.length === 0, 'stale frames: ' + JSON.stringify(stale3).slice(0, 300));
}

// ---------------------------------------------------------------------------
// F6 (r2-6-L6-01) + F13 (C14), one clip fixture: the presence-log window makes a
// proposal cost ~8 s of wall clock, so both findings ride the same clip.
//   F13: approvers[].online was state.sessions.contains_key — a delivery-only
//        socket or show_online_status=false still read "online" while
//        /servers/:id/members said offline. On 0.9.3 H and D read online:true.
//   F6:  GET /clips/:id, /clips/pending and POST vote re-checked only the frozen
//        voter snapshot, so a kicked non-member kept reading the clip and their
//        vote still counted. On 0.9.3 all three succeed for the kicked A.
// ---------------------------------------------------------------------------
async function clipsAfterKickAndApproverOnline() {
    section('F6 + F13: clip routes 404 after a kick; approver online flag honours visibility (r2-6-L6-01, C14)');
    const O = mkUser('clo'), P = mkUser('clp'), A = mkUser('cla'), B = mkUser('clb'), H = mkUser('clh'), D = mkUser('cld'), Z = mkUser('clz');
    const S = await mkServer(O);
    const T = await mkChannel(S, 'clips-text', 0);
    const C = await mkChannel(S, 'general-voice', 1);
    const setr = await O.api('PATCH', `/servers/${S.id}/settings`, { clips_enabled: true, clip_channel_id: T });
    check('fixture: clips enabled and pinned to the text channel', setr.status === 200, setr.status + ' ' + setr.text);
    for (const m of [P, A, B, H, D, Z]) await joinViaInvite(S, m);
    // H hides presence; D is reachable only through a delivery socket.
    psql(`UPDATE users SET show_online_status = false WHERE id = ${H.id}`);
    psql(`UPDATE users SET show_online_status = true WHERE id IN (${B.id}, ${D.id})`);

    const wP = await ws(P); wP.send('JoinRoom', { room_id: `voice_${C}` });
    const wA = await ws(A); wA.send('JoinRoom', { room_id: `voice_${C}` });
    const wB = await ws(B); wB.send('JoinRoom', { room_id: `voice_${C}` });
    check('fixture: proposer P joined the voice room', !!(await wP.waitFor(f => f.type === 'RoomJoined', 3000)));
    check('fixture: approver A joined the voice room', !!(await wA.waitFor(f => f.type === 'RoomJoined', 3000)));
    const wH = await ws(H);                       // visible socket, presence hidden
    const wD = await ws(D, { delivery: true });   // delivery-only
    await sleep(400);

    // Ground truth from the roster the flag is meant to agree with.
    const members = await P.api('GET', `/servers/${S.id}/members`);
    const online = (uid) => (members.json || []).find(m => m.id === uid || m.user_id === uid)?.is_online;
    check('fixture: /members says B online, H offline (flag), D offline (delivery-only)', members.status === 200 && online(B.id) === true && online(H.id) === false && online(D.id) === false, `B=${online(B.id)} H=${online(H.id)} D=${online(D.id)}`);

    // The proposer must have been present longer than duration + PAD (7 s) or
    // propose answers 409 window_predates_log.
    await sleep(8500);
    const prop = await P.api('POST', `/channels/${C}/clips`, { target_channel_id: T, duration_ms: 5000, ended_ago_ms: 0, declared_participants: [A.id, B.id, H.id, D.id] });
    check('fixture: propose_clip -> 201', prop.status === 201, prop.status + ' ' + prop.text);
    const clipId = prop.json?.clip_id;
    const approver = (resp, uid) => (resp.json?.approvers || []).find(a => a.id === uid);
    check('fixture: voter set contains A, B, H and D', [A, B, H, D].every(u => !!approver(prop, u.id)), JSON.stringify(prop.json?.approvers));

    // F13
    check('control: approvers[B].online is true (visible socket, flag on)', approver(prop, B.id)?.online === true, JSON.stringify(approver(prop, B.id)));
    check('approvers[H].online is false while show_online_status is off', approver(prop, H.id)?.online === false, JSON.stringify(approver(prop, H.id)));
    check('approvers[D].online is false on a delivery-only socket', approver(prop, D.id)?.online === false, JSON.stringify(approver(prop, D.id)));
    const g0 = await P.api('GET', `/clips/${clipId}`);
    check('GET /clips/:id agrees: H and D offline, B online', g0.status === 200 && approver(g0, H.id)?.online === false && approver(g0, D.id)?.online === false && approver(g0, B.id)?.online === true, g0.status + ' ' + JSON.stringify(g0.json?.approvers));

    // F6 controls, pre-kick.
    const bPending = await B.api('GET', '/clips/pending');
    check('control: entitled approver B sees the clip in /clips/pending', bPending.status === 200 && (bPending.json?.proposals || []).some(p => p.clip_id === clipId), bPending.status + ' ' + bPending.text.slice(0, 200));
    const bGet = await B.api('GET', `/clips/${clipId}`);
    check('control: entitled approver B reads GET /clips/:id', bGet.status === 200 && bGet.json?.voice_channel_name === 'general-voice', bGet.status + ' ' + bGet.text.slice(0, 200));
    const aPre = await A.api('GET', `/clips/${clipId}`);
    check('control: A (still a member) reads GET /clips/:id', aPre.status === 200, aPre.status + ' ' + aPre.text.slice(0, 120));
    const zGet = await Z.api('GET', `/clips/${clipId}`);
    check('control: a member who is not a voter gets 404 (the gate exists)', zGet.status === 404, zGet.status + ' ' + zGet.text);

    const kick = await O.api('POST', `/servers/${S.id}/kick/${A.id}`, { reason: 'probe' });
    check('fixture: owner kicks approver A', kick.status === 200 && row(`SELECT count(*) FROM server_members WHERE server_id='${S.id}' AND user_id=${A.id}`) === '0', kick.status + ' ' + kick.text);
    const aGet = await A.api('GET', `/clips/${clipId}`);
    check('kicked A: GET /clips/:id -> 404', aGet.status === 404 && noLeak(aGet, 'general-voice'), aGet.status + ' ' + aGet.text.slice(0, 200));
    const aPending = await A.api('GET', '/clips/pending');
    check('kicked A: /clips/pending no longer lists the clip', !(aPending.status === 200 && (aPending.json?.proposals || []).some(p => p.clip_id === clipId)), aPending.status + ' ' + aPending.text.slice(0, 200));
    const aVote = await A.api('POST', `/clips/${clipId}/vote`, { approve: true });
    check('kicked A: POST /clips/:id/vote -> 404 (vote not counted)', aVote.status === 404, aVote.status + ' ' + aVote.text);
    const bVote = await B.api('POST', `/clips/${clipId}/vote`, { approve: true });
    check('control: entitled approver B still votes -> 200', bVote.status === 200, bVote.status + ' ' + bVote.text);
    const after = await B.api('GET', `/clips/${clipId}`);
    check('...and A\'s refused vote did not move approved_count', after.status === 200 && after.json?.approved_count === 1, JSON.stringify(after.json));
    wP.close(); wA.close(); wB.close(); wH.close(); wD.close();
}

// ---------------------------------------------------------------------------
// F8 (r2-2-L2-01/02): assign_role/remove_role reason about SERVER bits, but
// VIEW is decided by per-channel overwrites a zero-bit role can carry. A
// MANAGE_ROLES holder could hand THEMSELVES the role that allows a hidden
// channel, or strip their own deny role. On 0.9.3 both self-target calls 200.
// ---------------------------------------------------------------------------
async function selfRoleChange() {
    section('F8: a non-privileged MANAGE_ROLES holder cannot change their OWN roles (r2-2-L2-01/02)');
    const O = mkUser('rlo'), A = mkUser('rla'), L = mkUser('rll');
    const S = await mkServer(O);
    const HID = await mkChannel(S, 'hidden');     // @everyone denied, Secret allows
    const VIS = await mkChannel(S, 'visible');    // @everyone allowed, Restricted denies
    await joinViaInvite(S, A); await joinViaInvite(S, L);
    const mkRole = (name, perms, pos) => parseInt(row(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ('${S.id}', '${name}_${RUN}', '#99aab5', ${perms}, ${pos}, false) RETURNING id`), 10);
    const MOD = mkRole('Mod', BITS.MANAGE_ROLES, 5);
    const SEC = mkRole('Secret', 0, 2);
    const RES = mkRole('Restricted', 0, 2);
    await denyView(S, HID);
    let r = await O.api('PUT', `/channels/${HID}/overwrites/${SEC}`, { allow: BITS.VIEW_CHANNEL, deny: 0 });
    check('fixture: Secret ALLOWS VIEW on the hidden channel', r.status === 200, r.status + ' ' + r.text);
    r = await O.api('PUT', `/channels/${VIS}/overwrites/${RES}`, { allow: 0, deny: BITS.VIEW_CHANNEL });
    check('fixture: Restricted DENIES VIEW on the visible channel', r.status === 200, r.status + ' ' + r.text);
    psql(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('${S.id}', ${A.id}, ${MOD}), ('${S.id}', ${A.id}, ${RES})`);
    await O.api('POST', `/channels/${HID}/messages`, { content: `enc:v2:HIDDEN_${RUN}` });
    await O.api('POST', `/channels/${VIS}/messages`, { content: `enc:v2:VISIBLE_${RUN}` });

    r = await A.api('GET', `/channels/${HID}/messages`); check('baseline: A cannot read the hidden channel (404)', r.status === 404, r.status);
    r = await A.api('GET', `/channels/${VIS}/messages`); check('baseline: A cannot read the Restricted-denied channel (404)', r.status === 404, r.status);

    // Self-assign the allow role.
    r = await A.api('PUT', `/servers/${S.id}/members/${A.id}/roles/${SEC}`);
    check('A self-assigning Secret -> 403 "Cannot change your own roles"', r.status === 403 && /own roles/i.test(r.text), r.status + ' ' + r.text);
    check('...no member_roles row was written', row(`SELECT count(*) FROM member_roles WHERE server_id='${S.id}' AND user_id=${A.id} AND role_id=${SEC}`) === '0');
    r = await A.api('GET', `/channels/${HID}/messages`); check('...and the hidden channel stays 404 for A', r.status === 404, r.status);
    // Self-remove the deny role.
    r = await A.api('DELETE', `/servers/${S.id}/members/${A.id}/roles/${RES}`);
    check('A self-removing Restricted -> 403 "Cannot change your own roles"', r.status === 403 && /own roles/i.test(r.text), r.status + ' ' + r.text);
    // The third route to the same overwrite: deleting a role you HOLD cascades
    // its channel overwrites away (migration 033), so it is refused the same
    // way for a non-administrator. Restricted sits below A's highest role, so
    // only the self-held guard can be what refuses it.
    r = await A.api('DELETE', `/servers/${S.id}/roles/${RES}`);
    check('A deleting Restricted (a role A holds) -> 403 "Cannot change your own roles"', r.status === 403 && /own roles/i.test(r.text), r.status + ' ' + r.text);
    check('...and the role still exists', row(`SELECT count(*) FROM server_roles WHERE id=${RES}`) === '1');
    check('...the Restricted row is still there', row(`SELECT count(*) FROM member_roles WHERE server_id='${S.id}' AND user_id=${A.id} AND role_id=${RES}`) === '1');
    r = await A.api('GET', `/channels/${VIS}/messages`); check('...and the denied channel stays 404 for A', r.status === 404, r.status);

    // Controls: the same actor, the same roles, ANOTHER member as the target.
    r = await A.api('PUT', `/servers/${S.id}/members/${L.id}/roles/${SEC}`);
    check('control: A assigns Secret to L -> 200', r.status === 200, r.status + ' ' + r.text);
    r = await L.api('GET', `/channels/${HID}/messages`);
    check('control: L now reads the hidden channel', r.status === 200 && r.text.includes(`HIDDEN_${RUN}`), r.status + ' ' + r.text.slice(0, 100));
    r = await A.api('PUT', `/servers/${S.id}/members/${L.id}/roles/${RES}`);
    check('control: A assigns Restricted to L -> 200', r.status === 200, r.status + ' ' + r.text);
    r = await L.api('GET', `/channels/${VIS}/messages`); check('control: L is now denied the visible channel (404)', r.status === 404, r.status);
    r = await A.api('DELETE', `/servers/${S.id}/members/${L.id}/roles/${RES}`);
    check('control: A removes Restricted from L -> 200', r.status === 200, r.status + ' ' + r.text);
    r = await L.api('GET', `/channels/${VIS}/messages`); check('control: L reads the visible channel again', r.status === 200 && r.text.includes(`VISIBLE_${RUN}`), r.status);
    // A privileged actor (the owner) is exempt: self-target is refused BELOW owner/administrator.
    r = await O.api('PUT', `/servers/${S.id}/members/${O.id}/roles/${SEC}`);
    check('control: the owner may still assign a role to themselves -> 200', r.status === 200, r.status + ' ' + r.text);
}

// ---------------------------------------------------------------------------
// F10 (C02): POST /channels/:id/read checked server membership only, so a
// VIEW-denied member got 200 for a hidden channel and 403 for a missing id — an
// existence oracle over sequential channel ids, plus a read-state write for a
// channel they cannot see. On 0.9.3 hidden=200, missing=403.
// ---------------------------------------------------------------------------
async function markReadOracle() {
    section('F10: mark-read uses the VIEW gate (C02)');
    const O = mkUser('mro'), M = mkUser('mrm'), X = mkUser('mrx');
    const S = await mkServer(O); const PUB = await mkChannel(S, 'pub'); const HID = await mkChannel(S, 'hid');
    await joinViaInvite(S, M);
    await O.api('POST', `/channels/${HID}/messages`, { content: 'enc:v2:x' });
    await denyView(S, HID);
    const ok = await M.api('POST', `/channels/${PUB}/read`);
    check('control: member marks a visible channel read -> 200', ok.status === 200, ok.status + ' ' + ok.text);
    check('control: read state row written for the visible channel', row(`SELECT count(*) FROM channel_read_state WHERE user_id=${M.id} AND channel_id=${PUB}`) === '1');
    const hidden = await M.api('POST', `/channels/${HID}/read`);
    const missing = await M.api('POST', '/channels/999999/read');
    check('VIEW-denied member: hidden channel -> 404', hidden.status === 404, hidden.status + ' ' + hidden.text);
    check('VIEW-denied member: missing channel -> 404', missing.status === 404, missing.status + ' ' + missing.text);
    check('ORACLE CLOSED: hidden and missing are indistinguishable', hidden.status === missing.status && hidden.text === missing.text, `${hidden.status} ${hidden.text} | ${missing.status} ${missing.text}`);
    check('...and no read state was written for the hidden channel', row(`SELECT count(*) FROM channel_read_state WHERE user_id=${M.id} AND channel_id=${HID}`) === '0');
    // Non-member: refused. (Hidden 403 vs missing 404 across the non-member
    // boundary is the documented C05 limit, not asserted equal here.)
    const xh = await X.api('POST', `/channels/${HID}/read`);
    // Every refusal on this write route is the SAME 404, non-members included: nothing needs
    // a 403 here and 403-vs-404 would confirm to an outsider which channel ids exist.
    check('non-member: hidden channel -> the same 404', xh.status === 404, xh.status + ' ' + xh.text);
    check('...and no read state was written', row(`SELECT count(*) FROM channel_read_state WHERE user_id=${X.id}`) === '0');
}

// ---------------------------------------------------------------------------
// F11 (C07): POST /dms was an id -> username directory for any account and
// worked on tombstoned accounts. Now a stranger who shares no server, is not a
// friend and was never written to gets 403; a deleted user is 404. On 0.9.3 both
// stranger and tombstone answer 200 with the username.
// ---------------------------------------------------------------------------
async function dmRelationship() {
    section('F11: POST /dms requires a relationship and refuses deleted users (C07)');
    const V = mkUser('dmv'), A = mkUser('dmstr'), M = mkUser('dmsrv'), M3 = mkUser('dmsrv3'), F = mkUser('dmfr'), F2 = mkUser('dmfr2'), D = mkUser('dmdel'), MD = mkUser('dmdelm');
    // Shared servers: V with M and M3; D with MD (before D is tombstoned).
    const SV = await mkServer(V); await joinViaInvite(SV, M); await joinViaInvite(SV, M3);
    const SD = await mkServer(D); await joinViaInvite(SD, MD);
    psql(`INSERT INTO friends (user1_id, user2_id) VALUES (${F.id}, ${V.id}), (${V.id}, ${F2.id})`);
    // The exact anonymising UPDATE DELETE /account performs (handlers.rs); the
    // rig cannot mint the password proof that route requires.
    psql(`UPDATE users SET username='deleted#'||id, display_name=NULL, public_key=NULL, account_sign_pub=NULL, deleted_at=NOW(), token_version=token_version+1 WHERE id=${D.id}`);
    check('fixture: A shares no server and no friendship with V', row(`SELECT (SELECT count(*) FROM friends WHERE (user1_id=${A.id} AND user2_id=${V.id}) OR (user1_id=${V.id} AND user2_id=${A.id})) + (SELECT count(*) FROM server_members a JOIN server_members b ON a.server_id=b.server_id WHERE a.user_id=${A.id} AND b.user_id=${V.id})`) === '0');

    let r = await M.api('POST', '/dms', { user_id: V.id });
    check('control: a fellow server member opens a DM -> 200 with the username', r.status === 200 && r.json?.other_username === V.username, r.status + ' ' + r.text.slice(0, 120));
    r = await F.api('POST', '/dms', { user_id: V.id });
    check('control: a friend opens a DM -> 200', r.status === 200 && r.json?.other_user_id === V.id, r.status + ' ' + r.text.slice(0, 120));
    r = await A.api('POST', '/dms', { user_id: V.id });
    check('a stranger (no shared server, not a friend, never written to) -> 403', r.status === 403, r.status + ' ' + r.text);
    check('...the 403 body names the DM-acceptance rule, not the user', r.text.length > 0 && noLeak(r, V.username), r.text);
    check('...and no conversation row was manufactured', row(`SELECT count(*) FROM dm_conversations WHERE (user1_id=${Math.min(A.id, V.id)} AND user2_id=${Math.max(A.id, V.id)})`) === '0');
    r = await MD.api('POST', '/dms', { user_id: D.id });
    check('a deleted user -> 404 even for a fellow server member', r.status === 404 && noLeak(r, 'deleted#'), r.status + ' ' + r.text);
    r = await MD.api('POST', '/dms', { user_id: 999999999 });
    check('a nonexistent id -> 404 (same as deleted)', r.status === 404, r.status + ' ' + r.text);
    // The flag now means what its name says: OFF closes the server-member path
    // and leaves friends. (Fresh callers: an existing conversation is always returned.)
    psql(`UPDATE users SET allow_dms_from_server_members = false WHERE id = ${V.id}`);
    r = await M3.api('POST', '/dms', { user_id: V.id });
    check('flag off: a fellow server member -> 403', r.status === 403, r.status + ' ' + r.text);
    r = await F2.api('POST', '/dms', { user_id: V.id });
    check('flag off: a friend -> 200', r.status === 200, r.status + ' ' + r.text.slice(0, 120));
}

// ---------------------------------------------------------------------------
// F12 (C06): the dm-keys gate ("must already share a DM conversation") was
// self-satisfiable through POST /dms. The route now applies the relationship
// rule too. The fixture plants the conversation row a 0.9.3 attacker created
// for themselves: on 0.9.3 that row alone opens the route (200).
// ---------------------------------------------------------------------------
async function dmKeysStranger() {
    section('F12: GET /users/:id/dm-keys is 404 for a stranger (C06)');
    const V = mkUser('dkv'), A = mkUser('dkatk'), W = mkUser('dkw');
    const SV = await mkServer(V); await joinViaInvite(SV, W);
    const base = await A.api('GET', `/users/${V.id}/dm-keys`);
    check('baseline: a stranger with no conversation -> 404', base.status === 404, base.status + ' ' + base.text);
    // The row a 0.9.3 attacker manufactured (lower id is user1); no messages.
    psql(`INSERT INTO dm_conversations (id, user1_id, user2_id) VALUES ('${randomUUID()}', ${Math.min(A.id, V.id)}, ${Math.max(A.id, V.id)})`);
    const leak = await A.api('GET', `/users/${V.id}/dm-keys`);
    check('a stranger holding a conversation row V never wrote to -> 404', leak.status === 404 && !leak.json?.sessions, leak.status + ' ' + leak.text.slice(0, 160));
    // Controls on the same route.
    const self = await V.api('GET', `/users/${V.id}/dm-keys`);
    check('control: V reads own dm-keys -> 200', self.status === 200 && Array.isArray(self.json?.sessions), self.status + ' ' + self.text.slice(0, 120));
    const open = await V.api('POST', '/dms', { user_id: W.id });
    check('control fixture: V opens a DM with fellow member W', open.status === 200, open.status + ' ' + open.text.slice(0, 100));
    const wRead = await W.api('GET', `/users/${V.id}/dm-keys`);
    check('control: a fellow server member with a conversation -> 200', wRead.status === 200 && Array.isArray(wRead.json?.sessions), wRead.status + ' ' + wRead.text.slice(0, 120));
}

// ---------------------------------------------------------------------------
// F14: four id-existence oracles.
//   C16 task parents: "in a different checklist" vs "not found" (both 400) told
//       any account which sequential task ids exist. Now one message.
//   C17 task lists: 403 for someone else's list vs 404 for a missing one. Now 404.
//   C18 delete_file: 409 (referenced) before the ownership check told which
//       foreign file ids are live avatars/icons/emoji. Now 404 unless yours.
//   C19 reports: reported_message_id / reported_user_id stored unscoped. Now 400.
// ---------------------------------------------------------------------------
async function idOracles() {
    section('F14: task-parent, task-list, delete_file and report id oracles (C16 C17 C18 C19)');
    // C16
    const O = mkUser('tpo'), X = mkUser('tpx');
    const S = await mkServer(O); const chan = await mkChannel(S, 'secret-tasks');
    const t1 = await O.api('POST', `/channels/${chan}/tasks`, { description: 'victim task' });
    check('fixture: owner creates a channel task', t1.status === 200 && Number.isInteger(t1.json?.id), t1.status + ' ' + t1.text);
    const T = t1.json.id;
    const lr = await X.api('POST', '/task-lists', { title: 'probe' });
    check('fixture: outsider X (no memberships) creates a personal list', lr.status === 200 && Number.isInteger(lr.json?.id), lr.status + ' ' + lr.text);
    const L = lr.json.id;
    const anchor = await X.api('POST', `/task-lists/${L}/tasks`, { description: 'anchor' });
    const child = await X.api('POST', `/task-lists/${L}/tasks`, { description: 'child', parent_id: anchor.json?.id });
    check('control: an in-scope parent_id in the caller\'s own list -> 200', child.status === 200 && Number.isInteger(child.json?.id), child.status + ' ' + child.text);
    const exists = await X.api('POST', `/task-lists/${L}/tasks`, { description: 'p', parent_id: T });
    const absent = await X.api('POST', `/task-lists/${L}/tasks`, { description: 'p', parent_id: T + 1000000 });
    check('create_list_task: foreign parent -> 400 "Parent task not found"', exists.status === 400 && exists.text === 'Parent task not found', exists.status + ' ' + exists.text);
    check('create_list_task: nonexistent parent -> the same 400 body', absent.status === 400 && absent.text === exists.text, absent.status + ' ' + absent.text);
    const reExists = await X.api('POST', `/tasks/${anchor.json.id}/reorder`, { reparent: true, parent_id: T, after_id: null });
    const reAbsent = await X.api('POST', `/tasks/${anchor.json.id}/reorder`, { reparent: true, parent_id: T + 1000000, after_id: null });
    check('reorder_task: foreign parent -> 400 "Parent task not found"', reExists.status === 400 && reExists.text === 'Parent task not found', reExists.status + ' ' + reExists.text);
    check('reorder_task: nonexistent parent -> the same 400 body', reAbsent.status === 400 && reAbsent.text === reExists.text, reAbsent.status + ' ' + reAbsent.text);
    check('integrity: nothing was inserted under the foreign parent', row(`SELECT count(*) FROM channel_tasks WHERE parent_id=${T}`) === '0');

    // C17
    const Vl = mkUser('tlv'), Al = mkUser('tla');
    const vList = await Vl.api('POST', '/task-lists', { title: 'v-secret-list' });
    const aList = await Al.api('POST', '/task-lists', { title: 'mine' });
    check('fixture: two personal lists exist', vList.status === 200 && aList.status === 200, `${vList.status} ${aList.status}`);
    const Lv = vList.json.id, La = aList.json.id, Lmiss = La + 100000;
    let r = await Al.api('GET', `/task-lists/${La}/tasks`); check('control: A reads own list -> 200', r.status === 200 && Array.isArray(r.json), r.status + ' ' + r.text);
    const fe = await Al.api('GET', `/task-lists/${Lv}/tasks`), fm = await Al.api('GET', `/task-lists/${Lmiss}/tasks`);
    check('GET tasks of a foreign list -> 404 "List not found"', fe.status === 404 && /List not found/.test(fe.text), fe.status + ' ' + fe.text);
    check('...identical to a missing list', fm.status === fe.status && fm.text === fe.text, fm.status + ' ' + fm.text);
    r = await Al.api('PATCH', `/task-lists/${Lv}`, { title: 'x' }); check('rename of a foreign list -> 404', r.status === 404, r.status + ' ' + r.text);
    r = await Al.api('DELETE', `/task-lists/${Lv}`); check('delete of a foreign list -> 404', r.status === 404, r.status + ' ' + r.text);
    r = await Al.api('POST', `/task-lists/${Lv}/tasks`, { description: 'x' }); check('create task in a foreign list -> 404', r.status === 404, r.status + ' ' + r.text);
    check('integrity: the foreign list is untouched', row(`SELECT title FROM task_lists WHERE id=${Lv}`) === 'v-secret-list');

    // C18
    const Fo = mkUser('flo'), Fa = mkUser('fla');
    const ins = (uploader) => row(`INSERT INTO uploaded_files (id, uploader_id, original_name, stored_name, mime_type, size_bytes, kind) VALUES (gen_random_uuid(), ${uploader}, 'x_${RUN}.png', 'x_${RUN}.png', 'image/png', 10, 'attachment') RETURNING id`);
    const uAvatar = ins(Fo.id), uOrphan = ins(Fo.id), uOwnDel = ins(Fo.id);
    psql(`UPDATE users SET avatar_file_id = '${uAvatar}' WHERE id = ${Fo.id}`);
    r = await Fo.api('DELETE', `/files/${uOwnDel}`);
    check('control: the uploader deletes their own unreferenced file -> 204', r.status === 204 && row(`SELECT count(*) FROM uploaded_files WHERE id='${uOwnDel}'`) === '0', r.status + ' ' + r.text);
    r = await Fo.api('DELETE', `/files/${uAvatar}`);
    check('control: the uploader deleting their own still-referenced avatar -> 409', r.status === 409, r.status + ' ' + r.text.slice(0, 80));
    const fa = await Fa.api('DELETE', `/files/${uAvatar}`), fo = await Fa.api('DELETE', `/files/${uOrphan}`), fu = await Fa.api('DELETE', `/files/${randomUUID()}`);
    check('a stranger deleting a REFERENCED foreign file -> 404 (not 409)', fa.status === 404, fa.status + ' ' + fa.text.slice(0, 80));
    check('a stranger deleting an unreferenced foreign file -> 404', fo.status === 404, fo.status + ' ' + fo.text.slice(0, 80));
    check('a stranger deleting an unknown id -> 404', fu.status === 404, fu.status + ' ' + fu.text.slice(0, 80));
    check('ORACLE CLOSED: referenced and unreferenced foreign files answer identically', fa.status === fo.status && fa.text === fo.text, `${fa.status} ${fa.text} | ${fo.status} ${fo.text}`);
    check('integrity: no attacker DELETE removed a row', row(`SELECT count(*) FROM uploaded_files WHERE id IN ('${uAvatar}','${uOrphan}')`) === '2');

    // C19
    const Ro = mkUser('rpo'), Rb = mkUser('rpb'), Rc = mkUser('rpc'), Rn = mkUser('rpn');
    const RS = await mkServer(Ro, `S_${RUN}`); const chS = await mkChannel(RS, 'general'); await joinViaInvite(RS, Rb);
    const RT = await mkServer(Rc, `T_${RUN}`); const chT = await mkChannel(RT, 'secret');
    const foreign = await Rc.api('POST', `/channels/${chT}/messages`, { content: 'enc:v2:FOREIGN' });
    const local = await Ro.api('POST', `/channels/${chS}/messages`, { content: 'enc:v2:LOCAL' });
    check('fixture: a message in this server and one in an unrelated server', foreign.status === 200 && local.status === 200);
    const report = (body) => Ro.api('POST', `/servers/${RS.id}/reports`, { report_type: 'other', reason: 'probe', ...body });
    r = await report({ reported_message_id: local.json.id, reported_user_id: Rb.id });
    check('control: a report naming a message in this server by a member -> 200', r.status === 200 && typeof r.json?.id === 'number', r.status + ' ' + r.text);
    r = await report({ reported_message_id: foreign.json.id, reported_user_id: Rb.id });
    check('a foreign message id -> 400', r.status === 400, r.status + ' ' + r.text);
    r = await report({ reported_message_id: local.json.id, reported_user_id: Rn.id });
    check('a reported_user_id with no relationship to this server -> 400', r.status === 400, r.status + ' ' + r.text);
    r = await report({ reported_user_id: 2147483000 });
    check('a nonexistent reported_user_id -> 400 (was a 500 FK violation)', r.status === 400, r.status + ' ' + r.text);
    check('integrity: no report row carries the foreign message or the outsider', row(`SELECT count(*) FROM reports WHERE server_id='${RS.id}' AND (reported_message_id='${foreign.json.id}' OR reported_user_id=${Rn.id})`) === '0');
    r = await Rn.api('POST', `/servers/${RS.id}/reports`, { report_type: 'other', reason: 'x', reported_user_id: Ro.id });
    check('a non-member cannot report at all -> 403', r.status === 403, r.status + ' ' + r.text);
}

// ---------------------------------------------------------------------------
// F15 (C33): READ_MESSAGE_HISTORY was enforced on GET /messages only; /pins and
// /edits handed message bodies to a member the role editor denied history. On
// 0.9.3 both return 200 with the body.
// ---------------------------------------------------------------------------
async function historyBit() {
    section('F15: pins and edits honour READ_MESSAGE_HISTORY (C33)');
    const O = mkUser('hso'), M = mkUser('hsm');
    const S = await mkServer(O); const C = await mkChannel(S, 'nohist'); await joinViaInvite(S, M);
    const m = await O.api('POST', `/channels/${C}/messages`, { content: 'enc:v2:NOHIST-BODY' }); const MSG = m.json.id;
    await O.api('PATCH', `/channels/${C}/messages/${MSG}`, { content: 'enc:v2:NOHIST-BODY-EDIT' });
    await O.api('POST', `/channels/${C}/messages/${MSG}/pin`);
    let r = await M.api('GET', `/channels/${C}/pins`); check('control: with history, GET /pins returns the body', r.status === 200 && r.text.includes('NOHIST-BODY'), r.status);
    r = await M.api('GET', `/channels/${C}/messages/${MSG}/edits`); check('control: with history, GET /edits returns the prior body', r.status === 200 && r.text.includes('NOHIST-BODY'), r.status + ' ' + r.text.slice(0, 100));
    const ow = await O.api('PUT', `/channels/${C}/overwrites/${S.everyoneRoleId}`, { allow: 0, deny: BITS.READ_MESSAGE_HISTORY });
    check('fixture: READ_MESSAGE_HISTORY denied for @everyone', ow.status === 200, ow.status + ' ' + ow.text);
    r = await M.api('GET', `/channels/${C}/messages`); check('history-denied member: GET /messages -> 403', r.status === 403 && noLeak(r, 'NOHIST-BODY'), r.status);
    r = await M.api('GET', `/channels/${C}/pins`); check('history-denied member: GET /pins -> 403, no body', r.status === 403 && noLeak(r, 'NOHIST-BODY'), r.status + ' ' + r.text.slice(0, 120));
    r = await M.api('GET', `/channels/${C}/messages/${MSG}/edits`); check('history-denied member: GET /edits -> 403, no body', r.status === 403 && noLeak(r, 'NOHIST-BODY'), r.status + ' ' + r.text.slice(0, 120));
    r = await O.api('GET', `/channels/${C}/pins`); check('control: the owner still reads pins', r.status === 200 && r.text.includes('NOHIST-BODY'), r.status);
}

// ---------------------------------------------------------------------------
// F17: send_message stored reply_to_id verbatim, so a member could plant a
// pointer into a channel they cannot see. On 0.9.3 the cross-channel reply is
// a 200 with the foreign id stored.
// ---------------------------------------------------------------------------
async function replyScope() {
    section('F17: reply_to_id must be a message in the same channel');
    const O = mkUser('rso'), M = mkUser('rsm');
    const S = await mkServer(O); const C1 = await mkChannel(S, 'one'); const C2 = await mkChannel(S, 'two'); await joinViaInvite(S, M);
    const m1 = await O.api('POST', `/channels/${C1}/messages`, { content: 'enc:v2:ORIGINAL' });
    check('fixture: owner posts in channel one', m1.status === 200 && !!m1.json?.id);
    const ok = await M.api('POST', `/channels/${C1}/messages`, { content: 'enc:v2:REPLY', reply_to_id: m1.json.id });
    check('control: a same-channel reply -> 200 with reply_to_id stored', ok.status === 200 && row(`SELECT reply_to_id FROM messages WHERE id='${ok.json?.id}'`) === m1.json.id, ok.status + ' ' + ok.text.slice(0, 120));
    const cross = await M.api('POST', `/channels/${C2}/messages`, { content: 'enc:v2:CROSS', reply_to_id: m1.json.id });
    check('a reply from ANOTHER channel to that message -> 400', cross.status === 400, cross.status + ' ' + cross.text);
    const ghost = await M.api('POST', `/channels/${C2}/messages`, { content: 'enc:v2:GHOST', reply_to_id: randomUUID() });
    check('a reply to a nonexistent id -> 400', ghost.status === 400, ghost.status + ' ' + ghost.text);
    check('integrity: no message in channel two points at channel one', row(`SELECT count(*) FROM messages WHERE channel_id=${C2} AND reply_to_id IS NOT NULL`) === '0');
}

await boundaryMatrix();
await evictionMatrix();
await voiceUsersNameAlias();
await voiceMoveOracle();
await connectDenyEvicts();
await parkedNotifications();
await clipsAfterKickAndApproverOnline();
await selfRoleChange();
await markReadOracle();
await dmRelationship();
await dmKeysStranger();
await idOracles();
await historyBit();
await replyScope();
done();
