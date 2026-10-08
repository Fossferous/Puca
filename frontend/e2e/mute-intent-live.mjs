// LIVE: a member who muted themselves is never made live by the app.
//
// When a member's microphone dies mid-call, the call goes listen-only, which
// mutes them (nobody can hear them). When a microphone comes back, the call
// re-opens it. That recovery used to UNMUTE unconditionally, so a member who
// had muted themselves (or deafened, which mutes) before the microphone died
// came back LIVE without touching anything. And the forced mute of a
// moderator's "Move to" is the same shape: the member lands in a new channel,
// and a new channel used to mean a fresh, unmuted mic.
//
// Two REAL clients (A speaks, B listens) in a real throwaway call. A's
// "microphone dies" with Chromium's fake capture: an init script makes every
// audio open fail with NotFoundError and the input list empty, and the live
// capture is stopped and its 'ended' fired (what Chromium does when a
// Bluetooth headset walks out of range). "It comes back": the opens succeed
// again and a devicechange burst is fired. Every audio sender's (track,
// enabled) is sampled continuously; B's view of A's status comes from B's own
// sidebar; what B HEARS is the audio energy of B's inbound RTP; and A's own
// speaking ring is sampled from A's sidebar (it must light when A is live and
// never when A is not).
//
//   - unmuted -> lost -> back: live again, B hears A (the recovery's purpose,
//     and the positive control: the measurement can hear an open mic);
//   - muted -> lost -> back: still muted, at no moment an enabled sender,
//     B sees A muted and hears nothing;
//   - lost -> A presses its Toggle Mute key WHILE listen-only -> back: still
//     muted (and the Mute button itself works while listen-only);
//   - deafened -> lost -> back: still deafened AND muted;
//   - push-to-talk, key not held -> lost -> back: nothing transmits;
//   - Toggle Deafen and Toggle Mute pressed in ONE task (no render between:
//     two desktop-global hotkey events behind a busy main thread, a macro),
//     both orders, from unmuted and from muted, and longer alternations: a
//     deafened member never transmits, and each ends in its known state;
//   - joined with NO microphone, then one plugged in: B hears A iff A is
//     unmuted (on mesh the join had no audio sender to put it on);
//   - a moderator moves A to another channel: unmuted, A arrives live (the
//     control); muted (then muted + deafened), A arrives muted (deafened)
//     and nothing transmits;
//   - A leaves and joins by itself: unmuted, as a join always started (the
//     control: nothing a move carried leaks into a join the member makes);
//   - moved while the microphone is gone, then it comes back: heard;
//   - in the AFK channel -> lost -> back: still muted (the channel's own mute).
//
// Run it against a build from before the fix and the muted cases FAIL (the
// rig's red control); the unmuted case passes on both.
//
// Headless Edge, --mute-audio, Chromium's FAKE capture devices: nothing is
// shown, nothing plays, no real microphone is opened. Needs a THROWAWAY
// backend + Postgres (PGPORT / PGDB / PGPASSWORD), API pointing at that
// backend (for the moderator move) and the built client served at APP
// (`DIST=<dir> PORT=... node e2e/serve-dist.mjs`). SFU=1 runs the same on
// SFU-mode channels (the AFK channel stays mesh; needs a LiveKit node the
// backend points at).
// Usage: APP=http://127.0.0.1:7911 API=http://127.0.0.1:7811 PGPORT=55436 PGDB=... [SFU=1] node e2e/mute-intent-live.mjs [out.json]
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const APP = process.env.APP || 'http://127.0.0.1:5173';
const API = process.env.API || 'http://127.0.0.1:3000';
const CHANNEL = process.env.CHANNEL || 'msedge';
const SFU = process.env.SFU === '1';
const OUT = process.argv[2] || '';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const SETTLE_MS = 800; // micDeviceWatchdog.ts SETTLE_MS
const HEARD = 0.2;     // a fake capture's tone over 3 s is ~1
const SILENT = 0.02;
const stamp = Date.now().toString(36);
const psql = (sql) => execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-p', process.env.PGPORT || '5432', '-d', process.env.PGDB || 'puca', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' } }).toString().trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
        try { last = await fn(); if (last) return last; } catch { /* retry */ }
        await sleep(step);
    }
    return last;
}

