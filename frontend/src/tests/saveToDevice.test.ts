/**
 * Writing files on a phone (api/saveToDevice.ts) and the two callers this
 * change moved onto it: saving an attachment (both Android apps) and Púca
 * Notes' export.
 *
 * The bug being closed: on Android, saveAttachment fell through to a blob-URL
 * anchor, which writes NOTHING in a WebView, and then reported "saved". The
 * must-not here is "a failed write is reported as a save"; the positive
 * control is the same call with a working filesystem, which must report the
 * real Documents path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let android = true;
const writeFile = vi.fn();
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => (android ? 'android' : 'web'),
        isPluginAvailable: (n: string) => android && n === 'Filesystem',
        isNativePlatform: () => android,
    },
    registerPlugin: () => ({}),
}));
vi.mock('@capacitor/filesystem', () => ({
    Filesystem: { writeFile: (o: unknown) => writeFile(o) },
    Directory: { Documents: 'DOCUMENTS' },
    Encoding: { UTF8: 'utf8' },
}));
vi.mock('../api/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isMobile: () => android,
    isTauri: () => false,
}));

const { bytesToBase64, safeDeviceFileName, timestampedName, saveTextToDevice } = await import('../api/saveToDevice');
const { saveAttachment } = await import('../api/saveAttachment');
const { saveNotesExport } = await import('../notes/model/noteText');

beforeEach(() => {
    android = true;
    writeFile.mockReset();
    // jsdom has no fetch for blob: URLs; the attachment path reads one.
    globalThis.fetch = vi.fn(async () => new Response('hello')) as unknown as typeof fetch;
});

describe('bytesToBase64', () => {
    it('matches btoa, across the chunk boundary', () => {
        const big = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 251);
        const expected = btoa(Array.from(big, b => String.fromCharCode(b)).join(''));
        expect(bytesToBase64(big)).toBe(expected);
    });
});

describe('file names', () => {
    it('strips paths, reserved and control characters', () => {
        expect(safeDeviceFileName('../../etc/passwd')).toBe('_.._etc_passwd');
        expect(safeDeviceFileName('a:b*c?"d<e>f|g')).toBe('a_b_c_d_e_f_g');
        expect(safeDeviceFileName(`bad${String.fromCharCode(0)}${String.fromCharCode(10)}name.txt`)).toBe('badname.txt');
        expect(safeDeviceFileName('')).toBe('file');
        expect(safeDeviceFileName('...hidden')).toBe('hidden');
    });
    it('caps long names but keeps the extension', () => {
        const n = safeDeviceFileName('x'.repeat(300) + '.json');
        expect(n.length).toBe(120);
        expect(n.endsWith('.json')).toBe(true);
    });
    it('timestamps before the extension, so a second save never reuses a name', () => {
        const d = new Date(2026, 8, 19, 7, 5, 9);
        expect(timestampedName('photo.jpg', d)).toBe('photo-20260919-070509.jpg');
        expect(timestampedName('README', d)).toBe('README-20260919-070509');
        expect(timestampedName('a.b.c.md', d)).toBe('a.b.c-20260919-070509.md');
    });
});

describe('saveTextToDevice', () => {
    it('writes Documents/<folder>/<name> and says where', async () => {
        writeFile.mockResolvedValue({ uri: 'file://x' });
        await expect(saveTextToDevice('Puca Notes', 'n.md', 'text')).resolves.toEqual({ where: 'Documents/Puca Notes/n.md', onDisk: true });
        expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({
            path: 'Puca Notes/n.md', data: 'text', directory: 'DOCUMENTS', encoding: 'utf8', recursive: true,
        }));
    });
    it('rejects when the write fails', async () => {
        writeFile.mockRejectedValue(new Error('EACCES'));
        await expect(saveTextToDevice('Puca', 'n.md', 'x')).rejects.toThrow('EACCES');
    });
    it('rejects off Android instead of pretending', async () => {
        android = false;
        await expect(saveTextToDevice('Puca', 'n.md', 'x')).rejects.toThrow(/cannot write files/);
        expect(writeFile).not.toHaveBeenCalled();
    });
});

describe('saveAttachment on Android', () => {
    it('a failed write is an error, never "saved"', async () => {
        writeFile.mockRejectedValue(new Error('EACCES'));
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
        await expect(saveAttachment('blob:x', 'photo.jpg')).rejects.toThrow(/Could not save the file/);
        expect(click, 'the dead anchor must not be reached on a phone').not.toHaveBeenCalled();
        click.mockRestore();
    });
    it('positive control: a working write lands in Documents/Puca under a unique name', async () => {
        writeFile.mockResolvedValue({ uri: 'file://x' });
        const r = await saveAttachment('blob:x', 'photo.jpg');
        expect(r.onDisk).toBe(true);
        expect(r.where).toMatch(/^Documents\/Puca\/photo-\d{8}-\d{6}\.jpg$/);
        expect(writeFile.mock.calls[0][0]).toMatchObject({ directory: 'DOCUMENTS', recursive: true });
        // Binary goes as base64 with no text encoding.
        expect(writeFile.mock.calls[0][0].encoding).toBeUndefined();
        expect(writeFile.mock.calls[0][0].data).toBe(btoa('hello'));
    });
    it('a file saved out of Púca NOTES lands in its own folder, not the chat app’s', async () => {
        writeFile.mockResolvedValue({ uri: 'file://x' });
        const { NOTES_FOLDER } = await import('../api/saveToDevice');
        const r = await saveAttachment('blob:x', 'tickets.pdf', NOTES_FOLDER);
        expect(r.where).toMatch(/^Documents\/Puca Notes\/tickets-\d{8}-\d{6}\.pdf$/);
        // Positive control: with no folder given it is still Púca's own.
        const p = await saveAttachment('blob:x', 'tickets.pdf');
        expect(p.where).toMatch(/^Documents\/Puca\/tickets-\d{8}-\d{6}\.pdf$/);
    });

    it('in a browser it is still the transient anchor', async () => {
        android = false;
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        await expect(saveAttachment('blob:x', 'photo.jpg')).resolves.toEqual({ where: 'photo.jpg', onDisk: false });
        expect(click).toHaveBeenCalledTimes(1);
        expect(writeFile).not.toHaveBeenCalled();
        click.mockRestore();
    });
});

describe('saveNotesExport', () => {
    it('Android: Documents/Puca Notes with a timestamped name', async () => {
        writeFile.mockResolvedValue({ uri: 'file://x' });
        const r = await saveNotesExport('puca-notes-2026-09-19.md', '# x', 'text/markdown');
        expect(r.where).toMatch(/^Documents\/Puca Notes\/puca-notes-\d{8}-\d{6}\.md$/);
    });
    it('Android: a failed write names the Android 10 permission, not success', async () => {
        writeFile.mockRejectedValue(new Error('EACCES'));
        await expect(saveNotesExport('a.md', 'x', 'text/markdown')).rejects.toThrow(/Púca Notes needs permission to write to Documents/);
    });
    it('browser: still a download', async () => {
        android = false;
        URL.createObjectURL = vi.fn(() => 'blob:y');
        URL.revokeObjectURL = vi.fn();
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        await expect(saveNotesExport('a.md', 'x', 'text/markdown')).resolves.toEqual({ where: 'a.md', onDisk: false });
        expect(click).toHaveBeenCalledTimes(1);
        click.mockRestore();
    });
});
