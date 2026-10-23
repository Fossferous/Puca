/**
 * Runs INSIDE the Púca page, before Púca's own scripts: the backend injects
 * it with Page.addScriptToEvaluateOnNewDocument, prefixed with its config. It
 * declares this plugin as Púca's embedding host (docs/EMBEDDING.md) and
 * carries messages between the page and the plugin:
 *   page -> plugin  through a DevTools binding, which the backend relays;
 *   plugin -> page  through window.__pucaDeckyShim, which the backend calls.
 *
 * It also holds the RECEIVING end of the microphone bridge. Steam's browser
 * refuses getUserMedia to every site that is not Steam's own, so the plugin
 * opens the microphone in Steam's own context and sends it here over a local
 * RTCPeerConnection with no ICE servers (it never leaves the Deck). Púca then
 * encrypts and sends it exactly as it would a microphone of its own.
 *
 * And the receiving end of a screen share: Steam's browser refuses
 * getDisplayMedia too, so the backend reads the screen itself and hands the
 * page its encoded picture, which this decodes into a track of its own.
 *
 * Built on its own (rollup.config.js) into dist/page-shim.js, one script with
 * nothing to import at run time (./h264 is bundled into it).
 */
import { codecOf, fromBase64 } from './h264';

interface ShimConfig {
    /** Only this origin gets the declaration: a link that leaves Púca does not. */
    origin: string;
    /** The DevTools binding's name (Runtime.addBinding). */
    binding: string;
    hostName: string;
}

type AnswerInit = { type: 'answer'; sdp: string };
type MicError = { name: string; message: string };

interface Bridge {
    pc: RTCPeerConnection;
    sink: HTMLAudioElement | null;
    released: boolean;
    answered: ((answer: AnswerInit | null, error: MicError | null) => void) | null;
}

/** Chromium's track made from frames (mediacapture-transform), not in TypeScript's DOM types. */
type GeneratedTrack = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type TrackGenerator = new (init: { kind: 'video' }) => GeneratedTrack;

interface Share {
    released: boolean;
    /** The plugin's answer: yes, or no and why; `refused` when the person
     *  said no, rather than the screen being impossible to share. */
    answered: ((ok: boolean, error: string | null, refused: boolean) => void) | null;
    writer: WritableStreamDefaultWriter<VideoFrame> | null;
    decoder: VideoDecoder | null;
    codec: string | null;
    /** Waiting for a keyframe: after a pause, a drop, or a decoder error. */
    needKey: boolean;
    paused: boolean;
    cardTimer: ReturnType<typeof setInterval> | null;
}

