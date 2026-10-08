// LIVE: a push-to-talk member's microphone stays SHUT when they join a call,
// on the SFU as on mesh, and push-to-talk still opens it.
//
// Found 2026-10-08 while fixing the default-microphone follow: Púca gates the
// mic with MediaStreamTrack.enabled, and livekit-client wraps a published
// MediaStreamTrack in a fresh LocalAudioTrack whose constructor re-syncs
// `enabled` to its own (unmuted) state. So publishing a shut mic to the SFU
// opened it. A push-to-talk member joining an SFU call went out enabled and
// stayed so, the button saying "hold your key to speak" while the room heard
// them; on mesh the same member sent nothing. sfuManager's
// holdMicGateWhilePublishing keeps a shut gate shut through every publish.
//
// Three calls, each with a fresh pair of members (A speaks, B listens), the
// sender state of A's mic sampled continuously and the audio ENERGY B
// receives measured from getStats:
//   - SFU, A on push-to-talk: no audio sender of A's is ever enabled after
//     the join and B receives no energy; then A holds the push-to-talk key
//     (F8): the mic opens and B hears it; A lets go: it shuts again;
//   - SFU, A on an open mic: enabled, B hears it (the positive control: the
//     measurement can see audio);
//   - mesh, A on push-to-talk: never enabled, B receives nothing (the path
//     that was always right).
// Run it against a build from before the fix and the first call FAILS.
//
// Headless Edge, --mute-audio, Chromium's FAKE capture devices: nothing is
// shown, nothing plays, no real microphone is opened. Needs a THROWAWAY
// backend + Postgres (PGPORT / PGDB / PGPASSWORD), a LiveKit node the backend
// points at, and the built client served at APP (`DIST=<dir> PORT=...
// node e2e/serve-dist.mjs`).
// Usage: APP=http://127.0.0.1:7731 PGPORT=55436 PGDB=... node e2e/sfu-mic-gate-live.mjs [out.json]
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const APP = process.env.APP || 'http://127.0.0.1:5173';
const CHANNEL = process.env.CHANNEL || 'msedge';
const OUT = process.argv[2] || '';
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
const PTT_KEY = { name: 'F8', keyCode: 119 };
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

const results = { app: APP, checks: [], calls: [] };
let failed = 0;
const check = (name, ok, detail = '') => {
    results.checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failed++;
};

// Before any app script: A's input mode, the RTCPeerConnection collector, and
// a sampler that records every change of an audio sender's (track, enabled).
const init = (opts) => {
    if (opts.mode) {
        const s = JSON.parse(localStorage.getItem('sovereign_settings') || '{}');
        s.voiceInputMode = opts.mode;
        if (opts.mode === 'pushToTalk') s.pttBinding = opts.key;
        localStorage.setItem('sovereign_settings', JSON.stringify(s));
    }
    const PC = window.RTCPeerConnection;
    const pcs = [];
    window.__pcs = pcs;
    const Wrapped = function (...a) { const pc = new PC(...a); pcs.push(pc); return pc; };
    Wrapped.prototype = PC.prototype;
    Object.setPrototypeOf(Wrapped, PC);
    window.RTCPeerConnection = Wrapped;
    const log = [];
    window.__senderLog = log;
    const last = new Map();
    setInterval(() => pcs.forEach((pc, n) => {
        if (pc.connectionState === 'closed') return;
        pc.getSenders().forEach((s, i) => {
            const tr = s.track;
            if (!tr || tr.kind !== 'audio') return;
            const key = n + ':' + i;
            const v = tr.id + ':' + tr.enabled;
            if (last.get(key) !== v) { last.set(key, v); log.push({ t: Date.now(), key, id: tr.id, enabled: tr.enabled }); }
        });
    }), 0);
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
const clickVoice = (p) => p.evaluate(() => {
    const el = [...document.querySelectorAll('.voice-channel-list .voice-channel')].filter(x => !x.classList.contains('afk'))[0];
    if (el) { el.click(); return Date.now(); } return 0;
});
const clickTitle = (p, title) => p.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === t && !x.disabled);
    if (b) { b.click(); return true; } return false;
}, title);
/** Audio energy and packets B has received, over every live connection. */
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
const senderLog = (p) => p.evaluate(() => window.__senderLog.slice());
/** A's audio senders right now. */
const senders = (p) => p.evaluate(() => window.__pcs.filter(pc => pc.connectionState !== 'closed')
    .flatMap(pc => pc.getSenders().filter(s => s.track && s.track.kind === 'audio').map(s => ({ id: s.track.id, enabled: s.track.enabled }))));
const HEARD = 0.2;   // a fake capture's tone over a few seconds is ~1-2
const SILENT = 0.02;

