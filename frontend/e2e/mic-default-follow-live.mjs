// LIVE: the OS default microphone moves mid-call and the call follows it.
//
// The owner's report (2026-10-07): Audio Hub moved the Windows default
// recording device from a still-connected headset to a desk mic, and the call
// kept recording the headset until he left and rejoined. This drives two REAL
// clients through a real throwaway call and moves A's "OS default" under it:
//
//   - the default moves, announced by a burst of devicechange events: ONE
//     re-acquire, onto the new default, the mic sender's track replaced on
//     every peer connection, B still receiving A's audio (inbound packets keep
//     growing) and A still sending, and the '[mic] default input changed'
//     line logged with its time;
//   - a devicechange burst that moves nothing, and a device added that is not
//     the default: no re-acquire (negative controls);
//   - A muted: the default moves, the new track goes out MUTED (sender track
//     disabled, the button still says Unmute), and unmuting opens it;
//   - the new default will not open (NotReadableError): the old mic stays on
//     every sender, live, and A is not listen-only; a device event 30 s later
//     tries it again (once) and moves;
//   - a specific microphone selected: the default moving is not followed;
//   - followed, lost, back: the device the call followed drops out (its
//     capture ends, the OS default falls back and the device-lost restart
//     opens it), then returns as the default: it is followed AGAIN;
//   - two inputs of ONE sound card (one groupId, as Chromium gives every
//     input on a controller): the default moving between them is followed;
//   - A clicks Mute while the new default is still OPENING (a slow open,
//     like a Bluetooth hands-free one): from the click on, no audio sender
//     ever carries an enabled track (sampled continuously, and every
//     replaceTrack / addTransceiver checked), the button says Unmute, and
//     unmuting opens the new mic;
//   - (SFU=1) the same move on an SFU call: the publication carries the new
//     track and B keeps receiving;
//   - (NS=rnnoise|deepfilter) all of it with A's noise graph in the path.
//
// How the "OS" is simulated, with Chromium's FAKE capture devices only: an
// init script wraps navigator.mediaDevices so the 'default' entry of
// enumerateDevices names whichever fake device the rig says is the default
// (its groupId and a "Default - " label, as Chromium does on Windows), and a
// default capture opens that device and reports itself the way Chromium
// reports a capture of 'default' (deviceId 'default', the device's groupId).
// RTCPeerConnection is wrapped to collect the instances for getStats, and
// every audio sender's (track, enabled) is sampled for the mute check. An
// input of the same sound card as a real fake device is simulated by a
// listed entry carrying that device's groupId and its own name, opened
// through the OTHER fake device so the two are told apart on the wire.
//
// Run it against a build from before the fix and the follow checks FAIL
// (the rig's red control); the negative controls pass on both.
//
// Everything is headless with --mute-audio and fake devices: nothing is
// shown, nothing plays, no real microphone is opened.
// Needs a THROWAWAY backend + Postgres (PGPORT / PGDB / PGPASSWORD) and the
// built client served at APP (`DIST=<dir> PORT=... node e2e/serve-dist.mjs`).
// Usage: APP=http://127.0.0.1:7711 PGPORT=55436 PGDB=... [SFU=1] [NS=rnnoise] node e2e/mic-default-follow-live.mjs [out.json]
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const APP = process.env.APP || 'http://127.0.0.1:5173';
const CHANNEL = process.env.CHANNEL || 'msedge';
const SFU = process.env.SFU === '1';
// NS=rnnoise|deepfilter runs A's mic through that noise graph, so every
// follow also rebuilds the graph: the PUBLISHED track is then the graph's
// output, a new one per re-acquire, not the capture itself.
const NS = process.env.NS || 'standard';
const OUT = process.argv[2] || '';
const SETTLE_MS = 800; // micDeviceWatchdog.ts SETTLE_MS
const PSQL = process.env.PSQL || 'C:/Program Files/PostgreSQL/16/bin/psql.exe';
const PASS = 'Password123!';
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

