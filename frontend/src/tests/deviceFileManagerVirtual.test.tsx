/**
 * The file browser's windowed list. A capped listing is still 5000 rows, and
 * mounting 5000 divs with per-row buttons froze the panel on a phone — so the
 * DOM must hold only the rows near the viewport, and scrolling must move the
 * window. The positive control (a small folder rendering whole) is what keeps
 * this from passing by rendering nothing at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const bigDir = Array.from({ length: 5000 }, (_, i) => ({
    name: `f${String(i).padStart(5, '0')}`,
    is_dir: false,
    size: 1,
}));

const smallDir = Array.from({ length: 20 }, (_, i) => ({
    name: `s${String(i).padStart(2, '0')}`,
    is_dir: false,
    size: 1,
}));

let dirEntries = bigDir;

vi.mock('../api/devices/fileTransfer', () => ({
    listRoots: async () => ['C:\\'],
    listDir: async () => ({ entries: [...dirEntries], truncated: false }),
    uploadFile: async () => { /* not exercised */ },
}));

vi.mock('../api/devices/session', () => {
    const session = {
        id: 'sess-1',
        fileScopeKind: 'policy',
        fileRoot: null,
        filesChannel: {},
        error: null,
    };
    return {
        activeSessions: () => [session],
        subscribeSessions: () => () => { /* unsubscribe */ },
        requestFileAccess: vi.fn(),
    };
});

vi.mock('../api/devices/deviceDownloads', () => ({
    startDeviceDownload: vi.fn(),
}));

import { DeviceFileManager } from '../components/DeviceFileManager';

const settle = () => act(() => new Promise<void>(r => setTimeout(r, 0)));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

/** Mount, then click through the single root so listDir's entries render. */
async function openDir() {
    await act(async () => root.render(<DeviceFileManager sessionId="sess-1" onClose={() => { /* noop */ }} />));
    await settle();
    const rootRow = container.querySelector('.dfm-entry') as HTMLElement;
    expect(rootRow, 'the granted root must render as a row').toBeTruthy();
    await act(async () => rootRow.click());
    await settle();
}

describe('DeviceFileManager windowed list', () => {
    it('renders a small window of a 5000-entry folder, and scrolling moves it', async () => {
        dirEntries = bigDir;
        await openDir();

        const rows = () => [...container.querySelectorAll('.dfm-entry')];
        expect(rows().length).toBeGreaterThan(0);
        expect(rows().length, 'the DOM must hold a window, not the folder').toBeLessThan(200);
        const firstBefore = rows()[0].querySelector('.dfm-name')!.textContent;
        expect(firstBefore).toBe('f00000');

        const list = container.querySelector('.dfm-list') as HTMLElement;
        await act(async () => {
            // 100 rows down at the 32px desktop row height.
            Object.defineProperty(list, 'scrollTop', { value: 3200, configurable: true });
            list.dispatchEvent(new Event('scroll'));
        });
        await settle();

        const firstAfter = rows()[0].querySelector('.dfm-name')!.textContent;
        expect(firstAfter).not.toBe(firstBefore);
        // floor(3200/32) - 8 overscan = row 92.
        expect(firstAfter).toBe('f00092');
    });

    it('renders a 20-entry folder in full (positive control)', async () => {
        dirEntries = smallDir;
        await openDir();
        const names = [...container.querySelectorAll('.dfm-name')].map(n => n.textContent);
        expect(names.length).toBe(20);
        expect(names[0]).toBe('s00');
        expect(names[19]).toBe('s19');
    });

    it('coarse pointer: rows carry the 48px height INLINE and the window math uses it', async () => {
        // The height once lived in CSS, where the cascade silently defeated
        // the coarse rule — rows were 32px while the math multiplied by 48,
        // leaving a blank strip and unreachable tail rows on every phone.
        // Inline style from the same constant is the fix this test pins.
        window.matchMedia = ((q: string) => ({
            matches: q.includes('pointer: coarse'),
            media: q, onchange: null,
            addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
            addListener() { /* noop */ }, removeListener() { /* noop */ }, dispatchEvent() { return false; },
        })) as unknown as typeof window.matchMedia;
        try {
            dirEntries = bigDir;
            await openDir();
            const row = container.querySelector('.dfm-entry') as HTMLElement;
            expect(row.style.height).toBe('48px');

            const list = container.querySelector('.dfm-list') as HTMLElement;
            await act(async () => {
                // 100 rows down at the 48px coarse row height.
                Object.defineProperty(list, 'scrollTop', { value: 4800, configurable: true });
                list.dispatchEvent(new Event('scroll'));
            });
            await settle();
            const first = container.querySelector('.dfm-name')!.textContent;
            // floor(4800/48) - 8 overscan = row 92.
            expect(first).toBe('f00092');
        } finally {
            delete (window as { matchMedia?: unknown }).matchMedia;
        }
    });
});