async function call(label, { sfu, mode }) {
    console.log(`\n--- ${label} ---`);
    const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
        '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required',
        ...(sfu ? ['--allow-loopback-in-peer-connection'] : [])];
    const bA = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args });
    const bB = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args });
    const out = { label };
    try {
        const cA = await bA.newContext({ permissions: ['microphone'] });
        await cA.addInitScript(init, { mode, key: { keyCode: PTT_KEY.keyCode, ctrl: false, alt: false, shift: false, label: PTT_KEY.name } });
        const cB = await bB.newContext({ permissions: ['microphone'] });
        await cB.addInitScript(init, {});
        const tag = `${stamp}${sfu ? 's' : 'm'}${mode === 'open' ? 'o' : 'p'}`;
        const A = await register(cA, `mg_a_${tag}`);
        const B = await register(cB, `mg_b_${tag}`);
        const name = 'MicGate_' + tag;
        await A.locator('.server-icon.add-server').click({ timeout: 5000 });
        await A.waitForTimeout(500);
        await A.locator('.template-card').first().click({ timeout: 4000 });
        await A.waitForTimeout(300);
        await A.locator('.audience-card').first().click({ timeout: 4000 });
        await A.waitForTimeout(300);
        await A.locator('.server-name-input input').fill(name);
        await A.locator('.wizard-actions .create-btn').click();
        await A.waitForTimeout(2500);
        const serverId = psql(`SELECT id FROM servers WHERE name='${name}'`);
        const bId = psql(`SELECT id FROM users WHERE username='mg_b_${tag}'`);
        psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${bId}) ON CONFLICT DO NOTHING`);
        if (sfu) psql(`UPDATE channels SET sfu_mode = true WHERE server_id='${serverId}' AND type=1 AND NOT is_afk`);
        await openServer(A);
        await openServer(B);
        if (!await clickVoice(B)) throw new Error('B: no voice channel');
        await sleep(4000);
        const r0 = await received(B);
        const tJoin = await clickVoice(A);
        const up = await until(async () => (await senders(A)).length > 0, 30_000, 200);
        check(`${label}: A joined and has a mic sender`, !!up);
        await sleep(6000);
        const r1 = await received(B);
        const log = (await senderLog(A)).filter(e => e.t >= tJoin);
        const enabledAt = log.filter(e => e.enabled).map(e => e.t - tJoin);
        out.afterJoin = { senderChanges: log.map(e => ({ ms: e.t - tJoin, sender: e.key, id: e.id.slice(0, 8), enabled: e.enabled })), energy: +(r1.energy - r0.energy).toFixed(4), packets: r1.packets - r0.packets };
        if (mode === 'open') {
            check(`${label}: A's mic is open`, (await senders(A)).every(s => s.enabled) && enabledAt.length > 0, JSON.stringify(out.afterJoin.senderChanges));
            check(`${label}: B hears A (the measurement sees audio)`, r1.energy - r0.energy > HEARD, `energy +${out.afterJoin.energy}, ${out.afterJoin.packets} packets`);
        } else {
            check(`${label}: no audio sender of A's was enabled at any moment after the join`, enabledAt.length === 0,
                JSON.stringify(out.afterJoin.senderChanges));
            check(`${label}: B receives no audio energy from A`, r1.energy - r0.energy < SILENT, `energy +${out.afterJoin.energy}, ${out.afterJoin.packets} packets`);
            check(`${label}: the button says push to talk`, await A.evaluate(() => [...document.querySelectorAll('button')].some(b => /^Push to talk/.test(b.getAttribute('title') || ''))));
            if (sfu) {
                // Push-to-talk still works after the publish: hold, then let go.
                const h0 = await received(B);
                await A.keyboard.down(PTT_KEY.name);
                const opened = await until(async () => (await senders(A)).every(s => s.enabled), 3000, 50);
                await sleep(3000);
                const h1 = await received(B);
                check(`${label}: holding the push-to-talk key opens the mic and B hears it`, !!opened && h1.energy - h0.energy > HEARD,
                    `opened ${!!opened}, energy +${(h1.energy - h0.energy).toFixed(4)}`);
                await A.keyboard.up(PTT_KEY.name);
                const shut = await until(async () => (await senders(A)).every(s => !s.enabled), 3000, 50);
                await sleep(1500);
                const h2 = await received(B);
                await sleep(3000);
                const h3 = await received(B);
                check(`${label}: letting go shuts it again`, !!shut && h3.energy - h2.energy < SILENT, `shut ${!!shut}, energy +${(h3.energy - h2.energy).toFixed(4)} over 3 s`);
            }
        }
        await clickTitle(A, 'Disconnect');
        await clickTitle(B, 'Disconnect');
        await sleep(1500);
    } finally {
        await bA.close().catch(() => {});
        await bB.close().catch(() => {});
    }
    results.calls.push(out);
}

await call('SFU, push-to-talk', { sfu: true, mode: 'pushToTalk' });
await call('SFU, open mic (positive control)', { sfu: true, mode: 'open' });
await call('mesh, push-to-talk (control)', { sfu: false, mode: 'pushToTalk' });

if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
