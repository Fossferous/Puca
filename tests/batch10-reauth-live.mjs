// Live acceptance for the Batch 10 re-auth requirement (2026-08-10 audit).
//
// Credential and key-custody rewrites used to accept a BARE bearer token, so a
// stolen JWT could set an attacker-chosen SRP verifier (complete account
// takeover — change_password then bumps token_version and evicts the real
// owner) or overwrite the wrapped identity seed. They now require a RECENT SRP
// password proof, recorded only by login_step_2.
//
// Both halves are asserted, because a gate that refused everyone would "pass" a
// one-sided test AND would have broken password changes for every user:
//   - a minted/stolen token with no proof is REFUSED (401)
//   - the same call right after a real SRP login SUCCEEDS
//
// SRP-6a client is the same construction as e2e/e2ee-live-verify.mjs.
// Prereqs: backend on :3000 against a THROWAWAY db.
// Usage: PGDB=puca_sec_test PGPORT=5433 node tests/batch10-reauth-live.mjs
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes as nodeRandomBytes, webcrypto } from 'node:crypto';

const crypto = webcrypto;
const API = process.env.API || 'http://localhost:3000';
const PGDB = process.env.PGDB || 'puca';
const PGPORT = process.env.PGPORT || '5432';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const JWT_SECRET = 'puca_super_secret_key_change_in_production';

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
    if (!ok) failures++;
};
const psql1 = (sql) => execFileSync(PSQL,
    ['-U', 'postgres', '-h', 'localhost', '-p', PGPORT, '-d', PGDB, '-q', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim().split(/\r?\n/).filter(Boolean)[0] ?? '';

const enc = new TextEncoder();
const toHex = (b) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array((h.match(/.{1,2}/g) || []).map(x => parseInt(x, 16)));
const toB64 = (b) => Buffer.from(b).toString('base64');
const randomBytes = (n) => new Uint8Array(nodeRandomBytes(n));

// ---------- SRP-6a (faithful to auth.ts / the rust srp crate) ----------
const N_HEX = ('AC6BDB41 324A9A9B F166DE5E 1389582F AF72B665 1987EE07 FC319294 3DB56050 A37329CB B4A099ED 8193E075 7767A13D D52312AB 4B03310D CD7F48A9 DA04FD50 E8083969 EDB767B0 CF609517 9A163AB3 661A05FB D5FAAAE8 2918A996 2F0B93B8 55F97993 EC975EEA A80D740A DBF4FF74 7359D041 D5C33EA7 1D281E44 6B14773B CA97B43A 23FB8016 76BD207A 436C6481 F1D2B907 8717461A 5B9D32E6 88F87748 544523B5 24B0D57D 5EA77A27 75D2ECFA 032CFBDB F52FB378 61602790 04E57AE6 AF874E73 03CE5329 9CCC041C 7BC308D8 2A5698F3 A8D0C382 71AE35F8 E9DBFBB6 94B5C803 D89F7AE4 35DE236D 525F5475 9B65E372 FCD68EF2 0FA7111F 9E4AFF73').replace(/\s/g, '');
const N = BigInt('0x' + N_HEX);
const g = 2n;
const N_BYTES = 256;
const modpow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; };
const toBytesBE = (n, len) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; let b = fromHex(h); if (len) { const p = new Uint8Array(len); p.set(b, len - b.length); b = p; } return b; };
const bytesToBig = (b) => BigInt('0x' + (toHex(b) || '0'));
const minimalBytes = (n) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; return fromHex(h); };
const padHex = (n, len) => { let h = n.toString(16); return '0'.repeat(Math.max(0, len * 2 - h.length)) + h; };
async function shaBytes(...parts) {
    const tot = parts.reduce((a, p) => a + p.length, 0);
    const buf = new Uint8Array(tot); let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}
const computeIdentityHash = (u, p) => shaBytes(enc.encode(`${u.toLowerCase()}:${p}`));
const computeX = async (salt, idHash) => bytesToBig(await shaBytes(salt, idHash));
const computeK = async () => bytesToBig(await shaBytes(toBytesBE(N, N_BYTES), toBytesBE(g, N_BYTES)));
const computeU = async (A, B) => bytesToBig(await shaBytes(minimalBytes(A), minimalBytes(B)));

const api = async (method, path, body, token) => {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
};

const WRAP_ITERS = 210000;
async function pbkdf2Kek(password, saltB64, iters) {
    const salt = Uint8Array.from(Buffer.from(saltB64, 'base64'));
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, base, 256));
}
async function aesEncrypt(keyBytes, plaintextB64) {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const iv = randomBytes(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintextB64)));
    return `${toB64(iv)}.${toB64(ct)}`;
}

