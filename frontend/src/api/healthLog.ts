/**
 * `health` — one line a minute in puca.log for as long as you are in a call,
 * followed in the same minute by a `health-send` line while you send video.
 *
 * WHY THIS EXISTS. On 2026-09-25 a call degraded after hours on ONE machine:
 * a watched stream fell to ~0.1 fps and every incoming voice lagged, while
 * everybody else in the call was fine, and restarting the app fixed it. By the
 * time anyone looked, the evidence was gone — the numbers that would have said
 * what drifted (a jitter buffer growing, the page's main thread falling
 * behind, memory creeping, a component re-rendering far too often) exist only
 * inside the page, only while it is happening, and only to somebody with
 * DevTools open. This writes them to the log file instead, so the next time it
 * happens the hours before it are already on disk.
 *
 * WHAT YOU SEND is on its own line, `health-send t=Nmin s=[...]`, next to
 * the `health` line with the same t= (the main line's `s=` gives only the count:
 * `none` when nothing is sent, `?` when it could not be read). Its own line
 * because the native sink keeps the first 2000 characters of each line. For
 * each outgoing video (each
 * simulcast rung on the SFU, each peer on a mesh call), the frame rate chosen,
 * the rung's cap where it binds, what reached the encoder from the capture,
 * what was actually sent, the size sent, WebRTC's adaptation state over the
 * minute, and hardware or software encode; a rung the SFU switched off reads
 * `paused`. A viewer on 2026-09-25 received a steady 22 fps with nothing lost,
 * so the cause was on the STREAMER's machine, and its log could not say
 * whether only 22 frames a second reached the encoder or the encoder dropped
 * some. Now the streamer's health-send line says which (statsSummary.ts
 * videoSendExtras has the reading rules). `lim:` is adaptation (for a share,
 * lowering RESOLUTION to hold frame rate), not an explanation of drops.
 *
 * Both transports: the SFU room when there is one, else the peer-to-peer
 * connections. `?` means neither could be read, never "nothing".
 *
 * WHAT IT COSTS. A 1 s timer (to measure how late timers run), a long-task
 * observer, one windowed getStats pass over watched and SENT video once a
 * minute (the same pass: voiceDiagnostics already reads both), one getStats per
 * incoming voice once a minute, and one log line (two while sending video). No animation
 * frame loop: a rAF counter would itself keep the page painting every frame.
 *
 * WHAT IT DOES NOT CONTAIN. No names, no message content, no addresses —
 * user ids are the pseudonymous numbers the SFU already uses, the same rule as
 * diagnosticsReport.ts.
 */
import { isTauri } from './platform';
import { sfuManager } from './rtc/sfuManager';
import { webrtcManager } from './webrtc';
import { getReplayState } from './clips/replayBuffer';
import type { InboundAudioHealth } from './rtc/statsSummary';

export const HEALTH_INTERVAL_MS = 60_000;
/** The windowed video read (a stream's fps and freezes are rates). */
const VIDEO_WINDOW_MS = 3000;
const LAG_PROBE_MS = 1000;

// ---- render counts --------------------------------------------------------

const renders = new Map<string, number>();
/** Called from a component's body: how often it re-renders is the cheapest
 *  evidence of "the whole app re-renders on every X". */
export function noteRender(name: string): void {
    renders.set(name, (renders.get(name) ?? 0) + 1);
}

// ---- the line -------------------------------------------------------------

export interface VideoIn {
    source: string;
    /** Mesh: a dead copy (a camera switched off, or superseded after off/on). */
    ended?: boolean;
    fps: number | null;
    size: string | null;
    dropped: number | null;
    freezes: number | null;
    freezeMs: number | null;
    jbMs: number | null;
    decodeMs: number | null;
    lost: number | null;
}

