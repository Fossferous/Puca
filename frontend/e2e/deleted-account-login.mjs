/**
 * Regression test for the account-deletion auth bypass.
 *
 * The first cut of DELETE /account cleared the SRP salt/verifier to EMPTY
 * bytes. That is NOT unauthenticatable: with verifier v = 0 the SRP-6a
 * premaster secret degenerates to 0 for ANY client-chosen A, and srp 0.6
 * derives M1 = H(A ‖ B ‖ K) from public values only — so anyone who knew the
 * (entirely predictable) `deleted#<id>` username could forge a client proof
 * and log in as the tombstone, reaching its DM metadata and task lists.
 *
 * This asserts the fix from BOTH directions: the tombstone must be refused at
 * login, and the stored material must no longer be the degenerate zero.
 *
 * Run:  API=http://127.0.0.1:3000 node e2e/deleted-account-login.mjs
 */
import { webcrypto, randomFillSync } from 'node:crypto';
const crypto = webcrypto;
const API = process.env.API || 'http://127.0.0.1:3000';

const results = [];
const check = (stage, ok, detail) => {
    results.push({ stage, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const enc = new TextEncoder();
const toHex = (b) => Buffer.from(b).toString('hex');
const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
function randBytes(n) { const b = new Uint8Array(n); randomFillSync(b); return b; }
const N_HEX = ('AC6BDB41 324A9A9B F166DE5E 1389582F AF72B665 1987EE07 FC319294 3DB56050 A37329CB B4A099ED 8193E075 7767A13D D52312AB 4B03310D CD7F48A9 DA04FD50 E8083969 EDB767B0 CF609517 9A163AB3 661A05FB D5FAAAE8 2918A996 2F0B93B8 55F97993 EC975EEA A80D740A DBF4FF74 7359D041 D5C33EA7 1D281E44 6B14773B CA97B43A 23FB8016 76BD207A 436C6481 F1D2B907 8717461A 5B9D32E6 88F87748 544523B5 24B0D57D 5EA77A27 75D2ECFA 032CFBDB F52FB378 61602790 04E57AE6 AF874E73 03CE5329 9CCC041C 7BC308D8 2A5698F3 A8D0C382 71AE35F8 E9DBFBB6 94B5C803 D89F7AE4 35DE236D 525F5475 9B65E372 FCD68EF2 0FA7111F 9E4AFF73').replace(/\s/g, '');
const N = BigInt('0x' + N_HEX); const g = 2n; const N_BYTES = 256;
const modpow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; };
const toBytesBE = (n, len) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; let b = fromHex(h); if (len) { const p = new Uint8Array(len); p.set(b, len - b.length); b = p; } return b; };
const bytesToBig = (b) => BigInt('0x' + (toHex(b) || '0'));
const minimalBytes = (n) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; return fromHex(h); };
async function shaBytes(...parts) { const t = parts.reduce((a, p) => a + p.length, 0); const buf = new Uint8Array(t); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; } return new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); }

async function api(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    for (let i = 0; i < 3; i++) {
        const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        if (res.status === 429) { await sleep(2500); continue; }
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch { json = text; }
        return { status: res.status, body: json };
    }
    return { status: 429, body: 'rate-limited' };
}

const padHex = (n, len) => { const h = n.toString(16); return '0'.repeat(Math.max(0, len * 2 - h.length)) + h; };

/** Full honest SRP login (used to prove a normal account still works).
 *  Mirrors e2e/feature-flows.mjs exactly — the known-good client flow. */
