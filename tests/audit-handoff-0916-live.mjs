// Live probes for the three backend candidates from the 2026-09-16 audit
// handoff (C-03 role self-mutation via the i64/i32 alias, C-05 remove_timeout
// hierarchy, C-07 custom-sound suppression hierarchy). Assertions describe the
// FIXED behaviour: against the unfixed 0.9.810 binary the bug lines must FAIL
// and the controls must PASS (positive control that the rig can see the bug).
//
// Usage: API=http://127.0.0.1:3000 PGDB=<throwaway db> PGPORT=5433 node tests/audit-handoff-0916-live.mjs
import {
    mkUser, mkServer, mkChannel, joinViaInvite, denyView,
    check, section, done, psql, psql1, BITS, RUN,
} from './probe-lib.mjs';

const row = (sql) => psql1(sql);
const WRAP = 2 ** 32; // an id that `as i32` wraps back onto the real row
const mkRole = (S, name, perms, pos) => parseInt(row(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default) VALUES ('${S.id}', '${name}_${RUN}', '#99aab5', ${perms}, ${pos}, false) RETURNING id`), 10);
const giveRole = (S, U, R) => psql(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('${S.id}', ${U.id}, ${R})`);
const hasRole = (S, U, R) => row(`SELECT count(*) FROM member_roles WHERE server_id='${S.id}' AND user_id=${U.id} AND role_id=${R}`) === '1';
const refused = (r) => r.status === 403 || r.status === 404;

async function roleAlias() {
    section('C-03: the i64/i32 alias of your own id must not bypass the self-role guard');
    const O = mkUser('rao'), A = mkUser('raa'), L = mkUser('ral');
    const S = await mkServer(O);
    const HID = await mkChannel(S, 'hidden');
    const VIS = await mkChannel(S, 'visible');
    await joinViaInvite(S, A); await joinViaInvite(S, L);
    const MOD = mkRole(S, 'Mod', BITS.MANAGE_ROLES, 5);
    const SEC = mkRole(S, 'Secret', 0, 2);
    const RES = mkRole(S, 'Restricted', 0, 2);
    await denyView(S, HID);
    let r = await O.api('PUT', `/channels/${HID}/overwrites/${SEC}`, { allow: BITS.VIEW_CHANNEL, deny: 0 });
    check('fixture: Secret ALLOWS VIEW on the hidden channel', r.status === 200, r.status + ' ' + r.text);
    r = await O.api('PUT', `/channels/${VIS}/overwrites/${RES}`, { allow: 0, deny: BITS.VIEW_CHANNEL });
    check('fixture: Restricted DENIES VIEW on the visible channel', r.status === 200, r.status + ' ' + r.text);
    giveRole(S, A, MOD); giveRole(S, A, RES);
    await O.api('POST', `/channels/${HID}/messages`, { content: `enc:v2:HIDDEN_${RUN}` });
    await O.api('POST', `/channels/${VIS}/messages`, { content: `enc:v2:VISIBLE_${RUN}` });
    r = await A.api('GET', `/channels/${HID}/messages`); check('baseline: A cannot read the hidden channel (404)', r.status === 404, r.status);
    r = await A.api('GET', `/channels/${VIS}/messages`); check('baseline: A cannot read the Restricted-denied channel (404)', r.status === 404, r.status);

    r = await A.api('PUT', `/servers/${S.id}/members/${A.id}/roles/${SEC}`);
    check('control: the DIRECT self-assign is refused (403)', r.status === 403 && /own roles/i.test(r.text), r.status + ' ' + r.text);

    // THE BUG: the same request with the caller's id + 2^32 (and - 2^32).
    r = await A.api('PUT', `/servers/${S.id}/members/${A.id + WRAP}/roles/${SEC}`);
    check('A self-assigning Secret via id+2^32 is refused, not 200', refused(r), r.status + ' ' + r.text);
    check('...no Secret row was written for A', !hasRole(S, A, SEC));
    r = await A.api('GET', `/channels/${HID}/messages`);
    check('...and the hidden channel stays 404 for A', r.status === 404 && !r.text.includes(`HIDDEN_${RUN}`), r.status);
    r = await A.api('PUT', `/servers/${S.id}/members/${A.id - WRAP}/roles/${SEC}`);
    check('A self-assigning Secret via id-2^32 is refused', refused(r), r.status + ' ' + r.text);
    check('...still no Secret row for A', !hasRole(S, A, SEC));
    r = await A.api('DELETE', `/servers/${S.id}/members/${A.id + WRAP}/roles/${RES}`);
    check('A self-removing Restricted via id+2^32 is refused', refused(r), r.status + ' ' + r.text);
    check('...the Restricted row is still there', hasRole(S, A, RES));
    r = await A.api('GET', `/channels/${VIS}/messages`);
    check('...and the denied channel stays 404 for A', r.status === 404, r.status);

    // Controls: real ids keep working; an alias of ANOTHER member writes nothing.
    r = await A.api('PUT', `/servers/${S.id}/members/${L.id}/roles/${SEC}`);
    check('control: A assigns Secret to L (real id) -> 200', r.status === 200 && hasRole(S, L, SEC), r.status + ' ' + r.text);
    r = await A.api('DELETE', `/servers/${S.id}/members/${L.id}/roles/${SEC}`);
    check('control: A removes Secret from L (real id) -> 200', r.status === 200 && !hasRole(S, L, SEC), r.status + ' ' + r.text);
    r = await A.api('PUT', `/servers/${S.id}/members/${L.id + WRAP}/roles/${SEC}`);
    check('an alias of ANOTHER member is refused and writes nothing', refused(r) && !hasRole(S, L, SEC), r.status + ' ' + r.text + ' row=' + hasRole(S, L, SEC));
    r = await O.api('PUT', `/servers/${S.id}/members/${O.id}/roles/${SEC}`);
    check('control: the owner may still assign a role to themselves -> 200', r.status === 200, r.status + ' ' + r.text);
}

