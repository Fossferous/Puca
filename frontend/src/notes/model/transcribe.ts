/**
 * Writing down a voice note — and refusing to, honestly.
 *
 * THE RULE THIS MODULE EXISTS TO KEEP: a recording is never sent anywhere to
 * be transcribed. The browser's own `SpeechRecognition` is a CLOUD service in
 * Chrome, and Android's default `SpeechRecognizer` is a cloud service on many
 * phones, so neither is allowed here. The only transcriber Púca Notes will
 * use is Android's ON-DEVICE recogniser, reached through the Notes plugin
 * (`transcribePcm`), which refuses unless
 * `SpeechRecognizer.isOnDeviceRecognitionAvailable` says yes. Everywhere else
 * — the browser page, an older APK, a phone below Android 13, a phone with no
 * on-device model — this returns a refusal IN WORDS and the clip is still
 * saved. A source-level gate (src/tests/notesTranscribeNoCloud.test.ts) keeps
 * the next person from "fixing" the refusal with a fallback.
 *
 * The recogniser reads raw PCM from a file, so the clip is decoded on this
 * device and written to the APP'S CACHE for the length of the call, then
 * deleted on EVERY exit path including a refusal. The sealed copy in the
 * note's sidecar is the only one that lasts. The transcript itself is
 * ordinary sealed note text — which is also what makes a voice note findable,
 * because search reads note text and never attachment names.
 */
import { MAX_TRANSCRIBE_MS, PCM_SAMPLE_RATE, toPcm16Mono16k } from './audioNote';
import { nativeTranscribePcm, notesNativeFeatures } from '../native/notesNative';

/** The outcome of trying to write a clip down. `text` null = nothing was
 *  written down, and `reason` says why in a sentence fit to show. */
export interface TranscribeOutcome {
    text: string | null;
    reason: string | null;
}

/** Reason codes the native side may answer with, in the words shown to the
 *  user. Anything unrecognised gets the generic honest sentence. */
const REASONS: Record<string, string> = {
    unsupported: 'This device can’t write down recordings on its own, so it didn’t — the recording is saved.',
    sdk: 'Writing down recordings needs Android 13 or newer, and nothing is sent anywhere — the recording is saved.',
    'no-on-device-model': 'This phone has no on-device speech model, and Púca Notes won’t send the recording anywhere — the recording is saved.',
    'no-speech': 'Nothing recognisable was heard, so there is nothing to write down — the recording is saved.',
    decode: 'This device couldn’t read the recording back to write it down — the recording is saved.',
    'too-long': `Recordings longer than ${Math.round(MAX_TRANSCRIBE_MS / 60_000)} minutes aren’t written down on the phone — the recording is saved.`,
    failed: 'Writing it down didn’t work this time — the recording is saved.',
};

export function describeTranscribeReason(reason: string | null | undefined): string {
    if (!reason) return REASONS.failed;
    return REASONS[reason] ?? REASONS.failed;
}

/** Does this shell have the on-device transcriber at all? (An older Notes
 *  APK has no such plugin method; the browser has no plugin.) */
export async function canTranscribe(): Promise<boolean> {
    return (await notesNativeFeatures()).includes('transcribe');
}

function base64Of(bytes: Uint8Array): string {
    let s = '';
    // 8 KB at a time: String.fromCharCode over a whole clip blows the
    // argument limit, and a chunked loop keeps the peak allocation small.
    for (let i = 0; i < bytes.length; i += 8192) {
        s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(s);
}

/** Decode with this device's audio engine. Separated so the pure resampler
 *  in audioNote.ts stays testable and so no AudioContext outlives the call. */
async function decodeHere(buf: ArrayBuffer): Promise<{ sampleRate: number; channels: Float32Array[] }> {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('no audio engine');
    const ctx = new Ctor();
    try {
        const audio = await ctx.decodeAudioData(buf);
        const channels: Float32Array[] = [];
        for (let i = 0; i < audio.numberOfChannels; i++) channels.push(audio.getChannelData(i));
        return { sampleRate: audio.sampleRate, channels };
    } finally {
        try { void Promise.resolve(ctx.close()).catch(() => {}); } catch { /* already closed */ }
    }
}

/**
 * Write down `clip`, on this device or not at all.
 *
 * `durationMs` is what the recorder measured; a clip past MAX_TRANSCRIBE_MS
 * is refused before it is decoded, because the PCM would be megabytes in this
 * page's heap for no better transcript.
 */
export async function transcribeClip(clip: Blob, durationMs: number): Promise<TranscribeOutcome> {
    if (!await canTranscribe()) return { text: null, reason: describeTranscribeReason('unsupported') };
    if (durationMs > MAX_TRANSCRIBE_MS) return { text: null, reason: describeTranscribeReason('too-long') };

    const pcm = await toPcm16Mono16k(await clip.arrayBuffer(), decodeHere);
    if (!pcm || pcm.length === 0) return { text: null, reason: describeTranscribeReason('decode') };

    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const path = `puca-notes-transcribe-${Date.now()}.pcm`;
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let wrote = false;
    try {
        // Chunked, so no single multi-megabyte base64 string crosses the
        // bridge. 192 KB of PCM ≈ 6 s of speech per chunk.
        const CHUNK = 192 * 1024;
        await Filesystem.writeFile({ path, data: base64Of(bytes.subarray(0, CHUNK)), directory: Directory.Cache, recursive: true });
        wrote = true;
        for (let i = CHUNK; i < bytes.length; i += CHUNK) {
            await Filesystem.appendFile({ path, data: base64Of(bytes.subarray(i, i + CHUNK)), directory: Directory.Cache });
        }
        const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
        const r = await nativeTranscribePcm({ path: uri, sampleRate: PCM_SAMPLE_RATE });
        const text = (r.text ?? '').trim();
        if (text === '') return { text: null, reason: describeTranscribeReason(r.reason ?? 'no-speech') };
        return { text, reason: null };
    } catch (err) {
        console.error('[notes] writing the recording down failed:', err);
        return { text: null, reason: describeTranscribeReason('failed') };
    } finally {
        // EVERY exit path, refusals included: the plaintext copy is the one
        // thing about a voice note that is not sealed, and it lives only as
        // long as the recogniser needs it.
        if (wrote) {
            try {
                await Filesystem.deleteFile({ path, directory: Directory.Cache });
            } catch (err) {
                console.error('[notes] could not delete the temporary recording:', err);
            }
        }
    }
}
