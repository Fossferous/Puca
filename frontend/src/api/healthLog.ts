/**
 * `health` — one line a minute in puca.log for as long as you are in a call.
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
 * WHAT IT COSTS. A 1 s timer (to measure how late timers run), a long-task
 * observer, one windowed getStats pass over watched VIDEO once a minute, one
 * getStats per incoming voice once a minute, and one log line. No animation
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
    fps: number | null;
    size: string | null;
    dropped: number | null;
    freezes: number | null;
    freezeMs: number | null;
    jbMs: number | null;
    decodeMs: number | null;
    lost: number | null;
}

export interface HealthInput {
    minutesInCall: number;
    video: VideoIn[];
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

/** Pure: one sample, one line. Everything a reader needs to see a drift is in
 *  the same place every minute, in the same order. */
export function formatHealthLine(h: HealthInput): string {
    const video = h.video.length === 0 ? 'none' : h.video.map(x =>
        `${x.source}:${v(x.fps, 'fps')}/${x.size ?? '?'} drop${v(x.dropped)} frz${v(x.freezes)}/${v(x.freezeMs, 'ms')} jb${v(x.jbMs, 'ms')} dec${v(x.decodeMs, 'ms')} lost${v(x.lost)}`,
    ).join(';');
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
        `v=[${video}]`,
        `a=[${audio}]`,
        `page lag${h.lagAvgMs}/${h.lagMaxMs}ms long${h.longTasks}/${h.longTaskMs}ms heap${v(h.heapMB, 'MB')} dom${h.domNodes} audioEl${h.audioEls} videoEl${h.videoEls}`,
        `renders/min ${renderText}`,
        noise,
        `clip=${c.phase}/${c.fps}fps/${c.kbps}kbps/${c.ringMB}MB/drop${c.dropped}`,
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

function videoFrom(diag: Record<string, unknown> | null): VideoIn[] {
    const rows = Array.isArray(diag?.remoteRtp) ? (diag!.remoteRtp as Array<Record<string, unknown>>) : [];
    const out: VideoIn[] = [];
    for (const row of rows) {
        const lat = row.latency as { inbound?: Array<Record<string, unknown>> } | undefined;
        const i = lat?.inbound?.[0];
        if (!i) continue;
        out.push({
            source: String(row.source ?? 'video'),
            fps: num(i.fps), size: typeof i.size === 'string' ? i.size : null,
            dropped: num(i.framesDropped), freezes: num(i.freezeCount), freezeMs: num(i.freezeMs),
            jbMs: num(i.jitterBufferMs), decodeMs: num(i.decodeMs), lost: num(i.packetsLost),
        });
    }
    return out;
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
    let audio: Array<InboundAudioHealth & { userId: string }> = [];
    try { audio = await sfuManager.inboundAudioHealth(); } catch { /* none */ }
    if (audio.length === 0) {
        try { audio = await webrtcManager.inboundAudioHealth(); } catch { /* none */ }
    }
    const mem = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    const r = getReplayState();
    const line = formatHealthLine({
        minutesInCall: startedAt ? Math.round((Date.now() - startedAt) / 60_000) : 0,
        video: videoFrom(diag),
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
    });
    lagSum = 0; lagN = 0; lagMax = 0; longTasks = 0; longTaskMs = 0;
    renders.clear();
    return line;
}

let chain: Promise<void> = Promise.resolve();
function send(line: string): void {
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