const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required',
    ...(SFU ? ['--allow-loopback-in-peer-connection'] : [])];

// Runs before any app script: the microphone that can die and come back, the
// RTCPeerConnection collector, and the sender sampler.
const osInit = () => {
    const md = navigator.mediaDevices;
    if (!md) return;
    const realEnum = md.enumerateDevices.bind(md);
    const realGum = md.getUserMedia.bind(md);
    const sim = { gone: false, tracks: {}, opens: [], senderLog: [], speaking: [] };
    window.__osSim = sim;
    md.enumerateDevices = async () => (await realEnum()).filter(d => !(sim.gone && d.kind === 'audioinput'));
    md.getUserMedia = async (c) => {
        if (c && c.audio && sim.gone) {
            sim.opens.push({ t: Date.now(), refused: true });
            throw new DOMException('Requested device not found', 'NotFoundError');
        }
        const s = await realGum(c);
        const t = s.getAudioTracks()[0];
        if (t) {
            sim.tracks[t.id] = t;
            sim.opens.push({ t: Date.now(), trackId: t.id });
        }
        return s;
    };
    /** The microphone dies: nothing can be opened, the input list is empty,
     *  and the live capture ends as the OS ends it. */
    sim.lose = () => {
        sim.gone = true;
        for (const t of Object.values(sim.tracks)) {
            if (t.readyState !== 'live') continue;
            t.stop();
            t.dispatchEvent(new Event('ended'));
        }
        md.dispatchEvent(new Event('devicechange'));
    };
    /** A microphone is back: opens succeed, and Windows announces it. */
    sim.back = async () => {
        sim.gone = false;
        for (let i = 0; i < 3; i++) { md.dispatchEvent(new Event('devicechange')); await new Promise(r => setTimeout(r, 40)); }
    };
    /** Sample whether OUR row in the sidebar shows the speaking ring. */
    sim.watchSpeaking = (name) => {
        setInterval(() => {
            const li = [...document.querySelectorAll('.voice-user-name')].find(n => n.textContent.includes(name))?.closest('li');
            if (li && li.classList.contains('speaking')) {
                const open = pcs.some(pc => pc.connectionState !== 'closed' && pc.getSenders().some(x => x.track && x.track.kind === 'audio' && x.track.enabled));
                sim.speaking.push({ t: Date.now(), open });
            }
        }, 50);
    };
    const PC = window.RTCPeerConnection;
    const pcs = [];
    window.__pcs = pcs;
    const Wrapped = function (...a) { const pc = new PC(...a); pcs.push(pc); return pc; };
    Wrapped.prototype = PC.prototype;
    Object.setPrototypeOf(Wrapped, PC);
    window.RTCPeerConnection = Wrapped;
    const last = new Map();
    setInterval(() => {
        pcs.forEach((pc, n) => {
            if (pc.connectionState === 'closed') return;
            pc.getSenders().forEach((s, i) => {
                const tr = s.track;
                if (!tr || tr.kind !== 'audio') return;
                const key = n + ':' + i;
                const v = tr.id + ':' + tr.enabled + ':' + tr.readyState;
                if (last.get(key) !== v) { last.set(key, v); sim.senderLog.push({ t: Date.now(), key, id: tr.id, enabled: tr.enabled, live: tr.readyState === 'live' }); }
            });
        });
    }, 0);
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
const clickVoiceNamed = (p, name) => p.evaluate((n) => {
    const el = [...document.querySelectorAll('.voice-channel-list .voice-channel')].find(x => x.textContent.includes(n));
    if (el) { el.click(); return true; } return false;
}, name);
const clickTitle = (p, title) => p.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === t && !x.disabled);
    if (b) { b.click(); return true; } return false;
}, title);
/** The voice panel's Mute button: its title, and whether it can be pressed. */
const muteButton = (p) => p.evaluate(() => {
    const b = document.querySelector('.voice-controls-compact .voice-btn');
    return b ? { title: b.getAttribute('title'), disabled: b.disabled, cls: b.className } : null;
});
const deafenButton = (p) => p.evaluate(() => {
    const b = document.querySelectorAll('.voice-controls-compact .voice-btn')[1];
    return b ? { title: b.getAttribute('title') } : null;
});
// The status line says so, except in an AFK channel (it says "AFK — mic
// disabled" there); the Mute button's `no-mic` look says so everywhere.
const listenOnly = (p) => p.evaluate(() => /listen-only/.test(document.querySelector('.voice-connected-label')?.textContent ?? '')
    || (document.querySelector('.voice-controls-compact .voice-btn')?.classList.contains('no-mic') ?? false));
