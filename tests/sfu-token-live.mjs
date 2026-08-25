// Live acceptance for the Tier-2 SFU control plane (src/sfu.rs + migration 035):
// sfu_mode channel flag, VIEW-gated token minting with per-connection
// identities, and admission-control denials. Pure HTTP against a locally
// running backend (:3000), same minted-JWT technique as perm-matrix-live.mjs.
//
// Runs in two profiles automatically:
//   - backend WITHOUT LIVEKIT_* env  → gating cases + 503-unconfigured case
//   - backend WITH LIVEKIT_* env     → gating cases + full mint/capacity cases
//
// Prereqs: native Postgres up, backend up. Usage: node tests/sfu-token-live.mjs
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const BASE = process.env.API || 'http://localhost:3000';
// Same rule as the other live harnesses: PGDB must be the THROWAWAY database
// the backend at BASE is pointed at (this file inserts users directly). A
// mismatch 401s every call, which looks like a gating failure rather than a
// misconfigured run.
const PGDB = process.env.PGDB || 'puca';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const JWT_SECRET = 'puca_super_secret_key_change_in_production';

const VIEW = 1 << 0;

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
const api = (token) => async (method, path, body) => {
    const res = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.clone().json(); } catch { /* non-JSON body */ }
    return { status: res.status, json, text: json ? '' : await res.text() };
};

// --- setup -------------------------------------------------------------------
const stamp = Date.now().toString(36);
const ownerId = Number(psql1(`INSERT INTO users (username, salt, verifier) VALUES ('sfuowner_${stamp}', '\\x00', '\\x00') RETURNING id`));
const memberId = Number(psql1(`INSERT INTO users (username, salt, verifier) VALUES ('sfumember_${stamp}', '\\x00', '\\x00') RETURNING id`));
const outsiderId = Number(psql1(`INSERT INTO users (username, salt, verifier) VALUES ('sfuout_${stamp}', '\\x00', '\\x00') RETURNING id`));
const owner = api(mintJwt(ownerId, `sfuowner_${stamp}`));
const member = api(mintJwt(memberId, `sfumember_${stamp}`));
const outsider = api(mintJwt(outsiderId, `sfuout_${stamp}`));

const srv = await owner('POST', '/servers', { name: `SfuLive ${stamp}` });
const serverId = srv.json?.id;
check('server created', !!serverId, JSON.stringify(srv));
psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${memberId})`);

const voice = await owner('POST', `/servers/${serverId}/channels`, { name: 'sfu-voice', channel_type: 1 });
const text = await owner('POST', `/servers/${serverId}/channels`, { name: 'sfu-text', channel_type: 0 });
const voiceId = voice.json?.id, textId = text.json?.id;
check('channels created', !!voiceId && !!textId);

// --- sfu_mode flag lifecycle ---------------------------------------------------
let r = await member('PATCH', `/channels/${voiceId}`, { sfu_mode: true });
check('member without MANAGE_CHANNELS cannot enable sfu_mode', r.status === 403, `got ${r.status}`);

r = await owner('GET', `/channels/${voiceId}/sfu-token`);
check('voice channel without sfu_mode refuses tokens (400)', r.status === 400, `got ${r.status}`);

r = await owner('PATCH', `/channels/${voiceId}`, { sfu_mode: true });
check('owner enables sfu_mode', r.status === 200, `got ${r.status}`);

r = await owner('GET', `/servers/${serverId}/channels`);
const voiceRow = (r.json || []).find(c => c.id === voiceId);
check('channel list carries sfu_mode=true', voiceRow?.sfu_mode === true, JSON.stringify(voiceRow));

// --- token gating (independent of LiveKit env) ---------------------------------
r = await owner('GET', `/channels/${textId}/sfu-token`);
check('text channel refuses tokens (400)', r.status === 400, `got ${r.status}`);

r = await outsider('GET', `/channels/${voiceId}/sfu-token`);
check('non-member gets 403', r.status === 403, `got ${r.status}`);

// VIEW-denied member: hide the channel entirely (404, mirroring key endpoints).
const roles = await owner('GET', `/servers/${serverId}/roles`);
const everyone = (roles.json || []).find(ro => ro.is_default);
check('found @everyone role', !!everyone);
r = await owner('PUT', `/channels/${voiceId}/overwrites/${everyone.id}`, { allow: 0, deny: VIEW });
check('VIEW-deny overwrite applied', r.status === 200 || r.status === 204, `got ${r.status}`);
r = await member('GET', `/channels/${voiceId}/sfu-token`);
check('VIEW-denied member gets 404 (channel hidden)', r.status === 404, `got ${r.status}`);
await owner('DELETE', `/channels/${voiceId}/overwrites/${everyone.id}`);

// --- mint path (only when the backend has LIVEKIT_* configured) ----------------
r = await owner('GET', `/channels/${voiceId}/sfu-token`);
if (r.status === 503) {
    check('unconfigured backend answers 503 (SFU tier off)', true);
    console.log('# LIVEKIT_* not set on this backend — mint/capacity cases skipped');
} else {
    check('token minted', r.status === 200 && !!r.json?.token, `got ${r.status} ${JSON.stringify(r.json)}`);
    check('identity is per-connection (u<id>#nonce)', new RegExp(`^u${ownerId}#[0-9a-f]{8}$`).test(r.json?.identity ?? ''), r.json?.identity);
    check('room is sfu_<channel>', r.json?.room === `sfu_${voiceId}`, r.json?.room);
    const [, payload] = (r.json?.token ?? '..').split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    check('grant: roomJoin without roomCreate', claims.video?.roomJoin === true && claims.video?.roomCreate === false, JSON.stringify(claims.video));
    check('token TTL <= 20 min', claims.exp - claims.iat <= 20 * 60, `${claims.exp - claims.iat}s`);

    // Same-user re-mints don't consume the room (multi-device allowance)…
    const again = await owner('GET', `/channels/${voiceId}/sfu-token`);
    check('same user can re-mint', again.status === 200, `got ${again.status}`);
    // …but distinct users hit the participant cap (reservations count).
    // Default cap is 8; mint fresh users until refusal.
    let denied = null;
    for (let i = 0; i < 12; i++) {
        const uid = Number(psql1(`INSERT INTO users (username, salt, verifier) VALUES ('sfufill${i}_${stamp}', '\\x00', '\\x00') RETURNING id`));
        psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${uid})`);
        const res = await api(mintJwt(uid, `sfufill${i}_${stamp}`))('GET', `/channels/${voiceId}/sfu-token`);
        if (res.status !== 200) { denied = res; break; }
    }
    check('admission control refuses past capacity (409)', denied?.status === 409, `got ${denied?.status ?? 'no denial in 12 mints'}`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
