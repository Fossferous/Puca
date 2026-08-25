// Live 2-peer noise-suppression swap test: proves a mid-call NS mode change
// (standard → deepfilter → rnnoise → off → standard) swaps the outgoing mic
// track seamlessly — the remote peer keeps RECEIVING audio (track live +
// unmuted) and no console errors fire. Guards the 0.5.76 fixes:
// identity-matched mic sender replaceTrack, build-before-teardown graph swap,
// resume() guard — and, since the worklet+worker rebuild, the DeepFilter
// build/teardown path (gated: the test opens the Advanced → Experimental gate
// via localStorage before swapping onto it).
//
// Prereqs: native Postgres + backend (:3000) + vite (:5173) up.
// Usage: node e2e/ns-swap-2peer.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const PSQL = 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const AUSER = 'nsswap_a_' + stamp;
const BUSER = 'nsswap_b_' + stamp;

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++; };
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-d', 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream',
        // Real-address host candidates: same-machine ICE must not coin-flip
        // on headless mDNS resolution (see voice-camera-2peer.mjs).
        '--disable-features=WebRtcHideLocalIpsWithMdns', '--use-fake-device-for-media-stream'],
});

const consoleErrors = { a: [], b: [] };

async function register(ctx, user, errBucket) {
    const page = await ctx.newPage();
    page.on('console', m => {
        if (m.type() === 'error') { errBucket.push(m.text()); console.log(`  [${user} err]`, m.text().slice(0, 140)); }
    });
    await page.goto('http://localhost:5173/login');
    await page.waitForURL('**/login');
    await page.waitForSelector('#username', { timeout: 10000 });
    await page.click('.toggle-mode', { timeout: 5000 });
    await page.waitForSelector('#inviteCode', { timeout: 5000 });
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 30000 });
    await page.waitForTimeout(1200);
    try { await page.check('.recovery-confirm input[type="checkbox"]', { timeout: 4000 }); await page.click('.recovery-done-btn'); } catch { /* older flow */ }
    try { await page.click('.welcome-popup-close', { timeout: 2000 }); } catch { /* none */ }
    return page;
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

async function joinVoice(page) {
    await page.reload();
    await page.waitForTimeout(1800);
    await page.evaluate(() => {
        const icons = [...document.querySelectorAll('.server-icon')];
        const target = icons.find(i => !/direct message|add server|join server|notes|tasks/i.test(
            (i.getAttribute('title') || '') + ' ' + (i.className || '')));
        target?.click();
    });
    await page.waitForTimeout(1500);
    const joined = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.voice-channel-list .voice-channel')];
        const el = items.find(n => !n.classList.contains('afk'));
        if (el) { el.click(); return true; }
        return false;
    });
    await page.waitForTimeout(3000);
    return joined;
}

/** B-side: state of the received audio from any remote peer. */
const remoteAudioState = (page) => page.evaluate(() => {
    const els = [...document.querySelectorAll('audio[id^="audio-"]')];
    for (const el of els) {
        const s = el.srcObject;
        const t = s?.getAudioTracks?.()[0];
        if (t) return { found: true, readyState: t.readyState, muted: t.muted, id: t.id };
    }
    return { found: false };
});

/** Poll until the given user's voice-list entry gets the `speaking` class (the
 *  local VAD ring — Chromium's fake mic plays a repeating tone, so a LIVE
 *  analyser must light it within a few seconds; a dead one never does).
 *  The class lands on `.voice-user-item` in the channel sidebar (Chat.tsx). */
async function speakingLights(page, username, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const lit = await page.evaluate((u) => {
            return [...document.querySelectorAll('.voice-user-item.speaking, .voice-user.speaking')]
                .some(el => el.textContent.includes(u));
        }, username);
        if (lit) return true;
        await page.waitForTimeout(150);
    }
    return false;
}

