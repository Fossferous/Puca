/**
 * A voice note is never sent anywhere to be written down.
 *
 * Two gates, because neither alone is enough:
 *
 *  1. A SOURCE-level sweep (the shape of src/tests/clipNoDiskWrite.test.ts):
 *     nothing under src/notes may name a browser speech recogniser — they are
 *     cloud services — and transcribe.ts may not reach the network at all. A
 *     behavioural test cannot catch "fall back to webkitSpeechRecognition when
 *     the phone has no model", and that single change would turn a private
 *     feature into a cloud one.
 *  2. A BEHAVIOURAL check of transcribeClip: the plugin is handed a cache
 *     PATH and never audio bytes, and the plaintext cache file is deleted on
 *     every exit path — success, refusal and failure alike.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// --- 1. the source gate ------------------------------------------------------------

const NOTES = join(__dirname, '..', 'notes');

function sources(dir: string): { name: string; text: string }[] {
    const out: { name: string; text: string }[] = [];
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) out.push(...sources(p));
        else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push({ name: p.slice(NOTES.length + 1), text: readFileSync(p, 'utf8') });
    }
    return out;
}

/** Comments may NAME the banned APIs (the contract does); code may not use them. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const BANNED = [
    /\bwebkitSpeechRecognition\b/,
    /\bSpeechRecognition\b/,
    /\bSpeechGrammarList\b/,
    /EXTRA_PREFER_OFFLINE/,
];

const files = sources(NOTES);

describe('Púca Notes never uses a cloud speech recogniser', () => {
    it('finds the module set (positive control — an empty glob must not pass)', () => {
        expect(files.length).toBeGreaterThan(30);
        expect(files.map(f => f.name.replace(/\\/g, '/'))).toEqual(expect.arrayContaining([
            'model/transcribe.ts', 'model/audioNote.ts', 'components/AudioRecorder.tsx',
        ]));
    });

    it('the sweep can actually fail (positive control for the patterns)', () => {
        const fake = stripComments('const r = new webkitSpeechRecognition();\n');
        expect(BANNED.some(re => re.test(fake))).toBe(true);
    });

    for (const f of files) {
        it(`${f.name} names no browser recogniser`, () => {
            const src = stripComments(f.text);
            for (const re of BANNED) expect(src, `${f.name} matches ${re}`).not.toMatch(re);
        });
    }

    it('transcribe.ts makes no network call of its own', () => {
        const src = stripComments(readFileSync(join(NOTES, 'model', 'transcribe.ts'), 'utf8'));
        for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /apiClient/, /sendBeacon/]) {
            expect(src, `transcribe.ts matches ${re}`).not.toMatch(re);
        }
    });
});

// --- 2. what transcribeClip actually does ------------------------------------------

const writeFile = vi.fn(async () => {});
const appendFile = vi.fn(async () => {});
const deleteFile = vi.fn(async () => {});
const getUri = vi.fn(async () => ({ uri: 'file:///data/cache/clip.pcm' }));
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Cache: 'CACHE' },
    Filesystem: {
        writeFile: (o: unknown) => writeFile(o as never),
        appendFile: (o: unknown) => appendFile(o as never),
        deleteFile: (o: unknown) => deleteFile(o as never),
        getUri: (o: unknown) => getUri(o as never),
    },
}));

let features: string[] = ['transcribe'];
const transcribePcm = vi.fn(async () => ({ text: 'milk and bread' } as { text: string | null; reason?: string }));
vi.mock('../notes/native/notesNative', () => ({
    notesNativeFeatures: async () => features,
    nativeTranscribePcm: (o: { path: string; sampleRate: number }) => transcribePcm(o as never),
}));

const { transcribeClip } = await import('../notes/model/transcribe');
const { MAX_TRANSCRIBE_MS, PCM_SAMPLE_RATE } = await import('../notes/model/audioNote');

/** A clip whose decode yields one second of 16 kHz mono. jsdom's AudioContext
 *  stub is replaced per test so the pure resampler runs for real, and its Blob
 *  has no arrayBuffer(), so one is supplied. */