/** Toggle Mute (Ctrl+Shift+M) / Toggle Deafen (Ctrl+Shift+D) presses
 *  dispatched in ONE task: no React render between them, which is what two
 *  desktop-global hotkey events queued behind a busy main thread get (or a
 *  Stream Deck macro). */
const KEY = { M: ['KeyM', 'M', 77], D: ['KeyD', 'D', 68] };
const burst = (p, seq) => p.evaluate((codes) => {
    document.activeElement?.blur?.();
    for (const [code, key, keyCode] of codes) {
        const o = { key, code, keyCode, which: keyCode, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true };
        window.dispatchEvent(new KeyboardEvent('keydown', o));
        window.dispatchEvent(new KeyboardEvent('keyup', o));
    }
}, seq.split('').map(c => KEY[c]));
/** What B's sidebar says about A. */
const rosterOf = (p, name) => p.evaluate((n) => {
    const li = [...document.querySelectorAll('.voice-user-name')].find(x => x.textContent.includes(n))?.closest('li');
    if (!li) return null;
    return { muted: !!li.querySelector('.voice-status-icon.muted'), deafened: !!li.querySelector('.voice-status-icon.deafened'),
        channel: li.closest('.voice-channel-list, li.voice-channel, .voice-channel')?.textContent?.slice(0, 60) ?? null };
}, name);
const senders = (p) => p.evaluate(() => window.__pcs.filter(pc => pc.connectionState !== 'closed')
    .flatMap(pc => pc.getSenders().filter(s => s.track && s.track.kind === 'audio')
        .map(s => ({ id: s.track.id, enabled: s.track.enabled, live: s.track.readyState === 'live' }))));
const sim = (p) => p.evaluate(() => ({ senderLog: window.__osSim.senderLog.slice(), opens: window.__osSim.opens.slice(), speaking: window.__osSim.speaking.slice() }));
/** Audio energy B has received, over every live connection. */
const received = (p) => p.evaluate(async () => {
    let energy = 0, packets = 0;
    for (const pc of window.__pcs) {
        if (pc.connectionState === 'closed') continue;
        (await pc.getStats()).forEach(r => {
            if (r.kind === 'audio' && r.type === 'inbound-rtp') { energy += r.totalAudioEnergy || 0; packets += r.packetsReceived || 0; }
        });
    }
    return { energy, packets };
});
const pcStates = (p) => p.evaluate(() => window.__pcs.filter(pc => pc.connectionState !== 'closed').map(pc => ({
    cs: pc.connectionState, ss: pc.signalingState,
    tx: pc.getTransceivers().map(t => `${t.mid}:${t.direction}/${t.currentDirection}:${t.sender.track ? t.sender.track.kind + (t.sender.track.enabled ? '+' : '-') : 'none'}`),
})));
async function energyOver(B, ms) {
    const r0 = await received(B); await sleep(ms); const r1 = await received(B);
    return { energy: +(r1.energy - r0.energy).toFixed(4), packets: r1.packets - r0.packets };
}

