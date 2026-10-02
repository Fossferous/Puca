/**
 * Paging in the file browser. A host answers a big folder one page at a time
 * (each page bounded in BYTES so it fits one data-channel message) and names
 * the next page's cursor; the browser offers "Load more" until there is none.
 * A host from before paging never names a next page, so the browser must fall
 * back to the old "the first N are listed" notice and offer no button that
 * could only ever re-fetch the same first page.
 *
 * The cursor is a POSITION in the host's enumeration, so a folder that changes
 * between pages shifts it. The browser asks each further page to start a few
 * entries early and resumes after the last name it already has; when that name
 * is not there to resume after, entries may have been skipped and it says so.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Entry = { name: string; is_dir: boolean; size: number };

const file = (name: string): Entry => ({ name, is_dir: false, size: 1 });
const dir = (name: string): Entry => ({ name, is_dir: true, size: 0 });

/** The mocked host's folder at C:\, in ITS enumeration order, paged exactly
 *  like the agent: `pageSize` entries from the cursor, and `next` = cursor +
 *  that many when the folder goes on. Tests mutate it between pages. */
let folder: Entry[];
let pageSize: number;
/** A host from before paging: one capped page, `truncated`, never a `next`. */
let oldHost: boolean;
/** Other folders, answered whole. */
let subfolders: Map<string, Entry[]>;
/** Every listDir call, for asserting what was asked. */
const calls: Array<{ path: string; cursor: number | undefined }> = [];
/** When set, the matching listDir call waits on `wait`. */
let gate: { matches: (path: string, cursor: number | undefined) => boolean; release: () => void; wait: Promise<void> } | null = null;

function makeGate(matches: (path: string, cursor: number | undefined) => boolean) {
    let release!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    gate = { matches, release, wait };
}