/** One outgoing video: one entry per simulcast rung (SFU) or per peer (mesh). */
export interface VideoOut {
    source: string;
    rid: string | null;
    /** Mesh only: the peer this copy is encoded for. */
    peer: string | null;
    /** false: the rung is switched off (the SFU pauses rungs nobody watches). */
    active: boolean | null;
    /** Mesh: the sender's track has ended (a camera switched off keeps its
     *  sender; turning it on again adds a new one). */
    ended: boolean;
    /** Chosen rate, this rung's configured cap, what reached the encoder, what
     *  was sent: where they part says where frames went (statsSummary.ts). */
    setFps: number | null;
    maxFps: number | null;
    captureFps: number | null;
    fps: number | null;
    /** framesEncoded so far: tells "sent 0" (Chromium omits fps when it is 0)
     *  from "unknown". */
    frames: number | null;
    size: string | null;
    /** WebRTC's adaptation state over the minute ('none', 'cpu', 'bandwidth',
     *  'other') and for what share of it. For a share (maintain-framerate) 'cpu'
     *  means the RESOLUTION was lowered; it does not explain dropped frames. */
    limit: string | null;
    limitPct: number | null;
    hw: boolean | null;
    encoder: string | null;
}

export interface HealthInput {
    minutesInCall: number;
    /** null: neither transport could be read (printed `?`, never `none`). */
    video: VideoIn[] | null;
    sending: VideoOut[] | null;
    audio: Array<InboundAudioHealth & { userId: string }>;
    lagAvgMs: number;
    lagMaxMs: number;
    longTasks: number;
    longTaskMs: number;
    heapMB: number | null;
    domNodes: number;
    audioEls: number;
    videoEls: number;
    renders: Array<[string, number]>;
    noise: { mode: string; context: string; dfAvgMs: number | null; dfMaxMs: number | null; overBudget: number | null; dry: number | null; flips: number | null; overloaded: boolean | null } | null;
    clip: { phase: string; fps: number; kbps: number; ringMB: number; dropped: number };
}

const v = (x: number | null | undefined, suffix = ''): string => (x === null || x === undefined ? '?' : `${x}${suffix}`);

/** The outgoing-video detail, or null when there is none to show (the main
 *  line's `s=` then says `none` or `?`). Its OWN line: the native log sink keeps
 *  the first 2000 characters of a line, and one entry per peer per outgoing
 *  video would otherwise push the main line's fixed fields off the end. */
export function formatSendLine(h: HealthInput): string | null {
    if (h.sending === null || h.sending.length === 0) return null;
    const sending = h.sending.map(x => {
        const name = `${x.source}${x.rid ? '/' + x.rid : ''}${x.peer ? '>' + x.peer : ''}`;
        // Mesh: a sender whose track ended (a camera switched off).
        if (x.ended) return `${name}:off`;
        // A rung the SFU switched off: its capture and limit figures belong to
        // the track, not to it, and its missing fps is a pause, not a stall.
        if (x.active === false) return `${name}:paused`;
        const lim = x.limit === null ? 'lim?'
            : x.limitPct === null ? `lim:${x.limit}`
            : x.limit === 'none' ? 'lim:none'
            : `lim:${x.limit}${x.limitPct}%`;
        const enc = `${x.hw === true ? 'hw' : x.hw === false ? 'sw' : 'enc'}:${x.encoder ?? '?'}`;
        // The rung's cap only where it binds (below what was chosen), so a
        // capped rung's lower rate is not read as dropped frames.
        const cap = x.maxFps !== null && (x.setFps === null || x.maxFps < x.setFps) ? ` max${x.maxFps}fps` : '';
        // Chromium omits framesPerSecond when it is 0; with a frame counter
        // present that is a real 0, not an unknown.
        const sent = x.fps !== null ? `${x.fps}fps` : x.frames !== null ? '0fps' : '?';
        return `${name}:set${v(x.setFps, 'fps')}${cap} cap${v(x.captureFps, 'fps')} sent${sent}/${x.size ?? '?'} ${lim} ${enc}`;
    }).join(';');
    return `health-send t=${h.minutesInCall}min s=[${sending}]`;
}

/** Pure: one sample, the main line. Everything a reader needs to see a drift is
 *  in the same place every minute, in the same order: the FIXED-size fields
 *  first, so the per-voice and per-video sections, which grow with the call,
 *  can only ever cut themselves at the sink's 2000-character limit. */
