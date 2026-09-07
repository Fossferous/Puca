/**
 * Background sampler for outbound-share health, for the "stream is laggy
 * above 60fps" investigation ([[puca-game-choppiness-0820]] in the
 * operator's notes) — WITHOUT DevTools focus.
 *
 * `__pucaMeshDiag()` / `__pucaVoiceDiag()` need a human at DevTools
 * to read them, and the bug only shows up while a FULLSCREEN GAME holds
 * focus — the one moment DevTools cannot be opened without tabbing out of
 * the game, which is the very thing being diagnosed. So this samples both
 * transports on a timer and writes each sample to the app's own log file via
 * a Tauri command, unattended, for the whole life of any WATCHED capture
 * (same lifecycle as streamBoost.ts's priority boost — voice screen share,
 * device-control host capture). Recoverable afterward from
 * %LOCALAPPDATA%\com.sovereign.chat\logs\puca.log — no focus required
 * at the moment that matters.
 *
 * HOLDER-KEYED, same idiom as captureBar.ts / streamBoost.ts, and its own
 * independent Set: this samples on live human curiosity about a REPORTED bug,
 * not "is a screen being captured" (the clip ring uses that phrasing but
 * intentionally sits outside this and the boost — nobody watches it live).
 */
import { isTauri } from './platform';
import { webrtcManager } from './webrtc';
import { sfuManager } from './rtc/sfuManager';
import { formatLatencyLine, type RtcLatencySummary } from './rtc/statsSummary';

/** Cadence while only a capture is held; a keyframe-triggered pacer spike
 *  lasts a few hundred ms and is invisible at 0.2 Hz, so a live remote-
 *  control session (an `rc-*` holder) samples every second instead. */
let sampling = false;
const SAMPLE_MS = 5000;
const SAMPLE_RC_MS = 1000;
const holders = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
let timerMs = 0;

/** Extra text for every sample — remoteControl installs one that names the
 *  live sessions and the pipe their input is on. Null = nothing to add. */
let probe: (() => string | null) | null = null;
export function setStreamDiagProbe(fn: (() => string | null) | null): void {
    probe = fn;
}

// Serialize the log lines onto one chain (same idiom as streamBoost.ts): each
// send() appends to whatever `chain` currently is, so the start marker, every
// sample, and the end marker land in the file in the order they were
// generated even though each write is itself an async IPC call. Also gives
// tests a settle point (streamDiagSettled) instead of racing microtasks.
let chain: Promise<void> = Promise.resolve();

function send(line: string): void {
    chain = chain.then(async () => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('log_stream_diag', { line });
        } catch {
            /* best effort — a missed sample just means a gap in the log */
        }
    });
}

function fmt(entry: Record<string, unknown>): string {
    const parts = [`fps=${entry.fps ?? '?'}`];
    if (entry.limit !== undefined) parts.push(`limit=${entry.limit}`);
    if (entry.encoder !== undefined) parts.push(`encoder=${entry.encoder}`);
    if (entry.rid) parts.push(`rid=${entry.rid}`);
    return parts.join(' ');
}

/** The delay fields (statsSummary shape) a diagnostics row carries, if any. */
function latencyOf(row: unknown): RtcLatencySummary | null {
    const l = (row as { latency?: RtcLatencySummary } | null)?.latency;
    return l && (l.inbound.length || l.outbound.length || l.pair) ? l : null;
}

/** One sampling tick across both transports — exported so a test can drive it
 *  directly instead of racing the interval timer. */
export async function sampleOnce(): Promise<void> {
    if (sampling) return; // a windowed tick outran its own cadence; skip, don't stack
    sampling = true;
    try {
        await sampleOnceInner();
    } finally {
        sampling = false;
    }
}

/** How long each tick watches for, to turn counters into a RATE. */
export function sampleWindowMs(cadenceMs: number): number {
    // Comfortably inside the cadence, because the two transports are sampled
    // concurrently and each holds its window open. Floor so the slowest useful
    // cadence still measures something real rather than a rounding artefact.
    return Math.max(250, Math.round(cadenceMs * 0.6));
}

