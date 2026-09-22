/**
 * Share INTO Púca Notes, at the bridge: the payload arrives ONCE, an older
 * APK (or the browser) answers an empty one and never throws, and what the
 * page makes of a shared subject/text is the same rule the native side
 * applies (ShareIntake.java).
 *
 * The plugin is a fake behind a mocked @capacitor/core, the way
 * notesNative.test.ts does it; `pluginPresent` flipping is each test's
 * control against the other.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let pluginPresent = true;
let shareQueue: { text: string | null; subject: string | null; files: { url: string | null; name: string; mime: string; size: number }[] }[] = [];
const EMPTY = { text: null, subject: null, files: [] as { url: string | null; name: string; mime: string; size: number }[] };

const fake = {
    info: vi.fn(async () => ({ api: 2, features: ['shareIn'] })),
    consumeLaunchShare: vi.fn(async () => shareQueue.shift() ?? EMPTY),
    requestAddTile: vi.fn(async () => ({ ok: true })),
};

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => (pluginPresent ? 'android' : 'web'),
        isPluginAvailable: (name: string) => pluginPresent && name === 'NotesNative',
        isNativePlatform: () => pluginPresent,
    },
    registerPlugin: () => fake,
}));

const nn = await import('../notes/native/notesNative');
const { shapeSharedText } = await import('../notes/native/useNativeShareIn');

beforeEach(() => {
    pluginPresent = true;
    shareQueue = [];
    for (const f of Object.values(fake)) f.mockClear();
    localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the shared payload', () => {
    // The one-shot itself lives in Java (NotesNativePlugin.consumeLaunchShare
    // nulls pendingShare before it answers) and cannot be reached from here —
    // the fake queue is what empties. What this pins is THIS side of it: the
    // bridge hands the payload straight through and does not cache it, so a
    // second ask reports the empty answer instead of repeating the first.
    it('hands each answer through as it comes, and holds nothing back for the next ask', async () => {
        shareQueue = [{ text: 'Milk and bread', subject: null, files: [] }];
        await expect(nn.consumeNativeLaunchShare()).resolves.toEqual({ text: 'Milk and bread', subject: null, files: [] });
        await expect(nn.consumeNativeLaunchShare()).resolves.toEqual({ text: null, subject: null, files: [] });
        expect(fake.consumeLaunchShare).toHaveBeenCalledTimes(2);
    });

    it('an older APK (no such method) answers empty and does not throw', async () => {
        fake.consumeLaunchShare.mockRejectedValueOnce(new Error('method not implemented'));
        await expect(nn.consumeNativeLaunchShare()).resolves.toEqual({ text: null, subject: null, files: [] });
    });

    it('the browser never calls the plugin at all (negative control)', async () => {
        pluginPresent = false;
        shareQueue = [{ text: 'Milk and bread', subject: null, files: [] }];
        await expect(nn.consumeNativeLaunchShare()).resolves.toEqual({ text: null, subject: null, files: [] });
        expect(fake.consumeLaunchShare).not.toHaveBeenCalled();
    });

    it('nothing shared is ever written to browser storage', async () => {
        shareQueue = [{ text: 'Milk and bread', subject: 'Errand', files: [] }];
        await nn.consumeNativeLaunchShare();
        expect(JSON.stringify(localStorage)).not.toMatch(/Milk|Errand/);
    });

    it('a payload with no files still yields usable text', async () => {
        shareQueue = [{ text: 'Line one\nLine two', subject: null, files: [] }];
        const p = await nn.consumeNativeLaunchShare();
        expect(p.files).toEqual([]);
        expect(shapeSharedText(p.text, p.subject)).toEqual({ title: 'Line one', body: 'Line two' });
    });
});

describe('the shared files', () => {
    const payload = (files: { url: string | null; name: string; mime: string; size: number }[]) =>
        ({ text: null, subject: null, files });

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([new Uint8Array([1, 2, 3])]))));
    });

    it('only pictures reach the composer — the page has nowhere else to put a file', async () => {
        // A .txt shared as a STREAM (a file manager, not a text share): the
        // composer's one destination for a file is the picture list, so an
        // unfiltered one would be sealed and stored as a photo that no view
        // can render. The APK reads it into the body instead; this is the
        // page's own half of that rule.
        const files = await nn.fetchSharedFiles(payload([
            { url: 'https://localhost/_capacitor_file_/a/notes.txt', name: 'notes.txt', mime: 'text/plain', size: 3 },
            { url: 'https://localhost/_capacitor_file_/a/snap.png', name: 'snap.png', mime: 'image/png', size: 3 },
        ]));
        expect(files.map(f => f.name)).toEqual(['snap.png']);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith('https://localhost/_capacitor_file_/a/snap.png');
    });

    it('a picture is read over the app’s own origin, with its name and type (positive control)', async () => {
        const files = await nn.fetchSharedFiles(payload([
            { url: 'https://localhost/_capacitor_file_/a/snap.jpg', name: 'snap.jpg', mime: 'IMAGE/JPEG', size: 3 },
        ]));
        expect(files).toHaveLength(1);
        expect(files[0].name).toBe('snap.jpg');
        // A mime the filter had to lower-case to recognise still arrives as
        // the file's type (File normalises it, as the composer expects).
        expect(files[0].type).toBe('image/jpeg');
    });

    it('one file that cannot be read does not lose the rest of the share', async () => {
        vi.stubGlobal('fetch', vi.fn(async (u: string) => (u.endsWith('gone.png')
            ? new Response(null, { status: 404 })
            : new Response(new Blob([new Uint8Array([1])])))));
        const files = await nn.fetchSharedFiles(payload([
            { url: 'https://localhost/_capacitor_file_/a/gone.png', name: 'gone.png', mime: 'image/png', size: 1 },
            { url: 'https://localhost/_capacitor_file_/a/here.png', name: 'here.png', mime: 'image/png', size: 1 },
        ]));
        expect(files.map(f => f.name)).toEqual(['here.png']);
    });
});

describe('shapeSharedText (the same rule as ShareIntake.java)', () => {
    it('prefers the sender’s subject and keeps the whole text as the body', () => {
        expect(shapeSharedText('Flour\nEggs', 'Recipe')).toEqual({ title: 'Recipe', body: 'Flour\nEggs' });
    });

    it('with no subject, borrows the first line and does not repeat it in the body', () => {
        expect(shapeSharedText('Errand\nMilk\nBread', null)).toEqual({ title: 'Errand', body: 'Milk\nBread' });
    });

    it('a single line becomes the title and leaves the body empty', () => {
        expect(shapeSharedText('Milk and bread', null)).toEqual({ title: 'Milk and bread', body: '' });
    });

    it('a first line too long to be a title stays in the body', () => {
        const long = 'x'.repeat(140);
        expect(shapeSharedText(`${long}\nmore`, null)).toEqual({ title: '', body: `${long}\nmore` });
    });

    it('truncates a subject at the composer’s own limit', () => {
        expect(shapeSharedText('body', 'y'.repeat(140)).title).toHaveLength(100);
    });

    it('nothing shared shapes to nothing (the guard that stops an empty composer opening)', () => {
        expect(shapeSharedText(null, null)).toEqual({ title: '', body: '' });
    });
});

describe('the tile prompt', () => {
    it('reports what the system said', async () => {
        await expect(nn.requestNativeAddTile()).resolves.toBe(true);
        fake.requestAddTile.mockResolvedValueOnce({ ok: false });
        await expect(nn.requestNativeAddTile()).resolves.toBe(false);
    });

    it('an older APK without the method answers false, not a throw', async () => {
        fake.requestAddTile.mockRejectedValueOnce(new Error('method not implemented'));
        await expect(nn.requestNativeAddTile()).resolves.toBe(false);
    });
});