export function formatHealthLine(h: HealthInput): string {
    const video = h.video === null ? '?' : h.video.length === 0 ? 'none' : h.video.map(x => x.ended
        ? `${x.source}:off`
        : `${x.source}:${v(x.fps, 'fps')}/${x.size ?? '?'} drop${v(x.dropped)} frz${v(x.freezes)}/${v(x.freezeMs, 'ms')} jb${v(x.jbMs, 'ms')} dec${v(x.decodeMs, 'ms')} lost${v(x.lost)}`,
    ).join(';');
    // How many outgoing videos the health-send line details.
    const sendCount = h.sending === null ? '?' : h.sending.length === 0 ? 'none' : String(h.sending.length);
    const audio = h.audio.length === 0 ? 'none' : h.audio.map(a =>
        `${a.userId}:jb${v(a.jbMs, 'ms')}/conc${v(a.concealedPct, '%')}/acc${v(a.accelPct, '%')}/dec${v(a.decelPct, '%')}/lost${v(a.lost)}`,
    ).join(',');
    const renderText = h.renders.length === 0 ? 'none' : h.renders.map(([n, c]) => `${n}${c}`).join(',');
    const n = h.noise;
    const noise = n
        ? `nz=${n.mode}/${n.context} df${v(n.dfAvgMs, 'ms')}/${v(n.dfMaxMs, 'ms')} over${v(n.overBudget)} dry${v(n.dry)} flips${v(n.flips)}${n.overloaded ? ' OVERLOADED' : ''}`
        : 'nz=?';
    const c = h.clip;
    return [
        `health t=${h.minutesInCall}min`,
        `page lag${h.lagAvgMs}/${h.lagMaxMs}ms long${h.longTasks}/${h.longTaskMs}ms heap${v(h.heapMB, 'MB')} dom${h.domNodes} audioEl${h.audioEls} videoEl${h.videoEls}`,
        `renders/min ${renderText}`,
        noise,
        `clip=${c.phase}/${c.fps}fps/${c.kbps}kbps/${c.ringMB}MB/drop${c.dropped}`,
        `s=${sendCount}`,
        `a=[${audio}]`,
        `v=[${video}]`,
    ].join(' ');
}

// ---- sampling -------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let observer: PerformanceObserver | null = null;
let startedAt = 0;
let lagSum = 0;
let lagN = 0;
let lagMax = 0;
let longTasks = 0;
let longTaskMs = 0;
let probeDue = 0;

