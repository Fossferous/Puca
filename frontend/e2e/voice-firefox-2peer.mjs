// Live 2-peer MESH call between Chromium and FIREFOX, through the REAL app
// and a real backend: the standard WebRTC Encoded Transform path
// (RTCRtpScriptTransform, rtc/scriptTransform.ts — what Safari and the iPhone
// Home Screen app run) against Chromium's createEncodedStreams, with the
// default "Require encryption for calls" on.
//
// e2e/mesh-e2ee-interop-real-browser.mjs proves the encryption itself with
// stand-ins for the server; this proves the shipped app does it: real
// sign-up, a real server and voice channel, signalling relayed by the real
// backend, the real MediaManager (noise suppression and all) in Firefox.
//   - both panels say Encrypted, and Firefox wraps every sender and receiver
//     in an RTCRtpScriptTransform while Chromium wraps none (one path each);
//   - each side's microphone is heard by the other — under enforcement,
//     frames that were not opened are dropped, so audio energy arriving at
//     all means it was decrypted (CONTROL: muting one side takes the energy
//     the other measures away, so the measurement can fail);
//   - each side's camera renders on the other's voice stage.
//
// Prereqs (a THROWAWAY stack, CLAUDE.md): Postgres, a backend, and the app
// served at APP (a rig dist via e2e/serve-dist.mjs, or vite) built against
// that backend. Firefox: npx playwright install firefox.
//   APP=http://127.0.0.1:5181 PGPORT=5461 PGDB=live node e2e/voice-firefox-2peer.mjs
//
// Silent by construction: Chromium --mute-audio, Firefox media.volume_scale 0
// (the fake microphones are tones and each peer plays the other's), headless.
import { chromium, firefox } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const PSQL = 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const APP = process.env.APP || 'http://localhost:5173';
const PASS = 'Password123!';
const stamp = Date.now().toString(36);
const AUSER = 'ffownerA_' + stamp;
const BUSER = 'ffpeerB_' + stamp;

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; return ok; };
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', 'localhost', '-p', process.env.PGPORT || '5432', '-d', process.env.PGDB || 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: 'postgres' } }).toString().trim();

// Every RTCPeerConnection the page makes, for stats and wiring.
const PC_REGISTRY = () => {
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    function Patched(...args) { const pc = new Orig(...args); window.__pcs.push(pc); return pc; }
    Patched.prototype = Orig.prototype;
    Object.setPrototypeOf(Patched, Orig);
    window.RTCPeerConnection = Patched;
};

const chromiumBrowser = await chromium.launch({
    args: [
        '--mute-audio',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        // Real-address host candidates (see voice-camera-2peer.mjs).
        '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
});
const firefoxBrowser = await firefox.launch({
    headless: true,
    firefoxUserPrefs: {
        'media.volume_scale': '0.0',
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        'media.peerconnection.ice.obfuscate_host_addresses': false,
        'media.autoplay.default': 0,
        'media.autoplay.block-webaudio': false,
        'media.autoplay.blocking_policy': 0,
    },
});

const logs = { A: [], B: [] };
async function register(browser, tag, user) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(PC_REGISTRY);
    const page = await ctx.newPage();
    page.on('console', m => {
        const t = m.text();
        if (/media-e2ee|\[WebRTC\] conn|pageerror|setRemoteDescription\(|rejects the offer|rebuild/i.test(t)) logs[tag].push(`${m.type()}: ${t.slice(0, 200)}`);
        if (m.type() === 'error') console.log(`  [${tag} err]`, t.slice(0, 160));
    });
    page.on('pageerror', e => console.log(`  [${tag} pageerror]`, e.message.slice(0, 160)));
    await page.goto(APP + '/login');
    await page.waitForSelector('#username', { timeout: 30000 });
    await page.click('.toggle-mode', { timeout: 5000 });
    await page.waitForSelector('input[placeholder="Choose a password (min 8 characters)"]', { timeout: 5000 });
    await page.fill('#username', user);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 60000 });
    await page.waitForTimeout(1500);
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

