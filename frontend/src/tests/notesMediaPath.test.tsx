/**
 * Which road a picture takes (notes/model/useListContent.ts `addNoteMedia`).
 *
 * Offline, or behind a queue it must not overtake, it is sealed and PARKED on
 * this device and the upload becomes an outbox op. Online with nothing
 * waiting it is uploaded there and then, as it always was — parking a second
 * copy of a photo that is about to go up costs a phone two more passes over
 * the ciphertext and twice its size in IndexedDB, and it let the on-device
 * cap refuse a picture on a device that was perfectly online.
 *
 * And the count that decides is only meaningful once the persisted queue has
 * LOADED: it reads 0 until then, however much a previous page left waiting,
 * so a photo added in the first moments after a reload would otherwise be
 * uploaded straight past everything queued ahead of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';

const H = vi.hoisted(() => ({
    uploadNoteMedia: vi.fn(),
    sealNoteMedia: vi.fn(),
    park: vi.fn(async () => undefined),
    setTaskListAttachments: vi.fn(async () => undefined),
    deleteFiles: vi.fn(async () => undefined),
    sendNoteOp: vi.fn(async () => ({ queued: true as const })),
    forgetParkedMedia: vi.fn(async () => undefined),
    pendingOutboxCount: vi.fn(() => 0),
    ensureOutboxLoaded: vi.fn(async () => undefined),
    sendCreateList: vi.fn(),
    sendCreateTask: vi.fn(),
    createTaskListWithContent: vi.fn(),
    resealRefs: vi.fn(),
    createListTask: vi.fn(),
}));

vi.mock('../api/noteMedia', async (orig) => {
    const real = await orig<typeof import('../api/noteMedia')>();
    return { ...real, uploadNoteMedia: H.uploadNoteMedia, sealNoteMedia: H.sealNoteMedia, resealRefs: H.resealRefs };
});
vi.mock('../api/listContent', async (orig) => {
    const real = await orig<typeof import('../api/listContent')>();
    return {
        ...real,
        setTaskListAttachments: H.setTaskListAttachments,
        deleteFiles: H.deleteFiles,
        createTaskListWithContent: H.createTaskListWithContent,
    };
});
vi.mock('../api/tasks', async (orig) => {
    const real = await orig<typeof import('../api/tasks')>();
    return { ...real, createListTask: H.createListTask };
});
vi.mock('../notes/model/notesBlobs', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesBlobs')>();
    return { ...real, appParkedStore: { ...real.appParkedStore, park: H.park } };
});
vi.mock('../notes/model/notesOutbox', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesOutbox')>();
    return {
        ...real,
        sendNoteOp: H.sendNoteOp,
        forgetParkedMedia: H.forgetParkedMedia,
        pendingOutboxCount: H.pendingOutboxCount,
        ensureOutboxLoaded: H.ensureOutboxLoaded,
        sendCreateList: H.sendCreateList,
        sendCreateTask: H.sendCreateTask,
    };
});

import { useListContentActions, type ListContentActions } from '../notes/model/useListContent';
import { setMessageToastSink } from '../components/messageToastBus';
import type { NoteRef } from '../notes/model/notesModel';
import type { TaskList } from '../api/tasks';
import { nextAudioName } from '../api/noteMedia';
import { ApiError, markNotSent } from '../api/client';
import { OP_KEY_SHAPE } from '../api/opKey';
import { NoteConflictError } from '../api/listConflict';
import { NO_LIST_FEATURES } from '../api/listContent';

const LISTS_KEY = ['notes', 'lists'];
const keys = { lists: LISTS_KEY, tasks: (ref: NoteRef) => ['notes', 'tasks', ref.kind, ref.id] };
const list: TaskList = { id: 1, title: 'Trip', created_at: '', total_tasks: 0, completed_tasks: 0, attachments: null };
const uploaded = { href: 'sovereign-enc:up1?k=K&m=image%2Fpng', name: 'plane.png' };
const sealed = { id: 'parked-1', name: 'plane.png', mime: 'image/png', key: 'K', data: btoa('cipher'), bytes: 10 };
const photo = () => new File(['bytes'], 'plane.png', { type: 'image/png' });

let root: Root | null = null;
let onLine = true;
/** Whether the fixture's server de-duplicates creates (migration 070). */
let serverDedupes = true;
let spy: ReturnType<typeof vi.spyOn> | null = null;

