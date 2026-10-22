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
 * Built on its own (rollup.config.js) into dist/page-shim.js: no imports.
 */

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

    // ---- The declaration Púca reads once, at startup -------------------------

    const declaration = Object.freeze({
        apiVersion: 1,
        name: cfg.hostName,
        getUserMedia,
        notify: (notification: unknown) => send({ type: 'notify', notification }),
        onStateChange: (state: unknown) => send({ type: 'state', state }),
        isForeground: () => foreground,
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
            releaseMics(): void {
                [...bridges.keys()].forEach(release);
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
    window.addEventListener('pagehide', () => [...bridges.keys()].forEach(release));
})();
