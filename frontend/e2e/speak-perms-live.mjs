// Live rig for the SPEAK permission: does a member without SPEAK get into a
// voice call, and does anyone hear them?
//
// Three real clients against a throwaway backend (never production):
//   A  the server owner, the receiver we measure at
//   C  a member WITH Speak, the positive control: A must hear C, or the rig is broken
//   B  a member whose role has Speak DENIED on the voice channel
// B can run a different client build (APP_B). Point it at a build that ignores
// the rule (an older release) to prove the refusal happens at the RECEIVER,
// which is the only place a peer-to-peer call can enforce it.
//
// Verdict per transport:
//   sfu   B joins listen-only (it used to fail outright with LiveKit's
//         "insufficient permissions" 403), hears A, and A hears nothing from B.
//   mesh  A plays C and does NOT play B; B still hears A.
// SCENARIO=revoke instead starts with B ALLOWED to speak (the control: A hears
// B), then denies Speak mid-call through the real overwrite API, as an admin
// saving the channel's Permissions tab would: A must stop playing B within
// seconds and (a current) B's client must say so; lifting the deny again tells
// B to rejoin (the mic is not re-opened mid-call).
// "Hears" is measured on the audio element's stream with an analyser: the
// fake microphone beeps, so a live, delivered stream has energy. Inbound RTP
// alone is not enough (bytes can arrive for a stream the app refuses to play).
//
// Everything is headless and MUTED (--mute-audio); nothing plays aloud.
//
// Receiver enforcement is measured directly: after a revoke, A and C must have
// NO audio element for B at all (the receiver retracted it), not merely a
// silent one (which B's own client muting itself would also produce).
// With APP_B === APP (B runs the current client), deny-at-join also counts
// every getUserMedia call that asks for AUDIO on B's page and requires none:
// a member without Speak must never see a microphone prompt. C's page is
// counted the same way as the positive control (C must have asked).
// With APP_B !== APP (an older B), the checks only a current client can
// satisfy - B's panel label, the rejoin notice, no prompt - are skipped, so a
// legacy-B run passes or fails on receiver enforcement alone.
// On SFU a revoke is ALSO checked at LiveKit: A's page lists what LiveKit says
// each participant publishes (__pucaVoiceDiag), and B's microphone must be
// gone after the revoke while C's stays. With a legacy B (which never
// unpublishes itself) that isolates the server's UpdateParticipant regrant.
// A legacy B cannot run deny-at-join on SFU at all - its join fails, which is
// the original bug - so that combination exits 2.
//
// Prereqs: Postgres (PGPORT/PGDB, password postgres), a backend on API with
// CORS for APP/APP_B, the client built against it and served at APP
// (`DIST=<dir> PORT=… node e2e/serve-dist.mjs`). TRANSPORT=sfu also needs a
// LiveKit the backend is configured for (LIVEKIT_URL/_API_KEY/_API_SECRET).
// PGPORT and PGDB are REQUIRED, with no defaults: the rig inserts users,
// servers, roles and overwrites straight into that database, so it must be
// the throwaway one the backend under test uses, named on purpose.
// Usage: APP=http://127.0.0.1:5181 [APP_B=http://127.0.0.1:5182] PGPORT=5433 PGDB=speak_rig
//        TRANSPORT=mesh|sfu EXPECT=fixed|bug [SCENARIO=revoke] node e2e/speak-perms-live.mjs [out.json]
// Exit 1 when the observed behaviour is not what EXPECT says; 2 on bad setup.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

if (!process.env.PGPORT || !process.env.PGDB) {
    console.error('speak-perms-live: PGPORT and PGDB must both be set explicitly (e.g. PGPORT=5433 PGDB=speak_rig).\n'
        + 'This rig writes rows straight into that database; point it at the THROWAWAY database your test backend uses,\n'
        + 'never a dev or production one. Refusing to guess.');
    process.exit(2);
}