async function actionsFor(): Promise<ListContentActions> {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    qc.setQueryData<TaskList[]>(LISTS_KEY, [list]);
    qc.setQueryData(['notes', 'features'], { ...NO_LIST_FEATURES, idempotentCreates: serverDedupes });
    let got: ListContentActions | null = null;
    function Harness() {
        const a = useListContentActions(keys);
        useEffect(() => { got = a; });
        return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>);
    });
    if (!got) throw new Error('the hook never rendered');
    return got;
}

beforeEach(() => {
    vi.clearAllMocks();
    onLine = true;
    serverDedupes = true;
    // A once-value a failing test left unconsumed must not leak into the next.
    H.uploadNoteMedia.mockReset();
    H.resealRefs.mockReset();
    H.uploadNoteMedia.mockResolvedValue([uploaded]);
    H.sealNoteMedia.mockResolvedValue([sealed]);
    H.sendNoteOp.mockResolvedValue({ queued: true });
    H.pendingOutboxCount.mockReturnValue(0);
    H.ensureOutboxLoaded.mockResolvedValue(undefined);
    H.sendCreateList.mockImplementation(async (title: string) => ({ id: -5, title, created_at: '', total_tasks: 0, completed_tasks: 0 }));
    H.createTaskListWithContent.mockImplementation(async (title: string) => ({ id: 9, title, created_at: '', total_tasks: 0, completed_tasks: 0 }));
    spy = vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => onLine);
    setMessageToastSink(() => {});
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    document.body.innerHTML = '';
    setMessageToastSink(null);
    spy?.mockRestore();
});

describe('a picture added while the connection is there', () => {
    it('is uploaded, not copied through this device’s parked store', async () => {
        const c = await actionsFor();
        expect(await c.addNoteMedia(1, [photo()], [])).toBe(true);
        expect(H.uploadNoteMedia).toHaveBeenCalledTimes(1);
        expect(H.sealNoteMedia).not.toHaveBeenCalled();
        expect(H.park).not.toHaveBeenCalled();
        // The third argument is the base revision the sidecar was read from
        // (migration 069): undefined here, because this fixture's server has
        // no content_rev to name.
        expect(H.setTaskListAttachments).toHaveBeenCalledWith(1, [uploaded], undefined);
    });

    it('POSITIVE CONTROL: with no connection the same call seals and parks instead', async () => {
        onLine = false;
        const c = await actionsFor();
        expect(await c.addNoteMedia(1, [photo()], [])).toBe(true);
        expect(H.sealNoteMedia).toHaveBeenCalledTimes(1);
        expect(H.park).toHaveBeenCalledWith([sealed]);
        expect(H.uploadNoteMedia).not.toHaveBeenCalled();
        expect(H.sendNoteOp.mock.calls[0][0]).toMatchObject({ k: 'addMedia', listId: 1, blobIds: ['parked-1'] });
    });

    it('...and so does a queue it must not overtake, connection or not', async () => {
        H.pendingOutboxCount.mockReturnValue(2);
        const c = await actionsFor();
        expect(await c.addNoteMedia(1, [photo()], [])).toBe(true);
        expect(H.park).toHaveBeenCalledTimes(1);
        expect(H.uploadNoteMedia).not.toHaveBeenCalled();
    });
});

