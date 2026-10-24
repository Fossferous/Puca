// @vitest-environment jsdom
/**
 * api/saveAttachment.ts in an iPhone or iPad Home Screen app: the share sheet
 * (whose "Save to Files" / "Save Image" are iOS's saves there) first, the
 * transient anchor as the fallback; a Safari tab, Android and the desktop
 * keep exactly the path they had.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => false,
    isMobile: () => false,
}));

import { saveAttachment } from '../api/saveAttachment';

type Nav = Omit<Navigator, 'share' | 'canShare'> & { standalone?: boolean; share?: unknown; canShare?: unknown };
const nav = navigator as unknown as Nav;
let anchorClicks: string[];
let share: ReturnType<typeof vi.fn>;

function homeScreen(on: boolean) {
    Object.defineProperty(nav, 'standalone', { configurable: true, value: on });
}

beforeEach(() => {
    anchorClicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        anchorClicks.push(this.download);
    });
    // A Response wrapping a jsdom Blob crosses realms and stringifies it.
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['hello'], { type: 'text/plain' }) })));
    share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(nav, 'share', { configurable: true, value: share });
    Object.defineProperty(nav, 'canShare', { configurable: true, value: () => true });
});

afterEach(() => {
    delete nav.standalone;
    delete nav.share;
    delete nav.canShare;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('saveAttachment in a Home Screen app', () => {
    it('hands the FILE, under its name, to the share sheet, and clicks no anchor', async () => {
        homeScreen(true);
        const r = await saveAttachment('blob:x', 'notes.txt');
        expect(share).toHaveBeenCalledTimes(1);
        const files = (share.mock.calls[0][0] as { files: File[] }).files;
        expect(files).toHaveLength(1);
        expect(files[0].name).toBe('notes.txt');
        expect(files[0].size).toBe(5);
        expect(files[0].type).toBe('text/plain');
        expect(anchorClicks).toEqual([]);
        expect(r).toEqual({ where: 'notes.txt', onDisk: false });
    });

    it('a dismissed share sheet is a cancel, not a save', async () => {
        homeScreen(true);
        share.mockRejectedValue(Object.assign(new Error('cancel'), { name: 'AbortError' }));
        const r = await saveAttachment('blob:x', 'notes.txt');
        expect(r.cancelled).toBe(true);
        expect(anchorClicks).toEqual([]);
    });

    it('a refused share (the tap\'s permission spent) falls back to the anchor', async () => {
        homeScreen(true);
        share.mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
        await saveAttachment('blob:x', 'notes.txt');
        expect(anchorClicks).toEqual(['notes.txt']);
    });

    it('an iOS that cannot share files falls back to the anchor', async () => {
        homeScreen(true);
        Object.defineProperty(nav, 'canShare', { configurable: true, value: () => false });
        await saveAttachment('blob:x', 'notes.txt');
        expect(share).not.toHaveBeenCalled();
        expect(anchorClicks).toEqual(['notes.txt']);
    });

    it('CONTROL: a Safari tab (and Android, desktop) keeps the anchor even where share exists', async () => {
        homeScreen(false);
        await saveAttachment('blob:x', 'notes.txt');
        expect(share).not.toHaveBeenCalled();
        expect(anchorClicks).toEqual(['notes.txt']);
    });
});