async function joinVoice(page, chName) {
    await page.reload();
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
        const icons = [...document.querySelectorAll('.server-icon')];
        const target = icons.find(i => !/direct message|add server|join server|notes|tasks/i.test(
            (i.getAttribute('title') || '') + ' ' + (i.className || '')));
        target?.click();
    });
    await page.waitForTimeout(1500);
    return page.evaluate((name) => {
        const items = [...document.querySelectorAll('.voice-channel-list .voice-channel')];
        const el = items.find(n => !n.classList.contains('afk') && n.textContent.includes(name));
        if (el) { el.click(); return true; }
        return false;
    }, chName);
}

const badge = (page) => page.evaluate(() => document.querySelector('.voice-e2ee .voice-e2ee-label')?.textContent ?? null);

/** Inbound audio over the page's connections: bytes and decoded energy so far. */
const inboundAudio = (page) => page.evaluate(async () => {
    let bytes = 0, energy = 0;
    for (const pc of window.__pcs ?? []) {
        if (pc.connectionState === 'closed') continue;
        (await pc.getStats()).forEach(r => {
            if (r.type === 'inbound-rtp' && (r.kind ?? r.mediaType) === 'audio') {
                bytes += r.bytesReceived ?? 0;
                energy += r.totalAudioEnergy ?? 0;
            }
        });
    }
    return { bytes, energy };
});

/** Energy the page decodes from the other side over `ms`. */
async function heardOver(page, ms = 3000) {
    const a = await inboundAudio(page);
    await page.waitForTimeout(ms);
    const b = await inboundAudio(page);
    return { bytes: b.bytes - a.bytes, energy: b.energy - a.energy };
}

const wiring = (page) => page.evaluate(() => {
    const name = (t) => (t == null ? null : (typeof RTCRtpScriptTransform !== 'undefined' && t instanceof RTCRtpScriptTransform ? 'script' : 'other'));
    const live = (window.__pcs ?? []).filter(pc => pc.connectionState !== 'closed');
    return live.map(pc => ({
        state: pc.connectionState,
        senders: pc.getSenders().filter(s => s.track).map(s => `${s.track.kind}:${name(s.transform)}`),
        receivers: pc.getReceivers().map(r => `${r.track.kind}:${name(r.transform)}`),
    }));
});

const micButton = (page) => page.evaluate(() => {
    const btn = [...document.querySelectorAll('.voice-controls-compact .voice-btn')].find(b => /mute|microphone/i.test(b.getAttribute('title') || ''));
    if (!btn) return null;
    btn.click();
    return btn.getAttribute('title');
});

async function cameraOn(page) {
    return page.evaluate(() => {
        const btn = [...document.querySelectorAll('.voice-controls-compact .voice-btn')].find(b => /camera/i.test(b.getAttribute('title') || ''));
        if (btn) { btn.click(); return true; }
        return false;
    });
}

async function rendersCamera(page) {
    await page.evaluate(() => {
        const items = [...document.querySelectorAll('.voice-channel-list .voice-channel')];
        items.find(n => !n.classList.contains('afk') && n.textContent.includes('default'))?.click();
    });
    return page.evaluate(async () => {
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
            const v = [...document.querySelectorAll('.voice-stage .vs-camera-video')].find(x => x.videoWidth > 0);
            if (v) return { videoWidth: v.videoWidth };
            await new Promise(r => setTimeout(r, 250));
        }
        return { videoWidth: 0, tiles: document.querySelectorAll('.voice-stage .vs-camera-video').length };
    });
}

