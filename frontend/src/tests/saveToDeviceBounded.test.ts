/**
 * No file write on a phone may send an unbounded string over the Capacitor
 * bridge.
 *
 * The bug: tapping Download on a 92 MB clip CLOSED the Android app. The whole
 * file went to Filesystem.writeFile as ONE base64 string; Capacitor's
 * MessageHandler parses each bridge message whole on the UI thread, and the
 * 128,625,344-byte allocation for that string threw OutOfMemoryError outside
 * the plugin's catch (Exception) — process gone (reproduced on a headless
 * emulator, docs in the commit). Smaller-but-large files hit the caught half:
 * a 0-byte file and a misleading "Android 10 permission" error.
 *
 * Every phone write therefore goes out in slices: writeFile for the first,
 * appendFile for the rest, each one at most BRIDGE_MAX_CHARS characters, and a
 * failure part-way deletes what was written so nothing half-written is left
 * wearing the real name. The bound is a literal here, not imported: the test
 * must not be able to pass by the module raising its own constant.
 *
 * Covered entry points: saveAttachment (both Android apps), the account
 * export (saveExportFile → saveTextToDevice) and the Notes export
 * (saveNotesExport → saveTextToDevice). The clip download has its own file
 * (clipDownloadAndroid.test.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeCapacitorFs, patternBytes, pluginError, PERMISSION_DENIED } from './fixtures/fakeCapacitorFs';

/** 3 MiB of raw bytes is exactly 4 MiB of base64. A bridge message of this
 *  size costs the Java heap a few tens of MB at most, against the ~96 MB a
 *  92 MB clip needed before it died — and the P2P download sink
 *  (capacitorSink.ts) has shipped 4 MiB-raw writes, i.e. larger messages than
 *  this, since its throughput audit. */
const BRIDGE_MAX_CHARS = 4 * 1024 * 1024;
/** Raw bytes per bridge call the slicing should reach. Every call is a
 *  stop-and-wait round trip PLUS a MediaScanner scan of the file (the plugin
 *  scans after every write to external storage, Documents included), so
 *  slices far smaller than the bound multiply both for nothing. */
const SLICE_RAW_BYTES = 3 * 1024 * 1024;

const fs = vi.hoisted(() => ({ current: null as ReturnType<typeof import('./fixtures/fakeCapacitorFs').fakeCapacitorFs> | null }));
let android = true;
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => (android ? 'android' : 'web'),
        isPluginAvailable: (n: string) => android && n === 'Filesystem',
        isNativePlatform: () => android,
    },
    registerPlugin: () => ({}),
}));
vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        writeFile: (o: never) => fs.current!.api.writeFile(o),
        appendFile: (o: never) => fs.current!.api.appendFile(o),
        deleteFile: (o: never) => fs.current!.api.deleteFile(o),
        rename: (o: never) => fs.current!.api.rename(o),
    },
    Directory: { Documents: 'DOCUMENTS' },
    Encoding: { UTF8: 'utf8' },
}));
vi.mock('../api/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isMobile: () => android,
    isTauri: () => false,
}));

const { saveAttachment } = await import('../api/saveAttachment');
const { saveTextToDevice, saveStreamToDevice, DeviceWriteError, DEVICE_WRITE_CHUNK_CHARS } = await import('../api/saveToDevice');
const { saveExportFile } = await import('../api/accountExport');
const { saveNotesExport } = await import('../notes/model/noteText');

/** blob: URL → bytes, for saveAttachment's fetch(blobUrl). Built by hand:
 *  jsdom's Blob has no arrayBuffer() and undici's Response cannot read it. */
const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
function blobUrlOf(bytes: Uint8Array<ArrayBuffer>): string {
    const url = `blob:test/${blobs.size + 1}`;
    blobs.set(url, bytes);
    return url;
}

