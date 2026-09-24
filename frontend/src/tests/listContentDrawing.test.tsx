/**
 * Drawings in PÚCA's own Tasks view (ListContentBlock): a drawing made in
 * Púca Notes can be opened and changed there, and a new one drawn.
 *
 * The rules that must hold whichever front door saves:
 *  - a LOCKED sidecar offers no drawing at all. The refusal is NoteImages'
 *    (writing over refs this device cannot read would orphan them), and Púca
 *    must inherit it rather than mount the canvas outside that gate.
 *  - replacing a drawing replaces the PAIR. A drawing is two files, the PNG
 *    and its strokes; dropping only the PNG leaves the strokes on the server
 *    with nothing naming them.
 *  - the new pair is named against what is LEFT, so an edit reuses the name
 *    it just freed instead of climbing for ever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { setAttachments, deleteFiles, upload, toast } = vi.hoisted(() => ({
    setAttachments: vi.fn(async () => undefined),
    deleteFiles: vi.fn(async () => undefined),
    upload: vi.fn(),
    toast: vi.fn(),
}));
vi.mock('../api/listContent', async () => {
    const real = await vi.importActual<typeof import('../api/listContent')>('../api/listContent');
    return { ...real, setTaskListAttachments: setAttachments, setTaskListBody: vi.fn(async () => undefined), deleteFiles };
});
vi.mock('../api/noteMedia', async () => {
    const real = await vi.importActual<typeof import('../api/noteMedia')>('../api/noteMedia');
    return { ...real, uploadNoteMedia: upload, readStrokes: vi.fn(async () => JSON.stringify({ v: 1, w: 1200, h: 900, strokes: [] })) };
});
vi.mock('../components/messageToastBus', async () => {
    const real = await vi.importActual<typeof import('../components/messageToastBus')>('../components/messageToastBus');
    return { ...real, pushMessageToast: toast };
});
// The pictures themselves are decrypted elsewhere; this test is about the
// controls and what a save plans. parseEncAttachment is NOT mocked: the
// gallery pairs a drawing by the ref's own mime, so faking it would pair
// nothing and every assertion below would pass for the wrong reason.
vi.mock('../api/attachments', async () => {
    const real = await vi.importActual<typeof import('../api/attachments')>('../api/attachments');
    return { ...real, decryptToBlobUrl: vi.fn(async () => 'blob:x'), encryptAndUploadRef: vi.fn() };
});
// The real canvas cannot draw in jsdom (it disables its own Save there), so
// the SAVE is driven through a stand-in that hands ListContentBlock a finished
// drawing — what the canvas does is not what these tests are about; what the
// block does with the answer to the sidecar write is.
vi.mock('../components/DrawingCanvas', async () => {
    const { createElement } = await import('react');
    return {
        DrawingCanvas: ({ onSave }: { onSave: (f: { png: Blob; strokes: string }) => Promise<boolean> }) =>
            createElement('button', { type: 'button', 'data-testid': 'stub-draw-save', onClick: () => { void onSave({ png: new Blob(['png']), strokes: '{"v":1}' }); } }, 'Save drawing'),
    };
});

import { ListContentBlock } from '../components/ListContentBlock';
import { ApiError } from '../api/client';
import { DRAWING_STROKES_MIME, galleryItems, planDrawingReplace } from '../api/noteMedia';
import { ENC_KEY_UNAVAILABLE } from '../api/decryptMarkers';
import { type TaskList, type TaskAttachmentRef } from '../api/tasks';
import { type ListFeatures } from '../api/listContent';

const encRef = (id: string, name: string, mime: string): TaskAttachmentRef => ({
    href: `sovereign-enc:${id}?k=${'A'.repeat(43)}&m=${encodeURIComponent(mime)}`, name,
});
const png = (n: string): TaskAttachmentRef => encRef(`${n}-png`, `${n}.png`, 'image/png');
const strokes = (n: string): TaskAttachmentRef => encRef(`${n}-json`, `${n}.json`, DRAWING_STROKES_MIME);
const SIDECAR = JSON.stringify([png('drawing-1'), strokes('drawing-1')]);
const FEATURES: ListFeatures = { body: true, attachments: true, trash: true, trashRetentionDays: 30, maxBodyLen: 65536, serverClockOffsetMs: 0 };
const list = (attachments: string | null): TaskList => ({
    id: 5, title: 'Sketch', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', body: null, attachments,
} as unknown as TaskList);

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => { setAttachments.mockClear(); deleteFiles.mockClear(); upload.mockReset(); toast.mockClear(); });
afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    root = null;
    host = null;
});

function mount(attachments: string | null): HTMLElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
        <ListContentBlock list={list(attachments)} features={FEATURES} onPatch={vi.fn()} coarse={false} />,
    ));
    return host!;
}
const byLabel = (el: ParentNode, label: string) => [...el.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === label);
const byText = (el: ParentNode, text: string) => [...el.querySelectorAll('button')].filter(b => b.textContent?.includes(text));

describe('drawings in Púca’s Tasks view', () => {
    it('offers Draw, and Edit drawing on a drawing made in Púca Notes', () => {
        const el = mount(SIDECAR);
        expect(byText(el, 'Draw')).toHaveLength(1);
        expect(byLabel(el, 'Edit drawing')).toHaveLength(1);
        // The strokes file is not a picture of its own.
        expect(el.querySelectorAll('.ni-item')).toHaveLength(1);
    });

    it('a LOCKED sidecar offers neither, and says why', () => {
        const el = mount(ENC_KEY_UNAVAILABLE);
        expect(byText(el, 'Draw')).toHaveLength(0);
        expect(byLabel(el, 'Edit drawing')).toHaveLength(0);
        expect(el.querySelector('.ni-locked')).not.toBeNull();
    });

    it('the note’s own text field is still there beside the pictures (control)', () => {
        const el = mount(SIDECAR);
        expect(el.querySelector('textarea.nb-text')).not.toBeNull();
    });
});

// The save itself is a pure plan (api/noteMedia.planDrawingReplace): the
// canvas cannot run in jsdom (no 2D context — DrawingCanvas says so and
// disables Save), so the rule lives where it can be tested, and BOTH hosts
// call it rather than each re-deriving it.
describe('planDrawingReplace', () => {
    it('replacing a drawing drops BOTH of its refs and hands both back to be deleted', () => {
        const refs = [png('drawing-1'), strokes('drawing-1'), png('photo')];
        const item = galleryItems(JSON.stringify(refs)).find(i => i.kind === 'drawing')!;
        const plan = planDrawingReplace(refs, item);
        expect(plan.kept.map(r => r.name)).toEqual(['photo.png']);
        expect(plan.dropped.map(r => r.name).sort()).toEqual(['drawing-1.json', 'drawing-1.png']);
        // and it reuses the name it just freed, rather than climbing for ever
        expect(plan.base).toBe('drawing-1');
    });

    it('a NEW drawing keeps everything and takes the next free name', () => {
        const refs = [png('drawing-1'), strokes('drawing-1')];
        const plan = planDrawingReplace(refs);
        expect(plan.kept).toHaveLength(2);
        expect(plan.dropped).toEqual([]);
        expect(plan.base).toBe('drawing-2');
    });
});

/**
 * A sidecar write whose ANSWER was lost (finding 4). The server commits
 * before it answers, and it cannot tell which uploads a sealed sidecar
 * names — so deleting this save's uploads on ANY failure (a dropped
 * connection, a gateway's 5xx, a timeout) broke a note that had in fact been
 * saved: the picture it now names is gone for good. Uploads are deleted only
 * after a DEFINITE refusal (api/client.ts isDefiniteRefusal), exactly as Púca
 * Notes does it, and the old drawing a replacement drops goes only once the
 * new sidecar is known to have landed.
 */