try {
    const pageA = await register(chromiumBrowser, 'A', AUSER);
    await createServer(pageA, 'FirefoxCall');
    const aId = psql(`SELECT id FROM users WHERE username='${AUSER}'`);
    const serverId = psql(`SELECT id FROM servers WHERE owner_id=${aId} ORDER BY id DESC LIMIT 1`);
    check('server created for the Chromium owner', !!serverId);

    const pageB = await register(firefoxBrowser, 'B', BUSER);
    const bId = psql(`SELECT id FROM users WHERE username='${BUSER}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${bId}) ON CONFLICT DO NOTHING`);
    check('the Firefox peer is a server member', psql(`SELECT count(*) FROM server_members WHERE server_id='${serverId}' AND user_id=${bId}`) === '1');

    check('both joined the voice channel', await joinVoice(pageA, 'default') && await joinVoice(pageB, 'default'));
    const deadline = Date.now() + 40000;
    let badges = [null, null];
    while (Date.now() < deadline) {
        badges = [await badge(pageA), await badge(pageB)];
        if (badges[0] === 'Encrypted' && badges[1] === 'Encrypted') break;
        await pageA.waitForTimeout(500);
    }
    check('both panels say Encrypted (under the default "Require encryption for calls")', badges[0] === 'Encrypted' && badges[1] === 'Encrypted', JSON.stringify(badges));
    check('both logged the forward-secret session key', logs.A.some(l => /ENABLED \(forward-secret/.test(l)) && logs.B.some(l => /ENABLED \(forward-secret/.test(l)));

    await pageA.waitForTimeout(2000);
    const [wA, wB] = [await wiring(pageA), await wiring(pageB)];
    const flat = (w) => w.flatMap(x => [...x.senders, ...x.receivers]);
    check('Chromium: one connected peer, no RTCRtpScriptTransform anywhere (createEncodedStreams)',
        wA.length === 1 && wA[0].state === 'connected' && flat(wA).length > 0 && flat(wA).every(s => s.endsWith(':null')), JSON.stringify(wA));
    check('Firefox: every sender and receiver on an RTCRtpScriptTransform',
        wB.length === 1 && wB[0].state === 'connected' && wB[0].senders.length > 0 && flat(wB).every(s => s.endsWith(':script')), JSON.stringify(wB));

    const heardA = await heardOver(pageA), heardB = await heardOver(pageB);
    check('Chromium hears Firefox (decrypted audio energy arrives)', heardA.bytes > 2000 && heardA.energy > 1e-4, JSON.stringify(heardA));
    check('Firefox hears Chromium (decrypted audio energy arrives)', heardB.bytes > 2000 && heardB.energy > 1e-4, JSON.stringify(heardB));

    // CONTROL: the measurement can fail — Firefox muted, Chromium hears nothing.
    const muted = await micButton(pageB);
    await pageB.waitForTimeout(1500);
    const whileMuted = await heardOver(pageA);
    check('CONTROL: with Firefox muted Chromium measures (almost) no energy', muted !== null && whileMuted.energy < heardA.energy / 20, JSON.stringify({ muted, whileMuted }));
    await micButton(pageB);
    await pageB.waitForTimeout(1500);
    const again = await heardOver(pageA);
    check('unmuted, Chromium hears Firefox again', again.energy > 1e-4, JSON.stringify(again));

    check('Chromium camera on', await cameraOn(pageA));
    const camAtB = await rendersCamera(pageB);
    check('Firefox renders the Chromium camera (decrypted video)', camAtB.videoWidth > 0, JSON.stringify(camAtB));
    check('Firefox camera on', await cameraOn(pageB));
    const camAtA = await rendersCamera(pageA);
    check('Chromium renders the Firefox camera (decrypted video)', camAtA.videoWidth > 0, JSON.stringify(camAtA));
    check('still Encrypted with both cameras on', (await badge(pageA)) === 'Encrypted' && (await badge(pageB)) === 'Encrypted');
    // Firefox's camera reuses the transceiver Chromium's camera offer made: a
    // codec preference there once made Firefox write an offer Chromium refused
    // whole, and the call only came back through a rebuild.
    const refused = [...logs.A, ...logs.B].filter(l => /setRemoteDescription\(|rejects the offer|rebuilding/i.test(l));
    check('no description refused and no connection rebuilt along the way', refused.length === 0, refused.slice(0, 2).join(' / '));
} catch (e) {
    console.log('EXCEPTION:', String(e).split('\n').slice(0, 3).join(' | '));
    failures++;
} finally {
    for (const tag of ['A', 'B']) {
        const tail = logs[tag].slice(-6);
        if (tail.length) console.log(`  ${tag} log tail:\n    ${tail.join('\n    ')}`);
    }
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
    await chromiumBrowser.close();
    await firefoxBrowser.close();
    process.exit(failures === 0 ? 0 : 1);
}
