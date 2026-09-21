/**
 * Voice notes, the pure side: the container probe, the clip budget, naming,
 * how the gallery classifies a recording, and that a clip goes up RAW but
 * sealed exactly like a photo.
 *
 * Each block carries its own positive control, because the failure mode that
 * matters here is a test that would stay green after the feature was removed:
 * "no audio item" passes on an empty sidecar, and "not a hero picture" passes
 * when heroItems returns nothing at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    AUDIO_CANDIDATE_MIMES,
    MAX_CLIP_BYTES,
    MAX_CLIP_MS,
    MAX_TRANSCRIBE_MS,
    appendTranscript,
    assertClipUploadable,
    extForMime,
    formatClipTime,
    isAudioMime,
    pickAudioMime,
    toPcm16Mono16k,
} from '../notes/model/audioNote';

const prepareImageForUpload = vi.fn(async (f: File) => f);
const encryptAndUploadRef = vi.fn(async (f: File) => ({ href: hrefFor(f.name, f.type), name: f.name, mime: f.type }));
const deleteFiles = vi.fn(async () => {});

vi.mock('../api/imagePrep', () => ({ prepareImageForUpload: (f: File) => prepareImageForUpload(f) }));
vi.mock('../api/listContent', () => ({ deleteFiles: (ids: string[]) => deleteFiles(ids) }));
vi.mock('../api/attachments', async () => {
    const actual = await vi.importActual<typeof import('../api/attachments')>('../api/attachments');
    return { ...actual, encryptAndUploadRef: (f: File) => encryptAndUploadRef(f) };
});

const { galleryItems, heroItems, nameAudioFiles, nextAudioName, nextDrawingName, uploadNoteMedia, DRAWING_STROKES_MIME } =
    await import('../api/noteMedia');

let seq = 0;
function hrefFor(name: string, mime: string): string {
    return `sovereign-enc:file-${name}-${++seq}?k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&m=${encodeURIComponent(mime)}`;
}
const ref = (name: string, mime: string) => ({ href: hrefFor(name, mime), name });
const sidecar = (refs: { href: string; name: string }[]) => JSON.stringify(refs);
const file = (name: string, mime: string, size = 16) => new File([new Uint8Array(size)], name, { type: mime });

beforeEach(() => {
    prepareImageForUpload.mockClear();
    encryptAndUploadRef.mockClear();
    deleteFiles.mockClear();
    encryptAndUploadRef.mockImplementation(async (f: File) => ({ href: hrefFor(f.name, f.type), name: f.name, mime: f.type }));
});

describe('the container probe', () => {
    it('takes the first candidate this device supports', () => {
        expect(pickAudioMime(m => m === 'audio/webm')).toBe('audio/webm');
        expect(pickAudioMime(() => true)).toBe(AUDIO_CANDIDATE_MIMES[0]);
        expect(pickAudioMime(m => m === 'audio/mp4')).toBe('audio/mp4');
    });
    it('answers null when the device can record none of them', () => {
        expect(pickAudioMime(() => false)).toBeNull();
    });
    it('a probe that throws means no', () => {
        expect(pickAudioMime(() => { throw new Error('nope'); })).toBeNull();
    });
    it.each([
        ['audio/webm;codecs=opus', 'webm'],
        ['audio/mp4', 'm4a'],
        ['audio/ogg', 'ogg'],
        ['application/pdf', 'bin'],
    ])('%s is stored as .%s', (mime, ext) => {
        expect(extForMime(mime)).toBe(ext);
    });
    it('classifies audio mimes and nothing else', () => {
        expect(isAudioMime('audio/webm;codecs=opus')).toBe(true);
        expect(isAudioMime('image/png')).toBe(false);
        expect(isAudioMime(DRAWING_STROKES_MIME)).toBe(false);
        expect(isAudioMime(null)).toBe(false);
    });
    it('the caps are the ones the UI promises', () => {
        expect(MAX_CLIP_MS).toBe(5 * 60_000);
        expect(MAX_TRANSCRIBE_MS).toBeLessThan(MAX_CLIP_MS);
        expect(formatClipTime(MAX_CLIP_MS)).toBe('5:00');
        expect(formatClipTime(9_400)).toBe('0:09');
    });
});

describe('the clip budget', () => {
    it('accepts a clip at the budget and refuses one byte more', () => {
        expect(() => assertClipUploadable(MAX_CLIP_BYTES)).not.toThrow();       // positive control
        expect(() => assertClipUploadable(MAX_CLIP_BYTES + 1)).toThrow(/limit is/);
    });
    it('the refusal is named so the toast can show it verbatim', () => {
        try {
            assertClipUploadable(MAX_CLIP_BYTES + 1);
            expect.unreachable('should have thrown');
        } catch (err) {
            expect((err as Error).name).toBe('ClipTooLargeError');
        }
    });
});

describe('naming', () => {
    it('skips bases already taken, and does not collide with drawings', () => {
        const refs = [ref('voice-1.webm', 'audio/webm'), ref('voice-3.webm', 'audio/webm')];
        expect(nextAudioName(refs)).toBe('voice-2');
        expect(nextAudioName([...refs, ref('voice-2.webm', 'audio/webm')])).toBe('voice-4');
        expect(nextDrawingName(refs)).toBe('drawing-1');
    });
    it('names several clips saved in one go apart', () => {
        const named = nameAudioFiles([file('voice.webm', 'audio/webm'), file('voice.webm', 'audio/webm')], []);
        expect(named.map(f => f.name)).toEqual(['voice-1.webm', 'voice-2.webm']);
        expect(named[0].type).toBe('audio/webm');
    });
});

describe('galleryItems', () => {
    it('gives a recording its own kind', () => {
        const items = galleryItems(sidecar([ref('voice-1.webm', 'audio/webm;codecs=opus')]));
        expect(items.map(i => i.kind)).toEqual(['audio']);
    });
    it('still pairs a drawing with its strokes (control: nothing was reclassified)', () => {
        const png = ref('drawing-1.png', 'image/png');
        const strokes = ref('drawing-1.json', DRAWING_STROKES_MIME);
        const items = galleryItems(sidecar([png, strokes, ref('shot.jpg', 'image/jpeg'), ref('voice-1.webm', 'audio/webm')]));
        expect(items.map(i => i.kind)).toEqual(['drawing', 'image', 'audio']);
        expect(items[0].strokes?.href).toBe(strokes.href);
    });
    it('a non-audio, non-image attachment is still a plain file', () => {
        expect(galleryItems(sidecar([ref('notes.pdf', 'application/pdf')])).map(i => i.kind)).toEqual(['file']);
    });
});

describe('heroItems', () => {
    it('leads with pictures and never with a recording', () => {
        const opened = sidecar([ref('voice-1.webm', 'audio/webm'), ref('shot.jpg', 'image/jpeg')]);
        const heroes = heroItems(opened);
        expect(heroes.length).toBe(1);                         // positive control: it found the picture
        expect(heroes.map(i => i.kind)).toEqual(['image']);
    });
    it('a note with only a recording has no hero picture', () => {
        expect(heroItems(sidecar([ref('voice-1.webm', 'audio/webm')]))).toEqual([]);
    });
});

describe('uploadNoteMedia: the raw audio channel', () => {
    it('never runs a recording through the image preparation', async () => {
        const refs = await uploadNoteMedia([], [], 0, [file('voice-1.webm', 'audio/webm')]);
        expect(prepareImageForUpload).not.toHaveBeenCalled();
        expect(encryptAndUploadRef).toHaveBeenCalledTimes(1);
        expect(refs.map(r => r.name)).toEqual(['voice-1.webm']);
    });
    it('still prepares photos beside it (positive control for the spy)', async () => {
        await uploadNoteMedia([file('shot.jpg', 'image/jpeg')], [], 0, [file('voice-1.webm', 'audio/webm')]);
        expect(prepareImageForUpload).toHaveBeenCalledTimes(1);
        expect(prepareImageForUpload.mock.calls[0][0].name).toBe('shot.jpg');
    });
    it('rolls back every landed upload when a later one fails', async () => {
        encryptAndUploadRef.mockImplementationOnce(async (f: File) => ({ href: hrefFor(f.name, f.type), name: f.name, mime: f.type }));
        encryptAndUploadRef.mockImplementationOnce(async () => { throw new Error('uplink died'); });
        await expect(uploadNoteMedia([], [], 0, [file('voice-1.webm', 'audio/webm'), file('voice-2.webm', 'audio/webm')]))
            .rejects.toThrow('uplink died');
        expect(deleteFiles).toHaveBeenCalledTimes(1);
        expect(deleteFiles.mock.calls[0][0]).toHaveLength(1);
    });
    it('refuses an over-budget clip BEFORE anything is uploaded', async () => {
        const huge = new File([], 'voice-1.webm', { type: 'audio/webm' });
        Object.defineProperty(huge, 'size', { value: MAX_CLIP_BYTES + 1 });
        await expect(uploadNoteMedia([file('shot.jpg', 'image/jpeg')], [], 0, [huge])).rejects.toThrow(/limit is/);
        expect(encryptAndUploadRef).not.toHaveBeenCalled();
        expect(prepareImageForUpload).not.toHaveBeenCalled();
    });
    it('a recording counts against the sidecar slots', async () => {
        await expect(uploadNoteMedia([], [], 12, [file('voice-1.webm', 'audio/webm')])).rejects.toThrow(/at most/);
        expect(encryptAndUploadRef).not.toHaveBeenCalled();
    });
});

describe('appendTranscript', () => {
    const size = (s: string) => new TextEncoder().encode(s).length;
    it('adds the transcript below what the user wrote, with a blank line', () => {
        expect(appendTranscript('Shopping', 'milk and bread', 1000, size)).toBe('Shopping\n\nmilk and bread');
    });
    it('is the whole text when the note had none', () => {
        expect(appendTranscript('', 'milk and bread', 1000, size)).toBe('milk and bread');
    });
    it('adds nothing for an empty transcript', () => {
        expect(appendTranscript('Shopping', '   ', 1000, size)).toBeNull();
    });
    it('refuses rather than clipping the user’s own words', () => {
        expect(appendTranscript('Shopping', 'milk and bread', 10, size)).toBeNull();
    });
});

describe('toPcm16Mono16k', () => {
    const decodeOf = (sampleRate: number, channels: Float32Array[]) => async () => ({ sampleRate, channels });

    it('downsamples 48 kHz stereo to 16 kHz mono', async () => {
        const left = new Float32Array(4800).fill(1);
        const right = new Float32Array(4800).fill(-1);
        const pcm = await toPcm16Mono16k(new ArrayBuffer(8), decodeOf(48_000, [left, right]));
        expect(pcm).not.toBeNull();
        expect(pcm!.length).toBe(1600);
        // 1 mixed with -1 is silence: the mix happened, not a channel drop.
        expect(pcm![0]).toBe(0);
    });
    it('keeps a full-scale mono signal at full scale (positive control)', async () => {
        const pcm = await toPcm16Mono16k(new ArrayBuffer(8), decodeOf(16_000, [new Float32Array(320).fill(1)]));
        expect(pcm!.length).toBe(320);
        expect(pcm![0]).toBe(0x7fff);
    });
    it('clamps rather than wrapping on an over-unity sample', async () => {
        const pcm = await toPcm16Mono16k(new ArrayBuffer(8), decodeOf(16_000, [new Float32Array(16).fill(-4)]));
        expect(pcm![0]).toBe(-0x8000);
    });
    it('answers null — a refusal, never an empty transcript — when it cannot decode', async () => {
        expect(await toPcm16Mono16k(new ArrayBuffer(8), async () => { throw new Error('bad container'); })).toBeNull();
        expect(await toPcm16Mono16k(new ArrayBuffer(8), decodeOf(16_000, []))).toBeNull();
        expect(await toPcm16Mono16k(new ArrayBuffer(8), decodeOf(0, [new Float32Array(16)]))).toBeNull();
    });
});