async function registerUser(username, password) {
    const salt = randomBytes(32);
    const x = await computeX(salt, await computeIdentityHash(username, password));
    const v = modpow(g, x, N);
    const seed = randomBytes(32);
    const wrapSalt = randomBytes(16);
    const kek = await pbkdf2Kek(password, toB64(wrapSalt), WRAP_ITERS);
    const wrapped = await aesEncrypt(kek, toB64(seed));
    const r = await api('POST', '/auth/register', {
        username, salt_hex: toHex(salt), verifier_hex: padHex(v, N_BYTES),
        public_key: 'x25519:' + toB64(randomBytes(32)),
        wrap_salt: toB64(wrapSalt), recovery_salt: toB64(randomBytes(16)),
        seed_wrapped_pw: wrapped, seed_wrapped_rc: wrapped,
        pw_kdf_iterations: WRAP_ITERS,
    });
    if (r.status >= 300) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
    return { username, password, wrapSalt: toB64(wrapSalt), wrapped };
}

/** Full SRP login — this is what records the server-side password proof. */
async function loginUser(username, password) {
    const a = bytesToBig(randomBytes(32));
    const A = modpow(g, a, N);
    const s1 = await api('POST', '/auth/login/step1', { username, a_pub_hex: padHex(A, N_BYTES) });
    if (s1.status >= 300) throw new Error(`step1 failed: ${s1.status}`);
    const salt = fromHex(s1.body.salt_hex);
    const B = BigInt('0x' + s1.body.b_pub_hex);
    const u = await computeU(A, B);
    const k = await computeK();
    const x = await computeX(salt, await computeIdentityHash(username, password));
    const gx = modpow(g, x, N);
    let base = (B - (k * gx) % N) % N; if (base < 0n) base += N;
    const S = modpow(base, a + u * x, N);
    const M1 = await shaBytes(minimalBytes(A), minimalBytes(B), minimalBytes(S));
    const s2 = await api('POST', '/auth/login/step2', {
        username, m_hex: toHex(M1), ...(s1.body.attempt_id ? { attempt_id: s1.body.attempt_id } : {}),
    });
    if (s2.status >= 300) throw new Error(`step2 failed: ${s2.status} ${JSON.stringify(s2.body)}`);
    return s2.body.token;
}

/** A token minted directly from the signing key — i.e. a STOLEN one: valid, but
 *  its holder never proved the password to this server. */
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mintStolenToken = (sub, username, tv) => {
    const head = b64u({ alg: 'HS256', typ: 'JWT' });
    const body = b64u({ sub, username, tv, exp: Math.floor(Date.now() / 1000) + 3600 });
    return `${head}.${body}.${createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')}`;
};

const RUN = Math.random().toString(36).slice(2, 8);
const changePasswordBody = (wrapSalt, wrapped) => ({
    new_salt_hex: toHex(randomBytes(32)),
    new_verifier_hex: padHex(modpow(g, 12345n, N), N_BYTES),
    new_wrap_salt: wrapSalt,
    new_seed_wrapped_pw: wrapped,
    new_pw_kdf_iterations: WRAP_ITERS,
    new_pw_kdf: 'pbkdf2',
});

