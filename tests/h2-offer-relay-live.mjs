// H-2 server half: the backend must RELAY the FileOffer.auth field verbatim to
// the recipient. If it drops it (unknown-field on the struct), the receiver —
// which now REQUIRES the MAC — rejects every transfer. The MAC crypto itself is
// unit-tested in frontend/src/tests/fileOfferAuth.test.ts; this proves the relay.
//
// Usage: PGDB=puca_sec_test PGPORT=5433 node tests/h2-offer-relay-live.mjs
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';

const PGDB = process.env.PGDB || 'puca';
const PGPORT = process.env.PGPORT || '5432';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const JWT_SECRET = 'puca_super_secret_key_change_in_production';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) failures++; };
const psql1 = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-p', PGPORT, '-d', PGDB, '-q', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim().split(/\r?\n/).filter(Boolean)[0] ?? '';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mintJwt = (sub, u) => { const h = b64u({ alg: 'HS256', typ: 'JWT' }); const b = b64u({ sub, username: u, tv: 0, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${b}.${createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url')}`; };

const RUN = Math.random().toString(36).slice(2, 8);
const mkUser = (n) => { const u = `h2_${n}_${RUN}`; const id = parseInt(psql1(`INSERT INTO users (username, salt, verifier, key_version, token_version) VALUES ('${u}','\\x00','\\x00',3,0) RETURNING id`), 10); return { id, username: u, t: mintJwt(id, u) }; };

const A = mkUser('a');
const B = mkUser('b');
// A DM conversation so users_can_dm passes.
psql1(`INSERT INTO dm_conversations (id, user1_id, user2_id) VALUES ('${randomUUID()}', ${A.id}, ${B.id})`);

const open = (user) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:3000/ws?token=${user.t}`);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
});

const run = async () => {
    const wsA = await open(A);
    const wsB = await open(B);
    let relayed = null;
    wsB.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data.toString()); } catch { return; }
        if (m.type === 'FileOffered') relayed = m.payload;
    });
    await new Promise(r => setTimeout(r, 300));

    const AUTH = 'dGhpcy1pcy1hLXRlc3QtbWFj'; // arbitrary base64 stand-in for the MAC
    const transferId = randomUUID();
    wsA.send(JSON.stringify({
        type: 'FileOffer',
        payload: {
            target_user: B.id, transfer_id: transferId,
            name: 'x.bin', size: 10, mime: 'application/octet-stream',
            sha256: 'a'.repeat(64), auth: AUTH,
        },
    }));
    for (let i = 0; i < 20 && !relayed; i++) await new Promise(r => setTimeout(r, 100));
    wsA.close(); wsB.close();

    check('recipient received FileOffered', !!relayed, 'none within 2s');
    check('relayed offer carries the auth MAC verbatim', relayed?.auth === AUTH, `auth=${relayed?.auth}`);
    check('relayed sha256 is intact', relayed?.sha256 === 'a'.repeat(64), `sha256=${relayed?.sha256}`);
};

run().then(() => { console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`); process.exit(failures ? 1 : 0); })
    .catch(e => { console.error(e); process.exit(1); });
