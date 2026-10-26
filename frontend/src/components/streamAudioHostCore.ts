/**
 * StreamAudioHost's engine: how every watched stream sounds wherever the
 * stage is not mounted. Kept apart from React and the app's stores (it is
 * handed them, HostDeps) so a real browser can run it exactly as it is:
 * e2e/stream-audio-gain-real-browser.mjs.
 *
 * One hidden <audio> per watched stream (the host renders them), bound to an
 * audio-only MediaStream of that stream's tracks. What SOUNDS is a Web Audio
 * graph per stream, like the stage's: that stream's own source node(s) into
 * its OWN GainNode — never shared, so one stream's level never moves another
 * — on one context routed to Settings > Output Device. Its gain is the
 * stream's level on the loudness curve times Output Volume, NOT capped, so a
 * boost above 100% plays here as it does on the stage; and on an iPhone or
 * iPad, where a page cannot set an element's volume, the level and Output
 * Volume apply at last. Stream Attenuation does NOT duck it: that stays the
 * big stream view's, as it always was (the owner, 2026-10-26: "Big view
 * only, as before").
 *
 * The <audio> stays bound, playing and MUTED: Chromium (the desktop app's
 * engine) feeds remote WebRTC audio into Web Audio only while a media element
 * has remote audio bound. Measured 2026-10-26 on a loopback call: in Edge and
 * Chromium a graph with no such element is digital silence, one with a muted
 * <audio> carries the full signal (paused too), and with every element
 * unbound it is silent again — any one bound element kept every remote track
 * flowing, so each stream keeps its own and none depends on another's.
 * Firefox needs none.
 *
 * Where Web Audio cannot play — no AudioContext, one that throws, one that is
 * not running (an autoplay policy before the first tap; 'interrupted' on an
 * iPhone after a phone call), one whose switch to the chosen output device
 * has not landed, one that cannot follow the chosen device at all (Firefox and
 * Safari have no AudioContext.setSinkId: a graph there would play on the OS
 * default while the routed <audio> sat muted) — a stream plays through its
 * <audio> exactly as before this graph existed: unmuted once THAT element's
 * routing has landed, at min(gain, 1), no ducking. Every pass resumes a
 * context that is not running (a tap is a pass: StreamAudioHost runs one on
 * each gesture), and the streams move onto the graph as soon as it runs.
 *
 * The stage's claim (streamAudioRouting.ts) arrives as a pass whose plan is
 * inaudible: every gain goes to 0 and every element is muted, in that task.
 */
import type { StreamAudioEntry } from './streamAudioRouting';

export interface HostDeps {
    /** One entry per watched stream that may sound here (never your own). */
    plan: () => StreamAudioEntry[];
    /** The watched stream's source, by user id. */
    sourceOf: (userId: number) => MediaStream | null | undefined;
    /** Every watched user id (their sources' track events are followed). */
    watched: () => readonly number[];
    /** Route an element, or the context, to the chosen Output Device. */
    routeElement: (el: HTMLAudioElement) => Promise<void>;
    routeContext: (ctx: AudioContext) => Promise<void>;
    /** Can `ctx` play on the chosen Output Device (settingsStore's
     *  contextFollowsOutputDevice)? Read once per pass. */
    followsOutputDevice: (ctx: AudioContext) => boolean;
    /** A new AudioContext; may throw where Web Audio is missing. */
    createContext: () => AudioContext;
}

/** Which path carries a stream's sound right now. */
export type StreamAudioPath = 'graph' | 'element';

interface Graph {
    gain: GainNode;
    sources: AudioNode[];
    /** The audio tracks the sources read, as one key. */
    key: string;
    /** The value the gain was last aimed at. */
    target: number;
    /** Its tracks could not be read into Web Audio: the element plays it. */
    failed: boolean;
}

/** Bind exactly the source stream's audio tracks; rebind only on a change
 *  (a fresh srcObject restarts playback, so never on every pass). */
export function syncTracks(el: HTMLAudioElement, source: MediaStream | null | undefined): boolean {
    const want = source?.getAudioTracks?.() ?? [];
    const bound = el.srcObject as MediaStream | null;
    const have = bound?.getAudioTracks?.() ?? [];
    if (have.length === want.length && want.every(t => have.includes(t))) return false;
    if (want.length === 0) {
        el.srcObject = null;
        return true;
    }
    const audioOnly = new MediaStream();
    for (const t of want) audioOnly.addTrack(t);
    el.srcObject = audioOnly;
    return true;
}

