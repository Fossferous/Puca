/**
 * Voice notes in the UI, mounted with react-dom/client + act (the repo's
 * component-test pattern).
 *
 * Two of these guard promises this machine's standing rules also depend on:
 * a recording NEVER plays by itself, and the microphone disclosure comes
 * BEFORE the microphone is asked for. Both are asserted the way they can
 * actually fail — `autoplay === false` on the real element, and the ORDER of
 * two spies rather than merely that both ran.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/attachments', () => ({
    parseEncAttachment: (href: string) => (href.startsWith('enc:')
        ? { id: href.slice(4), key: new Uint8Array(32), mime: href.includes('webm') ? 'audio/webm;codecs=opus' : 'image/png', cap: null }
        : null),
    decryptToBlobUrl: async (id: string) => `blob:decrypted-${id}`,
    videoMimeFor: () => null,
}));

const { NoteImages } = await import('../components/NoteImages');
const { AudioRecorder } = await import('../notes/components/AudioRecorder');

const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); }); };

let container: HTMLDivElement;
let root: Root;

// --- a fake microphone -------------------------------------------------------------
const order: string[] = [];
let tracks: { stop: () => void; stopped: boolean }[] = [];
let recorderInstances: FakeRecorder[] = [];

class FakeRecorder {
    static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus';
    state = 'inactive';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(public stream: unknown, public opts: { mimeType: string }) { recorderInstances.push(this); }
    start() { this.state = 'recording'; }
    stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array(64)], { type: this.opts.mimeType }) });
        this.onstop?.();
    }
}

function installMic(grant = true) {
    order.length = 0;
    tracks = [];
    recorderInstances = [];
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeRecorder;
    // setup.ts defines navigator.mediaDevices non-configurably, so the method
    // is replaced on the object it already installed.
    navigator.mediaDevices.getUserMedia = vi.fn(async () => {
        order.push('getUserMedia');
        if (!grant) throw new Error('denied');
        const t = { stopped: false, stop() { this.stopped = true; } };
        tracks.push(t);
        return { getTracks: () => tracks } as unknown as MediaStream;
    }) as unknown as typeof navigator.mediaDevices.getUserMedia;
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    installMic();
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.restoreAllMocks();
});

const sidecar = (refs: { href: string; name: string }[]) => JSON.stringify(refs);
const CLIP = { href: 'enc:clip1.webm', name: 'voice-1.webm' };
const PIC = { href: 'enc:pic1.png', name: 'shot.png' };

describe('NoteImages: a recording is a player, not a paperclip', () => {
    it('renders <audio controls> for a voice note, and it never autoplays', async () => {
        await act(async () => { root.render(<NoteImages opened={sidecar([CLIP])} editable={false} />); });
        await settle();
        const audio = container.querySelector('audio') as HTMLAudioElement | null;
        expect(audio, 'no <audio> was rendered').not.toBeNull();
        expect(container.querySelector('.ni-file'), 'the clip fell through to the paperclip chip').toBeNull();
        expect(audio!.controls).toBe(true);
        // The assertion that must not go green by accident: setting autoplay
        // in NoteImages turns this red.
        expect(audio!.autoplay).toBe(false);
        expect(audio!.hasAttribute('autoplay')).toBe(false);
        expect(audio!.paused).toBe(true);
        expect(audio!.getAttribute('src')).toBe('blob:decrypted-clip1.webm');
    });

    it('a picture is still a picture (positive control: the branch did not swallow everything)', async () => {
        await act(async () => { root.render(<NoteImages opened={sidecar([PIC])} editable={false} />); });
        await settle();
        expect(container.querySelector('img')).not.toBeNull();
        expect(container.querySelector('audio')).toBeNull();
    });

    it('offers the Voice note button only when the caller says recording is possible', async () => {
        await act(async () => { root.render(<NoteImages opened={null} editable onAddPhotos={() => {}} />); });
        expect(container.querySelector('button[aria-label="Voice note"]')).toBeNull();
        const onRecord = vi.fn();
        await act(async () => { root.render(<NoteImages opened={null} editable onAddPhotos={() => {}} onRecord={onRecord} />); });
        const btn = container.querySelector('button[aria-label="Voice note"]') as HTMLButtonElement;
        expect(btn).not.toBeNull();
        await act(async () => { btn.click(); });
        expect(onRecord).toHaveBeenCalledTimes(1);
    });

    it('removing a recording says what it is removing', async () => {
        await act(async () => { root.render(<NoteImages opened={sidecar([CLIP])} editable onRemove={() => {}} />); });
        await settle();
        expect(container.querySelector('button[aria-label="Remove voice note"]')).not.toBeNull();
    });
});

/** The recorder portals into document.body, so its DOM is queried there. */
const sheet = (sel: string) => document.querySelector(`.notes-recorder ${sel}`);

