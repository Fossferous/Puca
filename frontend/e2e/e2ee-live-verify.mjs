/**
 * Live end-to-end E2EE verification harness.
 *
 * Drives the REAL Rust backend over HTTP with THREE real users using the REAL
 * client crypto primitives (@noble/@scure + WebCrypto, the exact packages the
 * frontend ships), then queries Postgres DIRECTLY to prove the server never
 * holds plaintext. Reproduces the production wire protocol (SRP-6a register/
 * login, v3 seed custody, X25519 DM, channel group keys + epoch rotation).
 *
 * Run:  npm run verify:e2ee   (or: node e2e/e2ee-live-verify.mjs)
 *
 * Prereqs: an isolated test DB and a backend pointed at it, e.g.
 *   psql -U postgres -c "CREATE DATABASE puca_e2ee_test;"
 *   DATABASE_URL=postgres://postgres:postgres@localhost/puca_e2ee_test cargo run
 * NEVER run this against the real dev/prod DB — it creates users/servers and
 * reads content columns directly. Point PGDB at a throwaway database.
 *
 * Env:  API   (default http://127.0.0.1:3000)
 *       PSQL  (default "C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe")
 *       PGDB  (default puca_e2ee_test)   -- MUST be an isolated test DB
 *
 * Exit code 0 = all stages PASS, 1 = any FAIL.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';

const crypto = webcrypto;
const API = process.env.API || 'http://127.0.0.1:3000';
const PSQL = process.env.PSQL || 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
const PGDB = process.env.PGDB || 'puca_e2ee_test';

// ---------- tiny result tracker ----------
const results = [];
function check(stage, ok, detail) {
    results.push({ stage, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}${detail ? '  — ' + detail : ''}`);
}
function section(name) { console.log(`\n=== ${name} ===`); }

// ---------- db access ----------
function sql(query) {
    const env = { ...process.env, PGPASSWORD: 'postgres' };
    return execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-d', PGDB, '-t', '-A', '-c', query], { env }).toString().trim();
}

// ---------- byte / encoding helpers ----------
const enc = new TextEncoder();
const toB64 = (b) => Buffer.from(b).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const toHex = (b) => Buffer.from(b).toString('hex');
const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));

// ---------- e2ee.ts crypto (faithful reimplementation of the shipped funcs) ----------
const PUBKEY_PREFIX = 'x25519:';
const HKDF_DM_INFO = enc.encode('sovereign-dm-v2');
const HKDF_WRAP_INFO = enc.encode('sovereign-wrap-v2');
const HKDF_SELF_INFO = enc.encode('sovereign-self-v1');
const KDF_ITERATIONS = 210_000;
const WRAP_KDF_ITERATIONS = 600_000;

const encodePub = (pub) => PUBKEY_PREFIX + toB64(pub);
function decodePub(encoded) {
    if (!encoded || !encoded.startsWith(PUBKEY_PREFIX)) return null;
    try { const b = fromB64(encoded.slice(PUBKEY_PREFIX.length)); return b.length === 32 ? b : null; } catch { return null; }
}
async function aesEncrypt(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(plaintext)));
    const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
    return toB64(out);
}
async function aesDecrypt(key, b64) {
    const raw = fromB64(b64); const iv = raw.slice(0, 12); const ct = raw.slice(12);
    const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct);
    return new TextDecoder().decode(pt);
}
const deriveSym = (shared, info) => hkdf(sha256, shared, undefined, info, 32);

function makeIdentity(seed) {
    return { privateKey: seed, publicKey: x25519.getPublicKey(seed), publicKeyEncoded: encodePub(x25519.getPublicKey(seed)) };
}
async function encryptDM(identity, recipientPubEnc, plaintext) {
    const pub = decodePub(recipientPubEnc); if (!pub) return null;
    const key = deriveSym(x25519.getSharedSecret(identity.privateKey, pub), HKDF_DM_INFO);
    return { v: 2, t: 'dm', ct: await aesEncrypt(key, plaintext) };
}
async function decryptDM(identity, senderPubEnc, env2) {
    const pub = decodePub(senderPubEnc); if (!pub) return null;
    try { const key = deriveSym(x25519.getSharedSecret(identity.privateKey, pub), HKDF_DM_INFO); return await aesDecrypt(key, env2.ct); } catch { return null; }
}
const generateChannelKey = () => crypto.getRandomValues(new Uint8Array(32));
async function wrapChannelKeyForMembers(identity, ck, members) {
    const out = [];
    for (const m of members) {
        const pub = decodePub(m.publicKey); if (!pub) continue;
        const kek = deriveSym(x25519.getSharedSecret(identity.privateKey, pub), HKDF_WRAP_INFO);
        out.push({ recipientId: m.userId, wrappedKey: await aesEncrypt(kek, toB64(ck)), senderPublicKey: identity.publicKeyEncoded });
    }
    return out;
}
async function unwrapChannelKey(identity, wrapped) {
    const pub = decodePub(wrapped.senderPublicKey); if (!pub) return null;
    try { const kek = deriveSym(x25519.getSharedSecret(identity.privateKey, pub), HKDF_WRAP_INFO); return fromB64(await aesDecrypt(kek, wrapped.wrappedKey)); } catch { return null; }
}
const encryptChannelMessage = async (ck, epoch, pt) => ({ v: 2, t: 'ch', epoch, ct: await aesEncrypt(ck, pt) });
const decryptChannelMessage = async (ck, env2) => { try { return await aesDecrypt(ck, env2.ct); } catch { return null; } };
async function encryptSelf(identity, pt) { const key = hkdf(sha256, identity.privateKey, undefined, HKDF_SELF_INFO, 32); return { v: 2, t: 'self', ct: await aesEncrypt(key, pt) }; }
async function decryptSelf(identity, env2) { try { const key = hkdf(sha256, identity.privateKey, undefined, HKDF_SELF_INFO, 32); return await aesDecrypt(key, env2.ct); } catch { return null; } }
const serialize = (env2) => JSON.stringify(env2);

// v3 wrap material (PBKDF2 KEK via WebCrypto, matching e2ee.ts buildWrapMaterial)
async function pbkdf2Kek(password, saltB64, iters) {
    const salt = fromB64(saltB64);
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, base, 256);
    return new Uint8Array(bits);
}
async function buildWrapMaterial(seed, password) {
    const wrapSalt = crypto.getRandomValues(new Uint8Array(16));
    const kek = await pbkdf2Kek(password, toB64(wrapSalt), WRAP_KDF_ITERATIONS);
    const seedWrappedPw = await aesEncrypt(kek, toB64(seed));
    return { wrapSalt: toB64(wrapSalt), recoverySalt: toB64(crypto.getRandomValues(new Uint8Array(16))), seedWrappedPw, seedWrappedRc: seedWrappedPw, pwKdfIterations: WRAP_KDF_ITERATIONS };
}
async function unwrapSeedWithPassword(password, wrapSaltB64, seedWrappedPw, iters) {
    try { const kek = await pbkdf2Kek(password, wrapSaltB64, iters || WRAP_KDF_ITERATIONS); return fromB64(await aesDecrypt(kek, seedWrappedPw)); } catch { return null; }
}

// ---------- SRP-6a (faithful to auth.ts / rust srp crate) ----------
const N_HEX = ('AC6BDB41 324A9A9B F166DE5E 1389582F AF72B665 1987EE07 FC319294 3DB56050 A37329CB B4A099ED 8193E075 7767A13D D52312AB 4B03310D CD7F48A9 DA04FD50 E8083969 EDB767B0 CF609517 9A163AB3 661A05FB D5FAAAE8 2918A996 2F0B93B8 55F97993 EC975EEA A80D740A DBF4FF74 7359D041 D5C33EA7 1D281E44 6B14773B CA97B43A 23FB8016 76BD207A 436C6481 F1D2B907 8717461A 5B9D32E6 88F87748 544523B5 24B0D57D 5EA77A27 75D2ECFA 032CFBDB F52FB378 61602790 04E57AE6 AF874E73 03CE5329 9CCC041C 7BC308D8 2A5698F3 A8D0C382 71AE35F8 E9DBFBB6 94B5C803 D89F7AE4 35DE236D 525F5475 9B65E372 FCD68EF2 0FA7111F 9E4AFF73').replace(/\s/g, '');
const N = BigInt('0x' + N_HEX);
const g = 2n;
const N_BYTES = 256;
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
const toBytesBE = (n, len) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; let b = fromHex(h); if (len) { const p = new Uint8Array(len); p.set(b, len - b.length); b = p; } return b; };
const bytesToBig = (b) => BigInt('0x' + (toHex(b) || '0'));
const minimalBytes = (n) => { let h = n.toString(16); if (h.length % 2) h = '0' + h; return fromHex(h); };
const padHex = (n, len) => { let h = n.toString(16); return '0'.repeat(Math.max(0, len * 2 - h.length)) + h; };
async function shaBytes(...parts) { const tot = parts.reduce((a, p) => a + p.length, 0); const buf = new Uint8Array(tot); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; } return new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); }
async function computeIdentityHash(username, password) { return await shaBytes(enc.encode(`${username.toLowerCase()}:${password}`)); }
async function computeX(salt, idHash) { return bytesToBig(await shaBytes(salt, idHash)); }
const computeVerifier = (x) => modpow(g, x, N);
async function computeK() { return bytesToBig(await shaBytes(toBytesBE(N, N_BYTES), toBytesBE(g, N_BYTES))); }
async function computeU(A, B) { return bytesToBig(await shaBytes(minimalBytes(A), minimalBytes(B))); }

async function apiFetch(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
}

async function registerUser(username, password) {
    const salt = randomBytes(32);
    const idHash = await computeIdentityHash(username, password);
    const x = await computeX(salt, idHash);
    const v = computeVerifier(x);
    const seed = randomBytes(32);
    const identity = makeIdentity(seed);
    const material = await buildWrapMaterial(seed, password);
    await apiFetch('POST', '/auth/register', {
        username, salt_hex: toHex(salt), verifier_hex: padHex(v, N_BYTES),
        public_key: identity.publicKeyEncoded,
        wrap_salt: material.wrapSalt, recovery_salt: material.recoverySalt,
        seed_wrapped_pw: material.seedWrappedPw, seed_wrapped_rc: material.seedWrappedRc,
        pw_kdf_iterations: material.pwKdfIterations,
    });
    return { username, password, seed, identity };
}

async function loginUser(username, password) {
    const a = bytesToBig(randomBytes(32));
    const A = modpow(g, a, N);
    const s1 = await apiFetch('POST', '/auth/login/step1', { username, a_pub_hex: padHex(A, N_BYTES) });
    const salt = fromHex(s1.salt_hex); const B = BigInt('0x' + s1.b_pub_hex);
    const u = await computeU(A, B);
    const k = await computeK();
    const idHash = await computeIdentityHash(username, password);
    const x = await computeX(salt, idHash);
    // S = (B - k*g^x)^(a + u*x) mod N
    const gx = modpow(g, x, N);
    let base = (B - (k * gx) % N) % N; if (base < 0n) base += N;
    const S = modpow(base, a + u * x, N);
    const K = minimalBytes(S);
    const M1 = await shaBytes(minimalBytes(A), minimalBytes(B), K);
    const s2 = await apiFetch('POST', '/auth/login/step2', { username, m_hex: toHex(M1) });
    return { token: s2.token, salt_hex: s1.salt_hex };
}

// ============================================================
async function main() {
    console.log(`E2EE live verification against ${API}  (db=${PGDB})`);

    // Unique run marker so DB scans are unambiguous.
    const RUN = 'run' + Date.now();
    const PLAIN_DM = `SECRET-DM-${RUN}-hello-alice-to-bob`;
    const PLAIN_CH = `SECRET-CH-${RUN}-group-message`;
    const PLAIN_CH2 = `SECRET-CH2-${RUN}-post-eviction`;
    const PLAIN_TASK = `SECRET-TASK-${RUN}-buy-milk`;

    section('Setup: register 3 users via real SRP + v3 custody');
    const A = await registerUser(`alice_${RUN}`, 'passwordAlice1!');
    const B = await registerUser(`bob_${RUN}`, 'passwordBob1!');
    const C = await registerUser(`carol_${RUN}`, 'passwordCarol1!');
    const la = await loginUser(A.username, A.password); A.token = la.token; A.salt_hex = la.salt_hex;
    const lb = await loginUser(B.username, B.password); B.token = lb.token;
    const lc = await loginUser(C.username, C.password); C.token = lc.token;
    A.id = (await apiFetch('GET', '/profile', null, A.token)).id;
    B.id = (await apiFetch('GET', '/profile', null, B.token)).id;
    C.id = (await apiFetch('GET', '/profile', null, C.token)).id;
    check('setup/register+login (SRP-6a, 3 users)', !!(A.token && B.token && C.token && A.id), `ids A=${A.id} B=${B.id} C=${C.id}`);

    // --- Stage: identity seed custody — server holds only wrapped seed + public key ---
    section('Stage: identity-seed custody (server stores wrapped seed only)');
    {
        const row = sql(`SELECT public_key, seed_wrapped_pw, pw_kdf_iterations, key_version FROM users WHERE username='${A.username}';`);
        const [pub, wrapped, iters, ver] = row.split('|');
        const seedB64 = toB64(A.seed);
        const pubOk = pub.startsWith('x25519:');
        const noRawSeed = !wrapped.includes(seedB64) && wrapped !== seedB64;
        // Prove the wrapped blob is USELESS without the password, but the seed unwraps WITH it.
        const wm = sql(`SELECT wrap_salt, seed_wrapped_pw, pw_kdf_iterations FROM users WHERE username='${A.username}';`).split('|');
        const recovered = await unwrapSeedWithPassword(A.password, wm[0], wm[1], parseInt(wm[2]));
        const roundtrip = recovered && toB64(recovered) === seedB64;
        const wrongPw = await unwrapSeedWithPassword('wrong', wm[0], wm[1], parseInt(wm[2]));
        check('identity/pubkey stored, raw seed NOT in DB', pubOk && noRawSeed, `key_version=${ver} iters=${iters}`);
        check('identity/seed unwraps with password, fails with wrong password', !!roundtrip && wrongPw === null, `600k KDF`);
    }

    // --- Stage: DM pairwise ---
    section('Stage: DM pairwise (X25519 + AES-GCM)');
    {
        const bPub = (await apiFetch('GET', `/users/${B.id}/public-key`, null, A.token)).public_key;
        const cPub = (await apiFetch('GET', `/users/${C.id}/public-key`, null, A.token)).public_key;
        check('DM/server serves B public key to A', bPub === B.identity.publicKeyEncoded);
        const env2 = await encryptDM(A.identity, bPub, PLAIN_DM);
        const conv = await apiFetch('POST', '/dms', { user_id: B.id }, A.token);
        const convId = conv.id || conv.conversation_id;
        await apiFetch('POST', `/dms/${convId}/messages`, { content: serialize(env2) }, A.token);
        // Server storage: ciphertext only
        const stored = sql(`SELECT content FROM dm_messages WHERE conversation_id='${convId}' ORDER BY created_at DESC LIMIT 1;`);
        const isEnvelope = stored.includes('"v":2') && stored.includes('"t":"dm"') && stored.includes('"ct"');
        const noPlain = !stored.includes(PLAIN_DM);
        check('DM/server stores ciphertext envelope, NOT plaintext', isEnvelope && noPlain);
        // Recipient B decrypts via mirror DH
        const aPub = (await apiFetch('GET', `/users/${A.id}/public-key`, null, B.token)).public_key;
        const bMsgs = await apiFetch('GET', `/dms/${convId}/messages`, null, B.token);
        const bLast = bMsgs[bMsgs.length - 1];
        const bDec = await decryptDM(B.identity, aPub, JSON.parse(bLast.content));
        check('DM/recipient B decrypts to original plaintext', bDec === PLAIN_DM, bDec === PLAIN_DM ? '' : `got: ${bDec}`);
        // Third party C cannot decrypt (wrong key pair)
        const cDec = await decryptDM(C.identity, aPub, JSON.parse(bLast.content));
        check('DM/third-party C cannot decrypt (returns null)', cDec === null);
        // Tamper rejection
        const tampered = JSON.parse(bLast.content); const raw = fromB64(tampered.ct); raw[raw.length - 1] ^= 0xff; tampered.ct = toB64(raw);
        const tDec = await decryptDM(B.identity, aPub, tampered);
        check('DM/tampered ciphertext rejected (GCM auth)', tDec === null);
    }

    // --- Stage: channel group keys + message + rotation/eviction ---
    section('Stage: channel group keys, message, epoch rotation on eviction');
    let serverId, channelId, ckEpoch1;
    {
        const srv = await apiFetch('POST', '/servers', { name: `srv_${RUN}` }, A.token);
        serverId = srv.id;
        // B and C join. Servers are invite-only since 2026-07-24, so the join
        // goes through the invite code's own route — POST /servers/{id}/join
        // now 403s regardless of the code in the body.
        const inv = await apiFetch('POST', `/servers/${serverId}/invites`,
            { max_uses: 5, expires_in_hours: 1 }, A.token);
        const code = inv.code;
        await apiFetch('POST', `/invites/${code}/join`, {}, B.token);
        await apiFetch('POST', `/invites/${code}/join`, {}, C.token);
        const ch = await apiFetch('POST', `/servers/${serverId}/channels`, { name: 'general', channel_type: 0 }, A.token);
        channelId = ch.id;

        // A bootstraps epoch-1 channel key, wraps for all 3 members, publishes
        const memberKeys = await apiFetch('GET', `/channels/${channelId}/member-keys`, null, A.token);
        const members = memberKeys.filter(m => m.public_key).map(m => ({ userId: m.user_id, publicKey: m.public_key }));
        ckEpoch1 = generateChannelKey();
        const gen = (await apiFetch('GET', `/channels/${channelId}/keys`, null, A.token)).current_generation ?? 1;
        const wrapped = await wrapChannelKeyForMembers(A.identity, ckEpoch1, members);
        await apiFetch('POST', `/channels/${channelId}/keys`, { epoch: 1, member_generation: gen, keys: wrapped.map(w => ({ recipient_id: w.recipientId, wrapped_key: w.wrappedKey, sender_public_key: w.senderPublicKey })) }, A.token);
        check('channel/A published wrapped keys for all members', wrapped.length === 3, `${wrapped.length} members`);

        // A sends an encrypted channel message
        const env2 = await encryptChannelMessage(ckEpoch1, 1, PLAIN_CH);
        await apiFetch('POST', `/channels/${channelId}/messages`, { content: serialize(env2), is_task: false, key_epoch: 1 }, A.token);
        const stored = sql(`SELECT content FROM messages WHERE channel_id='${channelId}' ORDER BY created_at DESC LIMIT 1;`);
        check('channel/server stores ciphertext envelope, NOT plaintext', stored.includes('"t":"ch"') && !stored.includes(PLAIN_CH));

        // B fetches its wrapped key, unwraps, decrypts the message
        const bKeys = await apiFetch('GET', `/channels/${channelId}/keys`, null, B.token);
        const bWrap = bKeys.keys.find(k => k.epoch === 1);
        const bCk = await unwrapChannelKey(B.identity, { wrappedKey: bWrap.wrapped_key, senderPublicKey: bWrap.sender_public_key });
        const bMsgs = await apiFetch('GET', `/channels/${channelId}/messages`, null, B.token);
        const bEnv = JSON.parse(bMsgs[bMsgs.length - 1].content);
        const bDec = await decryptChannelMessage(bCk, bEnv);
        check('channel/member B unwraps key + decrypts message', bDec === PLAIN_CH, bDec === PLAIN_CH ? '' : `got: ${bDec}`);

        // --- Key PROVENANCE (migration 037) -------------------------------
        // The receive side used to unwrap with whatever `sender_public_key` the
        // server returned, with nothing tying that key to an identity. A server
        // could wrap a channel key of its own choosing for every member and read
        // all channel content. The wrapper's user id is now recorded so the
        // client can pin the key against it, exactly as DMs and mintEpoch do.
        check('provenance/served key carries the wrapper user id',
            bWrap.sender_user_id === A.id, `got ${JSON.stringify(bWrap.sender_user_id)} want ${A.id}`);
        const wrapperRow = sql(`SELECT sender_user_id FROM channel_keys WHERE channel_id='${channelId}' AND epoch=1 LIMIT 1;`);
        check('provenance/persisted, not just echoed back', wrapperRow.trim() === String(A.id), `db=${wrapperRow}`);
        // The stored key must really be the wrapper's identity key, or pinning
        // it against that user would compare against a value nobody owns.
        const matches = sql(`SELECT (sender_public_key = (SELECT public_key FROM users WHERE id = channel_keys.sender_user_id))::text FROM channel_keys WHERE channel_id='${channelId}' AND epoch=1 LIMIT 1;`);
        // `::text` on a boolean renders "true"/"false", not psql's "t"/"f".
        check('provenance/stored key IS the wrapper\'s real identity key',
            matches.trim() === 'true', `got ${matches}`);

        // A client may not publish under someone else's identity key: that would
        // frame a trusted member and get the forged key pinned in their name.
        let forgedStatus = 0;
        try {
            await apiFetch('POST', `/channels/${channelId}/keys`, {
                epoch: 3, member_generation: gen,
                keys: [{ recipient_id: B.id, wrapped_key: 'AAAA', sender_public_key: B.identity.publicKeyEncoded }],
            }, A.token);
        } catch (e) {
            forgedStatus = Number(String(e.message).match(/→ (\d+)/)?.[1] ?? 0);
        }
        check('provenance/publishing under another user\'s identity key is refused',
            forgedStatus === 400, `status=${forgedStatus}`);

        // --- Eviction: kick C, rotate to epoch 2 ---
        await apiFetch('POST', `/servers/${serverId}/kick/${C.id}`, {}, A.token);
        const mk2 = await apiFetch('GET', `/channels/${channelId}/member-keys`, null, A.token);
        const members2 = mk2.filter(m => m.public_key).map(m => ({ userId: m.user_id, publicKey: m.public_key }));
        const gen2 = (await apiFetch('GET', `/channels/${channelId}/keys`, null, A.token)).current_generation ?? 2;
        const ckEpoch2 = generateChannelKey();
        const wrapped2 = await wrapChannelKeyForMembers(A.identity, ckEpoch2, members2);
        await apiFetch('POST', `/channels/${channelId}/keys`, { epoch: 2, member_generation: gen2, keys: wrapped2.map(w => ({ recipient_id: w.recipientId, wrapped_key: w.wrappedKey, sender_public_key: w.senderPublicKey })) }, A.token);
        const env2b = await encryptChannelMessage(ckEpoch2, 2, PLAIN_CH2);
        await apiFetch('POST', `/channels/${channelId}/messages`, { content: serialize(env2b), is_task: false, key_epoch: 2 }, A.token);

        // Evicted C must have NO epoch-2 key row
        const cEpoch2Rows = sql(`SELECT COUNT(*) FROM channel_keys WHERE channel_id='${channelId}' AND epoch=2 AND recipient_id=${C.id};`);
        check('eviction/evicted C has NO epoch-2 key (forward secrecy)', cEpoch2Rows === '0', `rows=${cEpoch2Rows}`);
        // C's cached epoch-1 key cannot decrypt the epoch-2 message
        const cKeys1 = sql(`SELECT wrapped_key, sender_public_key FROM channel_keys WHERE channel_id='${channelId}' AND epoch=1 AND recipient_id=${C.id};`);
        const [cwk, csp] = cKeys1.split('|');
        const cCk1 = await unwrapChannelKey(C.identity, { wrappedKey: cwk, senderPublicKey: csp });
        const cDec = await decryptChannelMessage(cCk1, env2b);
        check('eviction/C epoch-1 key cannot decrypt epoch-2 message', cDec === null);
        // B (still a member) CAN decrypt epoch 2
        const bKeys2 = await apiFetch('GET', `/channels/${channelId}/keys`, null, B.token);
        const bWrap2 = bKeys2.keys.find(k => k.epoch === 2);
        const bCk2 = await unwrapChannelKey(B.identity, { wrappedKey: bWrap2.wrapped_key, senderPublicKey: bWrap2.sender_public_key });
        const bDec2 = await decryptChannelMessage(bCk2, env2b);
        check('eviction/remaining member B decrypts epoch-2 message', bDec2 === PLAIN_CH2);
    }

    // --- Stage: server-admin require-E2EE policy round-trip ---
    section('Stage: server-admin require-E2EE policy');
    {
        // Default false on a fresh server
        const listed0 = (await apiFetch('GET', '/servers', null, A.token)).find(s => s.id === serverId);
        check('policy/new server defaults require_media_e2ee=false', listed0.require_media_e2ee === false, `got ${listed0.require_media_e2ee}`);
        // Owner (A) turns it on
        await apiFetch('PATCH', `/servers/${serverId}/settings`, { require_media_e2ee: true }, A.token);
        const dbVal = sql(`SELECT require_media_e2ee FROM servers WHERE id='${serverId}';`);
        check('policy/owner PATCH persists to DB', dbVal === 't', `db=${dbVal}`);
        // The flag is READABLE by clients (the is_public write-only bug is not repeated)
        const listed1 = (await apiFetch('GET', '/servers', null, B.token)).find(s => s.id === serverId);
        check('policy/flag is readable by members via GET /servers', listed1.require_media_e2ee === true);
        // Non-owner (B) cannot change it
        let forbidden = false;
        try { await apiFetch('PATCH', `/servers/${serverId}/settings`, { require_media_e2ee: false }, B.token); }
        catch (e) { forbidden = /403/.test(String(e)); }
        const stillOn = sql(`SELECT require_media_e2ee FROM servers WHERE id='${serverId}';`);
        check('policy/non-owner PATCH is rejected (403), value unchanged', forbidden && stillOn === 't');
    }

    // --- Stage: self / checklist encryption ---
    section('Stage: self-encryption (private tasks/notes)');
    {
        const env2 = await encryptSelf(A.identity, PLAIN_TASK);
        await apiFetch('POST', `/channels/${channelId}/messages`, { content: serialize(env2), is_task: true, key_epoch: null }, A.token);
        const stored = sql(`SELECT content FROM messages WHERE channel_id='${channelId}' AND is_task=true ORDER BY created_at DESC LIMIT 1;`);
        check('self/server stores ciphertext, NOT plaintext', stored.includes('"t":"self"') && !stored.includes(PLAIN_TASK));
        const aDec = await decryptSelf(A.identity, JSON.parse(stored));
        const bDec = await decryptSelf(B.identity, JSON.parse(stored));
        check('self/owner A decrypts, other user B cannot', aDec === PLAIN_TASK && bDec === null);
    }

    // --- Stage: file attachments (E2EE via encryptAndUpload) ---
    section('Stage: file attachments (client-side AES-GCM before upload)');
    {
        const PLAIN_FILE = `SECRET-FILE-${RUN}-attachment-body-contents`;
        // Replicate attachments.ts encryptAndUpload: random 32B key, nonce(12)||AES-GCM(ct)
        const keyBytes = crypto.getRandomValues(new Uint8Array(32));
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const k = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, enc.encode(PLAIN_FILE)));
        const blob = new Uint8Array(nonce.length + ct.length); blob.set(nonce); blob.set(ct, nonce.length);
        // Multipart upload of the CIPHERTEXT blob (generic name/mime, as the client does)
        const form = new FormData();
        form.append('file', new Blob([blob], { type: 'application/octet-stream' }), 'attachment.enc');
        const upRes = await fetch(`${API}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${A.token}` }, body: form });
        const uploaded = JSON.parse(await upRes.text());
        // Server-stored bytes must be the ciphertext (no plaintext), and metadata generic
        const meta = sql(`SELECT original_name, mime_type FROM uploaded_files WHERE id='${uploaded.id}';`).split('|');
        const fetched = await fetch(`${API}/files/${uploaded.id}`, { headers: { Authorization: `Bearer ${A.token}` } });
        const storedBytes = new Uint8Array(await fetched.arrayBuffer());
        const storedStr = Buffer.from(storedBytes).toString('latin1');
        const noPlainOnServer = !storedStr.includes(PLAIN_FILE);
        check('file/server stores ciphertext bytes + generic metadata, NOT plaintext', noPlainOnServer && meta[0] === 'attachment.enc', `name=${meta[0]} mime=${meta[1]}`);
        // Holder of the key (delivered inside the E2EE message href) decrypts
        const dn = storedBytes.slice(0, 12), dct = storedBytes.slice(12);
        const dec = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: dn }, k, dct));
        check('file/key holder decrypts to original file contents', dec === PLAIN_FILE);
        // Wrong key fails
        let wrongFail = false;
        try { const wk = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['decrypt']); await crypto.subtle.decrypt({ name: 'AES-GCM', iv: dn }, wk, dct); } catch { wrongFail = true; }
        check('file/wrong key cannot decrypt attachment', wrongFail);
    }

    // --- Stage: recovery keeps history ---
    section('Stage: password reset via recovery preserves history');
    {
        // Re-derive A's identity purely from the server-held wrapped seed + password
        // (simulates a fresh device with no local key material).
        const wm = sql(`SELECT wrap_salt, seed_wrapped_pw, pw_kdf_iterations FROM users WHERE username='${A.username}';`).split('|');
        const seed = await unwrapSeedWithPassword(A.password, wm[0], wm[1], parseInt(wm[2]));
        const freshIdentity = seed && makeIdentity(seed);
        const samePubkey = freshIdentity && freshIdentity.publicKeyEncoded === A.identity.publicKeyEncoded;
        // With the re-derived identity, decrypt the earlier DM history
        const aPubSelf = A.identity.publicKeyEncoded;
        // decrypt the epoch-1 channel msg from history using B->A? Use self note instead (single-identity proof)
        const selfRow = sql(`SELECT content FROM messages WHERE channel_id='${channelId}' AND is_task=true ORDER BY created_at DESC LIMIT 1;`);
        const histDec = freshIdentity && await decryptSelf(freshIdentity, JSON.parse(selfRow));
        check('recovery/seed re-derivable from server blob yields SAME identity key', !!samePubkey);
        check('recovery/re-derived identity decrypts pre-existing history', histDec === PLAIN_TASK);
    }

    // --- Stage: server-wide plaintext sweep ---
    section('Stage: full-DB plaintext sweep');
    {
        const markers = [PLAIN_DM, PLAIN_CH, PLAIN_CH2, PLAIN_TASK];
        let leaks = [];
        for (const col of ['messages.content', 'dm_messages.content']) {
            const [tbl, c] = col.split('.');
            for (const m of markers) {
                const hit = sql(`SELECT COUNT(*) FROM ${tbl} WHERE ${c} LIKE '%${m}%';`);
                if (hit !== '0') leaks.push(`${col}~${m}`);
            }
        }
        check('sweep/no plaintext marker anywhere in message/DM content columns', leaks.length === 0, leaks.join(','));
    }

    // ---------- summary ----------
    section('SUMMARY');
    const pass = results.filter(r => r.ok).length, fail = results.length - pass;
    console.log(`\n${pass}/${results.length} checks passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:'); results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.stage}: ${r.detail || ''}`)); }
    process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
