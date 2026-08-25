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

const SAMPLE_MS = 5000;
const holders = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

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

/** One sampling tick across both transports — exported so a test can drive it
 *  directly instead of racing the interval timer. */
export async function sampleOnce(): Promise<void> {
    const lines: string[] = [];

    for (const peer of await webrtcManager.meshDiagnostics()) {
        for (const r of (peer as { rtp?: Record<string, unknown>[] }).rtp ?? []) {
            if (r.dir === 'outbound-rtp' && r.kind === 'video') {
                lines.push(`mesh peer=${(peer as { userId?: unknown }).userId} ${fmt(r)}`);
            }
        }
    }

    const sfu = await sfuManager.voiceDiagnostics();
    for (const r of (sfu as { localRtp?: Record<string, unknown>[] }).localRtp ?? []) {
        if (r.kind === 'video') lines.push(`sfu source=${r.source} ${fmt(r)}`);
    }

    // Log the empty tick too — silence here is itself informative: it means
    // neither transport sees an outbound video track at all, which would
    // point away from encode starvation and toward the capture never having
    // started.
    send(lines.length > 0 ? lines.join(' | ') : '(no outbound video track)');
}

/** Start sampling on behalf of `holder` (idempotent per holder). */
export function holdStreamDiag(holder: string): void {
    if (!isTauri()) return;
    const wasEmpty = holders.size === 0;
    holders.add(holder);
    if (!wasEmpty || holders.size === 0) return;
    send('=== stream-diag session start ===');
    void sampleOnce();
    timer = setInterval(() => void sampleOnce(), SAMPLE_MS);
}

/** Release `holder`; sampling stops only when no holder remains. */
export function releaseStreamDiag(holder: string): void {
    if (!holders.delete(holder)) return;
    if (holders.size > 0) return;
    if (timer) { clearInterval(timer); timer = null; }
    send('=== stream-diag session end ===');
}

/** Test/diagnostic hook: which holders currently keep the sampler running. */
export function streamDiagHolders(): string[] {
    return [...holders];
}

/** Test hook: await all in-flight log writes (sends are fire-and-forget). */
export function streamDiagSettled(): Promise<void> {
    return chain;
}
