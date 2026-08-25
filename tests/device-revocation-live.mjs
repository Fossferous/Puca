// Live acceptance for the device-revocation fix (2026-08-20 pre-release audit).
//
// THE BUG: POST /devices/token minted a full ACCOUNT token for a device whose
// `devices.revoked_at` was set. Revocation only stamps that column — the row
// and its `sign_pub` survive — so a revoked machine could answer the challenge
// forever and keep re-minting session tokens. Every other device query filters
// on `revoked_at IS NULL` (device_handlers.rs:196/253/285/346/401/529/601/790/
// 987/1150); `device_token.rs` was the one that forgot, and the enrolment path
// already carries an explicit "A REVOKED device stays revoked" guard for the
// mirror half of the same mistake.
//
// POSITIVE CONTROL: `revoked device is refused a token` FAILS against the
// pre-fix query. Revert `AND d.revoked_at IS NULL` in device_token.rs and it
// goes red — that is the whole point of the file. The live-device checks
// around it exist so a query that refuses EVERYONE cannot pass either.
//
// Prereqs: backend on $API against a THROWAWAY db (PGDB + PGPORT must match).
// Usage: API=http://127.0.0.1:3098 PGDB=puca_audit_e2e PGPORT=5434 \
//        node tests/device-revocation-live.mjs
import { execFileSync } from 'node:child_process';
import { createHmac, generateKeyPairSync, sign as edSign, randomUUID } from 'node:crypto';

const BASE = process.env.API || 'http://localhost:3000';
const PGDB = process.env.PGDB || 'puca';
const PGPORT = process.env.PGPORT || '5432';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const JWT_SECRET = process.env.JWT_SECRET || 'puca_super_secret_key_change_in_production';

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
    if (!ok) failures++;
};
const psql = (sql) => execFileSync(PSQL,
    ['-U', 'postgres', '-h', '127.0.0.1', '-p', PGPORT, '-d', PGDB, '-q', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();
const psql1 = (sql) => psql(sql).split(/\r?\n/).filter(Boolean)[0] ?? '';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mintJwt = (sub, username, tv = 0) => {
    const head = b64u({ alg: 'HS256', typ: 'JWT' });
    const now = Math.floor(Date.now() / 1000);
    const body = b64u({ sub, username, tv, exp: now + 3600, sst: now });
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
    const u = `dr_${name}_${RUN}`;
    const id = psql1(`INSERT INTO users (username, salt, verifier, key_version, token_version)
                      VALUES ('${u}', '\\x00', '\\x00', 3, 0) RETURNING id`);
    return { id: parseInt(id, 10), username: u, t: mintJwt(parseInt(id, 10), u) };
};

// An Ed25519 device identity, in the wire shape ws::verify_device_attestation
// expects: "ed25519:<base64 raw 32-byte public key>", signatures base64 raw 64.
function mkDeviceKeys() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    return { signPub: `ed25519:${raw.toString('base64')}`, privateKey };
}
// Transcript is ws::device_attest_message: sovereign-device-attest-v1|<id>|<uid>
// but the TOKEN path signs the NONCE, not the device id — see device_token.rs.
const attest = (privateKey, nonce, userId) =>
    edSign(null, Buffer.from(`sovereign-device-attest-v1|${nonce}|${userId}`), privateKey).toString('base64');

async function redeem(device, user) {
    const ch = await api('POST', '/devices/token/challenge', { device_id: device.id });
    if (ch.status !== 200 || !ch.body?.nonce) return { status: ch.status, body: ch.body, stage: 'challenge' };
    const sig = attest(device.privateKey, ch.body.nonce, user.id);
    const tok = await api('POST', '/devices/token', { device_id: device.id, nonce: ch.body.nonce, sig });
    return { ...tok, stage: 'token' };
}

(async () => {
    const U = mkUser('owner');
    const keys = mkDeviceKeys();
    const devicePub = `x25519:${Buffer.from(randomUUID().replace(/-/g, ''), 'hex').toString('base64')}`;

    // Seeded directly, like every other harness here: POST /devices demands an
    // auth_record signed by the ACCOUNT key, which is derived from the E2EE
    // seed and so is not available to a minted-JWT harness. The route under
    // test reads the row, not the enrolment path, so this is the same fixture
    // either way — and it keeps the test pointed at the one query that changed.
    const deviceId = `dev-${RUN}-${randomUUID().slice(0, 8)}`;
    psql(`INSERT INTO devices (id, user_id, device_pub, sign_pub, name, platform, auth_record, auth_sig)
          VALUES ('${deviceId}', ${U.id}, '${devicePub}', '${keys.signPub}', 'audit-probe', 'windows', 'seeded', 'seeded')`);
    check('setup: device row seeded live',
        psql1(`SELECT revoked_at IS NULL FROM devices WHERE id = '${deviceId}'`) === 't');
    const device = { id: deviceId, privateKey: keys.privateKey };

    // --- CONTROL: a LIVE device must still get a token. Without this, a query
    // that refused every device would pass the security assertion below. ---
    const live = await redeem(device, U);
    check('control: a LIVE device is issued a token', live.status === 200 && !!live.body?.token,
        `stage=${live.stage} status=${live.status} ${JSON.stringify(live.body).slice(0, 200)}`);
    check('control: that token carries the account subject',
        (() => {
            if (!live.body?.token) return false;
            const c = JSON.parse(Buffer.from(live.body.token.split('.')[1], 'base64url').toString());
            return c.sub === U.id;
        })(), 'the minted token is a full account token — which is why revocation must gate it');

    // --- REVOKE, the way the Devices tab does (device_handlers.rs:400). ---
    psql(`UPDATE devices SET revoked_at = NOW() WHERE id = '${deviceId}'`);
    const stamped = psql1(`SELECT revoked_at IS NOT NULL FROM devices WHERE id = '${deviceId}'`);
    check('setup: revocation stamped the row', stamped === 't', `got '${stamped}'`);
    check('setup: the signing key SURVIVES revocation (why this bug was reachable)',
        psql1(`SELECT sign_pub <> '' FROM devices WHERE id = '${deviceId}'`) === 't');

    // --- THE POSITIVE CONTROL. Red against the pre-fix query. ---
    const after = await redeem(device, U);
    check('SECURITY: a REVOKED device is refused an account token',
        !(after.stage === 'token' && after.status === 200 && after.body?.token),
        `stage=${after.stage} status=${after.status} ${JSON.stringify(after.body).slice(0, 200)}`);
    check('SECURITY: the refusal does not disclose that the device id exists',
        after.stage !== 'token' || typeof after.body !== 'string' || !/revoked/i.test(after.body),
        `leaked: ${JSON.stringify(after.body).slice(0, 200)}`);

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
})();