describe('the count that decides is read only once the queue has loaded', () => {
    /** A cold start: 0 until the persisted queue is read, 2 after. */
    function coldStart() {
        let loaded = false;
        H.pendingOutboxCount.mockImplementation(() => (loaded ? 2 : 0));
        H.ensureOutboxLoaded.mockImplementation(async () => { loaded = true; });
    }

    it('a picture added moments after a reload waits behind what that page queued', async () => {
        coldStart();
        const c = await actionsFor();
        await c.addNoteMedia(1, [photo()], []);
        expect(H.ensureOutboxLoaded).toHaveBeenCalled();
        // Read before the load, the count is 0 and this uploads straight past
        // everything the previous page left waiting.
        expect(H.uploadNoteMedia).not.toHaveBeenCalled();
        expect(H.park).toHaveBeenCalledTimes(1);
    });

    it('a NOTE made moments after a reload does the same', async () => {
        coldStart();
        const c = await actionsFor();
        await c.createContentNote('Trip', [], { photos: [photo()] });
        expect(H.ensureOutboxLoaded).toHaveBeenCalled();
        expect(H.uploadNoteMedia).not.toHaveBeenCalled();
        expect(H.park).toHaveBeenCalledTimes(1);
    });
});

/**
 * A VOICE note made offline, or behind a queue (finding 5). The queued path
 * had no way to receive the recording: the note was queued without it,
 * reported success, and the composer dropped the clip — gone for good.
 */
describe('a voice note that has to wait for the connection', () => {
    const clip = () => new File(['rec-bytes'], 'rec.webm', { type: 'audio/webm' });

    it('seals and queues the RECORDING, and the note is called a voice note', async () => {
        onLine = false;
        const c = await actionsFor();
        const ref = await c.createContentNote('', [], { audio: [clip()] });
        expect(ref).not.toBeNull();
        expect(H.sealNoteMedia).toHaveBeenCalledTimes(1);
        const audio = H.sealNoteMedia.mock.calls[0][3] as File[];
        expect(audio.map(f => f.name)).toEqual([`${nextAudioName([])}.webm`]);
        expect(H.park).toHaveBeenCalledWith([sealed]);
        const queued = H.sendNoteOp.mock.calls.map(call => (call[0] as { k: string }).k);
        expect(queued).toContain('addMedia');
        expect(H.sendCreateList).toHaveBeenCalledWith('Voice note');
    });

    it('...and the same ONLINE, behind a queue it must not overtake', async () => {
        H.pendingOutboxCount.mockReturnValue(2);
        const c = await actionsFor();
        expect(await c.createContentNote('', [], { audio: [clip()] })).not.toBeNull();
        expect(H.sealNoteMedia).toHaveBeenCalledTimes(1);
        expect((H.sealNoteMedia.mock.calls[0][3] as File[])).toHaveLength(1);
        expect(H.uploadNoteMedia).not.toHaveBeenCalled();
    });

    it('online with nothing queued, a voice-only note is titled "Voice note" too', async () => {
        const c = await actionsFor();
        expect(await c.createContentNote('', [], { audio: [clip()] })).not.toBeNull();
        expect(H.createTaskListWithContent.mock.calls[0][0]).toBe('Voice note');
    });

    it('refuses LOUDLY rather than queue a note without refs it was handed', async () => {
        onLine = false;
        const toasts: string[] = [];
        setMessageToastSink(t => { toasts.push(t.title); });
        const c = await actionsFor();
        const ref = await c.createContentNote('Copy', [], { refs: [uploaded] });
        expect(ref).toBeNull();
        expect(H.sendCreateList).not.toHaveBeenCalled();
        expect(toasts.length).toBeGreaterThan(0);
    });
});

/**
 * A create whose ANSWER was lost (finding 4). The server commits before it
 * answers, and it cannot tell which uploads a sealed sidecar names — so
 * deleting "our" uploads on any failure broke a note that had in fact been
 * made, and the user's retry minted a second key and made it twice. Uploads
 * go only on a DEFINITE refusal, and a retry of the same draft re-sends the
 * same key and the same uploads, so the server answers it with the note it
 * already made.
 */