(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    const cfg = g.__pucaDeckyShimConfig as ShimConfig | undefined;
    try { delete g.__pucaDeckyShimConfig; } catch { /* not configurable: harmless */ }
    if (!cfg || window.top !== window || location.origin !== cfg.origin) return;
    if (g.__pucaDeckyShim) return;

    // Keep the binding to ourselves: once removed from the page's global, no
    // page script can speak to the plugin in our name.
    const binding = g[cfg.binding] as ((payload: string) => void) | undefined;
    try { delete g[cfg.binding]; } catch { /* stays visible; the backend still checks the sender */ }
    const send = (msg: unknown): void => {
        if (typeof binding !== 'function') return;
        try { binding(JSON.stringify(msg)); } catch { /* the plugin went away */ }
    };

    let foreground = false;
    /** When the Deck's controls were last in use (the backend notes it while
     *  it reads them, during a call); null while it does not. */
    let lastInputAt: number | null = null;

    // ---- The microphone bridge's receiving end -----------------------------

    const bridges = new Map<string, Bridge>();
    let seq = 0;

    const release = (id: string): void => {
        const b = bridges.get(id);
        if (!b || b.released) return;
        b.released = true;
        bridges.delete(id);
        if (b.answered) b.answered(null, { name: 'AbortError', message: 'released' });
        if (b.sink) { b.sink.pause(); b.sink.srcObject = null; }
        try { b.pc.close(); } catch { /* already closed */ }
        send({ type: 'mic-release', id });
    };

    /** Ask for a high, steady Opus rate on the loopback: it costs nothing on a
     *  local link, and the audio is encoded a second time by the call. */
    const tuneOpus = (sdp: string): string => {
        const m = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp);
        if (!m) return sdp;
        const pt = m[1];
        const want: Record<string, string> = { maxaveragebitrate: '128000', useinbandfec: '1', usedtx: '0', stereo: '0' };
        const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
        const found = fmtp.exec(sdp);
        if (!found) return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${Object.entries(want).map(([k, v]) => `${k}=${v}`).join(';')}`);
        const params = new Map(found[1].split(';').map(p => p.trim()).filter(Boolean).map(p => {
            const i = p.indexOf('=');
            return (i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]) as [string, string];
        }));
        for (const [k, v] of Object.entries(want)) params.set(k, v);
        return sdp.replace(found[0], `a=fmtp:${pt} ${[...params].map(([k, v]) => (v ? `${k}=${v}` : k)).join(';')}`);
    };

    const iceGathered = (pc: RTCPeerConnection, ms: number): Promise<void> => new Promise(resolve => {
        if (pc.iceGatheringState === 'complete') { resolve(); return; }
        const done = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } };
        const t = setTimeout(resolve, ms);
        pc.addEventListener('icegatheringstatechange', done);
    });

    const timeout = <T>(p: Promise<T>, ms: number, err: () => Error): Promise<T> => new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(err()), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });

    async function getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
        const id = `m${Date.now().toString(36)}${(++seq).toString(36)}`;
        const pc = new RTCPeerConnection({ iceServers: [] });
        const bridge: Bridge = { pc, sink: null, released: false, answered: null };
        bridges.set(id, bridge);
        try {
            pc.addTransceiver('audio', { direction: 'recvonly' });
            const trackArrived = new Promise<MediaStreamTrack>(resolve => {
                pc.addEventListener('track', e => resolve(e.track), { once: true });
            });
            const offer = await pc.createOffer();
            await pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp ?? '') });
            await iceGathered(pc, 3000);
            const answered = new Promise<AnswerInit>((resolve, reject) => {
                bridge.answered = (answer, error) => {
                    bridge.answered = null;
                    if (answer) resolve(answer);
                    else reject(new DOMException(error?.message ?? 'no microphone', error?.name ?? 'NotReadableError'));
                };
            });
            send({
                type: 'mic-request', id,
                constraints: typeof constraints.audio === 'object' ? constraints.audio : {},
                offer: { type: 'offer', sdp: pc.localDescription?.sdp ?? '' },
            });
            const answer = await timeout(answered, 20000,
                () => new DOMException(`${cfg!.hostName} did not answer for the microphone`, 'AbortError'));
            if (bridge.released) throw new DOMException('released', 'AbortError');
            await pc.setRemoteDescription(answer);
            const track = await timeout(trackArrived, 10000,
                () => new DOMException('the microphone never arrived', 'NotReadableError'));
            // Chromium hands a remote audio track's samples to Web Audio and to
            // an encoder only while a media element plays it; a MUTED element
            // is enough and outputs nothing (measured on the Deck, 2026-10-22:
            // silence without it, the tone intact with it).
            const sink = new Audio();
            sink.muted = true;
            sink.srcObject = new MediaStream([track]);
            bridge.sink = sink;
            await sink.play().catch(() => { /* muted autoplay is always allowed */ });
            // Hand it over once sound is flowing: Púca treats a microphone that
            // stays muted (no samples) as a lost device.
            if (track.muted) {
                await timeout(new Promise<void>(resolve => track.addEventListener('unmute', () => resolve(), { once: true })),
                    5000, () => new DOMException('the microphone sent nothing', 'NotReadableError'));
            }
            // Púca stops tracks it is done with: that is the plugin's cue to
            // close the capture on its side too.
            const stop = track.stop.bind(track);
            track.stop = () => { stop(); release(id); };
            return new MediaStream([track]);
        } catch (err) {
            release(id);
            if (err instanceof DOMException) throw err;
            throw new DOMException(String((err as Error)?.message ?? err), 'NotReadableError');
        }
    }

    // ---- The screen, for a share -------------------------------------------------
    //
    // The plugin shares only after a press in its own panel; until then the
    // request waits (getDisplayMedia's promise) for its answer. The backend
    // then hands over the picture (shareChunk), which is decoded (WebCodecs)
    // into a track made here (MediaStreamTrackGenerator) that Púca shares
    // like any screen. It starts paused, and whenever the plugin pauses it the
    // track shows a "Paused" card, again every second for viewers who join.

    const SHARE_W = 1280, SHARE_H = 800, SHARE_FPS = 30;
    const Generator = (globalThis as unknown as { MediaStreamTrackGenerator?: TrackGenerator }).MediaStreamTrackGenerator;
    const canShare = typeof Generator === 'function' && typeof VideoDecoder === 'function' && typeof OffscreenCanvas === 'function';
    const shares = new Map<string, Share>();
    const micros = (): number => Math.round(performance.now() * 1000);

    let cardCanvas: OffscreenCanvas | null = null;
    /** The picture while paused. */
    const card = (): VideoFrame => {
        if (!cardCanvas) {
            cardCanvas = new OffscreenCanvas(SHARE_W, SHARE_H);
            const x = cardCanvas.getContext('2d');
            if (x) {
                x.fillStyle = '#18191c';
                x.fillRect(0, 0, SHARE_W, SHARE_H);
                x.textAlign = 'center';
                x.textBaseline = 'middle';
                x.fillStyle = '#f2f3f5';
                x.font = '600 64px sans-serif';
                x.fillText('Paused', SHARE_W / 2, SHARE_H / 2 - 30);
                x.fillStyle = '#b5bac1';
                x.font = '30px sans-serif';
                x.fillText('The game is back in a moment.', SHARE_W / 2, SHARE_H / 2 + 40);
            }
        }
        return new VideoFrame(cardCanvas, { timestamp: micros() });
    };

    const releaseShare = (id: string, tell = true): void => {
        const s = shares.get(id);
        if (!s || s.released) return;
        s.released = true;
        shares.delete(id);
        if (s.answered) s.answered(false, 'released', true);
        if (s.cardTimer) { clearInterval(s.cardTimer); s.cardTimer = null; }
        try { s.decoder?.close(); } catch { /* already closed */ }
        s.decoder = null;
        // Closing the writable ends the track, and Púca hears that as the
        // share's end (measured on the Deck: 'ended' fires).
        const w = s.writer;
        s.writer = null;
        w?.close().catch(() => { /* Púca stopped it first */ });
        if (tell) send({ type: 'share-release', id });
    };

    const write = (id: string, s: Share, frame: VideoFrame): void => {
        const w = s.writer;
        if (!w || s.released || (w.desiredSize !== null && w.desiredSize <= 0)) {
            frame.close();
            return;
        }
        w.write(frame).catch(() => {
            try { frame.close(); } catch { /* closed */ }
            releaseShare(id);  // the track was stopped: Púca is done with it
        });
    };

    const setPaused = (id: string, s: Share, on: boolean): void => {
        s.paused = on;
        if (s.cardTimer) { clearInterval(s.cardTimer); s.cardTimer = null; }
        if (!on) return;
        s.needKey = true;
        write(id, s, card());
        s.cardTimer = setInterval(() => write(id, s, card()), 1000);
    };

    const configure = (id: string, s: Share, codec: string): boolean => {
        try { s.decoder?.close(); } catch { /* already closed */ }
        s.decoder = null;
        try {
            const decoder: VideoDecoder = new VideoDecoder({
                // A frame decoded after a pause began is never shown.
                output: frame => { if (s.paused || s.released) frame.close(); else write(id, s, frame); },
                error: e => {
                    console.warn(`[${cfg!.hostName}] the shared picture could not be decoded:`, e);
                    if (s.decoder === decoder) { s.decoder = null; s.needKey = true; }
                },
            });
            decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
            s.decoder = decoder;
            s.codec = codec;
            return true;
        } catch {
            return false;
        }
    };

    /** One access unit from the backend: true when it was decoded, false when
     *  it was dropped (waiting for a keyframe, behind, paused), null when there
     *  is no such share and the backend should stop. */
    const shareChunk = (id: string, data: string, key: boolean): boolean | null => {
        const s = shares.get(id);
        if (!s || s.released || !s.writer) return null;
        if (s.paused || typeof data !== 'string' || (!key && s.needKey)) return false;
        const bytes = fromBase64(data);
        if (key) {
            const codec = codecOf(bytes);
            if (!codec) return false;
            if ((!s.decoder || s.decoder.state === 'closed' || codec !== s.codec) && !configure(id, s, codec)) return false;
            s.needKey = false;
        } else if (!s.decoder || s.decoder.decodeQueueSize > 3) {
            s.needKey = true;  // behind: wait for the next keyframe rather than fall further back
            return false;
        }
        try {
            s.decoder!.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: micros(), data: bytes }));
            return true;
        } catch {
            s.needKey = true;
            return false;
        }
    };

    async function getDisplayMedia(): Promise<MediaStream> {
        if (!canShare || !Generator) throw new DOMException(`${cfg!.hostName} cannot share the screen here`, 'NotSupportedError');
        const id = `s${Date.now().toString(36)}${(++seq).toString(36)}`;
        const s: Share = { released: false, answered: null, writer: null, decoder: null, codec: null, needKey: true, paused: false, cardTimer: null };
        shares.set(id, s);
        try {
            const answered = new Promise<void>((resolve, reject) => {
                s.answered = (ok, error, refused) => {
                    s.answered = null;
                    if (ok) resolve();
                    // A refusal is the person's answer, like a cancelled
                    // picker; anything else says why it could not start.
                    else reject(new DOMException(error ?? 'not allowed', refused ? 'NotAllowedError' : 'NotReadableError'));
                };
            });
            send({ type: 'share-request', id });
            // The person may be asked in the panel first, and take their time.
            await timeout(answered, 60000,
                () => new DOMException(`${cfg!.hostName} did not answer for the screen`, 'AbortError'));
            if (s.released) throw new DOMException('released', 'AbortError');
            const track = new Generator({ kind: 'video' });
            s.writer = track.writable.getWriter();
            // Paused until the plugin has seen the game alone on screen; and a
            // picture before Púca has the track, which it sizes the share from.
            setPaused(id, s, true);
            // Púca stops a share's tracks when it is done: the plugin's cue to
            // stop the capture on its side too.
            const stop = track.stop.bind(track);
            track.stop = () => { stop(); releaseShare(id); };
            // Chromium 126 reports no size for a generated track (measured on
            // the Deck), and Púca and LiveKit size the share from it.
            const settings = track.getSettings.bind(track);
            track.getSettings = () => ({ ...settings(), width: SHARE_W, height: SHARE_H, frameRate: SHARE_FPS });
            return new MediaStream([track]);
        } catch (err) {
            releaseShare(id);
            if (err instanceof DOMException) throw err;
            throw new DOMException(String((err as Error)?.message ?? err), 'NotReadableError');
        }
    }

    // ---- The declaration Púca reads once, at startup -------------------------

    const declaration = Object.freeze({
        apiVersion: 1,
        name: cfg.hostName,
        getUserMedia,
        // Offered only where this browser can make the track: elsewhere Púca
        // hides its Share button rather than show one that cannot work.
        ...(canShare ? { getDisplayMedia } : {}),
        notify: (notification: unknown) => send({ type: 'notify', notification }),
        onStateChange: (state: unknown) => send({ type: 'state', state }),
        isForeground: () => foreground,
        // Púca's AFK move (docs/EMBEDDING.md): a player's input goes to the
        // game and the Deck's controls, never to this hidden page.
        idleSeconds: () => (lastInputAt === null ? null : Math.max(0, (Date.now() - lastInputAt) / 1000)),
    });
    // Handed to the FIRST reader only (Púca's startup, which keeps its own
    // copy): a script that runs later finds nothing to borrow.
    Object.defineProperty(window, '__PUCA_EMBED_HOST__', {
        configurable: true,
        get() {
            try { delete (window as unknown as Record<string, unknown>).__PUCA_EMBED_HOST__; } catch { /* keep going */ }
            return declaration;
        },
    });

    // ---- What the backend calls ------------------------------------------------

    type Api = Record<string, unknown> & { apiVersion?: number };
    const api = (): Api | null => (window as unknown as { pucaEmbed?: Api }).pucaEmbed ?? null;

    Object.defineProperty(window, '__pucaDeckyShim', {
        configurable: false,
        writable: false,
        value: Object.freeze({
            async call(method: string, args: unknown[]): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
                const a = api();
                if (!a) return { ok: false, error: 'unsupported' };
                const fn = a[method];
                if (typeof fn !== 'function') return { ok: false, error: `no ${method}` };
                try {
                    return { ok: true, value: await (fn as (...x: unknown[]) => unknown).apply(a, Array.isArray(args) ? args : []) };
                } catch (err) {
                    return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) };
                }
            },
            micAnswer(id: string, answer: AnswerInit | null, error: MicError | null): void {
                const b = bridges.get(id);
                if (!b || !b.answered) return;
                if (answer && answer.type === 'answer' && typeof answer.sdp === 'string') b.answered(answer, null);
                else b.answered(null, error && typeof error.name === 'string'
                    ? { name: error.name, message: String(error.message ?? '') }
                    : { name: 'NotReadableError', message: 'no microphone' });
            },
            setForeground(on: boolean): void {
                foreground = on === true;
            },
            /** The Deck's controls are in use now. */
            noteInput(): void {
                lastInputAt = Date.now();
            },
            /** The backend stopped reading them: "cannot tell" again. */
            clearInput(): void {
                lastInputAt = null;
            },
            releaseMics(): void {
                [...bridges.keys()].forEach(release);
            },
            /** The plugin's answer to a share request: yes, or no and why
             *  (`refused`: the person said no). */
            shareAnswer(id: string, ok: boolean, error: string | null, refused: boolean): void {
                const s = shares.get(id);
                if (!s || !s.answered) return;
                s.answered(ok === true, typeof error === 'string' ? error.slice(0, 200) : null, refused !== false);
            },
            shareChunk,
            sharePaused(id: string, on: boolean): void {
                const s = shares.get(id);
                if (s && !s.released && s.writer) setPaused(id, s, on === true);
            },
            /** The plugin stopped the picture: the track ends, and Púca with it. */
            shareEnded(id: string): void {
                releaseShare(id, false);
            },
        }),
    });

    const ready = () => {
        const a = api();
        send({ type: 'ready', apiVersion: typeof a?.apiVersion === 'number' ? a.apiVersion : null, appVersion: '' });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
    else ready();
    window.addEventListener('load', ready, { once: true });
    window.addEventListener('pagehide', () => {
        [...bridges.keys()].forEach(release);
        [...shares.keys()].forEach(id => releaseShare(id));
    });
})();