async function roleTargetRank() {
    section('SWEEP: role changes obey the TARGET MEMBER rank, not just the role position');
    const O = mkUser('rro'), A = mkUser('rra'), HIGH = mkUser('rrh'), PEER = mkUser('rrp'), LOW = mkUser('rrl');
    const S = await mkServer(O);
    for (const u of [A, HIGH, PEER, LOW]) await joinViaInvite(S, u);
    const MOD = mkRole(S, 'Mod5', BITS.MANAGE_ROLES, 5);
    const SENIOR = mkRole(S, 'Senior9', 0, 9);
    const GRANT = mkRole(S, 'Grantable2', 0, 2); // below A's highest, so the role-position guard passes
    giveRole(S, A, MOD); giveRole(S, HIGH, SENIOR); giveRole(S, PEER, MOD);
    giveRole(S, HIGH, GRANT); // so the strip case has something to remove

    let r = await A.api('PUT', `/servers/${S.id}/members/${LOW.id}/roles/${GRANT}`);
    check('control: A (rank 5) assigns a rank-2 role to LOW (rank 0) -> 200', r.status === 200 && hasRole(S, LOW, GRANT), r.status + ' ' + r.text);
    r = await A.api('DELETE', `/servers/${S.id}/members/${LOW.id}/roles/${GRANT}`);
    check('control: A strips it from LOW again -> 200', r.status === 200 && !hasRole(S, LOW, GRANT), r.status + ' ' + r.text);

    r = await A.api('PUT', `/servers/${S.id}/members/${HIGH.id}/roles/${GRANT}`);
    check('A (rank 5) assigning a role to HIGH (rank 9) -> 403', r.status === 403 && /ranked at or above/i.test(r.text), r.status + ' ' + r.text);
    r = await A.api('DELETE', `/servers/${S.id}/members/${HIGH.id}/roles/${GRANT}`);
    check('A stripping a role from HIGH (rank 9) -> 403', r.status === 403, r.status + ' ' + r.text);
    check('...HIGH keeps the role', hasRole(S, HIGH, GRANT));
    r = await A.api('PUT', `/servers/${S.id}/members/${PEER.id}/roles/${GRANT}`);
    check('A assigning a role to an EQUAL-ranked peer -> 403', r.status === 403, r.status + ' ' + r.text);
    check('...PEER did not get it', !hasRole(S, PEER, GRANT));

    r = await O.api('PUT', `/servers/${S.id}/members/${HIGH.id}/roles/${MOD}`);
    check('control: the owner may still assign a role to a high-ranked member -> 200', r.status === 200, r.status + ' ' + r.text);
    r = await O.api('PUT', `/servers/${S.id}/members/${O.id}/roles/${GRANT}`);
    check('control: the owner may still assign a role to THEMSELVES -> 200', r.status === 200, r.status + ' ' + r.text);
}