function probe(): void {
    const now = Date.now();
    const late = Math.max(0, now - probeDue);
    lagSum += late;
    lagN++;
    if (late > lagMax) lagMax = late;
    probeDue = now + LAG_PROBE_MS;
    probeTimer = setTimeout(probe, LAG_PROBE_MS);
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function videoInOf(source: string, i: Record<string, unknown>): VideoIn {
    return {
        source,
        ...(i.ended === true && { ended: true }),
        fps: num(i.fps), size: typeof i.size === 'string' ? i.size : null,
        dropped: num(i.framesDropped), freezes: num(i.freezeCount), freezeMs: num(i.freezeMs),
        jbMs: num(i.jitterBufferMs), decodeMs: num(i.decodeMs), lost: num(i.packetsLost),
    };
}

function videoFrom(diag: Record<string, unknown>): VideoIn[] {
    const rows = Array.isArray(diag.remoteRtp) ? (diag.remoteRtp as Array<Record<string, unknown>>) : [];
    const out: VideoIn[] = [];
    for (const row of rows) {
        const lat = row.latency as { inbound?: Array<Record<string, unknown>> } | undefined;
        const i = lat?.inbound?.[0];
        if (!i) continue;
        out.push(videoInOf(String(row.source ?? 'video'), i));
    }
    return out;
}

/** Last minute's cumulative qualityLimitationDurations, per outgoing rung. */
const prevLimits = new Map<string, Record<string, number>>();

/** The worst non-'none' limitation over the MINUTE, from WebRTC's cumulative
 *  seconds-per-reason differenced against the last read. The first read of a
 *  share covers the share so far. Falls back to the instantaneous reason when
 *  there are no durations to difference. */
function limitOver(key: string, durations: unknown, reason: unknown): { limit: string | null; limitPct: number | null } {
    const instant = typeof reason === 'string' ? reason : null;
    if (!durations || typeof durations !== 'object') return { limit: instant, limitPct: null };
    const cur = durations as Record<string, unknown>;
    let prev = prevLimits.get(key) ?? {};
    // One sender's counters only ever rise. Any that fell means this is not the
    // sender the baseline came from: start from zero rather than clamp each
    // reason, which would measure the minute against a truncated total.
    if (Object.entries(cur).some(([k, x]) => typeof x === 'number' && x < (prev[k] ?? 0))) prev = {};
    const next: Record<string, number> = {};
    let total = 0;
    let worst: [string, number] = ['none', 0];
    for (const [k, raw] of Object.entries(cur)) {
        const secs = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
        next[k] = secs;
        const d = secs - (prev[k] ?? 0);
        total += d;
        if (k !== 'none' && d > worst[1]) worst = [k, d];
    }
    prevLimits.set(key, next);
    if (total <= 0) return { limit: instant, limitPct: null };
    return worst[1] > 0
        ? { limit: worst[0], limitPct: Math.round((worst[1] / total) * 100) }
        : { limit: 'none', limitPct: 0 };
}

/** One outgoing video row (SFU localRtp, or a mesh peer's outbound rtp row)
 *  into a VideoOut. The limit baseline is keyed by the SENDER (its ssrc): a
 *  restarted share, a camera flip or a reconnect is a new sender whose counters
 *  start at zero, and must never be differenced against the old one's. */
function videoOut(r: Record<string, unknown>, peer: string | null, seen: Set<string>): VideoOut {
    const round = (x: unknown) => { const n = num(x); return n === null ? null : Math.round(n); };
    const source = String(r.source ?? 'video');
    const rid = typeof r.rid === 'string' ? r.rid : null;
    const key = `${source}/${rid ?? ''}/${peer ?? ''}/${typeof r.ssrc === 'number' ? r.ssrc : ''}`;
    seen.add(key);
    return {
        source, rid, peer,
        active: typeof r.active === 'boolean' ? r.active : null,
        ended: r.ended === true,
        setFps: round(r.setFps), maxFps: round(r.maxFps), captureFps: round(r.captureFps), fps: round(r.fps),
        frames: num(r.frames),
        size: typeof r.size === 'string' ? r.size : null,
        ...limitOver(key, r.limitDurations, r.limit),
        hw: typeof r.hwEncoder === 'boolean' ? r.hwEncoder : null,
        encoder: typeof r.encoder === 'string' ? shortEncoder(r.encoder) : null,
    };
}

/** "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)" is 64
 *  characters per entry; the part in brackets names the encoder. */
function shortEncoder(name: string): string {
    const m = /\(([^()]+)\)\s*$/.exec(name);
    return m ? m[1] : name;
}

/** Forget baselines of senders that are gone, so the map cannot grow for the
 *  length of a call and a stopped share's totals never linger. */
function pruneLimits(seen: Set<string>): void {
    for (const k of [...prevLimits.keys()]) if (!seen.has(k)) prevLimits.delete(k);
}

function sendingFromSfu(diag: Record<string, unknown>): VideoOut[] {
    const rows = Array.isArray(diag.localRtp) ? (diag.localRtp as Array<Record<string, unknown>>) : [];
    const seen = new Set<string>();
    const out = rows.filter(r => r.kind === 'video').map(r => videoOut(r, null, seen));
    pruneLimits(seen);
    return out;
}

/** Mesh: every peer connection's outgoing video rows, and incoming video. */
function fromMesh(peers: Array<Record<string, unknown>>): { video: VideoIn[]; sending: VideoOut[] } {
    const seen = new Set<string>();
    const video: VideoIn[] = [];
    const sending: VideoOut[] = [];
    for (const p of peers) {
        const peer = String(p.userId ?? '?');
        const rtp = Array.isArray(p.rtp) ? (p.rtp as Array<Record<string, unknown>>) : [];
        for (const r of rtp) {
            if (r.dir === 'outbound-rtp' && r.kind === 'video') sending.push(videoOut(r, peer, seen));
        }
        const lat = p.latency as { inbound?: Array<Record<string, unknown>> } | null | undefined;
        // `<peer`: received FROM that peer (s= uses `>peer`: sent TO it).
        for (const i of lat?.inbound ?? []) video.push(videoInOf(`${typeof i.source === 'string' ? i.source : 'video'}<${peer}`, i));
    }
    pruneLimits(seen);
    return { video, sending };
}

function noiseFrom(diag: Record<string, unknown> | null): HealthInput['noise'] {
    const nz = diag?.noise as Record<string, unknown> | undefined;
    if (!nz) return null;
    const df = nz.deepFilter as { worker?: Record<string, unknown>; worklet?: Record<string, unknown> } | undefined;
    const w = df?.worker ?? {};
    const k = df?.worklet ?? {};
    const round1 = (x: unknown) => { const n = num(x); return n === null ? null : Math.round(n * 10) / 10; };
    return {
        mode: String(nz.mode ?? '?'), context: String(nz.contextState ?? '?'),
        dfAvgMs: round1(w.avgMs), dfMaxMs: round1(w.maxMs), overBudget: num(w.overBudgetHops),
        dry: num(k.dryDelta), flips: num(k.flipsDelta), overloaded: typeof k.overloaded === 'boolean' ? k.overloaded : null,
    };
}

/** Gathers one sample, formats it, and resets the per-minute counters. */
export async function sampleHealth(): Promise<string> {
    let diag: Record<string, unknown> | null = null;
    try { diag = await sfuManager.voiceDiagnostics(VIDEO_WINDOW_MS); } catch { /* no SFU call */ }
    // The SFU room when there is one; else the peer-to-peer connections. When
    // neither can be read the video sections say `?`, never `none`.
    let video: VideoIn[] | null = null;
    let sending: VideoOut[] | null = null;
    if (diag?.connected === true) {
        video = videoFrom(diag);
        sending = sendingFromSfu(diag);
    } else {
        try {
            const mesh = await webrtcManager.meshDiagnostics(VIDEO_WINDOW_MS);
            ({ video, sending } = fromMesh(mesh));
        } catch { /* neither transport readable: stays null */ }
    }
    let audio: Array<InboundAudioHealth & { userId: string }> = [];
    try { audio = await sfuManager.inboundAudioHealth(); } catch { /* none */ }
    if (audio.length === 0) {
        try { audio = await webrtcManager.inboundAudioHealth(); } catch { /* none */ }
    }
    const mem = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    const r = getReplayState();
    const input: HealthInput = {
        minutesInCall: startedAt ? Math.round((Date.now() - startedAt) / 60_000) : 0,
        video,
        sending,
        audio,
        lagAvgMs: lagN ? Math.round(lagSum / lagN) : 0,
        lagMaxMs: Math.round(lagMax),
        longTasks,
        longTaskMs: Math.round(longTaskMs),
        heapMB: mem?.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1_048_576) : null,
        domNodes: document.getElementsByTagName('*').length,
        audioEls: document.getElementsByTagName('audio').length,
        videoEls: document.getElementsByTagName('video').length,
        renders: [...renders.entries()].sort(),
        noise: noiseFrom(diag),
        clip: {
            phase: r.phase, fps: Math.round(r.fps ?? 0), kbps: Math.round(r.kbps ?? 0),
            ringMB: Math.round((r.ringBytes ?? 0) / 1_048_576), dropped: r.droppedFrames ?? 0,
        },
    };
    const line = [formatHealthLine(input), formatSendLine(input)].filter(Boolean).join('\n');
    lagSum = 0; lagN = 0; lagMax = 0; longTasks = 0; longTaskMs = 0;
    renders.clear();
    return line;
}

