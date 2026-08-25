/**
 * Regression harness for custom per-user join/leave sounds (migration 043).
 *
 * Covers the server-side contract the UI relies on:
 *   - PATCH /profile accepts an OWN uploaded audio file as join/leave sound,
 *     refuses non-audio (400), oversized clips (400), and files uploaded by
 *     someone else (403); empty string clears (src/handlers.rs).
 *   - /servers/:id/members-with-roles exposes join/leave file ids and
 *     custom_sounds_disabled — and NULLS the ids when a moderator disabled the
 *     member's sounds, so clients can't play what policy muted
 *     (src/role_handlers.rs).
 *   - PUT /servers/:id/custom-sounds/:userId needs MUTE_MEMBERS, refuses
 *     targeting the owner, 404s non-members (src/moderation_handlers.rs).
 *   - DELETE /files/:id refuses to orphan a file referenced as someone's
 *     join/leave sound until it is unset (src/upload_handlers.rs).
 *
 * Run:  API=http://127.0.0.1:3000 node e2e/custom-sounds-verify.mjs
 * Prereqs: backend on :3000 against a THROWAWAY DB. Never the dev/prod one.
 */
import { webcrypto, randomFillSync } from 'node:crypto';
const crypto = webcrypto;
const API = process.env.API || 'http://127.0.0.1:3000';