function clip(): Blob {
    const b = new Blob([new Uint8Array(2048)], { type: 'audio/webm' });
    if (typeof b.arrayBuffer !== 'function') {
        Object.defineProperty(b, 'arrayBuffer', { value: async () => new ArrayBuffer(2048) });
    }
    return b;
}

beforeEach(() => {
    features = ['transcribe'];
    for (const m of [writeFile, appendFile, deleteFile, getUri, transcribePcm]) m.mockClear();
    transcribePcm.mockResolvedValue({ text: 'milk and bread' });
    class Ctx {
        async decodeAudioData() {
            return {
                sampleRate: 16_000,
                numberOfChannels: 1,
                getChannelData: () => new Float32Array(16_000).fill(0.5),
            } as unknown as AudioBuffer;
        }
        close() { return Promise.resolve(); }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = Ctx;
});

describe('transcribeClip', () => {
    it('hands the plugin a cache PATH and a sample rate, never audio bytes', async () => {
        const r = await transcribeClip(clip(), 1_000);
        expect(r.text).toBe('milk and bread');
        expect(transcribePcm).toHaveBeenCalledTimes(1);
        const arg = transcribePcm.mock.calls[0][0] as unknown as { path: string; sampleRate: number };
        expect(arg).toEqual({ path: 'file:///data/cache/clip.pcm', sampleRate: PCM_SAMPLE_RATE });
        // No base64 audio anywhere in what crossed the bridge.
        expect(/[A-Za-z0-9+/]{200,}/.test(JSON.stringify(arg))).toBe(false);
    });

    it('deletes the plaintext cache file after a SUCCESSFUL transcription', async () => {
        await transcribeClip(clip(), 1_000);
        expect(writeFile).toHaveBeenCalledTimes(1);
        expect(deleteFile).toHaveBeenCalledTimes(1);
        expect((deleteFile.mock.calls[0][0] as unknown as { path: string }).path)
            .toBe((writeFile.mock.calls[0][0] as unknown as { path: string }).path);
    });

    it('deletes it after a REFUSAL too', async () => {
        transcribePcm.mockResolvedValue({ text: null, reason: 'no-on-device-model' });
        const r = await transcribeClip(clip(), 1_000);
        expect(r.text).toBeNull();
        expect(r.reason).toMatch(/on-device|won’t send/i);
        expect(deleteFile).toHaveBeenCalledTimes(1);
    });

    it('deletes it after a FAILURE too', async () => {
        transcribePcm.mockRejectedValue(new Error('bridge died'));
        const r = await transcribeClip(clip(), 1_000);
        expect(r.text).toBeNull();
        expect(deleteFile).toHaveBeenCalledTimes(1);
    });

    it('refuses without the plugin feature, and writes nothing to the cache', async () => {
        features = ['reminders'];
        const r = await transcribeClip(clip(), 1_000);
        expect(r.text).toBeNull();
        expect(r.reason).toMatch(/can’t write down/i);
        expect(writeFile).not.toHaveBeenCalled();
        expect(transcribePcm).not.toHaveBeenCalled();
    });

    it('refuses a clip past the transcription budget before decoding it', async () => {
        const r = await transcribeClip(clip(), MAX_TRANSCRIBE_MS + 1);
        expect(r.text).toBeNull();
        expect(r.reason).toMatch(/longer than/i);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it('refuses — never silently succeeds — when the clip cannot be decoded', async () => {
        class Bad { async decodeAudioData(): Promise<AudioBuffer> { throw new Error('bad container'); } close() { return Promise.resolve(); } }
        (window as unknown as { AudioContext: unknown }).AudioContext = Bad;
        const r = await transcribeClip(clip(), 1_000);
        expect(r.text).toBeNull();
        expect(r.reason).toMatch(/couldn’t read the recording/i);
        expect(transcribePcm).not.toHaveBeenCalled();
    });

    it('an empty answer is a refusal with words, not an empty transcript', async () => {
        transcribePcm.mockResolvedValue({ text: '   ' });
        const r = await transcribeClip(clip(), 1_000);
        expect(r.text).toBeNull();
        expect(r.reason).toMatch(/nothing recognisable/i);
    });
});
