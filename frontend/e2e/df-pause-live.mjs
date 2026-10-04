// DeepFilter PAUSE / RESUME in a real call, flip by flip.
//
// DeepFilter pauses while nobody can hear the mic (src/api/dfPause.ts) and
// must resume the moment someone can. The unit suites pin the decision, the
// controller and the audio thread with fakes; this drives REAL clients
// through a real throwaway call and watches the measured client's DeepFilter
// worklet do it:
//
//   A alone                -> paused (alone), the Worker gets no hops
//   B joins                -> A resumes
//   B deafens              -> A pauses (everyone else deafened)
//   B undeafens            -> A resumes
//   A mutes / unmutes      -> paused / resumes
//   A muted, B leaves, A unmutes -> still paused (now alone), never resumed between
//   B joins again          -> resumes
//   push-to-talk: released -> paused; each press resumes, each release pauses
//
// For every resume it records the time from the action (the click or key
// press, on this machine's clock) to the main thread's 'resume' message, and
// how long the RNNoise bridge then carried the mic before DeepFilter was on
// air again (the worklet's own count, in samples). For every paused stretch it
// checks the Worker was really idle (no hop sent between two of the worklet's
// reports), and after every resume that DeepFilter is processing again with
// NOT ONE raw sample on air (dry and rawUncovered unchanged: the bridge
// covered from the first sample).
//
// How it watches, without touching the app: an init script wraps
// MessagePort's postMessage and onmessage, so it sees the main thread's
// 'pause' / 'resume' to the worklet and the worklet's own reports ('stats'
// every ~2 s, 'resumed'). That works on ANY build - run it against a build
// from before pausing existed and every pause check fails (the rig's red
// control).
//
// SFU=1 also runs the join/leave/deafen/mute flips on an SFU channel (needs
// the backend's LIVEKIT_* pointing at a LOCAL LiveKit; see
// own-voice-2device.mjs for the loopback-only config).
//
// Everything is headless with --mute-audio: nothing is shown, nothing plays.
// Needs a THROWAWAY backend + Postgres (PGPORT / PGDB / PGPASSWORD) and the
// built client served at APP (`PORT=... node e2e/serve-dist.mjs`).
// Usage: APP=http://127.0.0.1:5912 PGPORT=55436 PGDB=... node e2e/df-pause-live.mjs [out.json]
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const APP = process.env.APP || 'http://127.0.0.1:5173';
const CHANNEL = process.env.CHANNEL || 'msedge';
const SFU = process.env.SFU === '1';
const OUT = process.argv[2] || '';
const HOLD_MS = 1500; // dfPause.ts PAUSE_HOLD_MS
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-p', process.env.PGPORT || '5432', '-d', process.env.PGDB || 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' } }).toString().trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required',
    ...(SFU ? ['--allow-loopback-in-peer-connection'] : [])];

// DeepFilter on the measured client before any app script reads settings.
const dfInit = () => {
    const KEY = 'sovereign_settings';
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    s.experimentalDeepFilter = true;
    localStorage.setItem(KEY, JSON.stringify(s));
    localStorage.setItem('noiseSuppressionMode', 'deepfilter');
};
// The watcher: every pause/resume the main thread sends the worklet, every
// report the worklet sends back. Timestamps are Date.now(), the same clock
// the rig's own actions are stamped with.
const tapInit = () => {
    const rig = { sent: [], resumed: [], stats: [] };
    window.__dfRig = rig;
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (msg, ...rest) {
        if (msg && (msg.type === 'pause' || msg.type === 'resume')) rig.sent.push({ t: Date.now(), type: msg.type });
        return post.call(this, msg, ...rest);
    };
    const d = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
    Object.defineProperty(MessagePort.prototype, 'onmessage', {
        configurable: true,
        get() { return d.get.call(this); },
        set(fn) {
            d.set.call(this, typeof fn !== 'function' ? fn : function (e) {
                const m = e?.data;
                if (m?.type === 'resumed') rig.resumed.push({ t: Date.now(), coverSamples: m.coverSamples });
                else if (m?.stats && typeof m.stats.hopsSent === 'number') {
                    const s = m.stats;
                    rig.stats.push({ t: Date.now(), type: m.type, hopsSent: s.hopsSent, processed: s.processedSamples, bridge: s.bridgeSamples, dry: s.drySamples, flips: s.flips, paused: s.paused, rawUncovered: s.rawUncovered, overloaded: s.overloaded });
                }
                return fn.call(this, e);
            });
        },
    });
};

