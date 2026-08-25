// Upload quota must be RECLAIMABLE.
//
// The quota sums `uploaded_files` per uploader and refuses at 512 MB / 5000
// files. Until DELETE /files/:id existed, nothing could remove a row except
// avatar replacement — no delete route, no background sweep, and message
// deletion never touched blobs. So the quota was a one-way ratchet: roughly 21
// max-size attachments and then EVERY upload path for that account (attachment,
// avatar, emoji, server icon) failed permanently with "please try again", which
// could never succeed. Deleting the messages did not help.
//
// This drives the real backend over HTTP and checks the whole loop: upload
// counts against usage, the file is fetchable, deleting it frees the usage
// again, and — the security half — one user cannot delete another user's file.
//
// Prereqs: backend on :3000 against an isolated DB (see e2ee-live-verify).
// Usage: API=http://127.0.0.1:3000 PGDB=puca_e2ee_test node tests/quota-reclaim-live.mjs
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const BASE = process.env.API || 'http://localhost:3000';
const PGDB = process.env.PGDB || 'puca_quota_test';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const JWT_SECRET = process.env.JWT_SECRET || 'puca_super_secret_key_change_in_production';

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
const mintJwt = (sub, username) => {
    const head = b64u({ alg: 'HS256', typ: 'JWT' });
    const body = b64u({ sub, username, exp: Math.floor(Date.now() / 1000) + 3600 });
    const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
};

async function uploadFile(token, bytes, name = 'blob.bin') {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
    const res = await fetch(`${BASE}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
    });
    let json = null;
    try { json = await res.clone().json(); } catch { /* non-JSON */ }
    return { status: res.status, json };
}

const stamp = Date.now().toString(36);
const aName = `quota_a_${stamp}`, bName = `quota_b_${stamp}`;
const aId = Number(psql1(`INSERT INTO users (username, salt, verifier) VALUES ('${aName}', '\\x00', '\\x00') RETURNING id`));
const bId = Number(psql1(`INSERT INTO users (username, salt, verifier) VALUES ('${bName}', '\\x00', '\\x00') RETURNING id`));
const aTok = mintJwt(aId, aName), bTok = mintJwt(bId, bName);
console.log(`# A=${aName}(${aId})  B=${bName}(${bId})`);

const usage = (uid) => Number(psql1(
    `SELECT COALESCE(SUM(size_bytes),0)::bigint FROM uploaded_files WHERE uploader_id = ${uid}`) || '0');

// --- upload counts against the quota ---------------------------------------
const before = usage(aId);
const payload = Buffer.alloc(64 * 1024, 7);
const up = await uploadFile(aTok, payload);
check('upload succeeds', up.status >= 200 && up.status < 300, JSON.stringify(up));
const fileId = up.json?.id;
check('upload returns a file id', !!fileId, JSON.stringify(up.json));

const afterUpload = usage(aId);
check('usage grew by the uploaded size',
    afterUpload === before + payload.length,
    `before=${before} after=${afterUpload} size=${payload.length}`);

// --- the file is really there ----------------------------------------------
const get1 = await fetch(`${BASE}/files/${fileId}`);
check('uploaded file is fetchable', get1.status === 200, `status=${get1.status}`);

// --- SECURITY: another user cannot delete it -------------------------------
const delByB = await fetch(`${BASE}/files/${fileId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${bTok}` },
});
check('a different user CANNOT delete it (404, no existence oracle)',
    delByB.status === 404, `status=${delByB.status}`);
check("...and B's attempt did not change A's usage", usage(aId) === afterUpload,
    `usage=${usage(aId)} expected=${afterUpload}`);

// --- unauthenticated cannot delete -----------------------------------------
const delAnon = await fetch(`${BASE}/files/${fileId}`, { method: 'DELETE' });
check('unauthenticated DELETE is refused', delAnon.status === 401, `status=${delAnon.status}`);

// --- THE POINT: the owner can reclaim --------------------------------------
const delByA = await fetch(`${BASE}/files/${fileId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${aTok}` },
});
check('owner deletes their own file (204)', delByA.status === 204, `status=${delByA.status}`);

const afterDelete = usage(aId);
check('QUOTA IS RECLAIMED — usage returns to its starting value',
    afterDelete === before, `before=${before} after=${afterDelete}`);

// The DB row must be gone, not just the blob: the quota reads the table.
check('the uploaded_files row is gone',
    psql1(`SELECT count(*) FROM uploaded_files WHERE id = '${fileId}'::uuid`) === '0');

// --- idempotency / already-deleted -----------------------------------------
const delAgain = await fetch(`${BASE}/files/${fileId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${aTok}` },
});
check('deleting again is 404, not a 500', delAgain.status === 404, `status=${delAgain.status}`);

const delGarbage = await fetch(`${BASE}/files/not-a-uuid`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${aTok}` },
});
check('a malformed id is 404, not a 500 (uuid cast must not blow up)',
    delGarbage.status === 404, `status=${delGarbage.status}`);

// --- and the blob is actually unreadable afterwards -------------------------
const get2 = await fetch(`${BASE}/files/${fileId}`);
check('the deleted file is no longer served', get2.status === 404, `status=${get2.status}`);

// --- REFUSE to delete a blob something still points at ----------------------
// `users.avatar_file_id` and `servers.icon_file_id` are plain TEXT with no
// foreign key, so nothing in the database stops a delete from turning a live
// avatar or server icon into a broken image for everyone who can see it.
{
    const up2 = await uploadFile(aTok, Buffer.alloc(2048, 3), 'avatar.png');
    const avatarId = up2.json?.id;
    check('second upload for the in-use test', !!avatarId, JSON.stringify(up2.json));
    psql(`UPDATE users SET avatar_file_id = '${avatarId}' WHERE id = ${aId}`);

    const usageWithAvatar = usage(aId);
    const delInUse = await fetch(`${BASE}/files/${avatarId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${aTok}` },
    });
    check('deleting a file still used as an avatar is REFUSED (409)',
        delInUse.status === 409, `status=${delInUse.status}`);
    check('...and the file really is still there', usage(aId) === usageWithAvatar,
        `usage=${usage(aId)} expected=${usageWithAvatar}`);
    check('...and still served', (await fetch(`${BASE}/files/${avatarId}`)).status === 200);

    // Once nothing references it, the same delete goes through — proving the
    // guard blocks on the REFERENCE, not on something incidental to the file.
    psql(`UPDATE users SET avatar_file_id = NULL WHERE id = ${aId}`);
    const delFreed = await fetch(`${BASE}/files/${avatarId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${aTok}` },
    });
    check('once dereferenced, the same file deletes fine (204)',
        delFreed.status === 204, `status=${delFreed.status}`);
    check('quota reclaimed after dereferencing', usage(aId) === before,
        `usage=${usage(aId)} expected=${before}`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