let fail = 0;
const check = (stage, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${stage}${detail ? '  — ' + detail : ''}`); if (!ok) fail++; };
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
const padHex = (n, len) => { const h = n.toString(16); return '0'.repeat(Math.max(0, len * 2 - h.length)) + h; };
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

/** Multipart upload of raw bytes under a chosen filename + content type. */
async function upload(token, name, type, bytes) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    for (let i = 0; i < 3; i++) {
        const res = await fetch(`${API}/upload`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: form,
        });
        if (res.status === 429) { await sleep(2500); continue; }
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch { json = text; }
        return { status: res.status, body: json };
    }
    return { status: 429, body: 'rate-limited' };
}

/** Smallest valid-enough WAV header + silence; the server only checks mime. */
function wavBytes(size = 2048) {
    const b = new Uint8Array(size);
    b.set(enc.encode('RIFF')); b.set(enc.encode('WAVEfmt '), 8);
    return b;
}

async function register(username, password) {
    const salt = randBytes(32);
    const idHash = await shaBytes(enc.encode(`${username.toLowerCase()}:${password}`));
    const x = bytesToBig(await shaBytes(salt, idHash));
    const v = modpow(g, x, N);
    const reg = await api('POST', '/auth/register', {
        username, salt_hex: toHex(salt), verifier_hex: padHex(v, N_BYTES),
        public_key: 'x25519:' + Buffer.from(randBytes(32)).toString('base64'),
    });
    if (reg.status >= 300) throw new Error(`register ${username} failed: ${reg.status}`);
}

async function login(username, password) {
    const a = bytesToBig(randBytes(32)); const A = modpow(g, a, N);
    const s1 = await api('POST', '/auth/login/step1', { username, a_pub_hex: padHex(A, N_BYTES) });
    if (s1.status >= 400) throw new Error(`login step1 ${username}: ${s1.status}`);
    const salt = fromHex(s1.body.salt_hex); const B = BigInt('0x' + s1.body.b_pub_hex);
    const idHash = await shaBytes(enc.encode(`${username.toLowerCase()}:${password}`));
    const x = bytesToBig(await shaBytes(salt, idHash));
    const k = bytesToBig(await shaBytes(toBytesBE(N, N_BYTES), toBytesBE(g, N_BYTES)));
    const u = bytesToBig(await shaBytes(minimalBytes(A), minimalBytes(B)));
    const gx = modpow(g, x, N); let base = (B - (k * gx) % N) % N; if (base < 0n) base += N;
    const S = modpow(base, a + u * x, N);
    const M1 = await shaBytes(minimalBytes(A), minimalBytes(B), minimalBytes(S));
    const s2 = await api('POST', '/auth/login/step2', { username, m_hex: toHex(M1) });
    if (s2.status !== 200 || !s2.body?.token) throw new Error(`login step2 ${username}: ${s2.status}`);
    return s2.body.token;
}

async function main() {
    const RUN = Date.now().toString(36);
    const P = 'SoundsPass1!';
    const A = `ann_${RUN}`, B = `boss_${RUN}`, C = `cam_${RUN}`;
    await register(A, P); await register(B, P); await register(C, P);
    const tA = await login(A, P), tB = await login(B, P), tC = await login(C, P);
    const idA = (await api('GET', '/profile', null, tA)).body.id;
    check('setup/users ready', !!idA);

    // B owns the server; A and C join via invite.
    const srv = (await api('POST', '/servers', { name: `Sounds ${RUN}` }, tB)).body;
    const inv = (await api('POST', `/servers/${srv.id}/invites`, {}, tB)).body;
    await api('POST', `/invites/${inv.code}/join`, {}, tA);
    await api('POST', `/invites/${inv.code}/join`, {}, tC);
    const members = await api('GET', `/servers/${srv.id}/members-with-roles`, null, tC);
    check('setup/server with 3 members', members.status === 200 && members.body.length === 3, `status=${members.status} n=${members.body?.length}`);

    // === Setting a sound ====================================================
    const clip = await upload(tA, 'join.wav', 'audio/wav', wavBytes());
    check('upload/audio clip accepted', clip.status < 300 && !!clip.body?.id, `status=${clip.status}`);
    const clipId = clip.body.id;

    const setJoin = await api('PATCH', '/profile', { join_sound_file_id: clipId }, tA);
    check('profile/own audio accepted as join sound', setJoin.status < 300, `status=${setJoin.status}`);
    const prof = await api('GET', '/profile', null, tA);
    check('profile/join sound persisted', prof.body?.join_sound_file_id === clipId, `got=${prof.body?.join_sound_file_id}`);

    // Non-audio refused.
    const png = await upload(tA, 'notsound.png', 'image/png', randBytes(256));
    const setPng = await api('PATCH', '/profile', { leave_sound_file_id: png.body?.id }, tA);
    check('profile/non-audio refused (400)', setPng.status === 400, `status=${setPng.status}`);

    // Foreign file refused: B may not claim A's upload.
    const steal = await api('PATCH', '/profile', { join_sound_file_id: clipId }, tB);
    check('profile/foreign file refused (403)', steal.status === 403, `status=${steal.status}`);

    // Oversized clip refused (server cap 1 MB; upload cap is 25 MB so the
    // upload itself succeeds).
    const big = await upload(tA, 'big.wav', 'audio/wav', wavBytes(1024 * 1024 + 1));
    const setBig = await api('PATCH', '/profile', { leave_sound_file_id: big.body?.id }, tA);
    check('profile/oversized clip refused (400)', setBig.status === 400, `status=${setBig.status}`);

    // === Distribution via members-with-roles ================================
    const m1 = await api('GET', `/servers/${srv.id}/members-with-roles`, null, tC);
    const rowA1 = m1.body.find(m => m.id === idA);
    check('members/join sound visible to other members', rowA1?.join_sound_file_id === clipId, `got=${rowA1?.join_sound_file_id}`);
    check('members/custom_sounds_disabled defaults false', rowA1?.custom_sounds_disabled === false, `got=${rowA1?.custom_sounds_disabled}`);

    // === Moderation =========================================================
    // C has no MUTE_MEMBERS → refused.
    const noPerm = await api('PUT', `/servers/${srv.id}/custom-sounds/${idA}`, { disabled: true }, tC);
    check('moderation/member without MUTE_MEMBERS refused', noPerm.status === 403, `status=${noPerm.status}`);

    // Owner B disables A's sounds.
    const disable = await api('PUT', `/servers/${srv.id}/custom-sounds/${idA}`, { disabled: true }, tB);
    check('moderation/owner can disable', disable.status < 300, `status=${disable.status}`);
    const m2 = await api('GET', `/servers/${srv.id}/members-with-roles`, null, tC);
    const rowA2 = m2.body.find(m => m.id === idA);
    check('members/disabled member sound NULLED server-side', rowA2?.join_sound_file_id == null, `got=${rowA2?.join_sound_file_id}`);
    check('members/disabled flag visible', rowA2?.custom_sounds_disabled === true, `got=${rowA2?.custom_sounds_disabled}`);

    // Profile still remembers the clip — policy mutes distribution, not the setting.
    const profStill = await api('GET', '/profile', null, tA);
    check('profile/own setting survives moderation', profStill.body?.join_sound_file_id === clipId, `got=${profStill.body?.join_sound_file_id}`);

    // Re-enable restores distribution.
    await api('PUT', `/servers/${srv.id}/custom-sounds/${idA}`, { disabled: false }, tB);
    const m3 = await api('GET', `/servers/${srv.id}/members-with-roles`, null, tC);
    check('members/re-enable restores the sound', m3.body.find(m => m.id === idA)?.join_sound_file_id === clipId);

    // Owner cannot be moderated — even by themselves.
    const idB = (await api('GET', '/profile', null, tB)).body.id;
    const ownerHit = await api('PUT', `/servers/${srv.id}/custom-sounds/${idB}`, { disabled: true }, tB);
    check('moderation/owner target refused', ownerHit.status >= 400, `status=${ownerHit.status}`);

    // Non-member target 404s.
    const ghost = await api('PUT', `/servers/${srv.id}/custom-sounds/999999`, { disabled: true }, tB);
    check('moderation/non-member target 404', ghost.status === 404, `status=${ghost.status}`);

    // The owner guard must not be defeatable by an id that only WRAPS to the
    // owner's. The handler used to bind `user_id as i32`, so owner_id + 2^32
    // compared unequal as an i64 (guard passed) but truncated back to the
    // owner in the UPDATE. Correct behaviour: no row matches → 404, and the
    // owner's own moderation state is untouched.
    const aliased = Number(idB) + 4294967296;
    const wrap = await api('PUT', `/servers/${srv.id}/custom-sounds/${aliased}`, { disabled: true }, tB);
    check('moderation/i32-wrapped owner id does not hit the owner', wrap.status === 404, `status=${wrap.status}`);
    const mOwner = await api('GET', `/servers/${srv.id}/members-with-roles`, null, tC);
    const rowOwner = mOwner.body.find(m => m.id === idB);
    check('moderation/owner still unmoderated after the wrap attempt',
        rowOwner?.custom_sounds_disabled === false, `got=${rowOwner?.custom_sounds_disabled}`);

    // === Delete guard + clearing ============================================
    const delRef = await api('DELETE', `/files/${clipId}`, null, tA);
    check('files/delete refused while referenced as a sound', delRef.status >= 400, `status=${delRef.status}`);
    const clear = await api('PATCH', '/profile', { join_sound_file_id: '' }, tA);
    check('profile/empty string clears the sound', clear.status < 300, `status=${clear.status}`);
    const profClear = await api('GET', '/profile', null, tA);
    check('profile/cleared', profClear.body?.join_sound_file_id == null, `got=${profClear.body?.join_sound_file_id}`);
    // Clearing (or replacing) a sound RECLAIMS the old blob automatically —
    // without that, every Replace/Remove leaked a file that counted against
    // the uploader's quota forever with no way to free it (delete_file refuses
    // while referenced, and once unreferenced the id is gone from the UI). So
    // the blob is already gone here: a follow-up delete 404s, and re-pointing
    // the profile at it must fail because the row no longer exists.
    const delAfterClear = await api('DELETE', `/files/${clipId}`, null, tA);
    check('files/cleared sound blob was auto-reclaimed', delAfterClear.status === 404, `status=${delAfterClear.status}`);
    const reuse = await api('PATCH', '/profile', { join_sound_file_id: clipId }, tA);
    check('profile/reclaimed clip can no longer be referenced', reuse.status >= 400, `status=${reuse.status}`);

    // Replace path: uploading a second clip over a first must reclaim the first.
    const c1 = await upload(tA, 'one.wav', 'audio/wav', wavBytes());
    await api('PATCH', '/profile', { leave_sound_file_id: c1.body.id }, tA);
    const c2 = await upload(tA, 'two.wav', 'audio/wav', wavBytes());
    await api('PATCH', '/profile', { leave_sound_file_id: c2.body.id }, tA);
    const oldGone = await api('DELETE', `/files/${c1.body.id}`, null, tA);
    check('files/replaced sound blob was auto-reclaimed', oldGone.status === 404, `status=${oldGone.status}`);
    const profNew = await api('GET', '/profile', null, tA);
    check('profile/replacement clip is the live one', profNew.body?.leave_sound_file_id === c2.body.id, `got=${profNew.body?.leave_sound_file_id}`);

    console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
    process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