const results = { app: APP, sfu: SFU, checks: [] };
let failed = 0;
const check = (name, ok, detail = '') => {
    results.checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failed++;
};

/** A's mic dies; A goes listen-only. Returns when it has. */
async function lose(A, label) {
    const t = Date.now();
    await A.evaluate(() => window.__osSim.lose());
    const lo = await until(() => listenOnly(A), 10_000, 100);
    check(`${label}: the microphone died and A went listen-only (the case is real)`, !!lo);
    return t;
}
/** A's mic comes back; wait for the re-open and the recovery to settle. */
async function back(A, label) {
    const n0 = (await sim(A)).opens.filter(o => !o.refused).length;
    await A.evaluate(() => window.__osSim.back());
    const reopened = await until(async () => (await sim(A)).opens.filter(o => !o.refused).length > n0, 10_000, 100);
    await until(async () => !(await listenOnly(A)), 8000, 100);
    await sleep(SETTLE_MS + 1500);
    const s = await senders(A);
    check(`${label}: the microphone came back, was re-opened and is on every sender`, !!reopened && !(await listenOnly(A)) && s.length > 0 && s.every(x => x.live),
        JSON.stringify(s.map(x => `${x.id.slice(0, 8)}:${x.live ? 'live' : 'ended'}:${x.enabled ? 'on' : 'off'}`)));
}
/** Nothing of A's went out enabled since `t0`, and B hears nothing. */
async function expectSilent(A, B, label, t0, nameA, { deafened = false, ptt = false, title = null } = {}) {
    const { senderLog, speaking } = await sim(A);
    const hot = senderLog.filter(e => e.t >= t0 && e.enabled && e.live);
    check(`${label}: no audio sender carried an enabled live track at any moment since`, hot.length === 0,
        JSON.stringify(hot.slice(0, 4).map(e => ({ ms: e.t - t0, sender: e.key, id: e.id.slice(0, 8) }))));
    const s = await senders(A);
    check(`${label}: every sender's mic track is shut now`, s.length > 0 && s.every(x => !x.enabled), JSON.stringify(s.map(x => x.enabled)));
    const btn = await muteButton(A);
    const wantTitle = title ?? (ptt ? 'Push to talk — hold your key to speak' : 'Unmute');
    check(`${label}: the Mute button says "${wantTitle}"`, btn?.title === wantTitle, JSON.stringify(btn));
    if (deafened) check(`${label}: still deafened (the button says Undeafen)`, (await deafenButton(A))?.title === 'Undeafen');
    const r = await until(async () => { const x = await rosterOf(B, nameA); return x && x.muted === !ptt && x.deafened === deafened ? x : null; }, 4000, 200) ?? await rosterOf(B, nameA);
    check(`${label}: B's sidebar shows A ${ptt ? 'not muted (push-to-talk is not a mute)' : 'muted'}${deafened ? ' and deafened' : ''}`,
        !!r && r.muted === !ptt && r.deafened === deafened, JSON.stringify(r));
    const e = await energyOver(B, 3000);
    check(`${label}: B receives no audio energy from A`, e.energy < SILENT, `energy +${e.energy}, ${e.packets} packets in 3 s`);
    const lit = speaking.filter(x => x.t >= t0 + 300);
    check(`${label}: A's own speaking ring never lit`, lit.length === 0,
        `${lit.length} sample(s)` + (lit.length ? `, ${lit[0].t - t0}..${lit[lit.length - 1].t - t0} ms after, a sender open at ${lit.filter(x => x.open).length} of them` : ''));
}
async function expectLive(A, B, label, nameA) {
    const s = await senders(A);
    check(`${label}: every sender's mic track is open`, s.length > 0 && s.every(x => x.enabled && x.live), JSON.stringify(s.map(x => x.enabled)));
    const btn = await muteButton(A);
    check(`${label}: the Mute button says "Mute"`, btn?.title === 'Mute', JSON.stringify(btn));
    const r = await until(async () => { const x = await rosterOf(B, nameA); return x && !x.muted ? x : null; }, 4000, 200) ?? await rosterOf(B, nameA);
    check(`${label}: B's sidebar shows A unmuted`, !!r && !r.muted && !r.deafened, JSON.stringify(r));
    const tE = Date.now();
    const e = await energyOver(B, 3000);
    // On a failure, what both ends' peer connections say (a renegotiation
    // that never landed reads as a recvonly transceiver here).
    const why = e.energy > HEARD ? '' : `; A ${JSON.stringify(await pcStates(A))}; B ${JSON.stringify(await pcStates(B))}`;
    check(`${label}: B hears A (the measurement sees audio)`, e.energy > HEARD, `energy +${e.energy}, ${e.packets} packets in 3 s${why}`);
    const lit = (await sim(A)).speaking.filter(x => x.t >= tE);
    check(`${label}: A's own speaking ring lights for it`, lit.length > 0, `${lit.length} sample(s) in 3 s`);
}

