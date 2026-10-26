// Does the small player's Web Audio gain (StreamAudioHost's engine,
// src/components/streamAudioHostCore.ts) really set each watched stream's
// loudness in a REAL browser, from a REAL remote WebRTC track — without
// anything ever reaching a speaker?
//
// WHY THIS EXISTS. vitest runs under jsdom, which has no Web Audio and no
// WebRTC: the unit tests drive the engine against a fake context that only
// records the values it is sent. Whether a remote track actually reaches the
// graph (in Chromium it does ONLY while a media element plays it: the muted
// <audio> sink), whether a boost above 100% is audible, whether mute is
// silence, only a real engine can say. So this bundles the REAL module
// (esbuild), negotiates a loopback call carrying two tones, one per watched
// stream (A at 440 Hz, B at 1000 Hz), and reads what the engine sends to the
// speakers, per stream, by frequency.
//
// SILENT, three ways: every AudioContext's destination is replaced by an
// AnalyserNode that is connected to nothing (nothing can reach an output
// device); the tones feed only MediaStream destinations; the browser runs
// with --mute-audio (Firefox: media.volume_scale 0). The fallback phases,
// where an <audio> plays unmuted, carry silent tracks.
//
// Checks (Edge, the desktop app's engine, and Firefox):
//   - both streams heard at 100% (positive control);
//   - B at 150% is +3 dB, A untouched; A at 30% is -21 dB, B untouched;
//   - mute: that stream is gone, the other untouched; both muted is digital
//     silence; the stage's claim is digital silence at once, and comes back;
//   - Output Volume 50% is -6 dB on both; Stream Attenuation ducks both by
//     its strength while anyone talks, and comes back;
//   - an iPhone-style element whose volume cannot be set: the levels apply
//     anyway (the graph carries them);
//   - NEGATIVE CONTROL (Chromium): with no sink <audio> bound the graph hears
//     neither stream — the meter reads the engine, and the sinks are what
//     feed it — and the next pass binds them again;
//   - fallback: no Web Audio at all, and a context held suspended until a
//     tap (the autoplay policy, simulated: headless counts every page as
//     already tapped): each stream on its <audio> (unmuted, at min(gain, 1)),
//     then — after the tap — on the graph, heard.
//
//   cd frontend && node e2e/stream-audio-gain-real-browser.mjs
//
// No server and no build needed. CHANNEL=bundled uses Playwright's Chromium
// instead of the installed Edge; FIREFOX=0 skips Firefox.
import { chromium, firefox } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, '..');
const bundle = await build({
    stdin: {
        contents: [
            "export { createHostController } from './src/components/streamAudioHostCore.ts';",
            "export { streamAudioPlan } from './src/components/streamAudioRouting.ts';",
        ].join('\n'),
        resolveDir: frontend,
        loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'StreamAudio',
    platform: 'browser',
});
const moduleSrc = bundle.outputFiles[0].text;

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => {
    if (cond) { pass++; console.log('PASS', label, extra); }
    else { fail++; console.log('FAIL', label, extra); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const dB = (g) => 20 * Math.log10(g);

/** Everything below runs in the page. */
const harness = () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // SILENCE: no context in this page can reach an output device.
    const Real = window.AudioContext;
    class TapContext extends Real {
        constructor(o) {
            super(o);
            const tap = this.createAnalyser();
            tap.fftSize = 16384;
            tap.smoothingTimeConstant = 0;
            this.__tap = tap;
        }
        get destination() { return this.__tap; }
    }
    window.AudioContext = TapContext;

    const ms = (t) => { const s = new MediaStream(); s.addTrack(t); return s; };

    /** A loopback call carrying one tone per stream (Hz), or silence. */
    async function call(tones) {
        const src = new AudioContext();
        const locals = tones.map((hz) => {
            const out = src.createMediaStreamDestination();
            if (hz) {
                const osc = src.createOscillator();
                osc.frequency.value = hz;
                const g = src.createGain();
                g.gain.value = 0.5;
                osc.connect(g).connect(out); // never to a destination
                osc.start();
            }
            return out.stream;
        });
        const pc1 = new RTCPeerConnection();
        const pc2 = new RTCPeerConnection();
        pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
        pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
        const remote = new Map();
        const all = new Promise((res) => {
            pc2.ontrack = (e) => {
                remote.set(e.streams[0].id, e.track);
                if (remote.size === locals.length) res();
            };
        });
        for (const s of locals) pc1.addTrack(s.getAudioTracks()[0], s);
        await pc1.setLocalDescription(await pc1.createOffer());
        await pc2.setRemoteDescription(pc1.localDescription);
        await pc2.setLocalDescription(await pc2.createAnswer());
        await pc1.setRemoteDescription(pc2.localDescription);
        await all;
        return { src, tracks: locals.map((s) => remote.get(s.id)) };
    }

    /** The host as StreamAudioHost mounts it, over `tracks` (user ids 1..n). */
    function host(tracks, opts = {}) {
        const state = {
            levels: Object.fromEntries(tracks.map((_, i) => [i + 1, 100])),
            mutes: {}, master: 1, claimed: false,
            attenuation: { enabled: false, strength: 0.5 },
            ctx: null,
        };
        const sources = Object.fromEntries(tracks.map((t, i) => [i + 1, ms(t)]));
        const ids = tracks.map((_, i) => i + 1);
        const box = document.createElement('div');
        box.innerHTML = ids.map((id) => `<audio data-stream-audio="${id}" autoplay muted></audio>`).join('');
        document.body.appendChild(box);
        const ctl = window.StreamAudio.createHostController({
            plan: () => window.StreamAudio.streamAudioPlan({
                selected: ids, ownId: null, stageOwns: state.claimed, mutes: state.mutes,
                volumes: state.levels, master: state.master, defaultVolume: 100,
            }),
            sourceOf: (id) => sources[id],
            watched: () => ids,
            routeElement: () => Promise.resolve(),
            routeContext: () => Promise.resolve(),
            createContext: () => {
                if (opts.noWebAudio) throw new Error('no Web Audio in this engine');
                state.ctx = new AudioContext();
                return state.ctx;
            },
            attenuation: () => state.attenuation,
        });
        ctl.attach(box);
        ctl.adopt();
        const el = (id) => box.querySelector(`audio[data-stream-audio="${id}"]`);
        return { ctl, state, el, box };
    }

    /** What the small player sends the speakers, per tone and overall. */
    async function meter(h, settleMs = 450) {
        await sleep(settleMs);
        const an = h.state.ctx.__tap;
        const f = new Float32Array(an.frequencyBinCount);
        an.getFloatFrequencyData(f);
        const hzPerBin = h.state.ctx.sampleRate / an.fftSize;
        const peak = (hz) => {
            const b = Math.round(hz / hzPerBin);
            let m = -Infinity;
            for (let i = b - 4; i <= b + 4; i++) m = Math.max(m, f[i]);
            return m;
        };
        const td = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(td);
        let maxAbs = 0;
        for (const v of td) maxAbs = Math.max(maxAbs, Math.abs(v));
        return { a: peak(440), b: peak(1000), maxAbs };
    }

    return { sleep, call, host, meter };
};

async function runMain(engine, launch, { chromiumSink }) {
    const browser = await launch();
    try {
        const page = await (await browser.newContext()).newPage();
        await page.setContent('<!doctype html><meta charset=utf-8><title>stream audio gain</title><body>rig</body>');
        await page.addScriptTag({ content: moduleSrc });
        const r = await page.evaluate(async ({ harnessSrc, chromiumSink }) => {
            const H = (0, eval)(`(${harnessSrc})`)();
            const out = {};
            const { tracks } = await H.call([440, 1000]);
            const h = H.host(tracks);
            await H.sleep(200);
            out.path = [h.ctl.path(1), h.ctl.path(2)];
            out.sinksMuted = [h.el(1).muted, h.el(2).muted];
            out.base = await H.meter(h);

            h.state.levels[2] = 150; h.ctl.reconcile();
            out.bBoost = await H.meter(h);
            h.state.levels[1] = 30; h.ctl.reconcile();
            out.aLow = await H.meter(h);

            h.state.mutes[1] = true; h.ctl.reconcile();
            out.aMuted = await H.meter(h);
            h.state.mutes[2] = true; h.ctl.reconcile();
            out.bothMuted = await H.meter(h);
            h.state.mutes = {}; h.state.levels = { 1: 100, 2: 100 }; h.ctl.reconcile();
            out.back = await H.meter(h);

            h.state.claimed = true; h.ctl.reconcile();
            out.claimed = await H.meter(h);
            h.state.claimed = false; h.ctl.reconcile();
            out.released = await H.meter(h);

            h.state.master = 0.5; h.ctl.reconcile();
            out.master = await H.meter(h);
            h.state.master = 1; h.ctl.reconcile();

            h.state.attenuation = { enabled: true, strength: 0.5 };
            h.ctl.reconcile();
            h.ctl.setSpeaking(true);
            out.ducked = await H.meter(h, 700);
            h.ctl.setSpeaking(false);
            out.unducked = await H.meter(h, 1600);
            h.state.attenuation = { enabled: false, strength: 0.5 };
            h.ctl.reconcile();

            // An iPhone: a page cannot set an element's volume.
            Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
                configurable: true, get: () => 1, set: () => {},
            });
            h.state.levels[1] = 30; h.ctl.reconcile();
            out.ios = await H.meter(h);
            out.iosPath = h.ctl.path(1);
            h.state.levels[1] = 100; h.ctl.reconcile();

            if (chromiumSink) {
                // NEGATIVE CONTROL: with NO sink bound, the graph hears neither
                // stream. (Measured 2026-10-26: Chromium's remote playout is
                // shared, so any one bound element keeps every remote track
                // flowing — unbinding A's alone left A heard — and a paused
                // one still counts; with none bound, nothing flows.)
                h.el(1).srcObject = null;
                h.el(2).srcObject = null;
                // The renderer lets go a moment after the unbind, and the
                // meter's window is 341 ms long.
                out.sinkPaused = await H.meter(h, 1500);
                h.ctl.reconcile(); // a pass binds and plays the sinks again
                out.sinkBack = await H.meter(h);
            }
            return out;
        }, { harnessSrc: harness.toString(), chromiumSink });

        const tag = `[${engine}]`;
        ck(r.path[0] === 'graph' && r.path[1] === 'graph', `${tag} both streams play through the graph`, JSON.stringify(r.path));
        ck(r.sinksMuted.every(Boolean), `${tag} the <audio> sinks are muted`);
        ck(r.base.a > -45 && r.base.b > -45 && r.base.maxAbs > 0.05,
            `${tag} POSITIVE CONTROL both streams heard at 100%`, `A ${r.base.a.toFixed(1)} dB, B ${r.base.b.toFixed(1)} dB`);
        ck(near(r.bBoost.b - r.base.b, dB(Math.SQRT2), 0.6), `${tag} B at 150% is +3 dB`, `${(r.bBoost.b - r.base.b).toFixed(2)} dB`);
        ck(near(r.bBoost.a, r.base.a, 0.3), `${tag} ...and A is untouched`, `${(r.bBoost.a - r.base.a).toFixed(2)} dB`);
        ck(near(r.aLow.a - r.base.a, dB(0.09), 1.0), `${tag} A at 30% is -21 dB`, `${(r.aLow.a - r.base.a).toFixed(2)} dB`);
        ck(near(r.aLow.b, r.bBoost.b, 0.3), `${tag} ...and B is untouched`, `${(r.aLow.b - r.bBoost.b).toFixed(2)} dB`);
        ck(r.aMuted.a < r.base.a - 60 && near(r.aMuted.b, r.aLow.b, 0.3),
            `${tag} A muted: gone, B untouched`, `A ${r.aMuted.a.toFixed(1)} dB`);
        ck(r.bothMuted.maxAbs === 0, `${tag} both muted: digital silence`, String(r.bothMuted.maxAbs));
        ck(near(r.back.a, r.base.a, 0.5) && near(r.back.b, r.base.b, 0.5), `${tag} unmuted at 100%: both back`);
        ck(r.claimed.maxAbs === 0, `${tag} the stage's claim: digital silence at once`, String(r.claimed.maxAbs));
        ck(near(r.released.a, r.base.a, 0.5), `${tag} ...and back when the stage lets go`);
        ck(near(r.master.a - r.base.a, -6.02, 0.6) && near(r.master.b - r.base.b, -6.02, 0.6),
            `${tag} Output Volume 50% is -6 dB on both`, `${(r.master.a - r.base.a).toFixed(2)} / ${(r.master.b - r.base.b).toFixed(2)} dB`);
        ck(near(r.ducked.a - r.base.a, -6.02, 0.8) && near(r.ducked.b - r.base.b, -6.02, 0.8),
            `${tag} Stream Attenuation (50%) ducks both while anyone talks`, `${(r.ducked.a - r.base.a).toFixed(2)} dB`);
        ck(near(r.unducked.a, r.base.a, 0.6), `${tag} ...and lets go after`, `${(r.unducked.a - r.base.a).toFixed(2)} dB`);
        ck(r.iosPath === 'graph' && near(r.ios.a - r.base.a, dB(0.09), 1.0),
            `${tag} element volume unsettable (iPhone): A at 30% is still -21 dB`, `${(r.ios.a - r.base.a).toFixed(2)} dB`);
        if (chromiumSink) {
            ck(r.sinkPaused.maxAbs < 1e-4,
                `${tag} NEGATIVE CONTROL no sink bound: the graph hears neither stream`, `max ${r.sinkPaused.maxAbs}`);
            ck(near(r.sinkBack.a, r.base.a, 0.6) && near(r.sinkBack.b, r.base.b, 0.6),
                `${tag} ...and the next pass binds the sinks again: both heard`, `${(r.sinkBack.a - r.base.a).toFixed(2)} dB`);
        }

        // Fallback: no Web Audio at all, in a fresh page (no iPhone override).
        // Silent tracks: these elements play unmuted.
        const page2 = await (await browser.newContext()).newPage();
        await page2.setContent('<!doctype html><meta charset=utf-8><title>stream audio fallback</title><body>rig</body>');
        await page2.addScriptTag({ content: moduleSrc });
        const f = await page2.evaluate(async ({ harnessSrc }) => {
            const H = (0, eval)(`(${harnessSrc})`)();
            const { tracks } = await H.call([0, 0]);
            const h = H.host(tracks, { noWebAudio: true });
            h.state.levels = { 1: 30, 2: 150 };
            h.ctl.reconcile();
            await H.sleep(100);
            return {
                path: [h.ctl.path(1), h.ctl.path(2)],
                muted: [h.el(1).muted, h.el(2).muted],
                volume: [h.el(1).volume, h.el(2).volume],
            };
        }, { harnessSrc: harness.toString() });
        ck(f.path.every(p => p === 'element') && f.muted.every(m => !m),
            `[${engine}] no Web Audio: each stream on its own unmuted <audio> (no silence)`, JSON.stringify(f.path));
        ck(near(f.volume[0], 0.09, 1e-6) && f.volume[1] === 1,
            `[${engine}] ...at min(gain, 1) each: 30% -> 0.09, 150% -> 1 (an element cannot boost)`, JSON.stringify(f.volume));
    } finally {
        await browser.close();
    }
}

