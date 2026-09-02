// Live acceptance for the Batch 6 report/audit-bound + pagination-clamp fixes.
//
// Each check drives the abuse AND the legitimate use of the same endpoint.
// The security assertions FAIL against v0.8.47 (revert-check to confirm).
//
// Covers:
//   M-e  create_report: unbounded reason, unbounded report volume per reporter
//   M-e  kick reason written to audit_log.details unbounded
//   M-f  negative pagination limit returning empty via a swallowed LIMIT -5 error
//
// Prereqs: backend on :3000 against a THROWAWAY db (PGDB + PGPORT must match).
// Usage: PGDB=puca_sec_test PGPORT=5433 node tests/batch6-bounds-live.mjs
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.API || 'http://localhost:3000';
const PGDB = process.env.PGDB || 'puca';
const PGPORT = process.env.PGPORT || '5432';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const JWT_SECRET = 'puca_super_secret_key_change_in_production';

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
    if (!ok) failures++;
};
const psql = (sql) => execFileSync(PSQL,
    ['-U', 'postgres', '-h', 'localhost', '-p', PGPORT, '-d', PGDB, '-q', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();
const psql1 = (sql) => psql(sql).split(/\r?\n/).filter(Boolean)[0] ?? '';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mintJwt = (sub, username) => {
    const head = b64u({ alg: 'HS256', typ: 'JWT' });
    const body = b64u({ sub, username, tv: 0, exp: Math.floor(Date.now() / 1000) + 3600 });
    const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
};
const api = async (method, path, body, token) => {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: (body === undefined || body === null || method === 'GET') ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
};

const RUN = Math.random().toString(36).slice(2, 8);
const mkUser = (name) => {
    const u = `b6_${name}_${RUN}`;
    const id = psql1(`INSERT INTO users (username, salt, verifier, key_version, token_version)
                      VALUES ('${u}', '\\x00', '\\x00', 3, 0) RETURNING id`);
    return { id: parseInt(id, 10), username: u, t: mintJwt(parseInt(id, 10), u) };
};
const mkServer = (ownerId, label) => {
    const sid = randomUUID();
    psql(`INSERT INTO servers (id, name, owner_id) VALUES ('${sid}', '${label}-${RUN}', ${ownerId})`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${sid}', ${ownerId})`);
    const rid = psql1(`INSERT INTO server_roles (server_id, name, color, permissions, position, is_default)
                       VALUES ('${sid}', 'Owner', '#F1C40F', 4194304, 100, false) RETURNING id`);
    psql(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('${sid}', ${ownerId}, ${rid})`);
    const cid = psql1(`INSERT INTO channels (name, type, position, server_id) VALUES ('general', 0, 0, '${sid}') RETURNING id`);
    return { id: sid, roleId: parseInt(rid, 10), channelId: parseInt(cid, 10) };
};

const O = mkUser('owner');       // owner: ADMINISTRATOR -> MANAGE_MESSAGES + KICK
const R = mkUser('reporter');    // a plain member who files reports
const srv = mkServer(O.id, 'modsrv');
psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${srv.id}', ${R.id})`);

console.log(`\n=== M-e: report reason must be length-capped ===`);
{
    const huge = 'x'.repeat(2000);
    const r = await api('POST', `/servers/${srv.id}/reports`,
        { report_type: 'spam', reason: huge }, R.t);
    check('report with a 2000-char reason is rejected', r.status === 413, `status=${r.status}`);
    const ok = await api('POST', `/servers/${srv.id}/reports`,
        { report_type: 'spam', reason: 'normal reason' }, R.t);
    check('report with a normal reason still succeeds', ok.status < 300, `status=${ok.status}`);
}

console.log(`\n=== M-e: report creation is rate-limited per reporter ===`);
{
    // The reporter above already filed 1. Fire enough more to cross the cap (15/hr).
    let firstRefusal = null;
    for (let i = 0; i < 20; i++) {
        const r = await api('POST', `/servers/${srv.id}/reports`,
            { report_type: 'other', reason: `flood ${i}` }, R.t);
        if (r.status === 429 && firstRefusal === null) { firstRefusal = i; break; }
    }
    check('report flood is throttled (429 before 20 succeed)', firstRefusal !== null, `never throttled`);
}

console.log(`\n=== M-e: kick reason (audit_log.details) must be length-capped ===`);
{
    const victim = mkUser('kickme');
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${srv.id}', ${victim.id})`);
    const huge = 'x'.repeat(2000);
    const r = await api('POST', `/servers/${srv.id}/kick/${victim.id}`, { reason: huge }, O.t);
    check('kick with a 2000-char reason is rejected', r.status === 413, `status=${r.status}`);
    const stillMember = psql1(`SELECT count(*) FROM server_members WHERE server_id='${srv.id}' AND user_id=${victim.id}`);
    check('victim was not kicked by the over-long request', stillMember === '1', `rows=${stillMember}`);
    const ok = await api('POST', `/servers/${srv.id}/kick/${victim.id}`, { reason: 'rule 3' }, O.t);
    check('kick with a normal reason still succeeds', ok.status < 300, `status=${ok.status}`);
}

console.log(`\n=== M-f: a negative pagination limit must not swallow the query into empty ===`);
{
    // There is at least one report in this server (created above). A negative
    // limit used to produce `LIMIT -5` -> Postgres error -> unwrap_or_default()
    // -> [] (indistinguishable from "no reports").
    const neg = await api('GET', `/servers/${srv.id}/reports?limit=-5`, null, O.t);
    check('reports?limit=-5 returns 200', neg.status === 200, `status=${neg.status}`);
    check('reports?limit=-5 is NOT empty (clamped, not errored-to-empty)',
        Array.isArray(neg.body) && neg.body.length > 0, `len=${Array.isArray(neg.body) ? neg.body.length : 'n/a'}`);
    // Audit log has entries too (the successful kick above logged one).
    const negA = await api('GET', `/servers/${srv.id}/audit-log?limit=-5`, null, O.t);
    check('audit-log?limit=-5 returns 200', negA.status === 200, `status=${negA.status}`);
    check('audit-log?limit=-5 is NOT empty', Array.isArray(negA.body) && negA.body.length > 0,
        `len=${Array.isArray(negA.body) ? negA.body.length : 'n/a'}`);
}

console.log(`\n=== L8-DOS-2: edit history is capped, and edited_at is written ===`);
{
    // Unbounded before: every successful edit wrote a full copy of the previous
    // body (up to 8000 bytes) with no cap and no pruning anywhere, and
    // get_message_edits then returned all of them in one response.
    const msgId = randomUUID();
    psql(`INSERT INTO messages (id, channel_id, user_id, content) VALUES ('${msgId}', ${srv.channelId}, ${O.id}, 'v0')`);

    let lastStatus = 0;
    for (let i = 1; i <= 25; i++) {
        const r = await api('PATCH', `/channels/${srv.channelId}/messages/${msgId}`, { content: `v${i}` }, O.t);
        lastStatus = r.status;
        if (r.status >= 300) break;
    }
    check('25 consecutive edits all succeed', lastStatus < 300, `last status=${lastStatus}`);

    const rows = psql1(`SELECT count(*) FROM message_edits WHERE message_id='${msgId}'`);
    check('edit history is capped at 10 rows', rows === '10', `rows=${rows}`);

    // The rows kept must be the NEWEST — a cap that kept the ten OLDEST would
    // also read as "10" above.
    const newest = psql1(`SELECT old_content FROM message_edits WHERE message_id='${msgId}'
                          ORDER BY edited_at DESC, id DESC LIMIT 1`);
    check('the ten kept are the most recent', newest === 'v24', `newest=${newest}`);

    // The API view agrees with the table and is DESC.
    const hist = await api('GET', `/channels/${srv.channelId}/messages/${msgId}/edits`, null, O.t);
    check('GET .../edits returns the capped history', Array.isArray(hist.body) && hist.body.length === 10,
        `status=${hist.status} len=${Array.isArray(hist.body) ? hist.body.length : 'n/a'}`);

    // edited_at: dead schema since migrations/001, now written.
    const stamped = psql1(`SELECT count(*) FROM messages WHERE id='${msgId}' AND edited_at IS NOT NULL`);
    check('messages.edited_at is stamped by an edit', stamped === '1', `rows=${stamped}`);

    // ...and it is ADDITIVE: an UNEDITED message must carry no edited_at key at
    // all, so the field cannot change what an old client already parses.
    const freshId = randomUUID();
    psql(`INSERT INTO messages (id, channel_id, user_id, content) VALUES ('${freshId}', ${srv.channelId}, ${O.id}, 'never-edited')`);
    const page = await api('GET', `/channels/${srv.channelId}/messages?limit=50`, null, O.t);
    const fresh = Array.isArray(page.body) ? page.body.find(m => m.id === freshId) : null;
    check('an unedited message serialises with no edited_at key',
        fresh !== null && fresh !== undefined && !('edited_at' in fresh),
        `found=${fresh ? 'yes' : 'no'} keys=${fresh ? Object.keys(fresh).join(',') : 'n/a'}`);
    const edited = Array.isArray(page.body) ? page.body.find(m => m.id === msgId) : null;
    check('an edited message DOES carry edited_at', typeof edited?.edited_at === 'string',
        `edited_at=${edited?.edited_at}`);

    // A REFUSED edit must leave no trace: the history insert and the message
    // update are now one transaction, so a conflict rolls both back.
    const before = psql1(`SELECT count(*) FROM message_edits WHERE message_id='${msgId}'`);
    psql(`UPDATE messages SET content='raced' WHERE id='${msgId}'`);
    const conflict = await api('PATCH', `/channels/${srv.channelId}/messages/${msgId}`, { content: 'v26' }, O.t);
    const after = psql1(`SELECT count(*) FROM message_edits WHERE message_id='${msgId}'`);
    check('an edit that affects zero rows writes no history row', after === before,
        `status=${conflict.status} before=${before} after=${after}`);
}
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