let disk: ReturnType<typeof fakeCapacitorFs>;
beforeEach(() => {
    android = true;
    disk = fakeCapacitorFs();
    fs.current = disk;
    blobs.clear();
    globalThis.fetch = vi.fn(async (u: string | URL | Request) => {
        const b = blobs.get(String(u));
        if (!b) throw new Error(`unexpected fetch ${String(u)}`);
        return new Response(b);
    }) as unknown as typeof fetch;
});

/** Path of the one file left on the fake disk, from the reported "where". */
const pathOf = (where: string) => where.replace(/^Documents\//, '');

describe('saveAttachment on Android — a large file never crosses the bridge whole', () => {
    it('60 MB: every bridge call is bounded, and the file on disk is the input byte for byte', async () => {
        const input = patternBytes(60 * 1024 * 1024 + 7, 3); // +7: a ragged tail
        const r = await saveAttachment(blobUrlOf(input), 'clip.mp4');

        expect(r.onDisk).toBe(true);
        expect(r.where).toMatch(/^Documents\/Puca\/clip-\d{8}-\d{6}\.mp4$/);
        expect(disk.maxChars(), 'largest single bridge message, in characters').toBeLessThanOrEqual(BRIDGE_MAX_CHARS);
        const ops = disk.calls.map(c => c.op);
        expect(ops[0]).toBe('writeFile'); // creates/truncates
        expect(ops.slice(1, -1).every(o => o === 'appendFile')).toBe(true);
        expect(ops.at(-1)).toBe('rename'); // .part -> the real name, once complete
        expect(disk.calls.every(c => c.directory === 'DOCUMENTS' && c.encoding === undefined)).toBe(true);
        const onDisk = disk.read(pathOf(r.where));
        expect(onDisk?.length).toBe(input.length);
        expect(onDisk!.equals(Buffer.from(input.buffer, input.byteOffset, input.byteLength))).toBe(true);
        expect([...disk.files.keys()]).toEqual([pathOf(r.where)]); // nothing else left behind
        // Not needlessly many round trips: each one also costs a media scan.
        const writes = disk.calls.filter(c => c.op === 'writeFile' || c.op === 'appendFile');
        expect(writes.length, 'write calls for 60 MB').toBeLessThanOrEqual(Math.ceil(input.length / SLICE_RAW_BYTES));
    }, 120_000);

    it('a write that fails part-way deletes what it wrote and says so — never "saved", never a crash', async () => {
        const input = patternBytes(10 * 1024 * 1024, 5); // four slices; the third fails
        disk.failOn((n) => (n === 3 ? new Error('OS-PLUG-FILE-0013') : null));
        await expect(saveAttachment(blobUrlOf(input), 'big.bin')).rejects.toThrow(/Could not save the file/);
        expect(disk.calls.filter(c => c.op !== 'deleteFile').length, 'stopped at the failing call').toBe(3);
        expect(disk.calls.some(c => c.op === 'deleteFile')).toBe(true);
        expect(disk.files.size, 'no half-written file left wearing the real name').toBe(0);
    });

    it('positive control: a small attachment is still ONE writeFile, as before', async () => {
        const input = patternBytes(1000, 9);
        const r = await saveAttachment(blobUrlOf(input), 'photo.jpg');
        expect(disk.calls.map(c => c.op)).toEqual(['writeFile']);
        expect(disk.read(pathOf(r.where))!.equals(Buffer.from(input))).toBe(true);
    });

    it('an empty file still exists after the save', async () => {
        const r = await saveAttachment(blobUrlOf(new Uint8Array(0)), 'empty.txt');
        expect(disk.read(pathOf(r.where))?.length).toBe(0);
    });
});

/*
 * Two saves of the same name in the same second. timestampedName is unique per
 * SECOND, and the per-button busy guards do not stop two different buttons (two
 * pasted "image.png" attachments, or one clip rendered twice). With one
 * writeFile per save the last writer simply won; with writeFile + appendFile
 * per slice, save B's writeFile truncates in the middle of save A's appends and
 * both then append into one file — corrupt, and both report "Saved to" it.
 */
describe('two saves of the same name at once (same second)', () => {
    const NOON = new Date(2026, 9, 2, 12, 0, 0);
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] }); // freeze the clock only; setTimeout stays real
        vi.setSystemTime(NOON);
        disk = fakeCapacitorFs({ latencyMs: 1 }); // a real round trip: the saves interleave
        fs.current = disk;
    });
    afterEach(() => { vi.useRealTimers(); });

    /** Each save starts once the previous one is part-way through its bridge
     *  calls — two taps, not one tick. (Starting them in the same tick also
     *  trips a vitest quirk: concurrent first `import()`s of a vi.mock'ed
     *  module hand all but one the REAL module, here a "web" Capacitor.) */
    async function staggered<T>(starts: Array<() => Promise<T>>): Promise<PromiseSettledResult<T>[]> {
        const running: Promise<T>[] = [];
        for (const start of starts) {
            const before = disk.calls.length;
            running.push(start());
            for (let i = 0; i < 5000 && disk.calls.length === before; i++) await new Promise(r => setTimeout(r, 1));
        }
        return Promise.allSettled(running);
    }

    it('each save gets its own file, byte for byte, and each reports its own path', async () => {
        const inputs = [patternBytes(7 * 1024 * 1024 + 100, 21), patternBytes(7 * 1024 * 1024 + 200, 22), patternBytes(2 * 1024 * 1024, 23)];
        const settled = await staggered(inputs.map(b => () => saveAttachment(blobUrlOf(b), 'image.jpg')));
        expect(settled.map(r => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
        // The saves really overlapped: the second began before the first finished.
        const firstPath = disk.calls[0].path;
        const firstDone = disk.calls.map(c => c.path).lastIndexOf(firstPath);
        expect(disk.calls.slice(0, firstDone).some(c => c.path !== firstPath || c.op === 'writeFile' && c !== disk.calls[0]), 'interleaved').toBe(true);

        const wheres = settled.map(r => (r as PromiseFulfilledResult<{ where: string }>).value.where);
        expect(new Set(wheres).size, `reported paths: ${wheres.join(', ')}`).toBe(3);
        expect(wheres[0]).toBe('Documents/Puca/image-20261002-120000.jpg'); // the first keeps the plain name
        for (let i = 0; i < inputs.length; i++) {
            const onDisk = disk.read(pathOf(wheres[i]));
            expect(onDisk?.length, `file ${i} length`).toBe(inputs[i].length);
            expect(onDisk!.equals(Buffer.from(inputs[i])), `file ${i} is its own input`).toBe(true);
        }
        expect(disk.files.size).toBe(3);
    }, 60_000);

    it("a second save that fails cannot delete the first save's file", async () => {
        const a = patternBytes(7 * 1024 * 1024 + 100, 31);
        const b = patternBytes(1000, 32);
        let writeFiles = 0;
        disk.failOn((_n, op) => (op === 'writeFile' && ++writeFiles === 2 ? new Error('OS-PLUG-FILE-0013') : null));
        const [ra, rb] = await staggered([() => saveAttachment(blobUrlOf(a), 'image.jpg'), () => saveAttachment(blobUrlOf(b), 'image.jpg')]);

        expect(rb.status).toBe('rejected');
        expect(ra.status).toBe('fulfilled');
        const where = (ra as PromiseFulfilledResult<{ where: string }>).value.where;
        expect(disk.read(pathOf(where))?.equals(Buffer.from(a)), 'the first save is intact').toBe(true);
        expect([...disk.files.keys()]).toEqual([pathOf(where)]);
    }, 60_000);
});

