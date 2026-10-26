// Does the small player's Web Audio gain (StreamAudioHost's engine,
// src/components/streamAudioHostCore.ts) really set each watched stream's
// loudness in a REAL browser, from a REAL remote WebRTC track — without
// anything ever reaching a speaker?
//
// WHY THIS EXISTS. vitest runs under jsdom, which has no Web Audio and no
// WebRTC: the unit tests drive the engine against a fake context that only
// records the values it is sent. Whether a remote track actually reaches the
// graph (in Chromium only while a media element has remote audio bound: the
// muted <audio> sinks), whether a boost above 100% is audible, whether mute
// is silence, only a real engine can say. So this bundles the REAL module
// (esbuild), negotiates a loopback call carrying two tones, one per watched
// stream (A at 440 Hz, B at 1000 Hz), and reads what the engine sends to the
// speakers, per stream, by frequency.
//
// SILENT, three ways, each enough on its own:
//   1. every AudioContext in the page has an AnalyserNode connected to
//      nothing as its destination: no graph can reach an output device;
//   2. no <audio> ever carries a tone unmuted. The tones start only once
//      every stream reads 'graph' (its <audio> a muted sink); from then on
//      the page refuses every unmute (a guard on HTMLMediaElement.muted; any
//      refusal fails the run). The phases where an <audio> plays unmuted on
//      purpose (the fallbacks, and the gesture phase before its tap) carry
//      tracks that are silent at their source;
//   3. the browser runs muted: --mute-audio (Firefox: media.volume_scale 0).
//
// Checks (Edge, the desktop app's engine, and Firefox):
//   - both streams heard at 100% (positive control);
//   - B at 150% is +3 dB, A untouched; A at 30% is -21 dB, B untouched;
//   - mute: that stream is gone, the other untouched; both muted is digital
//     silence; the stage's claim is digital silence, and comes back;
//   - Output Volume 50% is -6 dB on both (Stream Attenuation is the big
//     view's alone: the small player has no ducking to check);
//   - an iPhone-style element whose volume cannot be set: the levels apply
//     anyway (the graph carries them), and — NEGATIVE CONTROL — under the
//     same override the element path loses the level;
//   - (Chromium) a PAUSED sink still feeds the graph (so on Android, which
//     pauses elements in the background, the stream keeps sounding), and —
//     NEGATIVE CONTROL — with no sink bound at all the graph hears neither
//     stream; the next pass binds them again;
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

    // SILENCE 1: no context in this page can reach an output device.
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

    // SILENCE 2: once a tone is live, no element may be unmuted. A refused
    // unmute stays muted, and is counted: the run fails on any.
    window.__tonesLive = false;
    window.__unmuteRefused = 0;
    const muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
    Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
        configurable: true,
        get() { return muted.get.call(this); },
        set(v) {
            if (!v && window.__tonesLive) { window.__unmuteRefused++; muted.set.call(this, true); return; }
            muted.set.call(this, v);
        },
    });

    const ms = (t) => { const s = new MediaStream(); s.addTrack(t); return s; };

    /** A loopback call with one stream per tone (Hz). Every tone is SILENT at
     *  its source until start(); a 0 is a track that stays silent. */
    async function call(tones) {
        const src = new AudioContext();
        const levels = [];
        const locals = tones.map((hz) => {
            const out = src.createMediaStreamDestination();
            if (hz) {
                const osc = src.createOscillator();
                osc.frequency.value = hz;
                const g = src.createGain();
                g.gain.value = 0;
                osc.connect(g).connect(out); // never to a destination
                osc.start();
                levels.push(g);
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
        /** Let the tones go. From this moment no element may be unmuted. */
        const start = () => {
            window.__tonesLive = true;
            for (const g of levels) g.gain.value = 0.5;
        };
        return { src, tracks: locals.map((s) => remote.get(s.id)), start };
    }

    /** The host as StreamAudioHost mounts it, over `tracks` (user ids 1..n). */
    function host(tracks, opts = {}) {
        const state = {
            levels: Object.fromEntries(tracks.map((_, i) => [i + 1, 100])),
            mutes: {}, master: 1, claimed: false,
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
            followsOutputDevice: () => true, // the default device
            createContext: () => {
                if (opts.noWebAudio) throw new Error('no Web Audio in this engine');
                state.ctx = new AudioContext();
                return state.ctx;
            },
        });
        ctl.attach(box);
        ctl.adopt();
        const el = (id) => box.querySelector(`audio[data-stream-audio="${id}"]`);
        return { ctl, state, el, box, ids };
    }

    /** Wait (no tone yet) until every stream is on the graph. */
    async function onGraph(h, ms = 4000) {
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
            if (h.ids.every((id) => h.ctl.path(id) === 'graph') && h.ids.every((id) => h.el(id).muted)) return true;
            await sleep(25);
        }
        return false;
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

    /** An iPhone: a page cannot set an element's volume. What the page asks
     *  for is recorded (window.__volumeAsked), and none of it is taken. */
    function iosVolume() {
        window.__volumeAsked = [];
        Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
            configurable: true, get: () => 1, set: (v) => { window.__volumeAsked.push(v); },
        });
    }

    return { sleep, call, host, onGraph, meter, iosVolume };
};