const APP = process.env.APP || 'http://127.0.0.1:5181';
const APP_B = process.env.APP_B || APP;
/** B runs the same (current) client as A and C. False = an older/other build. */
const SAME_CLIENT_B = APP_B === APP;
const TRANSPORT = process.env.TRANSPORT === 'sfu' ? 'sfu' : 'mesh';
const EXPECT = process.env.EXPECT === 'bug' ? 'bug' : 'fixed';
const SCENARIO = process.env.SCENARIO === 'revoke' ? 'revoke' : 'deny-at-join';
const API = process.env.API || 'http://127.0.0.1:3000';
if (!SAME_CLIENT_B && TRANSPORT === 'sfu' && SCENARIO === 'deny-at-join') {
    // A pre-fix client publishes its mic on connect, LiveKit refuses it, and
    // the whole join fails -- that is the bug itself, not something the rig
    // can measure the fix against.
    console.error('speak-perms-live: a pre-fix client cannot join an SFU call without Speak; use SCENARIO=revoke');
    process.exit(2);
}
const CHANNEL = process.env.CHANNEL || 'msedge';
const OUT = process.argv[2] || '';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const SPEAK = 1 << 9;
const stamp = Date.now().toString(36);
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-p', process.env.PGPORT, '-d', process.env.PGDB, '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required',
    '--host-resolver-rules=MAP svrn.lol ~NOTFOUND, MAP *.svrn.lol ~NOTFOUND'];
if (TRANSPORT === 'sfu') args.push('--allow-loopback-in-peer-connection');
if (!args.includes('--mute-audio')) throw new Error('refusing to launch a voice rig without --mute-audio');

async function register(ctx, app, u) {
    const p = await ctx.newPage();
    p.on('console', m => { if (/\[VoicePanel\]|sfu|SFU|speak/i.test(m.text())) logs.push(`${u}: ${m.text().slice(0, 300)}`); });
    await p.goto(app + '/login');
    await p.waitForSelector('#username', { timeout: 60_000 });
    await p.click('.toggle-mode');
    await p.fill('#username', u); await p.fill('#password', PASS); await p.click('button[type="submit"]');
    await p.waitForURL('**/chat', { timeout: 60_000 }); await p.waitForTimeout(1200);
    try { await p.check('.recovery-confirm input[type=checkbox]', { timeout: 4000 }); await p.click('.recovery-done-btn'); } catch { /* none */ }
    try { await p.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    return p;
}

async function createServer(page, name) {
    await page.locator('.server-icon.add-server').click({ timeout: 5000 });
    await page.waitForTimeout(500);
    await page.locator('.template-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.audience-card').first().click({ timeout: 4000 });
    await page.waitForTimeout(300);
    await page.locator('.server-name-input input').fill(name);
    await page.locator('.wizard-actions .create-btn').click();
    await page.waitForTimeout(2500);
}

async function joinVoice(p) {
    await p.reload(); await p.waitForTimeout(2500);
    try { await p.click('.welcome-popup-close', { timeout: 1500 }); } catch { /* none */ }
    await p.evaluate(() => {
        const i = [...document.querySelectorAll('.server-icon')].find(x => !/direct message|add server|join server|notes|tasks/i.test((x.getAttribute('title') || '') + ' ' + (x.className || '')));
        i?.click();
    });
    await p.waitForTimeout(1500);
    return p.evaluate(() => {
        const el = [...document.querySelectorAll('.voice-channel-list .voice-channel')].find(n => !n.classList.contains('afk'));
        if (el) { el.click(); return true; } return false;
    });
}

/** What the voice panel says about us. */
const panelState = (p) => p.evaluate(() => ({
    label: document.querySelector('.voice-connected-label')?.textContent ?? null,
    errors: [...document.querySelectorAll('.voice-error-mini')].map(e => e.textContent.trim()),
}));

/** Is `uid` being PLAYED on this page, and does the stream carry sound? */
const heard = (p, uid) => p.evaluate(async (uid) => {
    const el = document.getElementById(`audio-${uid}`);
    if (!el) return { element: false, energy: 0 };
    const stream = el.srcObject;
    const track = stream?.getAudioTracks?.()[0];
    if (!stream || !track) return { element: true, stream: false, energy: 0 };
    const ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        an.getFloatTimeDomainData(buf);
        let s = 0; for (const v of buf) s += v * v;
        peak = Math.max(peak, Math.sqrt(s / buf.length));
    }
    await ctx.close();
    return { element: true, stream: true, paused: el.paused, track: track.readyState, energy: Number(peak.toFixed(4)) };
}, uid);

