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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeCapacitorFs, patternBytes } from './fixtures/fakeCapacitorFs';

/** 768 KiB of raw bytes is exactly 1 MiB of base64. A bridge message of this
 *  size costs the Java heap a few MB, against the ~96 MB a 92 MB clip needed
 *  before it died. */
const BRIDGE_MAX_CHARS = 1024 * 1024;

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
const { saveTextToDevice } = await import('../api/saveToDevice');
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
        expect(ops.slice(1).every(o => o === 'appendFile')).toBe(true);
        expect(disk.calls.every(c => c.directory === 'DOCUMENTS' && c.encoding === undefined)).toBe(true);
        const onDisk = disk.read(pathOf(r.where));
        expect(onDisk?.length).toBe(input.length);
        expect(onDisk!.equals(Buffer.from(input.buffer, input.byteOffset, input.byteLength))).toBe(true);
        expect([...disk.files.keys()]).toEqual([pathOf(r.where)]); // nothing else left behind
    }, 120_000);

    it('a write that fails part-way deletes what it wrote and says so — never "saved", never a crash', async () => {
        const input = patternBytes(5 * 1024 * 1024, 5);
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

/** Text with a surrogate pair straddling every slice boundary a naive cut
 *  would make, plus 2- and 3-byte UTF-8 characters. */
function awkwardText(minChars: number): string {
    const parts: string[] = [];
    let n = 0;
    const unit = 'a'.repeat(BRIDGE_MAX_CHARS - 1) + '\u{1F600}' + 'é€\n';
    while (n < minChars) { parts.push(unit); n += unit.length; }
    return parts.join('');
}

describe('text written on Android — the account export and the Notes export', () => {
    it('saveTextToDevice: bounded slices, never splitting a surrogate pair, UTF-8 intact', async () => {
        const text = awkwardText(5 * BRIDGE_MAX_CHARS);
        const r = await saveTextToDevice('Puca', 'big.json', text);
        expect(disk.maxChars()).toBeLessThanOrEqual(BRIDGE_MAX_CHARS);
        expect(disk.calls.length).toBeGreaterThan(1);
        expect(disk.calls.every(c => c.encoding === 'utf8' && c.directory === 'DOCUMENTS')).toBe(true);
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