vi.mock('../api/devices/fileTransfer', () => ({
    listRoots: async () => ['C:\\'],
    listDir: async (_s: string, path: string, cursor?: number) => {
        calls.push({ path, cursor });
        if (gate && gate.matches(path, cursor)) await gate.wait;
        const sub = subfolders.get(path);
        if (sub) {
            return sub.length > pageSize
                ? { entries: sub.slice(0, pageSize).map(e => ({ ...e })), truncated: true, next: pageSize }
                : { entries: sub.map(e => ({ ...e })), truncated: false, next: null };
        }
        const start = cursor ?? 0;
        const entries = folder.slice(start, start + pageSize).map(e => ({ ...e }));
        const end = start + entries.length;
        if (oldHost) return { entries, truncated: end < folder.length, next: null };
        return end < folder.length
            ? { entries, truncated: true, next: end }
            : { entries, truncated: false, next: null };
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
    oldHost = false;
    pageSize = 3;
    subfolders = new Map();
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

async function clickLoadMore() {
    await act(async () => loadMore()!.click());
    await settle();
}

async function openRow(name: string) {
    const row = [...container.querySelectorAll('.dfm-entry')]
        .find(r => r.querySelector('.dfm-name')?.textContent === name) as HTMLElement;
    await act(async () => row.click());
}

/** The RENDERED rows: the list is windowed, so a long folder shows a slice. */
const names = () => [...container.querySelectorAll('.dfm-name')].map(n => n.textContent);
const ROW_H = 32; // jsdom has no matchMedia, so the desktop row height applies
const listEl = () => container.querySelector('.dfm-list') as HTMLElement;
/** The windowed list's spacer: its padding stands in for the unrendered rows. */
const spacer = () => [...listEl().children].find(c => (c as HTMLElement).style.paddingTop !== '') as HTMLElement;
async function scrollListTo(px: number) {
    await act(async () => {
        listEl().scrollTop = px;
        listEl().dispatchEvent(new Event('scroll'));
    });
}
/** EVERY row in display order, read by scrolling the window down the list,
 *  then back to where it was. */
async function allNames(): Promise<string[]> {
    const was = listEl().scrollTop;
    const out: string[] = [];
    for (let row = 0; row < 100_000; row += 20) {
        await scrollListTo(row * ROW_H);
        const first = Math.round(parseFloat(spacer().style.paddingTop || '0') / ROW_H);
        names().forEach((n, i) => { out[first + i] = n ?? ''; });
        if (parseFloat(spacer().style.paddingBottom || '0') === 0) break;
    }
    await scrollListTo(was);
    return out;
}
const loadMore = () => container.querySelector('button.dfm-load-more') as HTMLButtonElement | null;
const banner = () => container.querySelector('.dfm-has-more, .dfm-truncated')?.textContent ?? null;
const changedNotice = () => container.querySelector('.dfm-changed')?.textContent ?? null;
const header = () => container.querySelector('.dfm-header h3')?.textContent ?? null;

/** `count` files in host order, named so their sort order is their index. */
const files = (count: number, prefix = 'f') =>
    Array.from({ length: count }, (_, i) => file(`${prefix}${String(i).padStart(3, '0')}`));

/** Load every page the host offers; returns how many were fetched. */
async function loadAll(limit = 50) {
    let n = 0;
    while (loadMore()) {
        expect(n++, 'Load more must reach the end').toBeLessThan(limit);
        await clickLoadMore();
    }
    return n;
}

describe('DeviceFileManager Load more', () => {
    it('pages through a folder until the host names no next page', async () => {
        folder = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(file);
        await openRoot();
        expect(names()).toEqual(['a', 'b', 'c']);
        expect(loadMore(), 'a folder with more must offer Load more').toBeTruthy();
        expect(banner()).toContain('3');

        await clickLoadMore();
        // Each further page starts AT the last name already held, so the
        // browser can check the folder did not shift under it.
        expect(calls.at(-1)).toEqual({ path: 'C:\\', cursor: 2 });
        expect(names()).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(loadMore()).toBeTruthy();

        await clickLoadMore();
        expect(calls.at(-1)).toEqual({ path: 'C:\\', cursor: 4 });
        expect(names()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
        expect(loadMore(), 'the last page completes the folder').toBeNull();
        expect(banner(), 'a complete folder carries no partial-folder notice').toBeNull();
        expect(changedNotice(), 'an unchanged folder is not reported as changed').toBeNull();
    });

    it('an older host (truncated, no next) keeps the first-N notice and offers no Load more', async () => {
        folder = ['a', 'b', 'c', 'd'].map(file);
        pageSize = 2;
        oldHost = true;
        await openRoot();
        expect(names()).toEqual(['a', 'b']);
        expect(loadMore()).toBeNull();
        expect(banner()).toContain('the first 2 are listed');
    });

    it('a complete folder shows neither (positive control)', async () => {
        folder = [file('a')];
        await openRoot();
        expect(names()).toEqual(['a']);
        expect(loadMore()).toBeNull();
        expect(banner()).toBeNull();
    });

    it('the partial-folder banner does not read as a complete A-Z run', async () => {
        folder = files(10);
        await openRoot();
        // Pages arrive in the HOST's order (hash order on Linux, whatever a
        // phone's provider gives) and are shown sorted, so page one is an
        // arbitrary slice of the folder. The words must not imply otherwise.
        expect(banner()).toMatch(/anywhere in the list/);
    });

    it('a file created before the cursor between pages is shown once', async () => {
        folder = files(100);
        pageSize = 40;
        await openRoot();
        folder.splice(5, 0, file('new-download.tmp'));
        await loadAll();
        const shown = await allNames();
        expect(new Set(shown).size, 'no name twice').toBe(shown.length);
        for (const e of folder) {
            if (e.name !== 'new-download.tmp') expect(shown).toContain(e.name);
        }
        expect(changedNotice()).toBeNull();
    });

    it('a file deleted before the cursor between pages does not hide the next one', async () => {
        // The reviewer's case: a browser's temp file vanishes from a busy
        // Downloads folder while the user is reading page one. Every later
        // entry shifts back one place, and a plain resume-at-the-cursor never
        // sends the first entry of the next page.
        folder = files(100);
        pageSize = 40;
        await openRoot();
        folder.splice(5, 1); // f005 is gone
        await loadAll();
        const shown = await allNames();
        // f005 stays on screen: it was listed with page one, and nothing says
        // it went. Only a fresh listing (Refresh) drops it.
        expect(shown.length).toBe(folder.length + 1);
        for (const e of folder) expect(shown, `${e.name} must not be skipped`).toContain(e.name);
        expect(changedNotice(), 'resumed exactly; nothing to warn about').toBeNull();
    });

    it('a folder that shifted further than the overlap says entries may be missing', async () => {
        folder = files(100);
        pageSize = 40;
        await openRoot();
        folder.splice(0, 30); // more deletions before the cursor than any overlap absorbs
        await loadAll();
        expect(loadMore()).toBeNull();
        expect(
            changedNotice(),
            'a folder that may be missing entries must announce itself rather than look complete',
        ).toMatch(/changed while it was loading/);
    });

    it('rows the user is reading stay put when a page sorts rows above them', async () => {
        // Page two brings folders, which sort above every file. Without
        // keeping the row under the user's eye in place, everything they were
        // reading slides down and Load more looks like it did nothing.
        folder = [...files(60), dir('Archive'), dir('Backups'), ...files(20, 'g')];
        pageSize = 60;
        await openRoot();
        await scrollListTo(20 * ROW_H);
        const topRowName = () => {
            const first = Math.round(parseFloat(spacer().style.paddingTop || '0') / ROW_H);
            const top = Math.floor(listEl().scrollTop / ROW_H);
            return names()[top - first];
        };
        expect(topRowName()).toBe('f020');
        await clickLoadMore();
        expect(topRowName(), 'the row under the eye stays under the eye').toBe('f020');
        const all = await allNames();
        expect(all.slice(0, 2), 'the folders sorted in above it').toEqual(['Archive', 'Backups']);
        expect(all.length).toBe(folder.length);
    });

    it('a page that lands after the user moved to another folder is not mixed into it', async () => {
        folder = [dir('other'), file('a'), file('late-arrival')];
        pageSize = 2;
        subfolders.set('C:\\other', [file('elsewhere.txt')]);
        makeGate((path, cursor) => path === 'C:\\' && cursor !== undefined);
        await openRoot();
        await act(async () => loadMore()!.click());
        // Navigate into a subfolder while page 2 is still in flight.
        await openRow('other');
        await settle();
        expect(names()).toEqual(['elsewhere.txt']);
        await act(async () => { gate!.release(); });
        await settle();
        expect(names(), 'the stale page must be dropped').toEqual(['elsewhere.txt']);
    });

    it('a folder listing that lands after the user opened another folder is dropped', async () => {
        // Open "slow" (its answer held back), then "fast" while it is pending;
        // "slow" lands LAST. Its entries, path and Load more must not replace
        // the folder the user is now in.
        folder = [dir('fast'), dir('slow')];
        subfolders.set('C:\\slow', [file('s1'), file('s2'), file('s3'), file('s4')]);
        subfolders.set('C:\\fast', [file('fast.txt')]);
        makeGate(path => path === 'C:\\slow');
        await openRoot();
        await openRow('slow');
        await openRow('fast');
        await settle();
        expect(names()).toEqual(['fast.txt']);
        await act(async () => { gate!.release(); });
        await settle();
        expect(names(), 'the late listing must not replace the open folder').toEqual(['fast.txt']);
        expect(header()).toContain('C:\\fast');
        expect(loadMore(), 'nor bring its Load more with it').toBeNull();
    });
});