/** Text with a surrogate pair straddling every slice boundary a naive cut
 *  would make, plus 2- and 3-byte UTF-8 characters. Positioned on the
 *  module's OWN slice size: the point is to land a pair on its cut. */
function awkwardText(minChars: number): string {
    const parts: string[] = [];
    let n = 0;
    const unit = 'a'.repeat(DEVICE_WRITE_CHUNK_CHARS - 1) + '\u{1F600}' + 'é€\n';
    while (n < minChars) { parts.push(unit); n += unit.length; }
    return parts.join('');
}

describe('text written on Android — the account export and the Notes export', () => {
    it('saveTextToDevice: bounded slices, never splitting a surrogate pair, UTF-8 intact', async () => {
        const text = awkwardText(5 * BRIDGE_MAX_CHARS);
        const r = await saveTextToDevice('Puca', 'big.json', text);
        expect(disk.maxChars()).toBeLessThanOrEqual(BRIDGE_MAX_CHARS);
        expect(disk.calls.length).toBeGreaterThan(1);
        expect(disk.calls.every(c => c.directory === 'DOCUMENTS')).toBe(true);
        expect(disk.calls.filter(c => c.op !== 'rename').every(c => c.encoding === 'utf8')).toBe(true);
        expect(disk.read(pathOf(r.where))!.toString('utf8')).toBe(text);
        // A slice that ended between the halves of a pair would have been
        // written as two U+FFFD replacement characters.
        expect(disk.read(pathOf(r.where))!.includes(Buffer.from('�', 'utf8'))).toBe(false);
    });

    it('account export (saveExportFile): a large export is written in bounded slices', async () => {
        const doc = { messages: Array.from({ length: 30_000 }, (_, i) => ({ id: i, body: `message ${i} ` + 'x'.repeat(120) + ' \u{1F600}' })) };
        const r = await saveExportFile(doc, 'w1clipdl-user');
        expect(r.where).toMatch(/^Documents\/Puca\/puca-export-w1clipdl-user-\d{4}-\d{2}-\d{2}\.json$/);
        expect(disk.maxChars()).toBeLessThanOrEqual(BRIDGE_MAX_CHARS);
        expect(JSON.parse(disk.read(pathOf(r.where))!.toString('utf8'))).toEqual(doc);
    });

    it('Notes export (saveNotesExport): bounded slices, and a failure deletes the partial file', async () => {
        const text = awkwardText(3 * BRIDGE_MAX_CHARS);
        const r = await saveNotesExport('puca-notes-2026-10-02.md', text, 'text/markdown');
        expect(disk.maxChars()).toBeLessThanOrEqual(BRIDGE_MAX_CHARS);
        expect(disk.read(pathOf(r.where))!.toString('utf8')).toBe(text);

        disk.reset();
        disk.failOn((n) => (n === 2 ? new Error('ENOSPC') : null));
        await expect(saveNotesExport('puca-notes-2026-10-02.md', text, 'text/markdown')).rejects.toThrow(/Could not save the export/);
        expect(disk.files.size).toBe(0);
    });

    it('positive control: short text is one writeFile with the text as given', async () => {
        await saveTextToDevice('Puca Notes', 'n.md', 'hello');
        expect(disk.calls).toEqual([expect.objectContaining({ op: 'writeFile', path: 'Puca Notes/n.md', chars: 5, encoding: 'utf8' })]);
    });
});