async function sampleOnceInner(): Promise<void> {
    const lines: string[] = [];
    // FIRST: the native sink caps a line at 2000 chars, and a large mesh
    // call's rows can exceed that — the one fragment that must never be the
    // one cut off is which pipe the input is on.
    const extra = probe?.() ?? null;
    if (extra) lines.push(extra);

    // WINDOWED, NOT CUMULATIVE. Both helpers return counters since the track
    // started unless they are given a window, and this asked for neither — so
    // every jb=, proc=, freeze= and lost= ever written to this log was a
    // LIFETIME MEAN, not the second it was printed beside. A buffer that grew
    // 51ms -> 88ms across a session logged a number that was never the current
    // one, and the whole point of a 1 Hz sampler is to see a spike when it
    // happens. Sampled concurrently so two windows cost one window of wall
    // clock, which is what lets the window fit inside the tick.
    const win = sampleWindowMs(wantedMs());
    const [mesh, sfu] = await Promise.all([
        webrtcManager.meshDiagnostics(win),
        sfuManager.voiceDiagnostics(win),
    ]);

    for (const peer of mesh) {
        const userId = (peer as { userId?: unknown }).userId;
        for (const r of (peer as { rtp?: Record<string, unknown>[] }).rtp ?? []) {
            if (r.dir === 'outbound-rtp' && r.kind === 'video') {
                lines.push(`mesh peer=${userId} ${fmt(r)}`);
            }
        }
        // The delay fields, both directions — a VIEWER's inbound share is
        // what a "control feels a second behind" report is about, and the
        // sender-only line above had nothing to say about it.
        const lat = latencyOf(peer);
        if (lat) lines.push(`mesh peer=${userId} ${formatLatencyLine(lat)}`);
    }

    for (const r of (sfu as { localRtp?: Record<string, unknown>[] }).localRtp ?? []) {
        if (r.kind === 'video') lines.push(`sfu source=${r.source} ${fmt(r)}`);
    }
    for (const r of (sfu as { remoteRtp?: Record<string, unknown>[] }).remoteRtp ?? []) {
        const lat = latencyOf(r);
        if (lat) lines.push(`sfu peer=${r.userId} source=${r.source} ${formatLatencyLine(lat)}`);
    }

    // Log the empty tick too — silence here is itself informative: it means
    // neither transport sees an outbound video track at all, which would
    // point away from encode starvation and toward the capture never having
    // started.
    send(lines.length > 0 ? lines.join(' | ') : '(no outbound video track)');
}

function wantedMs(): number {
    for (const h of holders) if (h.startsWith('rc-')) return SAMPLE_RC_MS;
    return SAMPLE_MS;
}

/** (Re)arm the interval at the cadence the current holders want. */
function retime(): void {
    const ms = wantedMs();
    if (timer && timerMs === ms) return;
    if (timer) clearInterval(timer);
    timerMs = ms;
    timer = setInterval(() => void sampleOnce(), ms);
}

/** Start sampling on behalf of `holder` (idempotent per holder). */
export function holdStreamDiag(holder: string): void {
    if (!isTauri()) return;
    const wasEmpty = holders.size === 0;
    holders.add(holder);
    if (wasEmpty) {
        send('=== stream-diag session start ===');
        void sampleOnce();
    }
    retime();
}

/** Release `holder`; sampling stops only when no holder remains. */
export function releaseStreamDiag(holder: string): void {
    if (!holders.delete(holder)) return;
    if (holders.size > 0) { retime(); return; }
    if (timer) { clearInterval(timer); timer = null; timerMs = 0; }
    send('=== stream-diag session end ===');
}

/** Test hook: the cadence the sampler is currently running at (0 = off). */
export function streamDiagIntervalMs(): number {
    return timer ? timerMs : 0;
}

/** Test/diagnostic hook: which holders currently keep the sampler running. */
export function streamDiagHolders(): string[] {
    return [...holders];
}

/** Test hook: await all in-flight log writes (sends are fire-and-forget). */
export function streamDiagSettled(): Promise<void> {
    return chain;
}