describe('a note whose create answer was lost', () => {
    const lost = () => new TypeError('Failed to fetch');
    const keyOf = (i: number) => H.createTaskListWithContent.mock.calls[i][2] as string | undefined;
    const refsOf = (i: number) => (H.createTaskListWithContent.mock.calls[i][1] as { refs?: unknown[] }).refs;

    it('keeps its uploads, and the retry re-sends the SAME key and the SAME uploads', async () => {
        const c = await actionsFor();
        const extra = { photos: [photo()] };
        H.createTaskListWithContent.mockRejectedValueOnce(lost());
        expect(await c.createContentNote('Trip', [], extra)).toBeNull();
        expect(H.deleteFiles).not.toHaveBeenCalled();
        expect(await c.createContentNote('Trip', [], extra)).not.toBeNull();
        expect(H.uploadNoteMedia).toHaveBeenCalledTimes(1);
        expect(keyOf(0)).toMatch(OP_KEY_SHAPE);
        expect(keyOf(1)).toBe(keyOf(0));
        expect(refsOf(1)).toEqual(refsOf(0));
    });

    /**
     * Re-sending the SAME uploads is only safe where the server answers the
     * retry with the note it already made. A server older than 070 ignores
     * the key and makes a second note: both would then name the same files,
     * and deleting either one (a duplicate, found and binned) would destroy
     * the other's pictures when the trash is emptied. So there the retry
     * uploads afresh — the old behaviour — and still deletes nothing.
     */
    it('on a server that cannot de-duplicate creates, the retry uploads AFRESH (two notes never share files)', async () => {
        serverDedupes = false;
        const second = { href: 'sovereign-enc:up2?k=K&m=image%2Fpng', name: 'plane.png' };
        H.uploadNoteMedia.mockResolvedValueOnce([uploaded]).mockResolvedValueOnce([second]);
        const c = await actionsFor();
        const extra = { photos: [photo()] };
        H.createTaskListWithContent.mockRejectedValueOnce(lost());
        expect(await c.createContentNote('Trip', [], extra)).toBeNull();
        expect(await c.createContentNote('Trip', [], extra)).not.toBeNull();
        expect(H.uploadNoteMedia).toHaveBeenCalledTimes(2);
        expect(refsOf(1)).toEqual([second]);
        // Neither attempt's uploads are deleted: the first may be named.
        expect(H.deleteFiles).not.toHaveBeenCalled();
    });

    it('...and neither is a hold older than the server can still remember its key', async () => {
        const second = { href: 'sovereign-enc:up2?k=K&m=image%2Fpng', name: 'plane.png' };
        H.uploadNoteMedia.mockResolvedValueOnce([uploaded]).mockResolvedValueOnce([second]);
        const c = await actionsFor();
        const extra = { photos: [photo()] };
        H.createTaskListWithContent.mockRejectedValueOnce(lost());
        expect(await c.createContentNote('Trip', [], extra)).toBeNull();
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 60 * 60_000);
        try {
            expect(await c.createContentNote('Trip', [], extra)).not.toBeNull();
        } finally { clock.mockRestore(); }
        expect(H.uploadNoteMedia).toHaveBeenCalledTimes(2);
        expect(refsOf(1)).toEqual([second]);
        // The key is kept: if the server still has it, it answers with the
        // note it made (the fresh uploads are then merely unused).
        expect(keyOf(1)).toBe(keyOf(0));
    });

    it('a 5xx from a gateway after the send is treated the same way', async () => {
        const c = await actionsFor();
        H.createTaskListWithContent.mockRejectedValueOnce(new ApiError('Bad gateway', 502));
        expect(await c.createContentNote('Trip', [], { photos: [photo()] })).toBeNull();
        expect(H.deleteFiles).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: a definite refusal (400) deletes the uploads, and the next try starts afresh', async () => {
        const c = await actionsFor();
        const extra = { photos: [photo()] };
        H.createTaskListWithContent.mockRejectedValueOnce(new ApiError('Nope', 400));
        expect(await c.createContentNote('Trip', [], extra)).toBeNull();
        expect(H.deleteFiles).toHaveBeenCalledWith(['up1']);
        await c.createContentNote('Trip', [], extra);
        expect(H.uploadNoteMedia).toHaveBeenCalledTimes(2);
        expect(keyOf(1)).not.toBe(keyOf(0));
    });

    it('POSITIVE CONTROL: a failure BEFORE anything was sent deletes them too', async () => {
        const c = await actionsFor();
        H.createTaskListWithContent.mockRejectedValueOnce(markNotSent(new TypeError('identity locked')));
        expect(await c.createContentNote('Trip', [], { photos: [photo()] })).toBeNull();
        expect(H.deleteFiles).toHaveBeenCalledWith(['up1']);
    });

    it('a draft EDITED between the attempts is a new intent: a new key and a new upload', async () => {
        const c = await actionsFor();
        const pic = photo();
        H.createTaskListWithContent.mockRejectedValueOnce(lost());
        await c.createContentNote('Trip', [], { photos: [pic], body: 'first' });
        await c.createContentNote('Trip', [], { photos: [pic], body: 'first, edited' });
        expect(keyOf(1)).not.toBe(keyOf(0));
        expect(H.uploadNoteMedia).toHaveBeenCalledTimes(2);
    });

    it('a create that LANDED is forgotten: the same draft again is a new note', async () => {
        const c = await actionsFor();
        const extra = { photos: [photo()] };
        await c.createContentNote('Trip', [], extra);
        await c.createContentNote('Trip', [], extra);
        expect(keyOf(1)).not.toBe(keyOf(0));
    });

    it('"Make a copy" whose answer was lost keeps its copies and retries with the same key', async () => {
        const src = { href: 'sovereign-enc:src1?k=K&m=image%2Fpng', name: 'src.png' };
        H.resealRefs.mockResolvedValue([uploaded]);
        const plan = { title: 'Trip', body: 'text', noteRefs: [src], items: [], files: 1 };
        const c = await actionsFor();
        H.createTaskListWithContent.mockRejectedValueOnce(lost());
        expect(await c.createNoteFromPlan(plan)).toBeNull();
        expect(H.deleteFiles).not.toHaveBeenCalled();
        expect(await c.createNoteFromPlan({ ...plan })).not.toBeNull();
        expect(H.resealRefs).toHaveBeenCalledTimes(1);
        expect(keyOf(0)).toMatch(OP_KEY_SHAPE);
        expect(keyOf(1)).toBe(keyOf(0));
        expect(refsOf(1)).toEqual([uploaded]);
    });

    it('"Make a copy" on a server that cannot de-duplicate creates re-copies for the retry', async () => {
        serverDedupes = false;
        const src = { href: 'sovereign-enc:src1?k=K&m=image%2Fpng', name: 'src.png' };
        const second = { href: 'sovereign-enc:up2?k=K&m=image%2Fpng', name: 'src.png' };
        H.resealRefs.mockResolvedValueOnce([uploaded]).mockResolvedValueOnce([second]);
        const plan = { title: 'Trip', body: 'text', noteRefs: [src], items: [], files: 1 };
        const c = await actionsFor();
        H.createTaskListWithContent.mockRejectedValueOnce(lost());
        expect(await c.createNoteFromPlan(plan)).toBeNull();
        expect(await c.createNoteFromPlan({ ...plan })).not.toBeNull();
        expect(H.resealRefs).toHaveBeenCalledTimes(2);
        expect(refsOf(1)).toEqual([second]);
        expect(H.deleteFiles).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: "Make a copy" refused outright deletes its copies', async () => {
        const src = { href: 'sovereign-enc:src1?k=K&m=image%2Fpng', name: 'src.png' };
        H.resealRefs.mockResolvedValue([uploaded]);
        const c = await actionsFor();
        H.createTaskListWithContent.mockRejectedValueOnce(new ApiError('Nope', 413));
        expect(await c.createNoteFromPlan({ title: 'Trip', body: '', noteRefs: [src], items: [], files: 1 })).toBeNull();
        expect(H.deleteFiles).toHaveBeenCalledWith(['up1']);
    });

    it('a picture added to a note whose save answer was lost keeps its upload', async () => {
        const c = await actionsFor();
        H.setTaskListAttachments.mockRejectedValueOnce(lost());
        expect(await c.addNoteMedia(1, [photo()], [])).toBe(false);
        expect(H.deleteFiles).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: a picture refused as STALE (nothing written) deletes its upload', async () => {
        const c = await actionsFor();
        H.setTaskListAttachments.mockRejectedValueOnce(new NoteConflictError(4, null, null, null));
        expect(await c.addNoteMedia(1, [photo()], [])).toBe(false);
        expect(H.deleteFiles).toHaveBeenCalledWith(['up1']);
    });
});