async function register(ctx, u) {
    const p = await ctx.newPage();
    await p.goto(APP + '/login');
    await p.waitForSelector('#username', { timeout: 30_000 });
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
/** Open the server and its text channel, ready to click the voice channel. */
async function openServer(p) {
    await p.reload(); await p.waitForTimeout(2000);
    await p.evaluate(() => {
        const i = [...document.querySelectorAll('.server-icon')].find(x => !/direct message|add server|join server|notes|tasks/i.test((x.getAttribute('title') || '') + ' ' + (x.className || '')));
        i?.click();
    });
    await p.waitForTimeout(1500);
    await p.evaluate(() => { document.querySelector('.channel-item:not(.voice-channel)')?.click(); });
    await p.waitForTimeout(500);
}
const clickVoice = (p, nth) => p.evaluate((n) => {
    const els = [...document.querySelectorAll('.voice-channel-list .voice-channel')].filter(x => !x.classList.contains('afk'));
    const el = els[n];
    if (el) { el.click(); return true; } return false;
}, nth);
const clickTitle = (p, title) => p.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === t && !x.disabled);
    if (b) { b.click(); return true; } return false;
}, title);
const rigState = (p) => p.evaluate(() => window.__dfRig);

/** Wait until A's last pause message is `type` (or none was ever sent and
 *  type is null); returns its timestamp, or null on timeout. */
async function waitSent(p, type, sinceT, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const r = await rigState(p);
        const hit = r.sent.find(m => m.t >= sinceT && m.type === type);
        if (hit) return hit.t;
        await sleep(20);
    }
    return null;
}
/** Two worklet reports at least `ms` apart, starting after `sinceT`. */
async function twoReports(p, sinceT, ms) {
    const end = Date.now() + ms + 8000;
    while (Date.now() < end) {
        const s = (await rigState(p)).stats.filter(x => x.t >= sinceT);
        const first = s[0];
        const later = first && s.find(x => x.t - first.t >= ms);
        if (later) return [first, later];
        await sleep(100);
    }
    return null;
}

const results = { app: APP, sfu: SFU, flips: [], checks: [], dfPause: null };
let failed = 0;
const check = (name, ok, detail = '') => {
    results.checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failed++;
};

/** The action happens, then A must send 'pause' within the hold + slack. */
async function expectPause(A, label, act) {
    const t0 = Date.now();
    await act();
    const t = await waitSent(A, 'pause', t0, HOLD_MS + 6000);
    check(`${label}: A pauses`, t !== null, t ? `${t - t0} ms after the action (hold ${HOLD_MS} ms)` : 'no pause within the hold + 6 s');
    if (t === null) return;
    results.flips.push({ flip: label, kind: 'pause', ms: t - t0 });
    // The Worker is idle: no hop between two reports >= 4 s apart.
    const pair = await twoReports(A, t + 300, 4000);
    check(`${label}: the Worker gets no hops while paused`, !!pair && pair[1].hopsSent === pair[0].hopsSent && pair[1].paused === true,
        pair ? `hopsSent ${pair[0].hopsSent} -> ${pair[1].hopsSent} over ${pair[1].t - pair[0].t} ms, paused=${pair[1].paused}` : 'no reports');
}

/** The action happens, then A must send 'resume' at once, and DeepFilter
 *  must be back on air, covered by the bridge from the first sample. */