// The simulated OS (see the header). Runs before any app script.
const osInit = () => {
    const md = navigator.mediaDevices;
    if (!md) return;
    const realEnum = md.enumerateDevices.bind(md);
    const realGum = md.getUserMedia.bind(md);
    const sim = {
        def: null,     // deviceId the "OS default" names (concrete or virtual); null = Chromium's own
        extra: [],     // extra audioinput entries (a device "plugged in")
        virtual: {},   // id -> { groupId, label, backing }: a listed input opened through `backing`
        failNext: 0,   // upcoming default opens to refuse with NotReadableError
        delayMs: 0,    // hold every audio open this long first (a slow Bluetooth open)
        started: [],   // every audio open as it STARTS: { t, asked }
        opens: [],     // every audio capture opened: { t, asked, opened, label, trackId }
        tracks: {},    // trackId -> the capture track, so the rig can end one
        senderLog: [], // every change of an audio sender's (track, enabled): { t, key, id, enabled }
        replaced: [],  // every audio replaceTrack: { t, id, enabled }
        added: [],     // every audio addTransceiver: { t, id, enabled }
    };
    window.__osSim = sim;
    const concrete = async () => (await realEnum())
        .filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const entry = (d) => ({ deviceId: d.deviceId, groupId: d.groupId, label: d.label, kind: d.kind, toJSON() { return this; } });
    const virtuals = () => Object.entries(sim.virtual).map(([deviceId, v]) => ({ deviceId, groupId: v.groupId, label: v.label, kind: 'audioinput' }));
    const find = (all, id) => all.find(d => d.deviceId === id) ?? virtuals().find(d => d.deviceId === id) ?? null;
    md.enumerateDevices = async () => {
        const all = await realEnum();
        const target = sim.def ? find(all, sim.def) : null;
        return all.map(d => (target && d.kind === 'audioinput' && d.deviceId === 'default')
            ? { deviceId: 'default', groupId: target.groupId, label: 'Default - ' + target.label, kind: 'audioinput', toJSON() { return this; } }
            : entry(d)).concat(sim.extra.map(entry), virtuals().map(entry));
    };
    md.getUserMedia = async (c) => {
        const a = c && c.audio;
        const id = a && typeof a === 'object' ? a.deviceId : undefined;
        const asked = id === undefined ? 'default' : (typeof id === 'object' ? (id.exact ?? id.ideal) : id);
        if (a) sim.started.push({ t: Date.now(), asked });
        if (a && sim.delayMs) await new Promise(r => setTimeout(r, sim.delayMs));
        if (a && asked === 'default') {
            if (sim.failNext > 0) {
                sim.failNext--;
                sim.opens.push({ t: Date.now(), asked, opened: null, refused: true });
                throw new DOMException('Could not start audio source', 'NotReadableError');
            }
            if (sim.def) {
                const target = find(await realEnum(), sim.def);
                const backing = sim.virtual[sim.def]?.backing ?? sim.def;
                const s = await realGum({ ...c, audio: { ...a, deviceId: { exact: backing } } });
                const t = s.getAudioTracks()[0];
                if (t) {
                    const real = t.getSettings.bind(t);
                    t.getSettings = () => ({ ...real(), deviceId: 'default', groupId: target.groupId });
                    Object.defineProperty(t, 'label', { value: 'Default - ' + target.label, configurable: true });
                    sim.tracks[t.id] = t;
                    sim.opens.push({ t: Date.now(), asked, opened: sim.def, label: target.label, trackId: t.id });
                }
                return s;
            }
        }
        const s = await realGum(c);
        const t = s.getAudioTracks()[0];
        if (t) {
            sim.tracks[t.id] = t;
            sim.opens.push({ t: Date.now(), asked, opened: t.getSettings().deviceId, label: t.label, trackId: t.id });
        }
        return s;
    };
    /** The OS took this capture away (Bluetooth out of range): its 'ended'. */
    sim.endTrack = (trackId) => { const t = sim.tracks[trackId]; if (t) t.dispatchEvent(new Event('ended')); return !!t; };
    /** Point the OS default at a deviceId (concrete or virtual) and announce
     *  it the way Windows does: a burst. */
    sim.moveDefaultTo = async (deviceId, burst = 3) => {
        sim.def = deviceId;
        for (let i = 0; i < burst; i++) { md.dispatchEvent(new Event('devicechange')); await new Promise(r => setTimeout(r, 40)); }
        return find(await realEnum(), deviceId)?.label ?? null;
    };
    /** Point the OS default at concrete input `idx` (null: Chromium's own
     *  default again) and announce it the way Windows does: a burst. */
    sim.moveDefault = async (idx, burst = 3) => {
        const list = await concrete();
        sim.def = idx === null ? null : list[idx].deviceId;
        for (let i = 0; i < burst; i++) { md.dispatchEvent(new Event('devicechange')); await new Promise(r => setTimeout(r, 40)); }
        return idx === null ? 'Fake Default Audio Input' : list[idx].label;
    };
    sim.poke = async (burst = 3) => {
        for (let i = 0; i < burst; i++) { md.dispatchEvent(new Event('devicechange')); await new Promise(r => setTimeout(r, 40)); }
    };
    sim.concreteIds = async () => (await concrete()).map(d => d.deviceId);
    const PC = window.RTCPeerConnection;
    const pcs = [];
    window.__pcs = pcs;
    const Wrapped = function (...a) { const pc = new PC(...a); pcs.push(pc); return pc; };
    Wrapped.prototype = PC.prototype;
    Object.setPrototypeOf(Wrapped, PC);
    window.RTCPeerConnection = Wrapped;
    // What goes onto a sender, as it goes on (mesh: replaceTrack; SFU: the
    // republish's addTransceiver), and every sender's state as often as the
    // timers allow.
    const rt = RTCRtpSender.prototype.replaceTrack;
    RTCRtpSender.prototype.replaceTrack = function (track) {
        if (track && track.kind === 'audio') sim.replaced.push({ t: Date.now(), id: track.id, enabled: track.enabled });
        return rt.call(this, track);
    };
    const at = PC.prototype.addTransceiver;
    PC.prototype.addTransceiver = function (trackOrKind, init) {
        if (trackOrKind && typeof trackOrKind === 'object' && trackOrKind.kind === 'audio') sim.added.push({ t: Date.now(), id: trackOrKind.id, enabled: trackOrKind.enabled });
        return at.call(this, trackOrKind, init);
    };
    const last = new Map();
    setInterval(() => {
        pcs.forEach((pc, n) => {
            if (pc.connectionState === 'closed') return;
            pc.getSenders().forEach((s, i) => {
                const tr = s.track;
                if (!tr || tr.kind !== 'audio') return;
                const key = n + ':' + i;
                const v = tr.id + ':' + tr.enabled;
                if (last.get(key) !== v) { last.set(key, v); sim.senderLog.push({ t: Date.now(), key, id: tr.id, enabled: tr.enabled }); }
            });
        });
    }, 0);
};