console.log(`\n=== a STOLEN token (no password proof) must not rewrite credentials ===`);
{
    const u = await registerUser(`b10_a_${RUN}`, 'CorrectHorse1!');
    const id = parseInt(psql1(`SELECT id FROM users WHERE username = '${u.username}'`), 10);
    const tv = parseInt(psql1(`SELECT token_version FROM users WHERE id = ${id}`), 10) || 0;
    const stolen = mintStolenToken(id, u.username, tv);

    const verifierBefore = psql1(`SELECT encode(verifier, 'hex') FROM users WHERE id = ${id}`);

    const r = await api('POST', '/keys/change-password', changePasswordBody(u.wrapSalt, u.wrapped), stolen);
    check('change-password refused without a password proof', r.status === 401, `status=${r.status}`);
    const verifierAfter = psql1(`SELECT encode(verifier, 'hex') FROM users WHERE id = ${id}`);
    check('SRP verifier is UNCHANGED (no takeover)', verifierBefore === verifierAfter,
        `before=${verifierBefore.slice(0, 16)} after=${verifierAfter.slice(0, 16)}`);

    // A SEPARATE user/token for the rewrap probe. Sharing the one above makes
    // this assertion pass for the wrong reason whenever the gate is off: the
    // change-password attempt then SUCCEEDS, bumping token_version, so the
    // second call 401s on stale-token auth rather than on the missing proof —
    // a green light that proves nothing. (Caught by the revert-check.)
    const u2 = await registerUser(`b10_a2_${RUN}`, 'CorrectHorse3!');
    const id2 = parseInt(psql1(`SELECT id FROM users WHERE username = '${u2.username}'`), 10);
    const tv2 = parseInt(psql1(`SELECT token_version FROM users WHERE id = ${id2}`), 10) || 0;
    const stolen2 = mintStolenToken(id2, u2.username, tv2);

    const rw = await api('POST', '/keys/rewrap', {
        wrap_salt: u2.wrapSalt, recovery_salt: u2.wrapSalt,
        seed_wrapped_pw: 'attacker.blob', seed_wrapped_rc: 'attacker.blob',
        pw_kdf_iterations: WRAP_ITERS, pw_kdf: 'pbkdf2',
    }, stolen2);
    check('key-custody rewrap refused without a password proof', rw.status === 401, `status=${rw.status}`);
    const seedNow = psql1(`SELECT seed_wrapped_pw FROM users WHERE id = ${id2}`);
    check('wrapped seed is UNCHANGED (owner not locked out)', seedNow !== 'attacker.blob', `seed=${seedNow.slice(0, 20)}`);
}

console.log(`\n=== the SAME calls SUCCEED right after a real SRP login ===`);
{
    const u = await registerUser(`b10_b_${RUN}`, 'CorrectHorse2!');
    const id = parseInt(psql1(`SELECT id FROM users WHERE username = '${u.username}'`), 10);

    // Key custody rewrite with a freshly-proven password — the login-time path.
    const token = await loginUser(u.username, u.password);
    const rw = await api('POST', '/keys/rewrap-pw', {
        wrap_salt: u.wrapSalt, seed_wrapped_pw: u.wrapped,
        pw_kdf_iterations: WRAP_ITERS, pw_kdf: 'pbkdf2',
    }, token);
    check('rewrap-pw succeeds after SRP login', rw.status < 300, `status=${rw.status} body=${JSON.stringify(rw.body).slice(0, 80)}`);

    // And a genuine password change still works end to end.
    const verifierBefore = psql1(`SELECT encode(verifier, 'hex') FROM users WHERE id = ${id}`);
    const cp = await api('POST', '/keys/change-password', changePasswordBody(u.wrapSalt, u.wrapped), token);
    check('change-password succeeds after SRP login', cp.status < 300, `status=${cp.status} body=${JSON.stringify(cp.body).slice(0, 80)}`);
    const verifierAfter = psql1(`SELECT encode(verifier, 'hex') FROM users WHERE id = ${id}`);
    check('SRP verifier WAS rewritten (the feature still works)', verifierBefore !== verifierAfter,
        `before=${verifierBefore.slice(0, 16)} after=${verifierAfter.slice(0, 16)}`);

    // The proof is consumed, so the window cannot authorise a second rewrite.
    const again = await api('POST', '/keys/change-password', changePasswordBody(u.wrapSalt, u.wrapped), token);
    check('a second rewrite in the same window is refused (proof consumed)', again.status === 401, `status=${again.status}`);
}

console.log(`\n=== L8-DATA-2: a successful login stores NO session-key row ===`);
{
    // login_step_2 used to INSERT the raw SRP session key into `sessions`
    // (BYTEA, never read, never pruned, surviving account deletion) on every
    // successful login. The write is gone; the login response must be exactly
    // what it was.
    // 0.9.1 (migration 058) dropped the table outright — the rows were live
    // secrets — so the assertion is now that it does not exist at all.
    const u = await registerUser(`b10_sess_${RUN}`, 'CorrectHorse1!');
    const token = await loginUser(u.username, 'CorrectHorse1!');
    check('SRP login still succeeds and returns a token',
        typeof token === 'string' && token.split('.').length === 3, `token=${String(token).slice(0, 24)}`);
    const tables = psql1(`SELECT count(*) FROM information_schema.tables WHERE table_name = 'sessions'`);
    check('the sessions table no longer exists (migration 058), so no login can write to it', tables === '0', `tables=${tables}`);

    // Positive control: the token really authenticates, so "no row written"
    // cannot be passing because the login silently failed.
    const me = await api('GET', '/servers', null, token);
    check('the token from that login is accepted', me.status === 200, `status=${me.status}`);
}
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