async function expectResume(A, label, act) {
    const before = (await rigState(A)).stats.slice(-1)[0];
    const t0 = Date.now();
    await act();
    const t = await waitSent(A, 'resume', t0, 8000);
    check(`${label}: A resumes`, t !== null, t ? `'resume' sent ${t - t0} ms after the action` : 'no resume within 8 s');
    if (t === null) return;
    let cover = null;
    for (let i = 0; i < 100 && cover === null; i++) {
        const r = (await rigState(A)).resumed.find(x => x.t >= t);
        if (r) cover = r.coverSamples;
        else await sleep(20);
    }
    check(`${label}: DeepFilter back on air after the bridge`, typeof cover === 'number' && cover >= 0 && cover < 48 * 500,
        cover === null ? 'no resumed report' : `bridge carried ${(cover / 48).toFixed(1)} ms`);
    results.flips.push({ flip: label, kind: 'resume', ms: t - t0, coverMs: cover === null ? null : cover / 48 });
    const pair = await twoReports(A, t + 300, 2500);
    const ok = !!pair && pair[1].hopsSent > pair[0].hopsSent && pair[1].processed > pair[0].processed && pair[1].paused === false
        && !!before && pair[1].dry === before.dry && pair[1].rawUncovered === before.rawUncovered;
    check(`${label}: processing again, not one raw sample on air`, ok,
        pair && before ? `hops +${pair[1].hopsSent - pair[0].hopsSent}, processed +${pair[1].processed - pair[0].processed}, dry ${before.dry}->${pair[1].dry}, rawUncovered ${before.rawUncovered}->${pair[1].rawUncovered}` : 'no reports');
}

