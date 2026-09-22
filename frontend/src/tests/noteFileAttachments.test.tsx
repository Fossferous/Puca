/**
 * A note holds any file, not only pictures.
 *
 * The gate was never the `accept` attribute (advisory — the OS dialog's "All
 * files" walks past it, which is how a PDF could already land in a note's
 * sidecar today) but the `image/*` filters in the pickers' onChange. With
 * those gone, the other half has to exist: a file in a note's own gallery
 * was a dead <span>, so a note could name a file nobody could ever open
 * again.
 *
 * The rule that must not be relaxed: a file is a DOWNLOAD, never an inline
 * preview and never an <a href="blob:">. A blob: document inherits this
 * app's origin and its MIME comes from the ref.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { saveAttachment } = vi.hoisted(() => ({ saveAttachment: vi.fn(async () => ({ where: 'Documents/Puca Notes', onDisk: true })) }));
vi.mock('../api/saveAttachment', () => ({ saveAttachment }));
const { decryptToBlobUrl } = vi.hoisted(() => ({ decryptToBlobUrl: vi.fn(async () => 'blob:decrypted') }));
vi.mock('../api/attachments', async () => {
    const real = await vi.importActual<typeof import('../api/attachments')>('../api/attachments');
    return { ...real, decryptToBlobUrl };
});
const { prepareImageForUpload } = vi.hoisted(() => ({ prepareImageForUpload: vi.fn(async (f: File) => f) }));
vi.mock('../api/imagePrep', async () => {
    const real = await vi.importActual<typeof import('../api/imagePrep')>('../api/imagePrep');
    return { ...real, prepareImageForUpload };
});
vi.mock('../api/uploads', () => ({
    uploadFile: vi.fn(async () => ({ id: 'up1', cap: 'c1' })),
    assertUploadable: vi.fn(),
    ENCRYPTED_OVERHEAD_BYTES: 28,
    // notes/model/audioNote.ts derives a voice note's plaintext budget from
    // this at module scope, and api/noteMedia.ts imports it — so a mock
    // without it cannot even load the module under test.
    MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
}));

import { NoteImages } from '../components/NoteImages';
import { galleryItems, clampAttachmentName, mediaCountLabel, MAX_ATTACHMENT_NAME_LEN, uploadNoteMedia, DRAWING_STROKES_MIME } from '../api/noteMedia';
import { deriveContentTitle } from '../notes/model/noteContent';
import { listBodySnippet } from '../components/useListContentSupport';

const enc = (id: string, mime: string, name: string) => ({ href: `sovereign-enc:${id}?k=KEY&m=${encodeURIComponent(mime)}`, name });
const sidecar = (...refs: Array<{ href: string; name: string }>) => JSON.stringify(refs);
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

// jsdom's File has no arrayBuffer(); the seal reads one.
if (typeof File.prototype.arrayBuffer !== 'function') {
    Object.defineProperty(File.prototype, 'arrayBuffer', {
        configurable: true,
        value(this: File) { return Promise.resolve(new ArrayBuffer(this.size)); },
    });
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
    saveAttachment.mockClear();
    prepareImageForUpload.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
});

describe('the sidecar model already knew about files', () => {
    it('classifies a PDF as a file and a PNG as a picture, and still pairs a drawing', () => {
        const items = galleryItems(sidecar(
            enc('a', 'application/pdf', 'tickets.pdf'),
            enc('b', 'image/png', 'photo.png'),
            enc('c', 'image/png', 'drawing-1.png'),
            enc('d', DRAWING_STROKES_MIME, 'drawing-1.json'),
        ));
        expect(items.map(i => [i.kind, i.ref.name])).toEqual([
            ['file', 'tickets.pdf'],
            ['image', 'photo.png'],
            ['drawing', 'drawing-1.png'],
        ]);
        expect(items[2].strokes?.name).toBe('drawing-1.json');
    });
});

describe('a file in a note’s own gallery', () => {
    const render = (opened: string) => {
        act(() => { root.render(<NoteImages opened={opened} editable saveFolder="Puca Notes" />); });
    };

    it('is a BUTTON that saves it, not dead text', async () => {
        render(sidecar(enc('a', 'application/pdf', 'tickets.pdf')));
        const btn = container.querySelector<HTMLButtonElement>('.ni-item.file button.ni-file');
        expect(btn, 'a file renders as a button').toBeTruthy();
        expect(btn!.textContent).toContain('tickets.pdf');
        await act(async () => { btn!.click(); });
        await settle();
        expect(saveAttachment).toHaveBeenCalledWith('blob:decrypted', 'tickets.pdf', 'Puca Notes');
    });

    it('never puts a blob: URL in the document', async () => {
        render(sidecar(enc('a', 'application/pdf', 'tickets.pdf')));
        await settle();
        expect(container.querySelector('a[href^="blob:"]')).toBeNull();
        // ...not even after the save, which is when the URL exists.
        await act(async () => { container.querySelector<HTMLButtonElement>('button.ni-file')!.click(); });
        await settle();
        expect(container.querySelector('a[href^="blob:"]')).toBeNull();
        expect(container.querySelector('iframe, embed, object')).toBeNull();
    });

    it('offers Add file beside Add photo, and the camera input keeps its capture', () => {
        act(() => { root.render(<NoteImages opened={null} editable showCamera onAddPhotos={() => {}} />); });
        const labels = [...container.querySelectorAll('.ni-action')].map(b => b.textContent?.trim());
        expect(labels).toContain('Add file');
        const camera = container.querySelector<HTMLInputElement>('input[capture]')!;
        expect(camera.accept).toBe('image/*');            // widening this sends the camera to a file browser
        const filePicker = container.querySelector<HTMLInputElement>('[data-testid="ni-pick-file"]')!;
        expect(filePicker.accept).toBe('');
    });

    it('keeps a picked PDF instead of silently dropping it', () => {
        const onAddPhotos = vi.fn();
        act(() => { root.render(<NoteImages opened={null} editable onAddPhotos={onAddPhotos} />); });
        const input = container.querySelector<HTMLInputElement>('[data-testid="ni-pick"]')!;
        const pdf = new File(['%PDF-1.4'], 'tickets.pdf', { type: 'application/pdf' });
        Object.defineProperty(input, 'files', { value: [pdf], configurable: true });
        act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        // The PDF ITSELF, not merely "something got through".
        expect(onAddPhotos).toHaveBeenCalledTimes(1);
        expect(onAddPhotos.mock.calls[0][0].map((f: File) => f.name)).toEqual(['tickets.pdf']);
    });
});

describe('what a file costs on the way up', () => {
    it('a non-image never goes through the image decoder', async () => {
        const pdf = new File(['%PDF-1.4'], 'tickets.pdf', { type: 'application/pdf' });
        await uploadNoteMedia([pdf], [], 0);
        expect(prepareImageForUpload).not.toHaveBeenCalled();
        // Positive control: a real picture still is shrunk.
        await uploadNoteMedia([new File(['x'], 'p.png', { type: 'image/png' })], [], 0);
        expect(prepareImageForUpload).toHaveBeenCalledTimes(1);
    });

    it('clamps a pathological file name, keeping its extension', () => {
        const long = `${'a'.repeat(4000)}.pdf`;
        const short = clampAttachmentName(long);
        expect(short.length).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_LEN);
        expect(short.endsWith('.pdf')).toBe(true);
        expect(clampAttachmentName('tickets.pdf')).toBe('tickets.pdf');   // ordinary names untouched
    });
});

describe('the words around a file-only note', () => {
    it('names the note after its file instead of "Untitled note"', () => {
        expect(deriveContentTitle('', { fileNames: ['tickets.pdf'] })).toBe('tickets');
        expect(deriveContentTitle('', {})).toBe('Untitled note');            // nothing to go on
        expect(deriveContentTitle('Trip', { fileNames: ['tickets.pdf'] })).toBe('Trip');   // a typed title wins
    });

    it('a queued PDF is called a file, not a picture, in the op label the toast repeats', () => {
        const f = (name: string, type: string) => new File(['x'], name, { type });
        expect(mediaCountLabel([f('tickets.pdf', 'application/pdf')], 0)).toBe('1 file');
        expect(mediaCountLabel([f('a.png', 'image/png'), f('b.png', 'image/png')], 0)).toBe('2 pictures');
        expect(mediaCountLabel([f('a.png', 'image/png'), f('t.pdf', 'application/pdf')], 0)).toBe('1 picture and 1 file');
        expect(mediaCountLabel([], 1)).toBe('1 picture');                       // a drawing is a picture
        expect(mediaCountLabel([f('t.pdf', 'application/pdf')], 1)).toBe('1 picture and 1 file');
        expect(mediaCountLabel([f('x', '')], 0)).toBe('1 file');                // no type at all is not a picture
    });

    it('counts files in the board snippet instead of leaving it blank', () => {
        const list = (attachments: string) => ({ id: 1, title: 't', created_at: '', total_tasks: 0, completed_tasks: 0, attachments });
        expect(listBodySnippet(list(sidecar(enc('a', 'application/pdf', 'tickets.pdf'))))).toBe('1 file');
        expect(listBodySnippet(list(sidecar(enc('a', 'image/png', 'p.png'), enc('b', 'application/pdf', 'q.pdf'))))).toBe('1 picture, 1 file');
        expect(listBodySnippet(list(sidecar(enc('a', 'image/png', 'p.png'))))).toBe('1 picture');
    });
});
