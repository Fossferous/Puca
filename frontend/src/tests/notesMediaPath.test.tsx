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
}));

vi.mock('../api/noteMedia', async (orig) => {
    const real = await orig<typeof import('../api/noteMedia')>();
    return { ...real, uploadNoteMedia: H.uploadNoteMedia, sealNoteMedia: H.sealNoteMedia };
});
vi.mock('../api/listContent', async (orig) => {
    const real = await orig<typeof import('../api/listContent')>();
    return { ...real, setTaskListAttachments: H.setTaskListAttachments, deleteFiles: H.deleteFiles };
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
    };
});

import { useListContentActions, type ListContentActions } from '../notes/model/useListContent';
import { setMessageToastSink } from '../components/messageToastBus';
import type { NoteRef } from '../notes/model/notesModel';
import type { TaskList } from '../api/tasks';

const LISTS_KEY = ['notes', 'lists'];
const keys = { lists: LISTS_KEY, tasks: (ref: NoteRef) => ['notes', 'tasks', ref.kind, ref.id] };
const list: TaskList = { id: 1, title: 'Trip', created_at: '', total_tasks: 0, completed_tasks: 0, attachments: null };
const uploaded = { href: 'sovereign-enc:up1?k=K&m=image%2Fpng', name: 'plane.png' };
const sealed = { id: 'parked-1', name: 'plane.png', mime: 'image/png', key: 'K', data: btoa('cipher'), bytes: 10 };
const photo = () => new File(['bytes'], 'plane.png', { type: 'image/png' });

let root: Root | null = null;
let onLine = true;
let spy: ReturnType<typeof vi.spyOn> | null = null;

async function actionsFor(): Promise<ListContentActions> {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    qc.setQueryData<TaskList[]>(LISTS_KEY, [list]);
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
    H.uploadNoteMedia.mockResolvedValue([uploaded]);
    H.sealNoteMedia.mockResolvedValue([sealed]);
    H.sendNoteOp.mockResolvedValue({ queued: true });
    H.pendingOutboxCount.mockReturnValue(0);
    H.ensureOutboxLoaded.mockResolvedValue(undefined);
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