const browserA = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args });
const browserB = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args });
try {
    const ctxA = await browserA.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1400, height: 900 } });
    await ctxA.addInitScript(dfInit);
    await ctxA.addInitScript(tapInit);
    const ctxB = await browserB.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 800 } });
    const uA = `dfp_a_${stamp}`; const uB = `dfp_b_${stamp}`;
    const A = await register(ctxA, uA);
    const B = await register(ctxB, uB);
    const serverName = 'DfPause_' + stamp;
    await createServer(A, serverName);
    const serverId = psql(`SELECT id FROM servers WHERE name='${serverName}'`);
    const bId = psql(`SELECT id FROM users WHERE username='${uB}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${bId}) ON CONFLICT DO NOTHING`);

    const runCall = async (label, nth) => {
        console.log(`\n--- ${label} ---`);
        await openServer(A);
        await openServer(B);
        // A joins ALONE.
        await expectPause(A, `${label}: A alone`, async () => {
            if (!await clickVoice(A, nth)) throw new Error('A: no voice channel');
        });
        await expectResume(A, `${label}: B joins`, async () => {
            if (!await clickVoice(B, nth)) throw new Error('B: no voice channel');
        });
        await sleep(3000);
        await expectPause(A, `${label}: B deafens`, () => clickTitle(B, 'Deafen'));
        await expectResume(A, `${label}: B undeafens`, () => clickTitle(B, 'Undeafen'));
        await sleep(2000);
        await expectPause(A, `${label}: A mutes`, () => clickTitle(A, 'Mute'));
        await expectResume(A, `${label}: A unmutes`, () => clickTitle(A, 'Unmute'));
        await sleep(2000);
        // Two conditions: muted AND (after B leaves) alone. Clearing one keeps
        // it paused - no resume message in between - and the last resumes.
        await expectPause(A, `${label}: A mutes again`, () => clickTitle(A, 'Mute'));
        const t0 = Date.now();
        await clickTitle(B, 'Disconnect');
        await sleep(4000);
        await clickTitle(A, 'Unmute');
        await sleep(HOLD_MS + 2500);
        const sent = (await rigState(A)).sent;
        const lastBefore = sent.filter(m => m.t < t0).pop();
        const between = sent.filter(m => m.t >= t0);
        check(`${label}: muted + B leaves + A unmutes: still paused throughout (now alone)`,
            lastBefore?.type === 'pause' && between.every(m => m.type !== 'resume'),
            `paused before: ${lastBefore?.type === 'pause'}, messages since: ${JSON.stringify(between.map(m => m.type))}`);
        await openServer(B); // a reload: not part of the join being timed
        await expectResume(A, `${label}: B joins again`, async () => {
            if (!await clickVoice(B, nth)) throw new Error('B: no voice channel');
        });
        await sleep(3000);
    };

    await runCall('mesh', 0);

    // PUSH-TO-TALK on the mesh call (B still in it): switch A live.
    console.log('\n--- push-to-talk ---');
    await expectPause(A, 'ptt: switched to push-to-talk (key up)', () => A.evaluate(() => {
        const KEY = 'sovereign_settings';
        const s = JSON.parse(localStorage.getItem(KEY) || '{}');
        s.voiceInputMode = 'pushToTalk';
        s.pttBinding = { keyCode: 84, ctrl: false, alt: false, shift: false, label: 'T' };
        localStorage.setItem(KEY, JSON.stringify(s));
        window.dispatchEvent(new Event('settingsChanged'));
    }));
    await A.evaluate(() => { (document.activeElement)?.blur?.(); });
    for (let k = 1; k <= 5; k++) {
        await expectResume(A, `ptt press ${k}`, () => A.keyboard.down('t'));
        await sleep(2500);
        await expectPause(A, `ptt release ${k}`, () => A.keyboard.up('t'));
    }
    // A quick tap (well under the hold) after a long release: one resume, and
    // the release re-pauses only after the hold.
    const tap0 = Date.now();
    await A.keyboard.down('t'); await sleep(300);
    const up = Date.now();
    await A.keyboard.up('t');
    await sleep(HOLD_MS + 1500);
    const tapMsgs = (await rigState(A)).sent.filter(m => m.t >= tap0);
    const rePause = tapMsgs.find(m => m.type === 'pause');
    check('ptt: a 300 ms tap resumes once, and re-pauses only after the hold',
        tapMsgs.length === 2 && tapMsgs[0].type === 'resume' && !!rePause && rePause.t - up >= HOLD_MS - 50,
        `${JSON.stringify(tapMsgs.map(m => m.type))}, re-paused ${rePause ? rePause.t - up : '-'} ms after the release`);
    await A.evaluate(() => {
        const KEY = 'sovereign_settings';
        const s = JSON.parse(localStorage.getItem(KEY) || '{}');
        s.voiceInputMode = 'open';
        localStorage.setItem(KEY, JSON.stringify(s));
        window.dispatchEvent(new Event('settingsChanged'));
    });
    await sleep(HOLD_MS + 1000);
    await clickTitle(A, 'Disconnect');
    await clickTitle(B, 'Disconnect');
    await sleep(2000);

    if (SFU) {
        // The same voice channel, switched to the SFU tier (the backend's
        // LIVEKIT_* must point at a local LiveKit). Both pages reload in
        // runCall, so they read the new mode.
        const n = psql(`UPDATE channels SET sfu_mode = true WHERE server_id='${serverId}' AND type=1 AND NOT is_afk RETURNING id`);
        check('sfu: a voice channel switched to SFU', n.length > 0, `channel ${n}`);
        await runCall('sfu', 0);
    }

    // What deciding cost: evaluations and their total time on A.
    results.dfPause = await A.evaluate(async () => {
        const d = await window.__pucaVoiceDiag?.();
        return d?.noise?.dfPause ?? null;
    }).catch(() => null);
    results.rig = await rigState(A);
} finally {
    await browserA.close().catch(() => {});
    await browserB.close().catch(() => {});
}

const resumes = results.flips.filter(f => f.kind === 'resume');
const med = (xs) => { const s = xs.filter(x => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
console.log('\nflip                                   | kind   | action->message ms | bridge ms');
for (const f of results.flips) console.log(`${f.flip.padEnd(38)} | ${f.kind.padEnd(6)} | ${String(f.ms).padStart(18)} | ${f.coverMs == null ? '' : f.coverMs.toFixed(1)}`);
console.log(`resumes: median action->resume ${med(resumes.map(f => f.ms))} ms, median bridge ${med(resumes.map(f => f.coverMs))?.toFixed?.(1)} ms, worst bridge ${Math.max(...resumes.map(f => f.coverMs ?? -1)).toFixed(1)} ms`);
if (results.dfPause) console.log('dfPause:', JSON.stringify(results.dfPause));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