// A's noise mode, before any app script reads it.
const nsInit = (mode) => {
    if (mode === 'standard') return;
    const KEY = 'sovereign_settings';
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (mode === 'deepfilter') s.experimentalDeepFilter = true;
    localStorage.setItem(KEY, JSON.stringify(s));
    localStorage.setItem('noiseSuppressionMode', mode);
};

async function register(ctx, u, logs) {
    const p = await ctx.newPage();
    if (logs) p.on('console', m => { const t = m.text(); if (t.startsWith('[mic]')) logs.push({ t: Date.now(), line: t }); if (m.type() === 'error' || (m.type() === 'warning' && /NoiseFilter|DeepFilter|RNNoise/.test(t))) logs.push({ t: Date.now(), error: t.slice(0, 300) }); });
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
const clickVoice = (p, nth) => p.evaluate((n) => {
    const els = [...document.querySelectorAll('.voice-channel-list .voice-channel')].filter(x => !x.classList.contains('afk'));
    const el = els[n];
    if (el) { el.click(); return true; } return false;
}, nth);
const clickTitle = (p, title) => p.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === t && !x.disabled);
    if (b) { b.click(); return true; } return false;
}, title);
const hasTitle = (p, title) => p.evaluate((t) => [...document.querySelectorAll('button')].some(x => x.getAttribute('title') === t), title);