async function newRig(browser) {
    const page = await (await browser.newContext()).newPage();
    await page.setContent('<!doctype html><meta charset=utf-8><title>stream audio gain</title><body style="height:400px">rig</body>');
    await page.addScriptTag({ content: moduleSrc });
    return page;
}

async function runMain(engine, launch, { chromiumSink }) {
    const browser = await launch();
    try {
        const page = await newRig(browser);
        const r = await page.evaluate(async ({ harnessSrc, chromiumSink }) => {
            const H = (0, eval)(`(${harnessSrc})`)();
            const out = {};
            const c = await H.call([440, 1000]);
            const h = H.host(c.tracks);
            out.onGraph = await H.onGraph(h);
            if (!out.onGraph) {
                // Never let the tones go unless every sink is a muted one.
                out.path = [h.ctl.path(1), h.ctl.path(2)];
                return out;
            }
            out.path = [h.ctl.path(1), h.ctl.path(2)];
            out.sinksMuted = [h.el(1).muted, h.el(2).muted];
            c.start();
            out.base = await H.meter(h, 700);

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

            H.iosVolume();
            h.state.levels[1] = 30; h.ctl.reconcile();
            out.ios = await H.meter(h);
            out.iosPath = h.ctl.path(1);
            h.state.levels[1] = 100; h.ctl.reconcile();

            if (chromiumSink) {
                // A PAUSED sink still feeds the graph (Android pauses elements
                // in the background): both heard with both sinks paused.
                h.el(1).pause();
                h.el(2).pause();
                out.sinksPausedMeter = await H.meter(h, 900);
                out.sinksPaused = [h.el(1).paused, h.el(2).paused];
                h.ctl.reconcile(); // plays them again
                // NEGATIVE CONTROL: with NO sink bound the graph hears neither
                // stream. (Chromium's remote playout is shared: any one bound
                // element keeps every remote track flowing, a paused one too.)
                h.el(1).srcObject = null;
                h.el(2).srcObject = null;
                // The renderer lets go a moment after the unbind, and the
                // meter's window is 341 ms long.
                out.unbound = await H.meter(h, 1500);
                h.ctl.reconcile(); // binds and plays the sinks again
                out.rebound = await H.meter(h);
            }
            out.unmuteRefused = window.__unmuteRefused;
            out.stillMuted = [h.el(1).muted, h.el(2).muted];
            return out;
        }, { harnessSrc: harness.toString(), chromiumSink });

        const tag = `[${engine}]`;
        ck(r.onGraph, `${tag} both streams on the graph, their <audio> muted sinks, BEFORE any tone starts`, JSON.stringify(r.path));
        if (!r.onGraph) return;
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
        ck(r.claimed.maxAbs === 0, `${tag} the stage's claim: digital silence`, String(r.claimed.maxAbs));
        ck(near(r.released.a, r.base.a, 0.5), `${tag} ...and back when the stage lets go`);
        ck(near(r.master.a - r.base.a, -6.02, 0.6) && near(r.master.b - r.base.b, -6.02, 0.6),
            `${tag} Output Volume 50% is -6 dB on both`, `${(r.master.a - r.base.a).toFixed(2)} / ${(r.master.b - r.base.b).toFixed(2)} dB`);
        ck(r.iosPath === 'graph' && near(r.ios.a - r.base.a, dB(0.09), 1.0),
            `${tag} element volume unsettable (iPhone): A at 30% is still -21 dB`, `${(r.ios.a - r.base.a).toFixed(2)} dB`);
        if (chromiumSink) {
            ck(r.sinksPaused.every(Boolean) && near(r.sinksPausedMeter.a, r.base.a, 0.6) && near(r.sinksPausedMeter.b, r.base.b, 0.6),
                `${tag} both sinks PAUSED: both still heard through the graph`, `A ${(r.sinksPausedMeter.a - r.base.a).toFixed(2)} dB`);
            ck(r.unbound.maxAbs < 1e-4,
                `${tag} NEGATIVE CONTROL no sink bound: the graph hears neither stream`, `max ${r.unbound.maxAbs}`);
            ck(near(r.rebound.a, r.base.a, 0.6) && near(r.rebound.b, r.base.b, 0.6),
                `${tag} ...and the next pass binds the sinks again: both heard`, `${(r.rebound.a - r.base.a).toFixed(2)} dB`);
        }
        ck(r.unmuteRefused === 0 && r.stillMuted.every(Boolean),
            `${tag} SAFETY no element was unmuted while a tone was live`, `refused ${r.unmuteRefused}`);

        // The element fallback (no Web Audio), with silent tracks: these
        // elements play unmuted on purpose. Once as it is, once as an iPhone.
        for (const ios of [false, true]) {
            const fallbackPage = await newRig(browser);
            const f = await fallbackPage.evaluate(async ({ harnessSrc, ios }) => {
                const H = (0, eval)(`(${harnessSrc})`)();
                if (ios) H.iosVolume();
                const { tracks } = await H.call([0, 0]); // silent at the source
                const h = H.host(tracks, { noWebAudio: true });
                h.state.levels = { 1: 30, 2: 150 };
                h.ctl.reconcile();
                await H.sleep(100);
                return {
                    path: [h.ctl.path(1), h.ctl.path(2)],
                    muted: [h.el(1).muted, h.el(2).muted],
                    volume: [h.el(1).volume, h.el(2).volume],
                    asked: window.__volumeAsked ?? [],
                };
            }, { harnessSrc: harness.toString(), ios });
            if (!ios) {
                ck(f.path.every(p => p === 'element') && f.muted.every(m => !m),
                    `${tag} no Web Audio: each stream on its own unmuted <audio> (no silence)`, JSON.stringify(f.path));
                ck(near(f.volume[0], 0.09, 1e-6) && f.volume[1] === 1,
                    `${tag} ...at min(gain, 1) each: 30% -> 0.09, 150% -> 1 (an element cannot boost)`, JSON.stringify(f.volume));
            } else {
                // The engine asked the element for 30%'s 0.09 (a fallback that
                // stopped asking fails here), and it plays at 1 regardless.
                ck(f.path.every(p => p === 'element') && f.asked.some(v => near(v, 0.09, 1e-6)) && f.volume[0] === 1,
                    `${tag} NEGATIVE CONTROL as an iPhone, the element path LOSES the level (asked for 0.09, plays at 1)`,
                    JSON.stringify({ asked: f.asked, volume: f.volume }));
            }
        }
    } finally {
        await browser.close();
    }
}