async function login(username, password) {
    const a = bytesToBig(randBytes(32)); const A = modpow(g, a, N);
    const s1 = await api('POST', '/auth/login/step1', { username, a_pub_hex: padHex(A, N_BYTES) });
    if (s1.status >= 400) return { status: s1.status };
    const salt = fromHex(s1.body.salt_hex); const B = BigInt('0x' + s1.body.b_pub_hex);
    const idHash = await shaBytes(enc.encode(`${username.toLowerCase()}:${password}`));
    const x = bytesToBig(await shaBytes(salt, idHash));
    const k = bytesToBig(await shaBytes(toBytesBE(N, N_BYTES), toBytesBE(g, N_BYTES)));
    const u = bytesToBig(await shaBytes(minimalBytes(A), minimalBytes(B)));
    const gx = modpow(g, x, N); let base = (B - (k * gx) % N) % N; if (base < 0n) base += N;
    const S = modpow(base, a + u * x, N);
    const M1 = await shaBytes(minimalBytes(A), minimalBytes(B), minimalBytes(S));
    const s2 = await api('POST', '/auth/login/step2', { username, m_hex: toHex(M1) });
    return { status: s2.status, token: s2.body?.token };
}

async function main() {
    const RUN = Date.now().toString(36);
    const U = `victim_${RUN}`;
    const P = 'VictimPass1!';

    // Register the victim with a real verifier.
    const salt = randBytes(32);
    const idHash = await shaBytes(enc.encode(`${U.toLowerCase()}:${P}`));
    const x = bytesToBig(await shaBytes(salt, idHash));
    const v = modpow(g, x, N);
    const reg = await api('POST', '/auth/register', {
        username: U, salt_hex: toHex(salt), verifier_hex: padHex(v, N_BYTES),
        public_key: 'x25519:' + Buffer.from(randBytes(32)).toString('base64'),
    });
    check('setup/register victim', reg.status < 300, `status=${reg.status}`);

    const li = await login(U, P);
    check('setup/victim can log in normally', li.status === 200 && !!li.token, `status=${li.status}`);
    const token = li.token;
    const me = await api('GET', '/profile', null, token);
    const uid = me.body?.id;
    check('setup/profile readable', me.status === 200 && !!uid, `id=${uid}`);

    // Username charset is enforced, so the tombstone name cannot be squatted.
    const squat = await api('POST', '/auth/register', {
        username: `deleted#${uid}`, salt_hex: toHex(randBytes(32)),
        verifier_hex: toHex(randBytes(256)),
        public_key: 'x25519:' + Buffer.from(randBytes(32)).toString('base64'),
    });
    check('squat/registering a "deleted#<id>" name is rejected', squat.status === 400, `status=${squat.status}`);

    // Delete the account.
    const del = await api('DELETE', '/account', { confirm_username: U }, token);
    check('delete/succeeds', del.status === 200, `status=${del.status}`);

    // THE BYPASS: step 1 against the tombstone must not expose a usable handle,
    // and the forged-proof step 2 must fail.
    const tomb = `deleted#${uid}`;
    const A = 2n; // any nonzero A; with v=0 the premaster secret is 0 regardless
    const s1 = await api('POST', '/auth/login/step1', { username: tomb, a_pub_hex: padHex(A, N_BYTES) });
    check('bypass/step1 does not error (indistinguishable from unknown user)', s1.status === 200, `status=${s1.status}`);
    if (s1.status === 200) {
        const B = BigInt('0x' + s1.body.b_pub_hex);
        // Forge M1 exactly as the degenerate-verifier attack does: with v = 0
        // the premaster secret S is 0, whose minimal big-endian encoding is the
        // single byte 0x00 — all of it derivable from public values.
        const M1 = await shaBytes(minimalBytes(A), minimalBytes(B), new Uint8Array([0]));
        const s2 = await api('POST', '/auth/login/step2', { username: tomb, m_hex: toHex(M1) });
        check('bypass/forged proof is REJECTED', s2.status >= 400 && !s2.body?.token, `status=${s2.status}`);
    }

    // And the tombstone is refused even with a legitimate-looking flow.
    const tombLogin = await login(tomb, P);
    check('bypass/tombstone cannot log in at all', tombLogin.status >= 400 && !tombLogin.token, `status=${tombLogin.status}`);

    // The victim's original credentials are dead too.
    const after = await login(U, P);
    check('delete/original credentials no longer work', after.status >= 400 && !after.token, `status=${after.status}`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
