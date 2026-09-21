// An EMULATED Rust side for the native clip pipeline: everything the JS half
// of Púca reaches through `window.__TAURI_INTERNALS__` while a clip buffer is
// armed automatically. Installed before any app module loads, so
// `isTauri()` is true and `@tauri-apps/api`'s invoke/listen land here.
//
// What it emulates, with the timing the real shell has:
//  - `start_clip_video_capture`: an agent whose clock starts BEFORE the app
//    subscribes, stamping each frame `ts_us` AFTER the acquire + readback
//    (READBACK_LAG_MS), and delivering it over IPC with jitter (VIDEO_IPC_MS).
//    The frames are a real H.264 Annex-B stream (a flash at a known frame).
//  - `start_clip_desktop_audio`: WASAPI loopback packets of 10 ms of f32
//    stereo PCM, delivered a WASAPI period plus IPC after their last sample
//    (AUDIO_DELIVERY_MS), silence except a 1 kHz burst at a known instant.
//  - the generation on every event, `stop_*` with a generation, the tray and
//    stream-diag commands (the `clip-av` line is captured for the report).
//
// THE ONE CLOCK: the harness's `performance.now()`. The burst starts at the
// instant the flash frame is presented, so the sealed clip's audio should
// begin at the flash frame; whatever the pipeline puts between them is the
// A/V error this harness measures. Nothing here reaches an audio device.
(function () {
    'use strict';
    const P = {
        fps: 30,
        width: 1280, height: 720,
        // The agent's clock starts this long before its first frame is presented
        // (its DXGI + encoder init; the app is already subscribed by then).
        agentHeadStartMs: 50,
        // ts is stamped after acquire + readback.
        readbackLagMs: 2,
        // IPC (pipe -> Puca.exe -> base64 -> Tauri event) per chunk: min + jitter.
        videoIpcMs: [3, 12],
        // WASAPI period (10 ms packets) + the same IPC, per packet.
        audioDeliveryMs: [12, 25],
        sampleRate: 48000, channels: 2, packetFrames: 480,
        // Bursts, each tied to a flash frame: {frame, offsetMs}. Offset 0 is
        // the truth; a second burst +300 ms after a second flash in the SAME
        // clip is the oracle's positive control (run-to-run variance cancels).
        bursts: [{ frame: 150, offsetMs: 0 }, { frame: 240, offsetMs: 300 }],
        burstMs: 30,
        // The first video frames sit in a queue for this long before the app's
        // worker is armed (the real WASAPI init wait) — modelled by the app
        // itself (replayBuffer's chunkQueue); nothing to emulate here.
    };
    const cfg = Object.assign(P, window.__AV_PARAMS__ || {});

    let nextCb = 1;
    const callbacks = new Map();           // callback id -> fn
    const listeners = new Map();           // event -> Map(eventId -> callback id)
    let nextEventId = 1;
    const log = [];
    const diag = [];
    let videoGen = 0, audioGen = 0;
    let video = null, audio = null;        // running emitters
    // PROBE: every AudioBufferSourceNode.start(when) in the page, as the lead
    // (when - currentTime, ms) it was scheduled with. nativeCapture's loopback
    // context is the only caller, so this is its scheduling lead over time.
    const leads = [];
    const origStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when) {
        if (typeof when === 'number') leads.push({ at: performance.now(), leadMs: (when - this.context.currentTime) * 1000, state: this.context.state });
        return origStart.apply(this, arguments);
    };

    function emit(event, payload) {
        const ls = listeners.get(event);
        if (!ls) return;
        for (const cbId of ls.values()) {
            const fn = callbacks.get(cbId);
            if (fn) fn({ event, id: cbId, payload });
        }
    }
    const jitter = ([lo, hi]) => lo + Math.random() * (hi - lo);
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

    // ---- video: the pre-encoded access units, on the emulated agent's clock
    function startVideo(generation) {
        const aus = window.__AV_AUS__;      // [{key, bytes(Uint8Array)}] set by the harness
        if (!aus || !aus.length) throw new Error('no access units loaded');
        const periodMs = 1000 / cfg.fps;
        const v0 = performance.now() + 20;          // first present
        const agentStart = v0 - cfg.agentHeadStartMs;
        const st = { stopped: false, timers: [], v0, agentStart, presented: [] };
        for (let k = 0; k < aus.length; k++) {
            const presentAt = v0 + k * periodMs;
            const tsUs = Math.round((presentAt + cfg.readbackLagMs - agentStart) * 1000);
            const emitAt = presentAt + cfg.readbackLagMs + jitter(cfg.videoIpcMs);
            st.timers.push(setTimeout(() => {
                if (st.stopped) return;
                st.presented.push({ k, presentAt, tsUs });
                emit('clip-video-chunk', {
                    data: b64(aus[k].bytes), keyframe: aus[k].key, ts_us: tsUs, dur_us: Math.round(1e6 / cfg.fps),
                    codec: aus[k].key ? window.__AV_CODEC__ : null, width: cfg.width, height: cfg.height, generation,
                });
            }, emitAt - performance.now()));
        }
        return st;
    }

    // ---- audio: 10 ms WASAPI packets on the same clock
    function startAudio(generation, burstsAtMs) {
        const st = { stopped: false, timer: null, a0: performance.now() + 5, n: 0 };
        const { sampleRate, channels, packetFrames } = cfg;
        const inBurst = (t) => { for (const b of burstsAtMs) if (t >= b && t < b + cfg.burstMs) return t - b; return -1; };
        const tick = () => {
            if (st.stopped) return;
            const now = performance.now();
            // Every packet whose last sample is at least AUDIO_DELIVERY behind now.
            for (;;) {
                const firstAt = st.a0 + (st.n * packetFrames * 1000) / sampleRate;
                const lastAt = firstAt + (packetFrames * 1000) / sampleRate;
                if (lastAt + st.nextDelay > now) break;
                const pcm = new Float32Array(packetFrames * channels);
                for (let i = 0; i < packetFrames; i++) {
                    const t = firstAt + (i * 1000) / sampleRate;
                    const dt = inBurst(t);
                    const v = dt >= 0 ? 0.5 * Math.sin(2 * Math.PI * 1000 * dt / 1000) : 0;
                    for (let c = 0; c < channels; c++) pcm[i * channels + c] = v;
                }
                emit('clip-audio-data', {
                    data: b64(new Uint8Array(pcm.buffer)), sample_rate: sampleRate, channels, bits_per_sample: 32,
                    silent: false, generation,
                });
                st.n++;
                st.nextDelay = jitter(cfg.audioDeliveryMs);
            }
            st.timer = setTimeout(tick, 2);
        };
        st.nextDelay = jitter(cfg.audioDeliveryMs);
        st.timer = setTimeout(tick, 2);
        return st;
    }

    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener(event, eventId) { listeners.get(event)?.delete(eventId); },
    };
    window.__TAURI_INTERNALS__ = {
        transformCallback(cb, once) {
            const id = nextCb++;
            callbacks.set(id, once ? (e) => { callbacks.delete(id); cb(e); } : cb);
            return id;
        },
        unregisterCallback(id) { callbacks.delete(id); },
        convertFileSrc(p) { return p; },
        async invoke(cmd, args) {
            log.push(cmd);
            switch (cmd) {
                case 'plugin:event|listen': {
                    const id = nextEventId++;
                    if (!listeners.has(args.event)) listeners.set(args.event, new Map());
                    listeners.get(args.event).set(id, args.handler);
                    return id;
                }
                case 'plugin:event|unlisten': listeners.get(args.event)?.delete(args.eventId); return null;
                case 'start_clip_video_capture': {
                    if (video && !video.stopped) throw new Error('Already capturing video');
                    const generation = ++videoGen;
                    video = startVideo(generation);
                    // Each burst starts at its flash frame's present instant (+ offset).
                    const bursts = cfg.bursts.map(b => ({ frame: b.frame, flashAt: video.v0 + b.frame * (1000 / cfg.fps), burstAt: video.v0 + b.frame * (1000 / cfg.fps) + b.offsetMs, offsetMs: b.offsetMs }));
                    window.__AV_TRUTH__ = { bursts, v0: video.v0, agentStart: video.agentStart };
                    return { output_index: 0, hmonitor: 65639, width: cfg.width, height: cfg.height, reason: 'primary', bitrate: 8000000, generation };
                }
                case 'stop_clip_video_capture': {
                    if (video && (args?.generation == null || args.generation === videoGen)) { video.stopped = true; video.timers.forEach(clearTimeout); }
                    return null;
                }
                case 'start_clip_desktop_audio': {
                    if (audio && !audio.stopped) throw new Error('Already capturing desktop audio');
                    const generation = ++audioGen;
                    const t = window.__AV_TRUTH__;
                    if (!t) throw new Error('video must start before audio in this emulation');
                    audio = startAudio(generation, t.bursts.map(b => b.burstAt));
                    return { device_name: 'Emulated loopback', generation };
                }
                case 'stop_clip_desktop_audio': {
                    if (audio && (args?.generation == null || args.generation === audioGen)) { audio.stopped = true; clearTimeout(audio.timer); }
                    return null;
                }
                case 'log_stream_diag': diag.push(String(args?.line ?? '')); return null;
                case 'set_clip_armed_indicator': case 'set_screen_share_indicator': case 'reset_capture_state': return null;
                default: return null;
            }
        },
    };
    window.__AV_EMU__ = { log, diag, params: cfg, leads, presented: () => (video ? video.presented : []) };
})();
