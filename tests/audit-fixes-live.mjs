// Live acceptance for the 2026-07-27 post-deploy audit fixes.
//
// Every check here FAILS against the code as it shipped in v0.7.1 — each one
// drives the exact attack the fix closes, and asserts both halves: the abuse is
// refused AND the legitimate use of the same endpoint still works. (A guard
// that returns 403 to everyone would pass a one-sided test.)
//
// Covers:
//   - create_channel trusting body parent_id/category_id (cross-server graft)
//   - pin_message not binding message -> channel (arbitrary message disclosure)
//   - get_message_edits reading edit history by message id alone
//   - remove_role missing the hierarchy guard assign_role enforces
//   - update_public_key overwriting an established v3 identity key
//   - update_profile: unbounded display_name, and an avatar file you don't own
//
// Same minted-JWT harness as perm-matrix-live.mjs.
// Prereqs: backend on :3000 against a THROWAWAY db (PGDB must match it).
// Usage: PGDB=puca_audit node tests/audit-fixes-live.mjs
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.API || 'http://localhost:3000';
const PGDB = process.env.PGDB || 'puca';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const JWT_SECRET = 'puca_super_secret_key_change_in_production';

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
    if (!ok) failures++;
};
const psql = (sql) => execFileSync(PSQL,
    ['-U', 'postgres', '-h', 'localhost', '-d', PGDB, '-q', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();
const psql1 = (sql) => psql(sql).split(/\r?\n/).filter(Boolean)[0] ?? '';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mintJwt = (sub, username, tv = 0) => {
    const head = b64u({ alg: 'HS256', typ: 'JWT' });
    const body = b64u({ sub, username, tv, exp: Math.floor(Date.now() / 1000) + 3600 });
    const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
};
const api = async (method, path, body, token) => {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: (body === undefined || body === null || method === "GET") ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
};

const RUN = Math.random().toString(36).slice(2, 8);
const mkUser = (name) => {
    const u = `af_${name}_${RUN}`;
    const id = psql1(`INSERT INTO users (username, salt, verifier, key_version, token_version)
                      VALUES ('${u}', '\\x00', '\\x00', 3, 0) RETURNING id`);
    return { id: parseInt(id, 10), username: u, t: mintJwt(parseInt(id, 10), u) };
};
const mkServer = (ownerId, label) => {
    const sid = randomUUID();
    psql(`INSERT INTO servers (id, name, owner_id) VALUES ('${sid}', '${label}-${RUN}', ${ownerId})`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${sid}', ${ownerId})`);
    // Owner role carrying ADMINISTRATOR, assigned — mirrors create_server.
    const rid = psql1(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
                       VALUES ('${sid}', 'Owner', '#F1C40F', 4194304, 100, false) RETURNING id`);
    psql(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('${sid}', ${ownerId}, ${rid})`);
    const cid = psql1(`INSERT INTO channels (name, type, position, server_id) VALUES ('general', 0, 0, '${sid}') RETURNING id`);
    return { id: sid, roleId: parseInt(rid, 10), channelId: parseInt(cid, 10) };
};

const A = mkUser('a');           // attacker — owns their own server
const V = mkUser('v');           // victim — owns a separate server
const srvA = mkServer(A.id, 'attacker');
const srvV = mkServer(V.id, 'victim');

console.log(`\n=== create_channel must not graft into another server (body parent_id/category_id) ===`);
{
    // A has MANAGE_CHANNELS on their OWN server (Owner/ADMINISTRATOR), and
    // names the VICTIM's channel as the parent.
    const r = await api('POST', `/servers/${srvA.id}/channels`,
        { name: 'graft', channel_type: 0, parent_id: srvV.channelId }, A.t);
    check('create_channel refuses a parent in another server', r.status === 400, `status=${r.status}`);

    const victimCat = psql1(`INSERT INTO channel_categories (server_id, name, position)
                             VALUES ('${srvV.id}', 'vcat-${RUN}', 0) RETURNING id`);
    const r2 = await api('POST', `/servers/${srvA.id}/channels`,
        { name: 'graft2', channel_type: 0, category_id: parseInt(victimCat, 10) }, A.t);
    check('create_channel refuses a category in another server', r2.status === 400, `status=${r2.status}`);

    // The legitimate case must still work, including a same-server parent.
    const ok = await api('POST', `/servers/${srvA.id}/channels`, { name: 'legit', channel_type: 0 }, A.t);
    check('create_channel still allows a plain channel', ok.status < 300, `status=${ok.status}`);
    const okParent = await api('POST', `/servers/${srvA.id}/channels`,
        { name: 'legit-child', channel_type: 0, parent_id: srvA.channelId }, A.t);
    check('create_channel still allows a same-server parent', okParent.status < 300, `status=${okParent.status}`);
}

console.log(`\n=== pin_message must bind the message to the authorized channel ===`);
{
    const victimMsg = randomUUID();
    psql(`INSERT INTO messages (id, channel_id, user_id, content) VALUES ('${victimMsg}', ${srvV.channelId}, ${V.id}, 'victim-secret-${RUN}')`);
    // A pins the victim's message id via a channel A controls.
    const r = await api('POST', `/channels/${srvA.channelId}/messages/${victimMsg}/pin`, {}, A.t);
    check('pin refuses a message from another channel', r.status === 404, `status=${r.status}`);
    const pins = await api('GET', `/channels/${srvA.channelId}/pins`, null, A.t);
    const leaked = JSON.stringify(pins.body || '').includes('victim-secret');
    check('pin list does not disclose the foreign message', !leaked, JSON.stringify(pins.body).slice(0, 120));

    // Legitimate pin in A's own channel still works.
    const ownMsg = randomUUID();
    psql(`INSERT INTO messages (id, channel_id, user_id, content) VALUES ('${ownMsg}', ${srvA.channelId}, ${A.id}, 'own-msg-${RUN}')`);
    const okPin = await api('POST', `/channels/${srvA.channelId}/messages/${ownMsg}/pin`, {}, A.t);
    check('pin still works for a message in the channel', okPin.status < 300, `status=${okPin.status}`);
    const pins2 = await api('GET', `/channels/${srvA.channelId}/pins`, null, A.t);
    check('pin list includes the legitimately pinned message',
        JSON.stringify(pins2.body || '').includes('own-msg'), JSON.stringify(pins2.body).slice(0, 120));
}

console.log(`\n=== get_message_edits must be scoped to the authorized channel ===`);
{
    const vMsg = randomUUID();
    psql(`INSERT INTO messages (id, channel_id, user_id, content) VALUES ('${vMsg}', ${srvV.channelId}, ${V.id}, 'current')`);
    psql(`INSERT INTO message_edits (message_id, old_content) VALUES ('${vMsg}', 'victim-old-content-${RUN}')`);
    const r = await api('GET', `/channels/${srvA.channelId}/messages/${vMsg}/edits`, null, A.t);
    const leaked = JSON.stringify(r.body || '').includes('victim-old-content');
    check('edit history of a foreign message is not returned', !leaked, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 120)}`);

    // Own-channel edit history still returns.
    const aMsg = randomUUID();
    psql(`INSERT INTO messages (id, channel_id, user_id, content) VALUES ('${aMsg}', ${srvA.channelId}, ${A.id}, 'current')`);
    psql(`INSERT INTO message_edits (message_id, old_content) VALUES ('${aMsg}', 'own-old-content-${RUN}')`);
    const ok = await api('GET', `/channels/${srvA.channelId}/messages/${aMsg}/edits`, null, A.t);
    check('own-channel edit history still returned',
        JSON.stringify(ok.body || '').includes('own-old-content'), JSON.stringify(ok.body).slice(0, 120));
}

console.log(`\n=== remove_role must enforce the same hierarchy as assign_role ===`);
{
    // Moderator in the victim's server: MANAGE_ROLES (1<<28) at position 5.
    const M = mkUser('mod');
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${srvV.id}', ${M.id})`);
    const modRole = psql1(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
                           VALUES ('${srvV.id}', 'Mod', '#3498DB', ${1 << 18}, 5, false) RETURNING id`);
    psql(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('${srvV.id}', ${M.id}, ${modRole})`);

    // Try to strip the OWNER role (position 100) from the owner.
    const r = await api('DELETE', `/servers/${srvV.id}/members/${V.id}/roles/${srvV.roleId}`, null, M.t);
    check('moderator cannot strip a role above their own', r.status === 403, `status=${r.status}`);
    const still = psql1(`SELECT count(*) FROM member_roles WHERE server_id='${srvV.id}' AND user_id=${V.id} AND role_id=${srvV.roleId}`);
    check('owner still holds the Owner role', still === '1', `count=${still}`);

    // A role BELOW the moderator's position is still removable (guard is not a blanket deny).
    const lowRole = psql1(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
                           VALUES ('${srvV.id}', 'Low', '#95A5A6', 1, 2, false) RETURNING id`);
    psql(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('${srvV.id}', ${M.id}, ${lowRole})`);
    const ok = await api('DELETE', `/servers/${srvV.id}/members/${M.id}/roles/${lowRole}`, null, M.t);
    check('moderator can still remove a role below their own', ok.status < 300, `status=${ok.status}`);
}

console.log(`\n=== update_public_key is write-once for a v3 account ===`);
{
    const K = mkUser('key');
    const mine = 'x25519:' + Buffer.alloc(32, 7).toString('base64');
    const attacker = 'x25519:' + Buffer.alloc(32, 9).toString('base64');
    psql(`UPDATE users SET public_key = '${mine}' WHERE id = ${K.id}`);

    const r = await api('PATCH', '/keys/public', { public_key: attacker }, K.t);
    check('replacing an established v3 identity key is refused', r.status === 409, `status=${r.status}`);
    const stored = psql1(`SELECT public_key FROM users WHERE id = ${K.id}`);
    check('stored identity key is unchanged', stored === mine, `stored=${stored}`);

    const same = await api('PATCH', '/keys/public', { public_key: mine }, K.t);
    check('idempotent re-upload of the same key still succeeds', same.status < 300, `status=${same.status}`);
    const bad = await api('PATCH', '/keys/public', { public_key: 'not-a-key' }, K.t);
    check('malformed identity key is rejected', bad.status === 400, `status=${bad.status}`);

    // A legacy v2 account must still be able to publish during migration.
    const L = mkUser('legacy');
    psql(`UPDATE users SET key_version = 2, public_key = NULL WHERE id = ${L.id}`);
    const legacy = await api('PATCH', '/keys/public', { public_key: attacker }, L.t);
    check('legacy v2 migration can still publish its key', legacy.status < 300, `status=${legacy.status}`);
}

console.log(`\n=== update_profile input validation ===`);
{
    const P = mkUser('prof');
    const long = 'x'.repeat(200);
    const r = await api('PATCH', '/profile', { display_name: long }, P.t);
    check('over-long display_name is rejected', r.status === 413, `status=${r.status}`);
    const ok = await api('PATCH', '/profile', { display_name: 'Reasonable Name' }, P.t);
    check('normal display_name still accepted', ok.status < 300, `status=${ok.status}`);

    // An avatar file uploaded by someone ELSE cannot be claimed.
    const fid = randomUUID();
    psql(`INSERT INTO uploaded_files (id, uploader_id, stored_name, original_name, mime_type, size_bytes)
          VALUES ('${fid}', ${V.id}, 'stored-${RUN}', 'a.png', 'image/png', 10)`);
    const steal = await api('PATCH', '/profile', { avatar_file_id: fid }, P.t);
    check("cannot claim another user's file as an avatar", steal.status === 403, `status=${steal.status}`);

    const ownFid = randomUUID();
    psql(`INSERT INTO uploaded_files (id, uploader_id, stored_name, original_name, mime_type, size_bytes)
          VALUES ('${ownFid}', ${P.id}, 'stored-own-${RUN}', 'b.png', 'image/png', 10)`);
    const okAvatar = await api('PATCH', '/profile', { avatar_file_id: ownFid }, P.t);
    check('own uploaded file is still accepted as an avatar', okAvatar.status < 300, `status=${okAvatar.status}`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