describe('a picture or drawing whose save answer was lost', () => {
    const lost = () => new TypeError('Failed to fetch');
    const flush = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); });
    const deleted = () => deleteFiles.mock.calls.flatMap(c => (c as unknown as [string[]])[0]);
    const toasts = () => toast.mock.calls.map(c => (c as unknown as [{ title: string }])[0].title);

    async function addPhoto(el: HTMLElement) {
        const input = el.querySelector<HTMLInputElement>('[data-testid="ni-pick"]')!;
        Object.defineProperty(input, 'files', { value: [new File(['bytes'], 'plane.png', { type: 'image/png' })], configurable: true });
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        await flush();
    }
    async function redraw(el: HTMLElement) {
        await act(async () => { byLabel(el, 'Edit drawing')[0].click(); });
        await flush();
        await act(async () => { el.ownerDocument.querySelector<HTMLButtonElement>('[data-testid="stub-draw-save"]')!.click(); });
        await flush();
    }

    it('a photo keeps its upload, and the user is told it may have been saved', async () => {
        upload.mockResolvedValue([png('photo-new')]);
        setAttachments.mockRejectedValueOnce(lost());
        const el = mount(null);
        await addPhoto(el);
        expect(setAttachments).toHaveBeenCalledTimes(1);
        expect(deleted()).toEqual([]);
        expect(toasts().some(t => /may or may not have been saved/.test(t))).toBe(true);
    });

    it('...and so does one answered by a gateway 5xx after the send', async () => {
        upload.mockResolvedValue([png('photo-new')]);
        setAttachments.mockRejectedValueOnce(new ApiError('Bad gateway', 502));
        const el = mount(null);
        await addPhoto(el);
        expect(deleted()).toEqual([]);
    });

    it('POSITIVE CONTROL: a photo DEFINITELY refused (400) deletes its upload', async () => {
        upload.mockResolvedValue([png('photo-new')]);
        setAttachments.mockRejectedValueOnce(new ApiError('Nope', 400));
        const el = mount(null);
        await addPhoto(el);
        expect(deleted()).toEqual(['photo-new-png']);
    });

    it('a redrawn drawing whose answer was lost keeps BOTH pairs — the new one it may name, the old one it may still name', async () => {
        upload.mockResolvedValue([png('drawing-new'), strokes('drawing-new')]);
        setAttachments.mockRejectedValueOnce(lost());
        const el = mount(SIDECAR);
        await redraw(el);
        expect(setAttachments).toHaveBeenCalledTimes(1);
        expect(deleted()).toEqual([]);
        expect(toasts().some(t => /may or may not have been saved/.test(t))).toBe(true);
    });

    it('POSITIVE CONTROL: a redraw DEFINITELY refused deletes the new pair, never the old one it still names', async () => {
        upload.mockResolvedValue([png('drawing-new'), strokes('drawing-new')]);
        setAttachments.mockRejectedValueOnce(new ApiError('Nope', 400));
        const el = mount(SIDECAR);
        await redraw(el);
        expect(deleted().sort()).toEqual(['drawing-new-json', 'drawing-new-png']);
    });

    it('POSITIVE CONTROL: a redraw that LANDED deletes the old pair, and only it', async () => {
        upload.mockResolvedValue([png('drawing-new'), strokes('drawing-new')]);
        const el = mount(SIDECAR);
        await redraw(el);
        expect(setAttachments).toHaveBeenCalledTimes(1);
        expect(deleted().sort()).toEqual(['drawing-1-json', 'drawing-1-png']);
    });
});
