/**
 * Púca Notes — the pure side of a voice note: which container this browser
 * can record, how long and how large a clip may be, and turning a recorded
 * clip into the raw mono PCM the phone's on-device recogniser wants.
 *
 * No DOM ownership and no network: the recorder component (AudioRecorder.tsx)
 * owns the microphone, api/noteMedia.ts owns the sealed upload, and
 * transcribe.ts owns the native call. Unit-tested (src/tests/notesAudio.test.ts).
 *
 * The clip itself is an ordinary E2EE attachment — encryptAndUploadRef seals
 * it exactly as it seals a photo, so the server holds ciphertext and a length
 * and cannot tell a recording from a picture. Nothing here ever sends audio
 * anywhere; `toPcm16Mono16k` only reshapes bytes this device already has.
 */
import { ENCRYPTED_OVERHEAD_BYTES, MAX_UPLOAD_BYTES } from '../../api/uploads';

/** Containers to try, best first — the same probe list as Púca's mic test
 *  (components/SettingsModal.tsx). Opus in WebM everywhere but Safari/iOS,
 *  which records AAC in MP4. */
export const AUDIO_CANDIDATE_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const;

/** A recording stops itself here. Long enough for a thought, short enough
 *  that a forgotten recorder cannot fill the 25 MB upload budget. */
export const MAX_CLIP_MS = 5 * 60_000;

/**
 * The longest clip this device will offer to write down. The recogniser is
 * fed raw 16 kHz mono PCM (32 KB per second), and those bytes cross the
 * Capacitor bridge to reach the app's cache file — 2 minutes is ~3.8 MB,
 * which is a bounded, chunked write; five would be ~9.6 MB in the WebView
 * heap for no better transcript. Longer clips are still SAVED, and the UI
 * says why they were not written down.
 */
export const MAX_TRANSCRIBE_MS = 120_000;

/** What the recogniser is fed. Android's on-device model expects 16 kHz. */
export const PCM_SAMPLE_RATE = 16_000;

/**
 * How long to wait for the phone's recogniser before giving up on a clip.
 *
 * This is a watchdog, not a performance budget: on-device recognition of a
 * file runs well under real time, but a recogniser whose service is killed
 * mid-session never calls back at all — and until this call RETURNS, the one
 * unsealed copy of the recording (the 16 kHz PCM in the app's cache) is not
 * deleted, because the delete lives in transcribeClip's `finally`.
 *
 * The phone's own watchdog (`TranscribeGate.watchdogMs`, which sees the same
 * clip as a byte count) uses the same clamp, so it normally answers first
 * with an honest refusal; the five seconds of slack here mean this side only
 * fires when the bridge itself is gone. Hard-capped, because the composer
 * waits on this before it closes.
 */
export function transcribeBudgetMs(durationMs: number): number {
    const d = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    const clip = Math.round(d * 1.5) + 15_000;
    return Math.min(60_000, Math.max(20_000, clip)) + 5_000;
}

/** The plaintext budget for one sealed clip. */
export const MAX_CLIP_BYTES = MAX_UPLOAD_BYTES - ENCRYPTED_OVERHEAD_BYTES;

export class ClipTooLargeError extends Error {
    constructor(bytes: number) {
        super(`That recording is ${Math.round(bytes / 1024 / 1024)} MB — the limit is ${Math.floor(MAX_CLIP_BYTES / 1024 / 1024)} MB.`);
        this.name = 'ClipTooLargeError';
    }
}

type SupportProbe = (mime: string) => boolean;

/** The first candidate container this browser can record, or null when it
 *  can record none (or has no MediaRecorder at all). */
export function pickAudioMime(isSupported?: SupportProbe): string | null {
    const probe = isSupported
        ?? (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
            ? (m: string) => MediaRecorder.isTypeSupported(m)
            : null);
    if (!probe) return null;
    for (const m of AUDIO_CANDIDATE_MIMES) {
        try {
            if (probe(m)) return m;
        } catch {
            // A probe that throws is a probe that said no.
        }
    }
    return null;
}

/** Can this device record at all? (No MediaRecorder, no getUserMedia, no
 *  container ⇒ the Voice note button is not offered.) */
export function canRecordAudio(): boolean {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
    return pickAudioMime() !== null;
}

/** The file extension a container is stored under (the ref's mime is the
 *  authority; the name is for the user). */
export function extForMime(mime: string): string {
    const base = mime.split(';')[0].trim().toLowerCase();
    if (base === 'audio/webm') return 'webm';
    if (base === 'audio/mp4') return 'm4a';
    if (base === 'audio/ogg') return 'ogg';
    if (base === 'audio/mpeg') return 'mp3';
    if (base === 'audio/wav' || base === 'audio/x-wav') return 'wav';
    return 'bin';
}

/** Is this mime a recording? (Used for the gallery's `audio` kind.) */
export function isAudioMime(mime: string | null | undefined): boolean {
    return !!mime && mime.toLowerCase().startsWith('audio/');
}

/** mm:ss for the recorder's elapsed time and a clip's length. */
export function formatClipTime(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** Fail before any bytes move (the same shape as api/uploads' check). */
export function assertClipUploadable(bytes: number): void {
    if (bytes > MAX_CLIP_BYTES) throw new ClipTooLargeError(bytes);
}

/**
 * Append a transcript to a note's text: a blank line between what the user
 * wrote and what the phone heard, and never past `maxBytes` — a transcript
 * that would not fit is refused whole rather than clipping the user's words.
 * Returns null when there is nothing to add or no room.
 */
export function appendTranscript(body: string, transcript: string, maxBytes: number, sizeOf: (s: string) => number): string | null {
    const text = transcript.trim();
    if (text === '') return null;
    const base = body.replace(/\s+$/, '');
    const next = base === '' ? text : `${base}\n\n${text}`;
    if (sizeOf(next) > maxBytes) return null;
    return next;
}

/**
 * A recorded clip as 16 kHz mono signed 16-bit PCM — what Android's on-device
 * recogniser reads from a file descriptor. Decoding happens through the
 * caller's `decode` (an AudioContext in the app, a stub under test), so this
 * stays testable and so the recorder never has to keep a context alive.
 *
 * Returns null when the clip cannot be decoded here — a refusal, never a
 * silent empty transcript.
 */
export async function toPcm16Mono16k(
    bytes: ArrayBuffer,
    decode: (b: ArrayBuffer) => Promise<{ sampleRate: number; channels: Float32Array[] }>,
): Promise<Int16Array | null> {
    let decoded: { sampleRate: number; channels: Float32Array[] };
    try {
        decoded = await decode(bytes);
    } catch {
        return null;
    }
    const chans = decoded.channels.filter(c => c && c.length > 0);
    if (chans.length === 0 || !(decoded.sampleRate > 0)) return null;
    const frames = Math.min(...chans.map(c => c.length));
    if (frames === 0) return null;

    // Mix to mono first, then take the nearest source sample per output frame.
    // Nearest-neighbour is enough for speech at 16 kHz and costs nothing; the
    // recogniser is far more tolerant of resampling than of the wrong rate.
    const ratio = decoded.sampleRate / PCM_SAMPLE_RATE;
    const outFrames = Math.max(1, Math.floor(frames / ratio));
    const out = new Int16Array(outFrames);
    for (let i = 0; i < outFrames; i++) {
        const src = Math.min(frames - 1, Math.round(i * ratio));
        let sum = 0;
        for (const c of chans) sum += c[src];
        const s = Math.max(-1, Math.min(1, sum / chans.length));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}