/** A's audio senders on live peer connections: the track each carries. */
const senders = (p) => p.evaluate(() => window.__pcs.filter(pc => pc.connectionState !== 'closed')
    .flatMap(pc => pc.getSenders().filter(s => s.track && s.track.kind === 'audio')
        .map(s => ({ pc: pc.connectionState, id: s.track.id, label: s.track.label, enabled: s.track.enabled, state: s.track.readyState }))));
/** Audio RTP counters on every live connection, by SSRC. */
const rtp = (p) => p.evaluate(async () => {
    const out = { in: {}, out: {} };
    for (const pc of window.__pcs) {
        if (pc.connectionState === 'closed') continue;
        const st = await pc.getStats();
        st.forEach(r => {
            if (r.kind !== 'audio') return;
            if (r.type === 'inbound-rtp') out.in[r.ssrc] = r.packetsReceived;
            if (r.type === 'outbound-rtp') out.out[r.ssrc] = r.packetsSent;
        });
    }
    return out;
});
const opens = (p) => p.evaluate(() => window.__osSim.opens.slice());
/** Largest per-SSRC growth between two rtp() snapshots. */
const grew = (a, b, dir) => Math.max(0, ...Object.entries(b[dir]).map(([k, v]) => v - (a[dir][k] ?? 0)));

const results = { app: APP, sfu: SFU, ns: NS, checks: [], follows: [] };
let failed = 0;
const check = (name, ok, detail = '') => {
    results.checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failed++;
};

/** B still hears A and A still sends: per-SSRC packet growth over 3 s. */
async function flowing(A, B, label) {
    const a0 = await rtp(A); const b0 = await rtp(B);
    await sleep(3000);
    const a1 = await rtp(A); const b1 = await rtp(B);
    const sent = grew(a0, a1, 'out');
    const recv = grew(b0, b1, 'in');
    check(`${label}: A keeps sending and B keeps receiving A's audio`, sent >= 20 && recv >= 20, `A sent +${sent}, B received +${recv} packets in 3 s`);
}

/** Move the default and expect exactly one re-acquire onto it. */
async function expectFollow(A, B, logs, label, idx, { muted = false } = {}) {
    const before = await senders(A);
    const n0 = (await opens(A)).length;
    const l0 = logs.length;
    const t0 = Date.now();
    // idx: a concrete fake input by index, or { id } for any listed deviceId.
    const target = await A.evaluate((i) => (typeof i === 'number' ? window.__osSim.moveDefault(i) : window.__osSim.moveDefaultTo(i.id)), idx);
    const fresh = await until(async () => { const o = await opens(A); return o.length > n0 ? o : null; }, 8000, 50);
    const tOpen = fresh ? fresh[n0].t : null;
    // Let anything a second, wrong re-acquire would do happen.
    await sleep(SETTLE_MS + 2500);
    const all = (await opens(A)).slice(n0);
    check(`${label}: exactly ONE re-acquire, onto the new default`, all.length === 1 && all[0].label === target,
        all.length ? `${all.length} open(s): ${all.map(o => o.label ?? (o.refused ? 'refused' : '?')).join(', ')}; ${tOpen - t0} ms after the move` : 'no re-acquire within 8 s');
    const after = await senders(A);
    // Standard: the published track IS the new capture. A noise graph
    // publishes its own output, rebuilt per re-acquire: a new id, live.
    const newId = NS === 'standard' ? all[0]?.trackId : after[0]?.id;
    const onEvery = after.length > 0 && after.every(s => s.id === newId && s.state === 'live');
    check(`${label}: every mic sender carries the new track`, onEvery && !!newId && !before.some(s => s.id === newId),
        `before ${JSON.stringify(before.map(s => s.id.slice(0, 8)))}, after ${JSON.stringify(after.map(s => `${s.id.slice(0, 8)}:${s.state}:${s.enabled ? 'on' : 'off'}`))}`);
    if (muted) {
        check(`${label}: the new track goes out muted and the button still says Unmute`,
            after.length > 0 && after.every(s => s.enabled === false) && await hasTitle(A, 'Unmute'),
            JSON.stringify(after.map(s => s.enabled)));
        // Not just at the end: at no moment of the follow (on SFU the
        // republish wraps the track in a LiveKit LocalAudioTrack, which
        // used to switch it on until the panel re-gated it).
        const log = await A.evaluate(() => window.__osSim.senderLog);
        const hot = log.filter(e => e.t >= t0 && e.enabled);
        check(`${label}: no audio sender carried an enabled track at any moment of the muted follow`, hot.length === 0,
            JSON.stringify(hot.slice(0, 4).map(e => ({ ms: e.t - t0, sender: e.key, id: e.id.slice(0, 8) }))));
    } else {
        check(`${label}: the new track is open`, after.length > 0 && after.every(s => s.enabled === true), JSON.stringify(after.map(s => s.enabled)));
    }
    const line = logs.slice(l0).find(l => l.line?.startsWith('[mic] default input changed:'));
    const ms = line ? Number(/re-acquired in (\d+) ms/.exec(line.line)?.[1]) : null;
    check(`${label}: '[mic] default input changed' logged with its time`, !!line && Number.isFinite(ms), line?.line ?? 'no line');
    results.follows.push({ label, moveToOpenMs: tOpen ? tOpen - t0 : null, reacquireMs: ms, line: line?.line });
    return target;
}