/** A-side: current local outgoing mic track id + NS mode. */
const localMicState = (page) => page.evaluate(() => {
    const mode = localStorage.getItem('noiseSuppressionMode');
    // The voice panel keeps a hidden probe: find any live local audio track via
    // the mute button state isn't enough — read from the media element-less
    // path: RTCPeerConnection senders aren't reachable, so use the stream that
    // the local VAD/mute path uses if exposed; fall back to enumerating
    // MediaStreamTracks via the page's active streams (Chromium exposes none
    // globally), so instead we read the app's own state via the mic toggle.
    return { mode };
});

/** A-side: pick the NS mode via the app's settings (the same code path the
 *  user takes) — falls back to the module API through the settings <select>. */
async function setNsMode(page, mode) {
    // The NS <select> lives in the voice settings; find ANY select that has an
    // option with this value, change it via the DOM with React's native setter.
    const done = await page.evaluate((m) => {
        const selects = [...document.querySelectorAll('select')];
        const sel = selects.find(s => [...s.options].some(o => o.value === m));
        if (!sel) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, m);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }, mode);
    return done;
}

try {
    console.log('== setup ==');
    const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const a = await register(ctxA, AUSER, consoleErrors.a);
    const b = await register(ctxB, BUSER, consoleErrors.b);
    await createServer(a, 'NS Swap ' + stamp);

    // Put B in A's server directly (skips invite UI).
    const serverId = psql(`SELECT id FROM servers WHERE name = 'NS Swap ${stamp}'`);
    const bId = psql(`SELECT id FROM users WHERE username = '${BUSER}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${bId})`);

    check('A joins voice', await joinVoice(a));
    check('B joins voice', await joinVoice(b));
    await b.waitForTimeout(4000); // mesh connect

    let remote = await remoteAudioState(b);
    check('B receives A audio (live)', remote.found && remote.readyState === 'live');
    const trackBefore = remote.id;

    // Baseline: A's OWN speaking indicator lights from the local VAD (fake mic
    // tone). If this fails the methodology is broken, not the VAD.
    check('A speaking indicator lights (baseline VAD)', await speakingLights(a, AUSER));

    // Scope the console-error check to the SWAPS: initial mesh join can emit a
    // known (pre-existing) glare error unrelated to noise-mode changes.
    consoleErrors.a.length = 0;
    consoleErrors.b.length = 0;

    console.log('== open A settings & find NS select ==');
    // DeepFilter is gated behind Settings → Advanced → Experimental: open the
    // gate the same way the settings UI would (stored settings + the
    // settingsChanged event VoicePanel listens for) so the option renders.
    await a.evaluate(() => {
        const KEY = 'sovereign_settings';
        const s = JSON.parse(localStorage.getItem(KEY) || '{}');
        s.experimentalDeepFilter = true;
        localStorage.setItem(KEY, JSON.stringify(s));
        window.dispatchEvent(new Event('settingsChanged'));
    });
    // The NS select needs the voice settings UI open; try the gear near voice
    // panel, else the main settings modal Voice section.
    let found = await setNsMode(a, 'rnnoise');
    if (!found) {
        try { await a.click('.voice-settings-btn', { timeout: 2000 }); await a.waitForTimeout(600); } catch { /* try modal */ }
        found = await setNsMode(a, 'rnnoise');
    }
    if (!found) {
        try {
            await a.click('.user-settings-btn, .settings-btn', { timeout: 2000 });
            await a.waitForTimeout(800);
            try { await a.click('text=Voice', { timeout: 1500 }); await a.waitForTimeout(400); } catch { /* single page */ }
            found = await setNsMode(a, 'rnnoise');
        } catch { /* none */ }
    }
    check('NS select reachable', found);

    if (found) {
        console.log('== standard -> rnnoise (wasm/worklet build path) ==');
        await a.waitForTimeout(8000); // wasm fetch + graph build + swap
        remote = await remoteAudioState(b);
        check('B audio still live after -> rnnoise', remote.found && remote.readyState === 'live');
        check('B audio unmuted (RTP flowing) after -> rnnoise', remote.muted === false);
        // THE historically-reported symptom: the local speaking indicator died
        // after a swap (the VAD analyser kept reading the pre-swap dead track).
        check('A speaking indicator STILL lights after -> rnnoise swap', await speakingLights(a, AUSER));

        console.log('== rnnoise -> deepfilter (worker + worklet build path, gated) ==');
        check('NS select offers gated deepfilter', await setNsMode(a, 'deepfilter'));
        await a.waitForTimeout(12000); // 14 MB wasm fetch + tract build + swap
        remote = await remoteAudioState(b);
        check('B audio still live after -> deepfilter', remote.found && remote.readyState === 'live');
        check('B audio unmuted (RTP flowing) after -> deepfilter', remote.muted === false);
        // NO speaking-indicator assert on this rung: Chromium's fake mic is a
        // pure TONE, and DFN3 (a speech model) suppresses pure tones to near
        // silence — measured -163 dB in e2e/deepfilter-verify.mjs — so the VAD
        // reading the PROCESSED stream stays correctly dark. Liveness is
        // proven the strong way instead: the DF worklet posts telemetry every
        // ~2 s while (and only while) its pipeline is actually processing.
        // (localStorage can't prove this — it keeps the user's choice even
        // when the build silently fell back to RNNoise.)
        const dfDiag = await a.evaluate(() => {
            const d = window.__pucaVoiceDiag?.();
            const w = d?.noise?.deepFilter?.worklet;
            return { mode: d?.noise?.mode, processed: w?.processedSamples ?? 0, dry: w?.drySamples ?? -1, overloaded: w?.overloaded };
        });
        const dfLive = dfDiag.mode === 'deepfilter' && dfDiag.processed > 0 && dfDiag.dry === 0 && dfDiag.overloaded === false;
        check('deepfilter graph LIVE (worklet telemetry flowing, zero dry fallback)', dfLive);
        if (!dfLive) console.log('  df diag:', JSON.stringify(dfDiag));

        console.log('== deepfilter -> rnnoise (DF teardown path) ==');
        check('NS select still reachable (df→rn)', await setNsMode(a, 'rnnoise'));
        await a.waitForTimeout(6000);
        remote = await remoteAudioState(b);
        check('B audio still live after df -> rnnoise', remote.found && remote.readyState === 'live');
        check('B audio unmuted after df -> rnnoise', remote.muted === false);
        check('A speaking indicator STILL lights after df -> rnnoise swap', await speakingLights(a, AUSER));

        console.log('== rnnoise -> off (raw mic path) ==');
        check('NS select still reachable', await setNsMode(a, 'off'));
        await a.waitForTimeout(4000);
        remote = await remoteAudioState(b);
        check('B audio still live after -> off', remote.found && remote.readyState === 'live');
        check('B audio unmuted (RTP flowing) after -> off', remote.muted === false);

        console.log('== off -> standard (teardown path) ==');
        check('NS select still reachable (2)', await setNsMode(a, 'standard'));
        await a.waitForTimeout(4000);
        remote = await remoteAudioState(b);
        check('B audio still live after -> standard', remote.found && remote.readyState === 'live');
        check('B audio unmuted after -> standard', remote.muted === false);
        check('remote track object survived all swaps (replaceTrack, no renegotiation)', remote.id === trackBefore);
    }

    const relevantErr = (l) => l.filter(t =>
        /noise|audio|track|sender|webrtc|deepfilter|rnnoise/i.test(t) &&
        !/favicon|manifest|websocket.*closed/i.test(t));
    check('no audio-related console errors on A', relevantErr(consoleErrors.a).length === 0);
    check('no audio-related console errors on B', relevantErr(consoleErrors.b).length === 0);
    if (relevantErr(consoleErrors.a).length) console.log('  A errors:', relevantErr(consoleErrors.a).slice(0, 3));
    if (relevantErr(consoleErrors.b).length) console.log('  B errors:', relevantErr(consoleErrors.b).slice(0, 3));
} catch (e) {
    console.error('HARNESS ERROR:', e.message);
    failures++;
} finally {
    await browser.close();
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