/**
 * Installed on every context before any page script runs: counts the
 * getUserMedia calls that ask for AUDIO. A reload starts the count over, so it
 * describes the page as it is now (joinVoice reloads right before joining).
 * `audio: null` when read = the wrapper never installed, which must never
 * pass as "no prompt".
 */
const COUNT_AUDIO_ASKS = () => {
    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') return;
    const orig = md.getUserMedia.bind(md);
    window.__gumAudioAsks = 0;
    window.__gumAsks = [];
    md.getUserMedia = (c) => {
        try {
            if (c && c.audio) window.__gumAudioAsks++;
            window.__gumAsks.push(JSON.stringify(c).slice(0, 200));
        } catch { /* never break the page over a counter */ }
        return orig(c);
    };
};
const audioAsks = (p) => p.evaluate(() => ({
    audio: typeof window.__gumAudioAsks === 'number' ? window.__gumAudioAsks : null,
    asks: (window.__gumAsks ?? []).slice(-10),
}));

const AUDIBLE = 0.005;
const logs = [];
const result = { transport: TRANSPORT, expect: EXPECT, scenario: SCENARIO, app: APP, appB: APP_B, sameClientB: SAME_CLIENT_B };
let ok = false;

const browser = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, headless: true, args });
try {
    const names = { A: `spkA_${stamp}`, B: `spkB_${stamp}`, C: `spkC_${stamp}` };
    const ctxOf = async () => {
        const c = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 800 } });
        await c.route(/https?:\/\/([^/]*\.)?svrn\.lol(\/|$)/, r => r.abort());
        await c.addInitScript(COUNT_AUDIO_ASKS);
        return c;
    };
    const A = await register(await ctxOf(), APP, names.A);
    const B = await register(await ctxOf(), APP_B, names.B);
    const C = await register(await ctxOf(), APP, names.C);

    const serverName = 'Speak_' + stamp;
    await createServer(A, serverName);
    const serverId = psql(`SELECT id FROM servers WHERE name='${serverName}'`);
    if (!serverId) throw new Error('server was not created');
    const uid = {};
    for (const k of ['A', 'B', 'C']) uid[k] = Number(psql(`SELECT id FROM users WHERE username='${names[k]}'`));
    for (const k of ['B', 'C']) psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${uid[k]}) ON CONFLICT DO NOTHING`);
    const voiceId = Number(psql(`SELECT id FROM channels WHERE server_id='${serverId}' AND type=1 AND NOT is_afk ORDER BY position, id LIMIT 1`));
    if (!voiceId) throw new Error('no voice channel in the new server');
    if (TRANSPORT === 'sfu') psql(`UPDATE channels SET sfu_mode = true WHERE server_id='${serverId}'`);
    // B's role denies Speak on this voice channel only (a role overwrite, the
    // way the channel's Permissions tab writes it). A (owner) and C keep it.
    const roleId = psql(`INSERT INTO server_roles (server_id, name, permissions, position) VALUES ('${serverId}', 'NoSpeak', 0, 1) RETURNING id`).split('\n')[0];
    psql(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ('${serverId}', ${uid.B}, ${roleId})`);
    if (SCENARIO === 'deny-at-join') {
        psql(`INSERT INTO channel_permission_overwrites (channel_id, role_id, allow, deny) VALUES (${voiceId}, ${roleId}, 0, ${SPEAK})`);
    }
    Object.assign(result, { serverId, voiceId, uid });

    for (const [k, p] of [['A', A], ['C', C], ['B', B]]) {
        if (!await joinVoice(p)) throw new Error(`${k} could not find the voice channel`);
        await sleep(k === 'B' ? 9000 : 5000);
    }

    if (SCENARIO === 'revoke') {
        const audible0 = (h) => !!h && h.stream === true && h.energy >= AUDIBLE;
        // The same request the Permissions tab's Save sends, as the owner.
        const overwrite = (method) => A.evaluate(async ({ api, cid, rid, method, deny }) => {
            const r = await fetch(`${api}/channels/${cid}/overwrites/${rid}`, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
                body: method === 'PUT' ? JSON.stringify({ allow: 0, deny }) : undefined,
            });
            return r.status;
        }, { api: API, cid: voiceId, rid: Number(roleId), method, deny: SPEAK });
        // What LiveKit itself says a member is publishing, read on A's page:
        // the SFU's participant list, not anything that member's client
        // claims. A legacy B never unpublishes its own mic, so with APP_B set
        // this isolates the server's UpdateParticipant regrant from the
        // receivers' SpeakGate. true / false, or 'absent' if not in the room.
        const lkMic = (id) => A.evaluate(async (id) => {
            const d = await window.__pucaVoiceDiag?.();
            const peer = (d?.peers ?? []).find(p => String(p.identity).startsWith(`u${id}#`));
            return peer ? peer.publications.some(p => p.source === 'microphone') : 'absent';
        }, id);
        result.before = { AhearsB: audible0(await heard(A, uid.B)), AhearsC: audible0(await heard(A, uid.C)) };
        if (TRANSPORT === 'sfu') result.livekit = { BmicBefore: await lkMic(uid.B), CmicBefore: await lkMic(uid.C) };
        result.revokeStatus = await overwrite('PUT');
        await sleep(5000);
        if (TRANSPORT === 'sfu') Object.assign(result.livekit, { BmicAfterRevoke: await lkMic(uid.B), CmicAfterRevoke: await lkMic(uid.C) });
        const atA_B = await heard(A, uid.B);
        const atC_B = await heard(C, uid.B);
        result.afterRevoke = {
            AhearsB: audible0(atA_B), CheardsB: audible0(atC_B),
            // The RECEIVERS retracted B: no element at all. B's own client
            // muting itself would leave the element in place, silent — which
            // an old or modified B would not even do.
            AhasElementForB: atA_B.element, ChasElementForB: atC_B.element,
            AhearsC: audible0(await heard(A, uid.C)), panelB: await panelState(B),
        };
        result.grantStatus = await overwrite('DELETE');
        await sleep(5000);
        result.afterGrant = { panelB: await panelState(B), AhearsB: audible0(await heard(A, uid.B)) };
        const r = result;
        const receiversEnforced = !r.afterRevoke.AhearsB && !r.afterRevoke.CheardsB
            && r.afterRevoke.AhasElementForB === false && r.afterRevoke.ChasElementForB === false;
        // Only a current client can show these; an older B is judged on the
        // receivers alone.
        const bClientSays = !SAME_CLIENT_B || (/can't speak/.test(r.afterRevoke.panelB.label ?? '')
            && r.afterGrant.panelB.errors.some(e => /rejoin/i.test(e)));
        // SFU: LiveKit must have dropped B's microphone publication and only
        // B's (C keeps publishing), B still in the room. Before the revoke both
        // must be there, or the check below cannot fail.
        const lk = r.livekit;
        const livekitEnforced = TRANSPORT !== 'sfu' || (lk.BmicAfterRevoke === false && lk.CmicAfterRevoke === true);
        const livekitControl = TRANSPORT !== 'sfu' || (lk.BmicBefore === true && lk.CmicBefore === true);
        result.observed = {
            receiversEnforced, livekitEnforced: TRANSPORT === 'sfu' ? livekitEnforced : 'n/a (mesh)',
            bClientSays: SAME_CLIENT_B ? bClientSays : 'skipped (APP_B is a different client)',
        };
        ok = r.before.AhearsB && r.before.AhearsC && livekitControl && r.revokeStatus < 300 && receiversEnforced
            && livekitEnforced && r.afterRevoke.AhearsC && r.grantStatus < 300 && bClientSays;
        result.verdict = !r.before.AhearsB || !r.before.AhearsC || !livekitControl
            ? 'RIG BROKEN: before the revoke A must hear both B and C (and, on SFU, LiveKit must list both mics)'
            : ok ? `REVOKE ENFORCED (${TRANSPORT}${SAME_CLIENT_B ? '' : TRANSPORT === 'sfu' ? ', legacy B: receivers + LiveKit' : ', legacy B: receivers only'})`
                : `revoke NOT enforced (${TRANSPORT})`;
        throw Object.assign(new Error('done'), { done: true });
    }

    result.panel = { A: await panelState(A), B: await panelState(B), C: await panelState(C) };
    result.atA = { fromC: await heard(A, uid.C), fromB: await heard(A, uid.B) };
    result.atB = { fromA: await heard(B, uid.A) };
    result.atC = { fromB: await heard(C, uid.B) };
    // Microphone asks since each page's last load (joinVoice reloads first).
    result.audioAsks = { B: await audioAsks(B), C: await audioAsks(C) };

    const audible = (h) => !!h && h.stream === true && h.energy >= AUDIBLE;
    const control = audible(result.atA.fromC);
    const bJoinFailed = result.panel.B.label === null && result.panel.B.errors.some(e => /insufficient permissions/i.test(e));
    const bHearsA = audible(result.atB.fromA);
    const aHearsB = audible(result.atA.fromB) || audible(result.atC.fromB);
    // Positive control for the counter: C (allowed to speak, same client)
    // must have asked for the mic, or a counter that never fires would read
    // as "B was never prompted".
    const counterWorks = (result.audioAsks.C.audio ?? 0) >= 1;
    const bNeverPrompted = result.audioAsks.B.audio === 0;
    const bLabelSaysSo = /can't speak/.test(result.panel.B.label ?? '');
    result.observed = {
        positiveControl_AhearsC: control, bJoinFailed, bInCall: result.panel.B.label !== null, bHearsA, someoneHearsB: aHearsB,
        ...(SAME_CLIENT_B
            ? { positiveControl_CaskedForMic: counterWorks, bNeverPrompted, bLabelSaysSo }
            : { bClientChecks: 'skipped (APP_B is a different client)' }),
    };

    if (!control) {
        result.verdict = 'RIG BROKEN: A cannot hear C (the member who may speak), so nothing else here means anything';
    } else if (EXPECT === 'bug') {
        ok = TRANSPORT === 'sfu' ? bJoinFailed : aHearsB;
        result.verdict = ok ? `REPRODUCED (${TRANSPORT})` : `NOT reproduced (${TRANSPORT})`;
    } else if (SAME_CLIENT_B && !counterWorks) {
        result.verdict = 'RIG BROKEN: the getUserMedia counter saw no microphone ask from C, so "B was never prompted" means nothing';
    } else {
        ok = !bJoinFailed && result.panel.B.label !== null && bHearsA && !aHearsB
            && (!SAME_CLIENT_B || (bNeverPrompted && bLabelSaysSo));
        result.verdict = ok ? `FIXED (${TRANSPORT}${SAME_CLIENT_B ? '' : ', legacy B: receivers only'})`
            : `NOT fixed (${TRANSPORT})`;
    }
} catch (e) {
    if (!e?.done) result.error = String(e?.stack || e);
} finally {
    await browser.close().catch(() => {});
}
result.logTail = logs.slice(-40);
console.log(JSON.stringify(result, null, 2));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