/** A device event that moves nothing: no re-acquire. */
async function expectNoFollow(A, label, act) {
    const n0 = (await opens(A)).length;
    const s0 = await senders(A);
    await act();
    await sleep(SETTLE_MS + 3000);
    const n1 = (await opens(A)).length;
    const s1 = await senders(A);
    check(`${label}: no re-acquire`, n1 === n0 && JSON.stringify(s0.map(s => s.id)) === JSON.stringify(s1.map(s => s.id)),
        `${n1 - n0} new open(s)`);
}

const browserA = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args });
const browserB = await chromium.launch({ channel: CHANNEL === 'bundled' ? undefined : CHANNEL, args });
const logsA = [];
try {
    const ctxA = await browserA.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1400, height: 900 } });
    await ctxA.addInitScript(osInit);
    await ctxA.addInitScript(nsInit, NS);
    const ctxB = await browserB.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 800 } });
    await ctxB.addInitScript(osInit); // B only needs the RTCPeerConnection collector
    const uA = `mdf_a_${stamp}`; const uB = `mdf_b_${stamp}`;
    const A = await register(ctxA, uA, logsA);
    const B = await register(ctxB, uB, null);
    const serverName = 'MicDefault_' + stamp;
    await createServer(A, serverName);
    const serverId = psql(`SELECT id FROM servers WHERE name='${serverName}'`);
    const bId = psql(`SELECT id FROM users WHERE username='${uB}'`);
    psql(`INSERT INTO server_members (server_id, user_id) VALUES ('${serverId}', ${bId}) ON CONFLICT DO NOTHING`);

    const runCall = async (label) => {
        console.log(`\n--- ${label} (A's noise mode: ${NS}) ---`);
        const callStart = Date.now();
        await openServer(A);
        await openServer(B);
        if (!await clickVoice(A, 0)) throw new Error('A: no voice channel');
        await sleep(2500);
        if (!await clickVoice(B, 0)) throw new Error('B: no voice channel');
        const up = await until(async () => {
            const s = await senders(A);
            const r0 = await rtp(B); await sleep(1000); const r1 = await rtp(B);
            return s.length > 0 && grew(r0, r1, 'in') > 10;
        }, 30_000, 500);
        check(`${label}: the call is up (A publishes, B receives)`, !!up);
        const first = (await opens(A))[0];
        check(`${label}: A joined on Chromium's own default`, first?.asked === 'default' && first?.opened === 'default', JSON.stringify(first));

        await expectNoFollow(A, `${label}: devicechange burst, default unchanged`, () => A.evaluate(() => window.__osSim.poke(3)));
        await expectNoFollow(A, `${label}: a device plugged in that is not the default`, () => A.evaluate(() => {
            window.__osSim.extra.push({ deviceId: 'rig-extra-mic', groupId: 'rig-extra-group', label: 'Rig Extra Mic', kind: 'audioinput' });
            return window.__osSim.poke(3);
        }));

        await expectFollow(A, B, logsA, `${label}: default -> Fake Audio Input 1`, 0);
        await flowing(A, B, `${label}: after the follow`);

        if (!SFU || label === 'sfu') {
            // Muted: the move is followed, the mic stays shut.
            check(`${label}: A mutes`, await clickTitle(A, 'Mute'));
            await sleep(500);
            await expectFollow(A, B, logsA, `${label}: muted, default -> Fake Audio Input 2`, 1, { muted: true });
            check(`${label}: A unmutes`, await clickTitle(A, 'Unmute'));
            await sleep(500);
            const s = await senders(A);
            check(`${label}: unmuted, the followed track is open`, s.length > 0 && s.every(x => x.enabled), JSON.stringify(s.map(x => x.enabled)));
            await flowing(A, B, `${label}: unmuted after a muted follow`);
        }

        // The new default refuses to open: keep the old mic.
        const keep = await senders(A);
        const nRef = (await opens(A)).length;
        const lRef = logsA.length;
        await A.evaluate(() => { window.__osSim.failNext = 1; return window.__osSim.moveDefault(null); });
        await until(async () => (await opens(A)).length > nRef, 8000, 50);
        await sleep(SETTLE_MS + 2500);
        const refusedOpens = (await opens(A)).slice(nRef);
        const kept = await senders(A);
        check(`${label}: the new default would not open: ONE attempt, refused`, refusedOpens.length === 1 && refusedOpens[0].refused === true, JSON.stringify(refusedOpens));
        check(`${label}: ...and the old mic stays on every sender, live and open`,
            kept.length > 0 && JSON.stringify(kept.map(s => s.id)) === JSON.stringify(keep.map(s => s.id)) && kept.every(s => s.state === 'live' && s.enabled),
            JSON.stringify(kept.map(s => `${s.id.slice(0, 8)}:${s.state}:${s.enabled ? 'on' : 'off'}`)));
        check(`${label}: ...A is not listen-only`, !(await hasTitle(A, 'No microphone detected — listen-only mode')));
        const keptLine = logsA.slice(lRef).find(l => l.line?.includes('could not open it'));
        check(`${label}: ...and the log says it kept the old one`, !!keptLine, keptLine?.line ?? 'no line');
        await flowing(A, B, `${label}: after the refused follow`);

        // ...retried on a device event once FOLLOW_RETRY_MS (30 s) has passed,
        // not before, and then it moves.
        const tRefused = refusedOpens[0]?.t ?? Date.now();
        await A.evaluate(() => window.__osSim.poke(2));
        await sleep(SETTLE_MS + 1500);
        check(`${label}: ...a device event inside 30 s does not retry it`, (await opens(A)).length === nRef + 1);
        await sleep(Math.max(0, tRefused + 30_500 - Date.now()));
        const nRetry = (await opens(A)).length;
        await A.evaluate(() => window.__osSim.poke(2));
        await until(async () => (await opens(A)).length > nRetry, 8000, 50);
        await sleep(SETTLE_MS + 1500);
        const retried = (await opens(A)).slice(nRetry);
        const afterRetry = await senders(A);
        check(`${label}: ...a device event after 30 s retries it ONCE and moves`,
            retried.length === 1 && retried[0].opened === 'default' && afterRetry.length > 0
                && afterRetry.every(s => s.state === 'live' && s.enabled) && !keep.some(k => afterRetry.some(s => s.id === k.id)),
            JSON.stringify(retried.map(o => o.label)) + ' ' + JSON.stringify(afterRetry.map(s => s.id.slice(0, 8))));
        await flowing(A, B, `${label}: after the retried follow`);

        // A specific microphone selected: the default is not followed.
        const ids = await A.evaluate(() => window.__osSim.concreteIds());
        const nSel = (await opens(A)).length;
        await A.evaluate((id) => {
            const KEY = 'sovereign_settings';
            const s = JSON.parse(localStorage.getItem(KEY) || '{}');
            s.inputDeviceId = id;
            localStorage.setItem(KEY, JSON.stringify(s));
            window.dispatchEvent(new Event('settingsChanged'));
        }, ids[0]);
        const selOpen = await until(async () => { const o = await opens(A); return o.length > nSel ? o[nSel] : null; }, 8000, 100);
        check(`${label}: selecting Fake Audio Input 1 re-opens onto it (the settings path)`, selOpen?.asked === ids[0], JSON.stringify(selOpen));
        await sleep(1500);
        await expectNoFollow(A, `${label}: a specific microphone selected, the default moves`, () => A.evaluate(() => window.__osSim.moveDefault(1)));
        // Back to Default for the next call.
        await A.evaluate(() => {
            const KEY = 'sovereign_settings';
            const s = JSON.parse(localStorage.getItem(KEY) || '{}');
            s.inputDeviceId = 'default';
            localStorage.setItem(KEY, JSON.stringify(s));
            window.dispatchEvent(new Event('settingsChanged'));
            window.__osSim.def = null;
        });
        await sleep(2500);

        // Two inputs of ONE sound card. The call is on Chromium's own
        // default here (Settings just went back to Default); a 'Line In' is
        // listed with that device's groupId (Chromium gives every input on a
        // controller one group) and its own name, opened through Fake Audio
        // Input 2 so the two are told apart on the wire.
        const onDefault = (await opens(A)).at(-1);
        check(`${label}: (same card) A is on Chromium's own default before the move`,
            onDefault?.asked === 'default' && onDefault?.opened === 'default', JSON.stringify(onDefault));
        await expectNoFollow(A, `${label}: another input of the same sound card is listed, not the default`, () => A.evaluate(async () => {
            const sim = window.__osSim;
            const list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
            const def = list.find(d => d.deviceId === 'default');
            const two = list.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications')[1];
            sim.virtual['rig-line-in'] = { groupId: def.groupId, label: 'Line In (' + def.label + ')', backing: two.deviceId };
            await sim.poke(2);
        }));
        await expectFollow(A, B, logsA, `${label}: default -> another input of the same sound card`, { id: 'rig-line-in' });
        await flowing(A, B, `${label}: after the same-card move`);

        // Followed, lost, back: followed AGAIN. The once-per-default rule
        // must not outlive the capture its follow produced.
        await expectFollow(A, B, logsA, `${label}: default -> Fake Audio Input 1 (to lose it)`, 0);
        const onX = (await opens(A)).at(-1);
        const nLost = (await opens(A)).length;
        await A.evaluate(async (tid) => {
            const sim = window.__osSim;
            sim.def = (await sim.concreteIds())[1]; // Windows falls back to the other input...
            sim.endTrack(tid);                      // ...as the followed one drops out
            await sim.poke(3);
        }, onX.trackId);
        await until(async () => (await opens(A)).length > nLost, 8000, 50);
        await sleep(SETTLE_MS + 2500);
        const afterLoss = (await opens(A)).slice(nLost);
        check(`${label}: the lost Fake Audio Input 1 is replaced by the fallback default (the device-lost path)`,
            afterLoss.length === 1 && afterLoss[0].label === 'Fake Audio Input 2', JSON.stringify(afterLoss.map(o => o.label)));
        await expectFollow(A, B, logsA, `${label}: Fake Audio Input 1 back as the default, followed again`, 0);
        await flowing(A, B, `${label}: after following it back`);

        // A clicks Mute while the new default is still opening.
        const s0 = await A.evaluate(() => window.__osSim.started.length);
        const nMute = (await opens(A)).length;
        await A.evaluate(() => { window.__osSim.delayMs = 1500; });
        // Back to Chromium's own default: a default this call has not just
        // followed, so the move is followed on any build of the watchdog.
        await A.evaluate(() => window.__osSim.moveDefault(null));
        await until(async () => (await A.evaluate(() => window.__osSim.started.length)) > s0, 8000, 20);
        await sleep(300);
        const tMute = await A.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === 'Mute' && !x.disabled);
            if (!b) return 0;
            b.click();
            return Date.now();
        });
        check(`${label}: A clicks Mute while the new default is opening`, tMute > 0);
        await until(async () => (await opens(A)).length > nMute, 8000, 50);
        await sleep(SETTLE_MS + 2500);
        await A.evaluate(() => { window.__osSim.delayMs = 0; });
        const sim = await A.evaluate(() => {
            const s = window.__osSim;
            return { senderLog: s.senderLog, replaced: s.replaced, added: s.added, opens: s.opens };
        });
        const opened = sim.opens.slice(nMute);
        const hot = sim.senderLog.filter(e => e.t >= tMute && e.enabled);
        const hotSwap = [...sim.replaced, ...sim.added].filter(e => e.t >= tMute && e.enabled);
        check(`${label}: muted mid-open: the new default WAS opened after the click (the case is real)`,
            opened.length === 1 && opened[0].t > tMute, JSON.stringify(opened.map(o => ({ label: o.label, msAfterMute: o.t - tMute }))));
        check(`${label}: muted mid-open: no audio sender carried an enabled track from the click on`,
            hot.length === 0 && hotSwap.length === 0,
            `${hot.length} enabled sample(s) ${JSON.stringify(hot.slice(0, 4).map(e => ({ ms: e.t - tMute, sender: e.key, id: e.id.slice(0, 8) })))}, `
            + `${hotSwap.length} enabled replaceTrack/addTransceiver; swaps after the click: `
            + JSON.stringify([...sim.replaced, ...sim.added].filter(e => e.t >= tMute).map(e => ({ ms: e.t - tMute, id: e.id.slice(0, 8), enabled: e.enabled }))));
        const mutedNow = await senders(A);
        check(`${label}: muted mid-open: every sender carries the new track, disabled, and the button says Unmute`,
            mutedNow.length > 0 && mutedNow.every(s => !s.enabled && s.state === 'live') && await hasTitle(A, 'Unmute')
                && (NS !== 'standard' || mutedNow.every(s => s.id === opened[0]?.trackId)),
            JSON.stringify(mutedNow.map(s => `${s.id.slice(0, 8)}:${s.state}:${s.enabled ? 'on' : 'off'}`)));
        check(`${label}: A unmutes`, await clickTitle(A, 'Unmute'));
        await sleep(500);
        const unmuted = await senders(A);
        check(`${label}: unmuted after a mid-open mute, the new track is open`, unmuted.length > 0 && unmuted.every(s => s.enabled && s.state === 'live'),
            JSON.stringify(unmuted.map(s => s.enabled)));
        await flowing(A, B, `${label}: unmuted after a mid-open mute`);
        const errors = logsA.filter(l => l.error && l.t >= callStart);
        results[`${label}Errors`] = errors.map(e => e.error);
        const graphDead = logsA.some(l => l.t >= callStart && /emitting pure silence|graph dead|worklet crashed|falling back/i.test(l.error ?? ''));
        check(`${label}: no noise graph died or fell back on the way`, !graphDead, errors.map(e => e.error.slice(0, 120)).join(' | ').slice(0, 400));
        await clickTitle(A, 'Disconnect');
        await clickTitle(B, 'Disconnect');
        await sleep(2000);
    };

    await runCall('mesh');

    if (SFU) {
        const n = psql(`UPDATE channels SET sfu_mode = true WHERE server_id='${serverId}' AND type=1 AND NOT is_afk RETURNING id`);
        check('sfu: a voice channel switched to SFU', n.length > 0, `channel ${n}`);
        // Fresh opens list per call: the reload in runCall resets the init script.
        await runCall('sfu');
    }
    results.micLines = logsA.filter(l => l.line).map(l => l.line);
} finally {
    await browserA.close().catch(() => {});
    await browserB.close().catch(() => {});
}

console.log('\nA\'s [mic] lines:');
for (const l of results.micLines ?? []) console.log('  ' + l);
console.log('\nfollow                                         | move->open ms | re-acquire ms');
for (const f of results.follows) console.log(`${f.label.padEnd(46)} | ${String(f.moveToOpenMs).padStart(13)} | ${String(f.reacquireMs).padStart(13)}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
