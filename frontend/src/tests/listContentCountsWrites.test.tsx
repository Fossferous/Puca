/**
 * ListContentBlock and TasksTrash write a personal list without going
 * through TasksView's own handlers — the note's text, its pictures, a
 * restore, a delete for good — so each runs its write through the view's
 * count (`runWrite`, components/writesInFlight.ts). A write the count cannot
 * see is one a Refresh's answer, read before it landed, lands over: the old
 * text and revision back in the field, a restored list off the bar again, a
 * list deleted for good back in the trash (tasksViewRefreshRaces.test.tsx
 * shows those on the whole view). Here each write is pinned to the count,
 * from its call until it lands — the picture save's only pin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { setAttachments, setBody, restore, forever } = vi.hoisted(() => ({
    setAttachments: vi.fn(), setBody: vi.fn(), restore: vi.fn(), forever: vi.fn(),
}));
vi.mock('../api/listContent', async () => {
    const real = await vi.importActual<typeof import('../api/listContent')>('../api/listContent');
    return {
        ...real,
        setTaskListAttachments: setAttachments, setTaskListBody: setBody,
        restoreTaskList: restore, deleteListForever: forever,
        deleteFiles: vi.fn(async () => undefined),
    };
});
// The pictures are decrypted elsewhere; these tests are about the saves.
vi.mock('../api/attachments', async () => {
    const real = await vi.importActual<typeof import('../api/attachments')>('../api/attachments');
    return { ...real, decryptToBlobUrl: vi.fn(async () => 'blob:x') };
});

import { ListContentBlock, TasksTrash } from '../components/ListContentBlock';
import { flushBodySave, type ListFeatures } from '../api/listContent';
import { type TaskAttachmentRef, type TaskList } from '../api/tasks';
import { type WritesInFlight, writesInFlight } from '../components/writesInFlight';

const FEATURES: ListFeatures = {
    body: true, attachments: true, trash: true, noteReminders: false, trashRetentionDays: 30, maxBodyLen: 65536,
    serverClockOffsetMs: 0, contentRev: true, idempotentCreates: true,
};
const photo: TaskAttachmentRef = { href: `sovereign-enc:photo?k=${'A'.repeat(43)}&m=${encodeURIComponent('image/png')}`, name: 'photo.png' };
const list = (over: Partial<TaskList> = {}): TaskList => ({
    id: 5, title: 'Note', created_at: '2026-09-01T00:00:00Z', body: null, attachments: null, content_rev: 1, ...over,
} as unknown as TaskList);

/** A save the test lands by hand. */
function pending<T>(value: T) {
    let land!: () => void;
    const p = new Promise<T>(r => { land = () => r(value); });
    return { p, land: () => land() };
}

let root: Root;
let host: HTMLDivElement;
let w: WritesInFlight;
beforeEach(() => {
    setAttachments.mockReset(); setBody.mockReset(); restore.mockReset(); forever.mockReset();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    w = writesInFlight();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); });
const button = (label: string) => {
    const b = [...host.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === label || x.textContent === label);
    expect(b, `the "${label}" button`).toBeTruthy();
    return b!;
};

describe('the writes beside TasksView run through its count', () => {
    it('the note\'s text save counts from its call until it lands', async () => {
        const save = pending(2);
        setBody.mockReturnValueOnce(save.p);
        await act(async () => { root.render(<ListContentBlock list={list()} features={FEATURES} onPatch={() => {}} coarse={false} runWrite={w.run} />); });
        const area = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note text"]')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'New words');
            area.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const mark = w.mark();
        const saving = flushBodySave(5);
        await flush();
        expect(setBody).toHaveBeenCalledTimes(1);
        expect(w.since(mark)).toBe(true);
        let settled: boolean | null = null;
        const waiting = w.settled(60_000).then(v => { settled = v; });
        await flush();
        expect(settled).toBeNull();
        save.land();
        await act(async () => { await saving; await waiting; });
        expect(settled).toBe(true);
    });

    it('a picture\'s save (the sidecar) counts from its call until it lands', async () => {
        const save = pending(2);
        setAttachments.mockReturnValueOnce(save.p);
        await act(async () => { root.render(<ListContentBlock list={list({ attachments: JSON.stringify([photo]) })} features={FEATURES} onPatch={() => {}} coarse={false} runWrite={w.run} />); });
        await flush();
        const mark = w.mark();
        await act(async () => { button('Remove picture').click(); });
        await flush();
        expect(setAttachments).toHaveBeenCalledTimes(1);
        expect(w.since(mark)).toBe(true);
        let settled: boolean | null = null;
        const waiting = w.settled(60_000).then(v => { settled = v; });
        await flush();
        expect(settled).toBeNull();
        save.land();
        await act(async () => { await waiting; });
        expect(settled).toBe(true);
    });

    it('a restore from the trash, and a delete for good, each count until they land', async () => {
        const back = pending({ trashed_at: null });
        const goneForGood = pending(undefined);
        restore.mockReturnValueOnce(back.p);
        forever.mockReturnValueOnce(goneForGood.p);
        const qc = new QueryClient();
        const trashed = [list({ id: 7, title: 'Seven', trashed_at: '2026-09-20T00:00:00Z' }), list({ id: 8, title: 'Eight', trashed_at: '2026-09-20T00:00:00Z' })];
        await act(async () => { root.render(<QueryClientProvider client={qc}><TasksTrash features={FEATURES} trashed={trashed} onRestored={() => {}} runWrite={w.run} /></QueryClientProvider>); });
        await act(async () => { host.querySelector<HTMLButtonElement>('.tasks-trash-toggle')!.click(); });

        let mark = w.mark();
        await act(async () => { host.querySelectorAll<HTMLButtonElement>('.tasks-trash-row')[0].querySelector<HTMLButtonElement>('.tasks-trash-btn')!.click(); });
        expect(restore).toHaveBeenCalledWith(7);
        expect(w.since(mark)).toBe(true);
        back.land();
        await flush();
        expect(await w.settled(60_000)).toBe(true);

        mark = w.mark();
        await act(async () => { host.querySelectorAll<HTMLButtonElement>('.tasks-trash-row')[1].querySelector<HTMLButtonElement>('.tasks-trash-btn.danger')!.click(); });
        expect(forever).toHaveBeenCalledTimes(1);
        expect(w.since(mark)).toBe(true);
        goneForGood.land();
        await flush();
        expect(await w.settled(60_000)).toBe(true);
    });

    it('positive control: with no count handed over, the saves still go out and land', async () => {
        setAttachments.mockResolvedValueOnce(2);
        await act(async () => { root.render(<ListContentBlock list={list({ attachments: JSON.stringify([photo]) })} features={FEATURES} onPatch={() => {}} coarse={false} />); });
        await flush();
        const mark = w.mark();
        await act(async () => { button('Remove picture').click(); });
        await flush();
        expect(setAttachments).toHaveBeenCalledTimes(1);
        // Nobody else's count moved.
        expect(w.since(mark)).toBe(false);
    });
});