let chain: Promise<void> = Promise.resolve();
function send(text: string): void {
    // One log entry per line: the sample may carry a health-send line too.
    for (const line of text.split('\n')) sendOne(line);
}

function sendOne(line: string): void {
    chain = chain.then(async () => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('log_stream_diag', { line });
        } catch { /* best effort: a missed minute is a gap, not a failure */ }
    });
}

/** Settle point for tests. */
export function healthLogSettled(): Promise<void> { return chain; }
export function healthLogRunning(): boolean { return timer !== null; }

/** Starts the minute line (desktop only — the log file is the shell's).
 *  Idempotent: a second start while running changes nothing. */
export function startHealthLog(): void {
    if (timer !== null || !isTauri()) return;
    startedAt = Date.now();
    lagSum = 0; lagN = 0; lagMax = 0; longTasks = 0; longTaskMs = 0;
    renders.clear();
    prevLimits.clear();
    probeDue = Date.now() + LAG_PROBE_MS;
    probeTimer = setTimeout(probe, LAG_PROBE_MS);
    try {
        observer = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) { longTasks++; longTaskMs += e.duration; }
        });
        observer.observe({ type: 'longtask', buffered: false });
    } catch { observer = null; /* no long-task timing in this engine */ }
    send('health started');
    timer = setInterval(() => { void sampleHealth().then(send); }, HEALTH_INTERVAL_MS);
}

export function stopHealthLog(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    if (probeTimer !== null) clearTimeout(probeTimer);
    probeTimer = null;
    observer?.disconnect();
    observer = null;
    send('health stopped');
}
