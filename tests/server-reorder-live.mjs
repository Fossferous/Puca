// Live acceptance for per-user server-rail reordering (migration 036,
// PATCH /servers/reorder). Same minted-JWT harness as the other live tests.
// Prereqs: native Postgres + backend (:3000) up. Usage: node tests/server-reorder-live.mjs
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const BASE = process.env.API || 'http://localhost:3000';
// PGDB must name the SAME database the backend at BASE is using, and per the
// working agreement that must be a THROWAWAY one — this harness inserts users
// directly. Hardcoding the dev DB made a compliant run impossible without
// editing the file; a mismatch 401s every call (the token_version lookup finds
// no user), which reads exactly like a permission bug.
const PGDB = process.env.PGDB || 'puca';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const JWT_SECRET = 'puca_super_secret_key_change_in_production';

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
    if (!ok) failures++;
};
const psql1 = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-d', PGDB, '-q', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim().split(/\r?\n/).filter(Boolean)[0] ?? '';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mintJwt = (sub, username) => {
    const head = b64u({ alg: 'HS256', typ: 'JWT' });
    const body = b64u({ sub, username, exp: Math.floor(Date.now() / 1000) + 3600 });
    const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
};
const api = (token) => async (method, path, body) => {
    const res = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.clone().json(); } catch { /* non-JSON */ }
    return { status: res.status, json };
};

const stamp = Date.now().toString(36);
const uid = Number(psql1(`INSERT INTO users (username, salt, verifier) VALUES ('reord_${stamp}', '\\x00', '\\x00') RETURNING id`));
const me = api(mintJwt(uid, `reord_${stamp}`));

// Three servers, created in order A,B,C (default list order = created_at).
const ids = [];
for (const n of ['A', 'B', 'C']) {
    const r = await me('POST', '/servers', { name: `Reorder${n} ${stamp}` });
    ids.push(r.json?.id);
}
check('three servers created', ids.every(Boolean));

let list = await me('GET', '/servers');
const names = (l) => l.json.filter(s => s.name.includes(stamp)).map(s => s.name.split(' ')[0]);
check('default order is creation order', JSON.stringify(names(list)) === JSON.stringify(['ReorderA', 'ReorderB', 'ReorderC']), JSON.stringify(names(list)));

// Reorder to C, A, B and confirm the list endpoint honors it.
let r = await me('PATCH', '/servers/reorder', { server_ids: [ids[2], ids[0], ids[1]] });
check('reorder accepted', r.status === 200, `got ${r.status}`);
list = await me('GET', '/servers');
check('list honors saved order', JSON.stringify(names(list)) === JSON.stringify(['ReorderC', 'ReorderA', 'ReorderB']), JSON.stringify(names(list)));

// A second user in one of those servers is unaffected (per-user order).
const uid2 = Number(psql1(`INSERT INTO users (username, salt, verifier) VALUES ('reord2_${stamp}', '\\x00', '\\x00') RETURNING id`));
psql1(`INSERT INTO server_members (server_id, user_id) VALUES ('${ids[0]}', ${uid2})`);
psql1(`INSERT INTO server_members (server_id, user_id) VALUES ('${ids[2]}', ${uid2})`);
const other = api(mintJwt(uid2, `reord2_${stamp}`));
const otherList = await other('GET', '/servers');
check('other user sees their own (join-date) order', JSON.stringify(names(otherList)) === JSON.stringify(['ReorderA', 'ReorderC']), JSON.stringify(names(otherList)));

// Oversized request bounded.
r = await me('PATCH', '/servers/reorder', { server_ids: Array.from({ length: 201 }, (_, i) => String(i)) });
check('oversized reorder rejected (400)', r.status === 400, `got ${r.status}`);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