/** A context held suspended until a tap. */
async function runGesture(engine, launch) {
    const browser = await launch();
    try {
        const page = await newRig(browser);
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
            // Silent at its source (and its context held) until the second tap.
            const c = await H.call([440]);
            window.__call = c;
            window.__tone = false;
            const h = H.host(c.tracks);
            window.__h = h;
            await H.sleep(400);
            // StreamAudioHost runs a pass on every gesture (onUserGesture).
            document.addEventListener('pointerdown', () => {
                window.__inTap = true;
                h.ctl.reconcile();
                if (window.__tone && h.ctl.path(1) === 'graph' && h.el(1).muted) {
                    void window.__call.src.resume();
                    window.__call.start();
                }
                window.__inTap = false;
            }, { capture: true });
            return { state: h.state.ctx.state, path: h.ctl.path(1), muted: h.el(1).muted };
        }, { harnessSrc: harness.toString() });
        ck(before.state === 'suspended' && before.path === 'element' && before.muted === false,
            `[${engine}] a context held suspended: the stream waits on its unmuted <audio> (silent here), not the graph`, JSON.stringify(before));
        await page.mouse.click(50, 50);
        const moved = await page.evaluate(async () => {
            const h = window.__h;
            await window.__H.sleep(300);
            return { state: h.state.ctx.state, path: h.ctl.path(1), muted: h.el(1).muted };
        });
        ck(moved.state === 'running' && moved.path === 'graph' && moved.muted === true,
            `[${engine}] a tap resumes it: the stream moves onto the graph, the <audio> a muted sink again`, JSON.stringify(moved));
        // Only now, with the <audio> muted, does a second tap let the tone go.
        await page.evaluate(() => { window.__tone = true; });
        await page.mouse.click(60, 60);
        const heard = await page.evaluate(async () => {
            const m = await window.__H.meter(window.__h, 700);
            return { a: m.a, muted: window.__h.el(1).muted, live: window.__tonesLive, refused: window.__unmuteRefused };
        });
        ck(heard.live && heard.a > -45 && heard.muted === true, `[${engine}] ...and heard through the graph`, `${heard.a.toFixed(1)} dB`);
        ck(heard.refused === 0, `[${engine}] SAFETY no element was unmuted while the tone was live`, `refused ${heard.refused}`);
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

const engineName = CHANNEL === 'bundled' ? 'chromium' : CHANNEL;
await runMain(engineName, () => chromium.launch(chromeOpts()), { chromiumSink: true });
await runGesture(engineName, () => chromium.launch(chromeOpts()));
if (process.env.FIREFOX !== '0') {
    await runMain('firefox', () => firefox.launch(ffOpts), { chromiumSink: false });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