const browserA = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args });
const browserB = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args });
try {
    const ctxA = await browserA.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1400, height: 900 } });
    await ctxA.addInitScript(osInit);
    const ctxB = await browserB.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 800 } });
    await ctxB.addInitScript(osInit); // B only needs the RTCPeerConnection collector
    const uA = `mi_a_${stamp}`; const uB = `mi_b_${stamp}`;
    const A = await register(ctxA, uA);
    const B = await register(ctxB, uB);
    // B owns the server (and so may move A); A is a member.
    const serverName = 'MuteIntent_' + stamp;
    await createServer(B, serverName);
    const serverId = psql(`SELECT id FROM servers WHERE name='${serverName}'`);
    const aId = psql(`SELECT id FROM users WHERE username='${uA}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${aId}) ON CONFLICT DO NOTHING`);
    // Two voice channels: where the call is, and where the moderator moves A.
    const mk = (name) => B.evaluate(async ({ api, sid, name }) => {
        const r = await fetch(`${api}/servers/${sid}/channels`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
            body: JSON.stringify({ name, channel_type: 1 }) });
        return r.ok ? (await r.json()).id : `HTTP ${r.status}`;
    }, { api: API, sid: serverId, name });
    const one = await mk('mi-one'); const two = await mk('mi-two');
    check('setup: two voice channels created', Number.isFinite(one) && Number.isFinite(two), `${one} ${two}`);
    if (SFU) psql(`UPDATE channels SET sfu_mode = true WHERE server_id='${serverId}' AND type=1 AND NOT is_afk`);
    await openServer(A);
    await openServer(B);
    if (!await clickVoiceNamed(B, 'mi-one')) throw new Error('B: no voice channel');
    await sleep(2500);
    if (!await clickVoiceNamed(A, 'mi-one')) throw new Error('A: no voice channel');
    const up = await until(async () => (await senders(A)).length > 0 && (await energyOver(B, 1000)).packets > 10, 30_000, 500);
    check('the call is up (A publishes, B receives)', !!up);
    await A.evaluate((n) => window.__osSim.watchSpeaking(n), uA);
    // Keyboard focus off any text field, so the Toggle Mute key is a hotkey.
    await A.evaluate(() => { document.activeElement?.blur?.(); });

    // 1. Unmuted: the recovery's purpose, and the positive control.
    await lose(A, 'unmuted');
    await back(A, 'unmuted');
    await expectLive(A, B, 'unmuted -> lost -> back', uA);

    // 2. Muted before the microphone died.
    check('muted: A mutes', await clickTitle(A, 'Mute'));
    await sleep(800);
    let t0 = await lose(A, 'muted');
    await back(A, 'muted');
    await expectSilent(A, B, 'muted -> lost -> back', t0, uA);
    check('muted: A unmutes by itself', await clickTitle(A, 'Unmute'));
    await sleep(800);
    await expectLive(A, B, 'muted -> lost -> back -> A unmutes', uA);

    // 3. Muted WHILE listen-only: the member's Toggle Mute key.
    t0 = await lose(A, 'muted while listen-only');
    const before = await muteButton(A);
    await A.evaluate(() => { document.activeElement?.blur?.(); });
    await A.keyboard.press('Control+Shift+KeyM');
    await sleep(500);
    const afterKey = await muteButton(A);
    check('muted while listen-only: the Mute button can be pressed while listen-only', !!before && !before.disabled, JSON.stringify(before));
    check('muted while listen-only: the Toggle Mute key changed what the button says', !!afterKey && afterKey.title !== before?.title, `${before?.title} -> ${afterKey?.title}`);
    await back(A, 'muted while listen-only');
    await expectSilent(A, B, 'muted while listen-only -> back', t0, uA);
    // ...and the button, both ways, while listen-only.
    t0 = await lose(A, 'button while listen-only');
    const b0 = await muteButton(A);
    const clicked = await A.evaluate(() => { const b = document.querySelector('.voice-controls-compact .voice-btn'); if (!b || b.disabled) return false; b.click(); return true; });
    await sleep(300);
    const b1 = await muteButton(A);
    check('button while listen-only: clicking Mute (muted -> wants to be live when it is back)', clicked && b1?.title !== b0?.title, `${b0?.title} -> ${b1?.title}`);
    await back(A, 'button while listen-only');
    await expectLive(A, B, 'unmuted with the button while listen-only -> back', uA);

    // 4. Deafened (deafen mutes).
    check('deafened: A deafens', await clickTitle(A, 'Deafen'));
    await sleep(800);
    t0 = await lose(A, 'deafened');
    await back(A, 'deafened');
    await expectSilent(A, B, 'deafened -> lost -> back', t0, uA, { deafened: true });
    check('deafened: A undeafens', await clickTitle(A, 'Undeafen'));
    await sleep(800);
    await expectSilent(A, B, 'deafened -> back -> undeafened: still muted, as undeafening always leaves you', t0, uA);
    check('deafened: A unmutes by itself', await clickTitle(A, 'Unmute'));
    await sleep(800);
    await expectLive(A, B, 'after deafen, A unmutes', uA);

    // 5. Push-to-talk, key not held.
    await A.evaluate(() => {
        const s = JSON.parse(localStorage.getItem('sovereign_settings') || '{}');
        s.voiceInputMode = 'pushToTalk';
        s.pttBinding = { keyCode: 119, ctrl: false, alt: false, shift: false, label: 'F8' };
        localStorage.setItem('sovereign_settings', JSON.stringify(s));
        window.dispatchEvent(new Event('settingsChanged'));
    });
    await sleep(1000);
    const ptt = await muteButton(A);
    check('push-to-talk: switched (the button says hold your key)', ptt?.title === 'Push to talk — hold your key to speak', JSON.stringify(ptt));
    t0 = await lose(A, 'push-to-talk');
    await back(A, 'push-to-talk');
    await expectSilent(A, B, 'push-to-talk, not held -> lost -> back', t0, uA, { ptt: true });
    await A.evaluate(() => {
        const s = JSON.parse(localStorage.getItem('sovereign_settings') || '{}');
        s.voiceInputMode = 'open';
        localStorage.setItem('sovereign_settings', JSON.stringify(s));
        window.dispatchEvent(new Event('settingsChanged'));
    });
    await sleep(1000);
    await expectLive(A, B, 'back to an open mic', uA);

    // 6. Two keys in ONE task (no render between them): both orders, from
    // unmuted and from muted, and longer alternations ending in a known state.
    // Deafen mutes, Toggle Mute is refused while deafened, and nothing a burst
    // does may leave a deafened member transmitting.
    const reset = async (label, muted = false) => {
        for (let i = 0; i < 3; i++) {
            if ((await deafenButton(A))?.title === 'Undeafen') { await clickTitle(A, 'Undeafen'); await sleep(400); }
            const want = muted ? 'Mute' : 'Unmute'; // the title to press away
            if ((await muteButton(A))?.title === want) { await clickTitle(A, want); await sleep(400); }
        }
        await sleep(800);
        const m = await muteButton(A);
        check(`${label}: starts ${muted ? 'muted' : 'unmuted'}, not deafened`,
            m?.title === (muted ? 'Unmute' : 'Mute') && (await deafenButton(A))?.title === 'Deafen', m?.title);
    };
    const bursts = [
        // [keys, start muted?, ends: 'deafened' | 'muted' | 'live']
        ['DM', false, 'deafened'], ['MD', false, 'deafened'],
        ['DM', true, 'deafened'], ['MD', true, 'deafened'],
        ['MDMDM', false, 'live'], ['DMDMD', false, 'deafened'], ['MMMMMMM', false, 'muted'],
    ];
    for (const [keys, startMuted, ends] of bursts) {
        const label = `keys ${keys.split('').join('+')} in one task from ${startMuted ? 'muted' : 'unmuted'}`;
        await reset(label, startMuted);
        await burst(A, keys);
        await sleep(1500);
        if (ends === 'live') await expectLive(A, B, label, uA);
        else await expectSilent(A, B, label, Date.now(), uA, { deafened: ends === 'deafened' });
    }
    await reset('after the bursts');

    // 7. Joined with NO microphone at all, then one is plugged in. On a mesh
    // call the join had no audio sender to put it on (only a receive-only
    // transceiver), so an unmuted member stayed unheard while everyone saw
    // them unmuted. B must receive A iff A is unmuted.
    const joinWithoutMic = async (label) => {
        check(`${label}: A disconnects`, await clickTitle(A, 'Disconnect'));
        await sleep(1500);
        await A.evaluate(() => { window.__osSim.gone = true; });
        check(`${label}: A joins mi-one with no microphone`, await clickVoiceNamed(A, 'mi-one'));
        check(`${label}: A joined listen-only`, !!await until(() => listenOnly(A), 20_000, 200));
        await sleep(3000);
    };
    await joinWithoutMic('no mic at the join, unmuted');
    await back(A, 'no mic at the join, unmuted');
    await expectLive(A, B, 'no mic at the join, unmuted -> one plugged in', uA);
    await joinWithoutMic('no mic at the join, muted');
    check('no mic at the join, muted: A presses Mute while there is no microphone', await A.evaluate(() => {
        const b = document.querySelector('.voice-controls-compact .voice-btn');
        if (!b || b.disabled) return false;
        b.click();
        return true;
    }));
    await sleep(500);
    t0 = Date.now();
    await back(A, 'no mic at the join, muted');
    await expectSilent(A, B, 'no mic at the join, muted -> one plugged in', t0, uA);
    check('no mic at the join, muted: A unmutes by itself', await clickTitle(A, 'Unmute'));
    await sleep(800);
    await expectLive(A, B, 'no mic at the join, muted -> plugged in -> A unmutes', uA);

    // 8. A moderator moves A: unmuted (the control: a move mutes nobody),
    // muted, then muted + deafened. Then A leaves and joins by itself (the
    // control: a join the member makes starts unmuted, as it always has, and
    // nothing a move carried leaks into it).
    const move = (to) => B.evaluate(async ({ api, sid, uid, to }) => {
        const r = await fetch(`${api}/servers/${sid}/voice-move/${uid}`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
            body: JSON.stringify({ channel_id: to }) });
        return r.status;
    }, { api: API, sid: serverId, uid: Number(aId), to });
    const inChannel = async (name) => (await A.evaluate(() => document.querySelector('.voice-channel-name')?.textContent ?? '')) === name
        && (await senders(A)).length > 0;
    const moveA = async (name, id, label) => {
        // B goes first, so someone in the destination hears A.
        await clickVoiceNamed(B, name);
        await sleep(2500);
        const t = Date.now();
        check(`${label}: B (the owner) moves A to ${name}`, (await move(id)) === 200);
        check(`${label}: A is in ${name} with a mic sender`, !!await until(() => inChannel(name), 20_000, 200));
        await sleep(3000);
        return t;
    };
    await moveA('mi-two', two, 'moved, unmuted');
    await expectLive(A, B, 'unmuted -> moved by a moderator (control: the move mutes nobody)', uA);
    check('moved: A mutes', await clickTitle(A, 'Mute'));
    await sleep(800);
    t0 = await moveA('mi-one', one, 'moved, muted');
    await expectSilent(A, B, 'muted -> moved by a moderator', t0, uA);
    check('moved: A deafens', await clickTitle(A, 'Deafen'));
    await sleep(800);
    t0 = await moveA('mi-two', two, 'moved, muted + deafened');
    await expectSilent(A, B, 'muted + deafened -> moved by a moderator', t0, uA, { deafened: true });
    check('own join: A disconnects', await clickTitle(A, 'Disconnect'));
    await sleep(1500);
    await clickVoiceNamed(B, 'mi-one');
    await sleep(2500);
    check('own join: A joins mi-one itself', await clickVoiceNamed(A, 'mi-one'));
    check('own join: A is in mi-one with a mic sender', !!await until(() => inChannel('mi-one'), 20_000, 200));
    await sleep(3000);
    await expectLive(A, B, 'a join A makes itself starts unmuted (control: unchanged)', uA);
    check('own join: not deafened', (await deafenButton(A))?.title === 'Deafen');

    // Moved WHILE the microphone is gone: the destination joins with no
    // microphone (the same mesh shape as a join without one), and the member
    // must be heard when it comes back, being unmuted.
    await lose(A, 'moved while listen-only');
    await clickVoiceNamed(B, 'mi-two');
    await sleep(2500);
    check('moved while listen-only: B moves A to mi-two', (await move(two)) === 200);
    check('moved while listen-only: A arrives in mi-two, still listen-only', !!await until(async () =>
        (await A.evaluate(() => document.querySelector('.voice-channel-name')?.textContent ?? '')) === 'mi-two' && await listenOnly(A), 20_000, 200));
    await sleep(3000);
    await back(A, 'moved while listen-only');
    await expectLive(A, B, 'unmuted, moved while listen-only -> back', uA);

    // 9. In the AFK channel the mic is shut by the channel itself: a
    // microphone coming back there must not report A unmuted (it did, though
    // the AFK gate kept the track shut).
    // A mutes first: a channel switch made WHILE the speaking ring is lit
    // leaves it lit in the next channel until that channel's detector flips
    // it (the switch tears the detectors down without clearing the ring),
    // which in an AFK channel never happens. Pre-existing, own ring only.
    check('afk: A mutes before switching', await clickTitle(A, 'Mute'));
    await sleep(800);
    await clickVoiceNamed(B, 'AFK');
    await sleep(2500);
    check('afk: A joins the AFK channel', await clickVoiceNamed(A, 'AFK'));
    check('afk: A is in the AFK channel with a mic sender', !!await until(() => inChannel('AFK'), 20_000, 200));
    await sleep(3000);
    t0 = await lose(A, 'afk');
    await back(A, 'afk');
    await expectSilent(A, B, 'AFK channel -> lost -> back', t0, uA, { title: 'Microphone is disabled in AFK channels' });

    await clickTitle(A, 'Disconnect');
    await clickTitle(B, 'Disconnect');
    await sleep(1000);
} finally {
    await browserA.close().catch(() => {});
    await browserB.close().catch(() => {});
}

if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