async function timeoutHierarchy() {
    section('C-05: lifting a timeout obeys the same hierarchy as imposing it');
    const O = mkUser('tho'), M1 = mkUser('thm1'), M2 = mkUser('thm2'), L = mkUser('thl');
    const S = await mkServer(O);
    const CH = await mkChannel(S, 'general');
    for (const u of [M1, M2, L]) await joinViaInvite(S, u);
    const HIGH = mkRole(S, 'Mod5', BITS.KICK_MEMBERS, 5);
    const LOW = mkRole(S, 'Mod3', BITS.KICK_MEMBERS, 3);
    giveRole(S, M1, HIGH); giveRole(S, M2, HIGH); giveRole(S, L, LOW);
    // Row PRESENCE, deliberately not `expires_at > NOW()`: the column is a naive
    // TIMESTAMP that the backend writes from a UTC session, and a psql session
    // in the operator's local zone reads the same comparison differently (the
    // 0906 timestamp-vs-NOW() trap). What is under test is whether the row
    // survives an unauthorized DELETE, and the 1 h timeouts here cannot expire
    // mid-run.
    const timedOut = (U) => row(`SELECT count(*) FROM member_timeouts WHERE server_id='${S.id}' AND user_id=${U.id}`) === '1';
    const body = { duration_seconds: 3600, reason: 'probe' };

    let r = await O.api('POST', `/servers/${S.id}/timeout/${L.id}`, body);
    check('fixture: the owner times out L -> 200', r.status === 200 && timedOut(L), r.status + ' ' + r.text);
    r = await L.api('POST', `/channels/${CH}/messages`, { content: `enc:v2:T_${RUN}` });
    check('fixture: a timed-out L cannot send (403)', r.status === 403, r.status + ' ' + r.text.slice(0, 80));

    // THE BUG (self): L holds KICK_MEMBERS and lifts their own timeout.
    r = await L.api('DELETE', `/servers/${S.id}/timeout/${L.id}`);
    check('L lifting their OWN timeout -> 403', r.status === 403, r.status + ' ' + r.text);
    check('...and L is still timed out', timedOut(L));
    // THE BUG (upward): the owner times out M1; L (rank 3) lifts it.
    r = await O.api('POST', `/servers/${S.id}/timeout/${M1.id}`, body);
    check('fixture: the owner times out M1 -> 200', r.status === 200 && timedOut(M1), r.status + ' ' + r.text);
    r = await L.api('DELETE', `/servers/${S.id}/timeout/${M1.id}`);
    check("L (rank 3) lifting M1 (rank 5)'s timeout -> 403", r.status === 403, r.status + ' ' + r.text);
    check('...M1 is still timed out', timedOut(M1));
    // THE BUG (equal): M2 (rank 5) lifts M1 (rank 5).
    r = await M2.api('DELETE', `/servers/${S.id}/timeout/${M1.id}`);
    check("M2 (rank 5) lifting M1 (rank 5)'s timeout -> 403 (equal rank)", r.status === 403, r.status + ' ' + r.text);
    check('...M1 is still timed out', timedOut(M1));
    r = await L.api('DELETE', `/servers/${S.id}/timeout/${M1.id + WRAP}`);
    check('an alias target on remove_timeout is refused', refused(r) && timedOut(M1), r.status + ' ' + r.text);

    // REVIEW FINDING: the shared hierarchy rule short-circuited on ADMINISTRATOR
    // before any self check, so an admin the owner had timed out could lift
    // their own timeout. The self refusal now comes first for everyone.
    const ADM = mkUser('thadm');
    await joinViaInvite(S, ADM);
    const ADMIN = mkRole(S, 'Admin', BITS.ADMINISTRATOR, 8);
    giveRole(S, ADM, ADMIN);
    r = await O.api('POST', `/servers/${S.id}/timeout/${ADM.id}`, body);
    check('fixture: the owner times out an administrator -> 200', r.status === 200 && timedOut(ADM), r.status + ' ' + r.text);
    r = await ADM.api('DELETE', `/servers/${S.id}/timeout/${ADM.id}`);
    check('an ADMINISTRATOR lifting their OWN timeout -> 403', r.status === 403, r.status + ' ' + r.text);
    check('...and the administrator is still timed out', timedOut(ADM));
    r = await ADM.api('DELETE', `/servers/${S.id}/timeout/${M1.id}`);
    check('control: the administrator may still lift SOMEONE ELSE\'s timeout -> 200', r.status === 200 && !timedOut(M1), r.status + ' ' + r.text);
    r = await O.api('POST', `/servers/${S.id}/timeout/${M1.id}`, body); // restore the fixture for the controls below
    check('fixture: M1 timed out again -> 200', r.status === 200 && timedOut(M1), r.status + ' ' + r.text);

    // Controls: downward and owner lifts work, and lifting really restores sending.
    r = await O.api('DELETE', `/servers/${S.id}/timeout/${M1.id}`);
    check("control: the owner lifts M1's timeout -> 200", r.status === 200 && !timedOut(M1), r.status + ' ' + r.text);
    r = await M1.api('DELETE', `/servers/${S.id}/timeout/${L.id}`);
    check("control: M1 (rank 5) lifts L (rank 3)'s timeout -> 200", r.status === 200 && !timedOut(L), r.status + ' ' + r.text);
    r = await L.api('POST', `/channels/${CH}/messages`, { content: `enc:v2:T2_${RUN}` });
    check('control: L can send again once the timeout is lifted', r.status === 200, r.status + ' ' + r.text.slice(0, 80));
}