describe('AudioRecorder: the microphone', () => {
    it('shows the disclosure BEFORE it asks for the microphone', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => { order.push('confirm'); return true; });
        await act(async () => { root.render(<AudioRecorder onSave={() => true} onCancel={() => {}} />); });
        await settle();
        expect(confirm).toHaveBeenCalledTimes(1);
        // ORDER, not merely "both ran": a disclosure after the prompt is no
        // disclosure at all.
        expect(order).toEqual(['confirm', 'getUserMedia']);
    });

    it('dismissing the disclosure never touches the microphone', async () => {
        vi.spyOn(window, 'confirm').mockImplementation(() => { order.push('confirm'); return false; });
        const onCancel = vi.fn();
        await act(async () => { root.render(<AudioRecorder onSave={() => true} onCancel={onCancel} />); });
        await settle();
        expect(order).toEqual(['confirm']);
        expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
        expect(onCancel).toHaveBeenCalled();
    });

    it('records, previews without playing, and hands the clip over', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const onSave = vi.fn(() => true);
        await act(async () => { root.render(<AudioRecorder onSave={onSave} onCancel={() => {}} />); });
        await settle();
        const stopBtn = sheet('button[aria-label="Stop recording"]') as HTMLButtonElement;
        expect(stopBtn, 'the recorder never reached the recording phase').not.toBeNull();
        await act(async () => { recorderInstances[0].stop(); });
        await settle();
        const preview = sheet('audio') as HTMLAudioElement;
        expect(preview).not.toBeNull();
        expect(preview.autoplay).toBe(false);
        expect(preview.paused).toBe(true);
        // Stopping releases the microphone, before anything is kept.
        expect(tracks.every(t => t.stopped)).toBe(true);

        const keep = [...document.querySelectorAll('.notes-recorder button')].find(b => b.textContent === 'Keep') as HTMLButtonElement;
        await act(async () => { keep.click(); });
        await settle();
        expect(onSave).toHaveBeenCalledTimes(1);
        const clip = onSave.mock.calls[0][0] as unknown as { file: File; url: string };
        expect(clip.file.type).toBe('audio/webm;codecs=opus');
        expect(clip.file.name).toBe('voice.webm');
    });

    it('unmounting stops every track', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        await act(async () => { root.render(<AudioRecorder onSave={() => true} onCancel={() => {}} />); });
        await settle();
        expect(tracks.length).toBe(1);
        expect(tracks[0].stopped).toBe(false);   // positive control: it was live
        await act(async () => { root.render(<div />); });
        expect(tracks[0].stopped).toBe(true);
    });

    it('hiding the page releases the microphone — nothing records off screen', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        await act(async () => { root.render(<AudioRecorder onSave={() => true} onCancel={() => {}} />); });
        await settle();
        expect(tracks[0].stopped).toBe(false);
        const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(tracks[0].stopped).toBe(true);
        spy.mockRestore();
    });

    it('a refused microphone says so and records nothing', async () => {
        installMic(false);
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        await act(async () => { root.render(<AudioRecorder onSave={() => true} onCancel={() => {}} />); });
        await settle();
        expect(sheet('button[aria-label="Stop recording"]')).toBeNull();
        expect(sheet('.notes-recorder-hint.warn')?.textContent).toMatch(/microphone/i);
    });
});