const quiet = (p: Promise<unknown> | undefined | void) => {
    void Promise.resolve(p).catch(() => { /* reported by the next pass, or by nothing */ });
};

/**
 * The host's imperative core, one per mounted host. Synchronous on purpose:
 * the stage's claim must silence everything here within its own task.
 */
export function createHostController(deps: HostDeps) {
    // The rendered container, handed over after every commit (attach).
    let container: HTMLDivElement | null = null;
    // Elements whose first Output Device routing has LANDED (may unmute).
    const routed = new WeakSet<HTMLAudioElement>();
    // Elements already handed to routing (a re-render must not re-route).
    const known = new WeakSet<HTMLAudioElement>();
    // addtrack/removetrack listeners per source stream.
    const sources = new Map<number, MediaStream>();

    // The Web Audio side: ONE context, one graph per stream.
    let ctx: AudioContext | null = null;
    let ctxRouted = false;
    let webAudioBroken = false;
    // The context can play on the chosen device (read once per pass).
    let followsDevice = true;
    const graphs = new Map<number, Graph>();
    const paths = new Map<number, StreamAudioPath>();

    const elements = () => [
        ...(container?.querySelectorAll<HTMLAudioElement>('audio[data-stream-audio]') ?? []),
    ];

    const live = () => !webAudioBroken && ctx !== null && ctxRouted && followsDevice && ctx.state === 'running';

    function disconnect(g: Graph) {
        for (const s of g.sources) {
            try { s.disconnect(); } catch { /* already gone */ }
        }
        try { g.gain.disconnect(); } catch { /* already gone */ }
    }

    function closeContext() {
        for (const g of graphs.values()) disconnect(g);
        graphs.clear();
        const c = ctx;
        ctx = null;
        ctxRouted = false;
        if (c) {
            c.onstatechange = null;
            try { quiet(c.close?.()); } catch { /* already closed */ }
        }
    }

    function ensureContext() {
        if (webAudioBroken) return;
        // Closed from outside (the platform, a crash of the audio service):
        // its nodes are dead, and a graph kept from it would be a silent
        // stream. Drop them all before making the next.
        if (ctx && ctx.state === 'closed') closeContext();
        if (!ctx) {
            let made: AudioContext;
            try {
                made = deps.createContext();
            } catch {
                webAudioBroken = true; // no Web Audio here: the elements carry it all
                return;
            }
            ctx = made;
            ctxRouted = false;
            made.onstatechange = () => { if (ctx === made) reconcile(); };
            // Born on the OS default: nothing joins the speakers before the
            // chosen device is in place (routeContext never rejects).
            quiet(deps.routeContext(made).then(() => {
                if (ctx !== made) return;
                ctxRouted = true;
                reconcile();
            }));
        }
        // 'suspended' (an autoplay policy) and Safari's 'interrupted' (a phone
        // call) both resume; allowed inside a gesture, refused (and harmless)
        // outside one.
        if (ctx.state !== 'running' && ctx.state !== 'closed') {
            try { quiet(ctx.resume?.()); } catch { /* the next gesture */ }
        }
    }

    /** Aim a graph's gain, at once, like an element's volume and mute: a
     *  claim must silence it in its own task, never overlap the stage. */
    function aim(g: Graph, target: number) {
        if (target === g.target) return;
        const p = g.gain.gain;
        p.cancelScheduledValues?.(ctx?.currentTime ?? 0);
        p.value = target;
        g.target = target;
    }

    /** Carry `userId`'s stream on its own graph at `target`. False: it cannot,
     *  and its element must. */
    function carry(userId: number, tracks: MediaStreamTrack[], target: number): boolean {
        const c = ctx;
        if (!c) return false;
        let g = graphs.get(userId);
        if (!g) {
            try {
                const gain = c.createGain();
                gain.gain.value = 0;
                gain.connect(c.destination);
                g = { gain, sources: [], key: '', target: 0, failed: false };
                graphs.set(userId, g);
            } catch {
                // No gain stage at all: this engine's Web Audio is unusable.
                webAudioBroken = true;
                closeContext();
                return false;
            }
        }
        const key = tracks.map(t => t.id).sort().join('\n');
        if (key !== g.key) {
            for (const s of g.sources) {
                try { s.disconnect(); } catch { /* already gone */ }
            }
            g.sources = [];
            g.key = key;
            g.failed = false;
            try {
                for (const t of tracks) {
                    // Built track by track, not `new MediaStream([t])`, the
                    // way syncTracks binds the element.
                    const one = new MediaStream();
                    one.addTrack(t);
                    const s = c.createMediaStreamSource(one);
                    s.connect(g.gain);
                    g.sources.push(s);
                }
            } catch {
                for (const s of g.sources) {
                    try { s.disconnect(); } catch { /* already gone */ }
                }
                g.sources = [];
                g.failed = true;
            }
        }
        if (g.failed) {
            aim(g, 0);
            return false;
        }
        aim(g, target);
        return true;
    }

    const reconcile = () => {
        const list = deps.plan();
        const entries = new Map(list.map(e => [e.userId, e]));
        const els = elements();
        if (list.length === 0 && els.length === 0) {
            // Nothing watched: let the audio device go. A context that could
            // not be made (or used) is tried again the next time: a refusal
            // can be passing (Safari caps how many may exist at once).
            closeContext();
            paths.clear();
            webAudioBroken = false;
            return;
        }
        if (list.length > 0) ensureContext();
        followsDevice = ctx ? deps.followsOutputDevice(ctx) : true;
        const seen = new Set<number>();
        for (const el of els) {
            const userId = Number(el.dataset.streamAudio);
            seen.add(userId);
            const entry = entries.get(userId);
            const source = deps.sourceOf(userId);
            const rebound = syncTracks(el, source);
            const tracks = source?.getAudioTracks?.() ?? [];
            const target = entry && entry.audible ? entry.gain : 0;
            const viaGraph = !!entry && live() && carry(userId, tracks, target);
            if (!viaGraph) {
                const g = graphs.get(userId);
                if (g) aim(g, 0);
            }
            paths.set(userId, viaGraph ? 'graph' : 'element');
            if (viaGraph) {
                el.muted = true; // the sink: bound and playing, never what sounds
            } else {
                el.muted = !entry || !entry.audible || !routed.has(el);
                if (entry) el.volume = entry.volume;
            }
            const sounding = viaGraph || !el.muted;
            if (el.srcObject && (rebound || (sounding && el.paused))) {
                el.play().catch(() => { /* autoplay policy: retried on the next pass */ });
            }
        }
        for (const [id, g] of graphs) {
            if (seen.has(id)) continue;
            disconnect(g);
            graphs.delete(id);
            paths.delete(id);
        }
    };

    const route = (el: HTMLAudioElement) => {
        void deps.routeElement(el).then(() => {
            routed.add(el);
            reconcile();
        });
    };

    const onTracks = () => reconcile();
    const unfollow = (src: MediaStream) => {
        src.removeEventListener?.('addtrack', onTracks);
        src.removeEventListener?.('removetrack', onTracks);
    };
    const followSources = () => {
        const watched = deps.watched();
        for (const [id, src] of sources) {
            if (deps.sourceOf(id) === src && watched.includes(id)) continue;
            unfollow(src);
            sources.delete(id);
        }
        for (const id of watched) {
            const src = deps.sourceOf(id);
            if (!src || sources.get(id) === src) continue;
            src.addEventListener?.('addtrack', onTracks);
            src.addEventListener?.('removetrack', onTracks);
            sources.set(id, src);
        }
    };

    return {
        attach: (el: HTMLDivElement | null) => { container = el; },
        elements,
        reconcile,
        followSources,
        /** After a commit: route elements that just appeared (they stay
         *  muted until routed), then apply the plan to all of them. */
        adopt: () => {
            for (const el of elements()) {
                if (known.has(el)) continue;
                known.add(el);
                el.muted = true;
                route(el);
            }
            reconcile();
        },
        rerouteAll: () => {
            for (const el of elements()) route(el);
            if (ctx && ctx.state !== 'closed') quiet(deps.routeContext(ctx));
        },
        /** Which path carries `userId`'s sound (diagnostics and tests). */
        path: (userId: number): StreamAudioPath | null => paths.get(userId) ?? null,
        dispose: () => {
            for (const src of sources.values()) unfollow(src);
            sources.clear();
            closeContext();
            paths.clear();
        },
    };
}

export type HostController = ReturnType<typeof createHostController>;
