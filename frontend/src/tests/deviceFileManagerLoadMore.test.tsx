/**
 * Paging in the file browser. A host answers a big folder one page at a time
 * (each page bounded in BYTES so it fits one data-channel message) and names
 * the next page's cursor; the browser offers "Load more" until there is none.
 * A host from before paging never names a next page, so the browser must fall
 * back to the old "the first N are listed" notice and offer no button that
 * could only ever re-fetch the same first page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Entry = { name: string; is_dir: boolean; size: number };
type Page = { entries: Entry[]; truncated: boolean; next: number | null };

const file = (name: string): Entry => ({ name, is_dir: false, size: 1 });

/** What the mocked host answers, by cursor (undefined = first page). */
let pages: Map<number | undefined, Page>;
/** Every listDir call, for asserting what was asked. */
const calls: Array<{ path: string; cursor: number | undefined }> = [];
/** When set, listDir for this cursor waits on the returned promise. */
let gate: { cursor: number; release: () => void; wait: Promise<void> } | null = null;

vi.mock('../api/devices/fileTransfer', () => ({
    listRoots: async () => ['C:\\'],
    listDir: async (_s: string, path: string, cursor?: number) => {
        calls.push({ path, cursor });
        if (gate && gate.cursor === cursor) await gate.wait;
        if (path.endsWith('\\other')) return { entries: [file('elsewhere.txt')], truncated: false, next: null };
        const p = pages.get(cursor);
        if (!p) throw new Error(`no page for cursor ${String(cursor)}`);
        return { entries: p.entries.map(e => ({ ...e })), truncated: p.truncated, next: p.next };
    },
    uploadFile: async () => { /* not exercised */ },
}));

vi.mock('../api/devices/session', () => {
    const session = { id: 'sess-1', fileScopeKind: 'policy', fileRoot: null, filesChannel: {}, error: null };
    return {
        activeSessions: () => [session],
        subscribeSessions: () => () => { /* unsubscribe */ },
        requestFileAccess: vi.fn(),
    };
});

vi.mock('../api/devices/deviceDownloads', () => ({ startDeviceDownload: vi.fn() }));

import { DeviceFileManager } from '../components/DeviceFileManager';

const settle = () => act(() => new Promise<void>(r => setTimeout(r, 0)));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    calls.length = 0;
    gate = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

async function openRoot() {
    await act(async () => root.render(<DeviceFileManager sessionId="sess-1" onClose={() => { /* noop */ }} />));
    await settle();
    const rootRow = container.querySelector('.dfm-entry') as HTMLElement;
    await act(async () => rootRow.click());
    await settle();
}

const names = () => [...container.querySelectorAll('.dfm-name')].map(n => n.textContent);
const loadMore = () => container.querySelector('button.dfm-load-more') as HTMLButtonElement | null;
const banner = () => container.querySelector('.dfm-truncated')?.textContent ?? null;

describe('DeviceFileManager Load more', () => {
    it('pages through a folder until the host names no next page', async () => {
        pages = new Map<number | undefined, Page>([
            [undefined, { entries: [file('a'), file('b'), file('c')], truncated: true, next: 3 }],
            [3, { entries: [file('d'), file('e'), file('f')], truncated: true, next: 6 }],
            [6, { entries: [file('g')], truncated: false, next: null }],
        ]);
        await openRoot();
        expect(names()).toEqual(['a', 'b', 'c']);
        expect(loadMore(), 'a folder with more must offer Load more').toBeTruthy();
        expect(banner()).toContain('3');

        await act(async () => loadMore()!.click());
        await settle();
        expect(calls.at(-1)).toEqual({ path: 'C:\\', cursor: 3 });
        expect(names()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        expect(loadMore()).toBeTruthy();

        await act(async () => loadMore()!.click());
        await settle();
        expect(calls.at(-1)).toEqual({ path: 'C:\\', cursor: 6 });
        expect(names()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
        expect(loadMore(), 'the last page completes the folder').toBeNull();
        expect(banner(), 'a complete folder carries no partial-folder notice').toBeNull();
    });

    it('an older host (truncated, no next) keeps the first-N notice and offers no Load more', async () => {
        pages = new Map<number | undefined, Page>([
            [undefined, { entries: [file('a'), file('b')], truncated: true, next: null }],
        ]);
        await openRoot();
        expect(names()).toEqual(['a', 'b']);
        expect(loadMore()).toBeNull();
        expect(banner()).toContain('the first 2 are listed');
    });

    it('a complete folder shows neither (positive control)', async () => {
        pages = new Map<number | undefined, Page>([
            [undefined, { entries: [file('a')], truncated: false, next: null }],
        ]);
        await openRoot();
        expect(names()).toEqual(['a']);
        expect(loadMore()).toBeNull();
        expect(banner()).toBeNull();
    });

    it('an entry repeated across pages (the folder changed) is shown once', async () => {
        pages = new Map<number | undefined, Page>([
            [undefined, { entries: [file('a'), file('b')], truncated: true, next: 2 }],
            [2, { entries: [file('b'), file('c')], truncated: false, next: null }],
        ]);
        await openRoot();
        await act(async () => loadMore()!.click());
        await settle();
        expect(names()).toEqual(['a', 'b', 'c']);
    });

    it('a page that lands after the user moved to another folder is not mixed into it', async () => {
        pages = new Map<number | undefined, Page>([
            [undefined, {
                entries: [{ name: 'other', is_dir: true, size: 0 }, file('a')],
                truncated: true,
                next: 2,
            }],
            [2, { entries: [file('late-arrival')], truncated: false, next: null }],
        ]);
        let release!: () => void;
        const wait = new Promise<void>(r => { release = r; });
        gate = { cursor: 2, release, wait };
        await openRoot();
        await act(async () => loadMore()!.click());
        // Navigate into a subfolder while page 2 is still in flight.
        const other = [...container.querySelectorAll('.dfm-entry')]
            .find(r => r.querySelector('.dfm-name')?.textContent === 'other') as HTMLElement;
        await act(async () => other.click());
        await settle();
        expect(names()).toEqual(['elsewhere.txt']);
        await act(async () => { gate!.release(); });
        await settle();
        expect(names(), 'the stale page must be dropped').toEqual(['elsewhere.txt']);
    });
});