/** A context the autoplay policy holds suspended until a tap. */
async function runGesture(engine, launch) {
    const browser = await launch();
    try {
        const page = await (await browser.newContext()).newPage();
        await page.setContent('<!doctype html><meta charset=utf-8><title>stream audio gesture</title><body style="height:400px">tap here</body>');
        await page.addScriptTag({ content: moduleSrc });
        const before = await page.evaluate(async ({ harnessSrc }) => {
            const H = (0, eval)(`(${harnessSrc})`)();
            window.__H = H;
            // The autoplay policy, simulated: headless counts every page as
            // already tapped (navigator.userActivation.hasBeenActive is true
            // with no input), so a context here is really suspended and may
            // resume only inside a tap's handler.
            window.__inTap = false;
            const Tap = window.AudioContext;
            class HeldContext extends Tap {
                constructor(o) { super(o); void super.suspend(); }
                resume() {
                    return window.__inTap ? super.resume() : Promise.reject(new DOMException('needs a tap', 'NotAllowedError'));
                }
            }
            window.AudioContext = HeldContext;
            // The tone's own context is held too: until the second tap the call
            // carries silence.
            const c = await H.call([440]);
            window.__src = c.src;
            window.__tone = false;
            const h = H.host(c.tracks);
            window.__h = h;
            await H.sleep(400);
            // StreamAudioHost runs a pass on every gesture (onUserGesture).
            document.addEventListener('pointerdown', () => {
                window.__inTap = true;
                h.ctl.reconcile();
                if (window.__tone) void window.__src.resume();
                window.__inTap = false;
            }, { capture: true });
            return { state: h.state.ctx.state, path: h.ctl.path(1), muted: h.el(1).muted };
        }, { harnessSrc: harness.toString() });
        ck(before.state === 'suspended' && before.path === 'element' && before.muted === false,
            `[${engine}] a context held suspended: the stream waits on its unmuted <audio>, not the graph`, JSON.stringify(before));
        await page.mouse.click(50, 50);
        const moved = await page.evaluate(async () => {
            const h = window.__h;
            await window.__H.sleep(300);
            return { state: h.state.ctx.state, path: h.ctl.path(1), muted: h.el(1).muted };
        });
        ck(moved.state === 'running' && moved.path === 'graph' && moved.muted === true,
            `[${engine}] a tap resumes it: the stream moves onto the graph, the <audio> a muted sink again`, JSON.stringify(moved));
        // Only now (the <audio> muted) is the tone let go, by a second tap.
        await page.evaluate(() => { window.__tone = true; });
        await page.mouse.click(60, 60);
        const heard = await page.evaluate(async () => {
            const m = await window.__H.meter(window.__h, 600);
            return { a: m.a, muted: window.__h.el(1).muted };
        });
        ck(heard.a > -45 && heard.muted === true, `[${engine}] ...and heard through the graph`, `${heard.a.toFixed(1)} dB`);
    } finally {
        await browser.close();
    }
}

const CHANNEL = process.env.CHANNEL || 'msedge';
// The autoplay policy flag is not what holds a context in the gesture phase:
// headless counts every page as already tapped whatever the flag says
// (measured), so that phase simulates the policy in the page.
const chromeOpts = () => ({
    headless: true,
    ...(CHANNEL === 'bundled' ? {} : { channel: CHANNEL }),
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const ffOpts = {
    headless: true,
    firefoxUserPrefs: { 'media.volume_scale': '0.0', 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 },
};

await runMain(CHANNEL === 'bundled' ? 'chromium' : CHANNEL, () => chromium.launch(chromeOpts()), { chromiumSink: true });
await runGesture(CHANNEL === 'bundled' ? 'chromium' : CHANNEL, () => chromium.launch(chromeOpts()));
if (process.env.FIREFOX !== '0') {
    await runMain('firefox', () => firefox.launch(ffOpts), { chromiumSink: false });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