/*
 * Where a save writes, and what a failure may clean up (adversarial review of
 * the first version of this fix). A save that takes several bridge calls must
 * not leave a truncated file under the REAL name if the app dies part-way —
 * the plugin media-scans after every call, so a half-written mp4 was visible
 * in Files and Gallery during the save and stayed there after a kill. And a
 * failure's cleanup may only ever delete what this save created: on Android 10
 * and older a storage-permission DENIAL is answered by the plugin before
 * anything is written, and a cleanup deleteFile there both re-prompts for the
 * permission and, if granted, deletes whatever already wore the name (the
 * account export's name is per DAY, so an earlier export from today).
 */
describe('a save leaves nothing it did not finish, and deletes nothing it did not write', () => {
    it('a multi-call save streams into <name>.part; only the final rename gives it the real name', async () => {
        const input = patternBytes(10 * 1024 * 1024 + 3, 41);
        const r = await saveAttachment(blobUrlOf(input), 'video.mp4');
        const real = pathOf(r.where);
        const writes = disk.calls.filter(c => c.op === 'writeFile' || c.op === 'appendFile');
        expect(writes.length).toBeGreaterThan(1);
        expect(writes.every(c => c.path === `${real}.part`), `write paths: ${[...new Set(writes.map(c => c.path))].join(', ')}`).toBe(true);
        expect(disk.calls.at(-1)).toMatchObject({ op: 'rename', path: `${real}.part`, to: real, directory: 'DOCUMENTS' });
        expect(disk.read(real)!.equals(Buffer.from(input))).toBe(true);
        expect([...disk.files.keys()]).toEqual([real]);
    });

    it('the app dying part-way leaves a .part, never a truncated file under the real name', async () => {
        // JS stops mid-save (process killed): the producer simply never
        // finishes. What is on disk at that moment is what the user finds.
        const slice = patternBytes(3 * 1024 * 1024, 43);
        let wrote = 0;
        void saveStreamToDevice('Puca', 'puca-clip-0000abcd-20261002-120000.mp4', async (write) => {
            await write(slice); await write(slice); await write(slice);
            wrote = 3;
            await new Promise(() => { /* killed */ });
        });
        for (let i = 0; i < 200 && wrote < 3; i++) await new Promise(r => setTimeout(r, 1));
        expect(wrote).toBe(3);
        expect(disk.bytesOnDisk(), 'part of the clip was written').toBeGreaterThan(0);
        expect([...disk.files.keys()]).toEqual(['Puca/puca-clip-0000abcd-20261002-120000.mp4.part']);
    });

    it('storage permission denied on the first write: no cleanup call, and the earlier same-day export is untouched', async () => {
        const doc = { messages: [{ id: 1, body: 'kept' }] };
        const first = await saveExportFile(doc, 'w1clipdl-user');
        const earlier = disk.read(pathOf(first.where))!;
        disk.calls.length = 0;
        disk.failOn((n) => (n === 2 ? pluginError(PERMISSION_DENIED, 'Unable to do file operation, user denied permission request.') : null));
        await expect(saveExportFile({ messages: [] }, 'w1clipdl-user')).rejects.toThrow(/Could not save/);
        expect(disk.calls.map(c => c.op), 'a deleteFile here would prompt for the permission again').toEqual(['writeFile']);
        expect(disk.read(pathOf(first.where))?.equals(earlier), 'the earlier export survives').toBe(true);
    });

    it('storage permission denied on a multi-call save: no cleanup call either', async () => {
        disk.failOn((n) => (n === 1 ? pluginError(PERMISSION_DENIED) : null));
        const text = 'x'.repeat(2 * DEVICE_WRITE_CHUNK_CHARS + 5);
        await expect(saveTextToDevice('Puca', 'big.json', text)).rejects.toBeInstanceOf(DeviceWriteError);
        expect(disk.calls.map(c => c.op)).toEqual(['writeFile']);
        expect(disk.files.size).toBe(0);
    });

    it('a first writeFile that fails after creating its file (disk full) leaves no 0-byte file — one call or many', async () => {
        disk.failOn((n) => (n === 1 ? pluginError('OS-PLUG-FILE-0013', 'No space left on device') : null));
        await expect(saveTextToDevice('Puca', 'small.json', 'hello')).rejects.toBeInstanceOf(DeviceWriteError);
        expect([...disk.files.keys()], 'the 0-byte file the plugin created is cleaned up').toEqual([]);

        disk.reset();
        disk.failOn((n) => (n === 1 ? pluginError('OS-PLUG-FILE-0013', 'No space left on device') : null));
        await expect(saveTextToDevice('Puca', 'big.json', 'y'.repeat(2 * DEVICE_WRITE_CHUNK_CHARS + 5))).rejects.toBeInstanceOf(DeviceWriteError);
        expect([...disk.files.keys()]).toEqual([]);
    });
});