async function customSoundsHierarchy() {
    section('C-07: suppressing custom sounds obeys the moderation hierarchy');
    const O = mkUser('cso'), M1 = mkUser('csm1'), L = mkUser('csl');
    const S = await mkServer(O);
    for (const u of [M1, L]) await joinViaInvite(S, u);
    const HIGH = mkRole(S, 'Mute5', BITS.MUTE_MEMBERS, 5);
    const LOW = mkRole(S, 'Mute3', BITS.MUTE_MEMBERS, 3);
    giveRole(S, M1, HIGH); giveRole(S, L, LOW);
    const disabled = (U) => row(`SELECT custom_sounds_disabled FROM server_members WHERE server_id='${S.id}' AND user_id=${U.id}`) === 't';

    let r = await L.api('PUT', `/servers/${S.id}/custom-sounds/${M1.id}`, { disabled: true });
    check("L (rank 3) silencing M1 (rank 5)'s sounds -> 403", r.status === 403, r.status + ' ' + r.text);
    check("...M1's sounds are NOT disabled", !disabled(M1));
    r = await L.api('PUT', `/servers/${S.id}/custom-sounds/${L.id}`, { disabled: true });
    check('L silencing their OWN sounds -> 403 (self is not moderatable)', r.status === 403, r.status + ' ' + r.text);
    r = await L.api('PUT', `/servers/${S.id}/custom-sounds/${O.id}`, { disabled: true });
    check('control: the owner stays untouchable -> 403', r.status === 403, r.status + ' ' + r.text);
    r = await M1.api('PUT', `/servers/${S.id}/custom-sounds/${L.id}`, { disabled: true });
    check("control: M1 (rank 5) silences L (rank 3) -> 200", r.status === 200 && disabled(L), r.status + ' ' + r.text);
    r = await O.api('PUT', `/servers/${S.id}/custom-sounds/${M1.id}`, { disabled: true });
    check('control: the owner silences M1 -> 200', r.status === 200 && disabled(M1), r.status + ' ' + r.text);
    r = await O.api('PUT', `/servers/${S.id}/custom-sounds/${M1.id + WRAP}`, { disabled: false });
    check('control: an alias target writes nothing (refused) - the 0.9.x wide-bind fix holds', refused(r) && disabled(M1), r.status + ' ' + r.text);

    // REVIEW FINDING (same shortcut as the timeout case): an administrator whose
    // sounds the owner suppressed could re-enable them on themself.
    const ADM = mkUser('csadm');
    await joinViaInvite(S, ADM);
    const ADMIN = mkRole(S, 'Admin', BITS.ADMINISTRATOR, 8);
    giveRole(S, ADM, ADMIN);
    r = await O.api('PUT', `/servers/${S.id}/custom-sounds/${ADM.id}`, { disabled: true });
    check('fixture: the owner silences an administrator -> 200', r.status === 200 && disabled(ADM), r.status + ' ' + r.text);
    r = await ADM.api('PUT', `/servers/${S.id}/custom-sounds/${ADM.id}`, { disabled: false });
    check('an ADMINISTRATOR re-enabling their OWN sounds -> 403', r.status === 403 && disabled(ADM), r.status + ' ' + r.text);
    r = await ADM.api('PUT', `/servers/${S.id}/custom-sounds/${L.id}`, { disabled: false });
    check('control: the administrator may still change SOMEONE ELSE\'s -> 200', r.status === 200 && !disabled(L), r.status + ' ' + r.text);
}

await roleAlias();
await roleTargetRank();
await timeoutHierarchy();
await customSoundsHierarchy();
done();
