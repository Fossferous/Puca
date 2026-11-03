// @vitest-environment jsdom
/**
 * "Ask where to save files" (desktop). Both writers — the transfer sink and the
 * attachment saver — run the OS Save As dialog first and treat a cancel as a
 * decline that touches nothing; with the setting off, neither ever opens it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TransferView } from '../api/fileTransferManager';

const dialog = vi.hoisted(() => ({ save: vi.fn<(o: unknown) => Promise<string | null>>() }));
const core = vi.hoisted(() => ({ invoke: vi.fn<(cmd: string, ...rest: unknown[]) => Promise<unknown>>() }));
const flag = vi.hoisted(() => ({ ask: false }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: core.invoke }));
vi.mock('../api/platform', async (orig) => ({
    ...(await orig<typeof import('../api/platform')>()),
    isTauri: () => true,
    isMobile: () => false,
}));
vi.mock('../components/settingsStore', async (orig) => {
    const real = await orig<typeof import('../components/settingsStore')>();
    return { ...real, loadSettings: () => ({ ...real.defaultSettings, askWhereToSaveFiles: flag.ask }) };
});

import { prepareSink } from '../api/transferSinks';
import { saveAttachment } from '../api/saveAttachment';
import { chooseSavePath } from '../api/savePath';

const transfer = { id: 't1', name: 'report.pdf', sha256: 'ab'.repeat(32), size: 10, direction: 'receive' } as unknown as TransferView;

/** Every call to the shell except the dialog itself. */
const shellWrites = () => core.invoke.mock.calls.filter(c => c[0] !== 'choose_save_path');

beforeEach(() => {
    dialog.save.mockReset();
    core.invoke.mockReset();
    core.invoke.mockImplementation(async (cmd: string, args: unknown) => {
        if (cmd === 'choose_save_path') return dialog.save(args);
        if (cmd === 'transfer_begin') return { existing_bytes: 0, path: 'C:\\Users\\x\\Downloads\\Puca\\report.pdf.part' };
        if (cmd === 'attachment_save') return 'C:\\Users\\x\\Downloads\\Puca\\pic.png';
        return undefined;
    });
    flag.ask = false;
});

/** The contract every writer above relies on. */
describe('chooseSavePath', () => {
    it('asks the shell by name, with the suggested name, and returns the path it chose as it came', async () => {
        dialog.save.mockResolvedValue('D:\\Zoë\\Púca – notes.md');
        await expect(chooseSavePath('Púca – notes.md')).resolves.toBe('D:\\Zoë\\Púca – notes.md');
        expect(core.invoke.mock.calls).toEqual([['choose_save_path', { suggestedName: 'Púca – notes.md' }]]);
    });

    it('a cancel is null: the shell answers Ok(None), which arrives as null', async () => {
        dialog.save.mockResolvedValue(null);
        await expect(chooseSavePath('a.txt')).resolves.toBeNull();
    });

    it('a dialog that could not open rejects with the shell\'s reason, and is never read as a cancel', async () => {
        dialog.save.mockRejectedValue('the window is gone');
        await expect(chooseSavePath('a.txt')).rejects.toBe('the window is gone');
    });
});

describe('received-file sink', () => {
    it('setting OFF: never opens the dialog, begins the transfer in the default location', async () => {
        const sink = await prepareSink(transfer);
        expect(sink).not.toBeNull();
        expect(dialog.save).not.toHaveBeenCalled();
        const [cmd, args] = core.invoke.mock.calls[0] as [string, Record<string, unknown>];
        expect(cmd).toBe('transfer_begin');
        expect(args.destPath).toBeUndefined();
    });

    it('setting ON + cancel: returns null (a decline) and asks the native side for nothing', async () => {
        flag.ask = true;
        dialog.save.mockResolvedValue(null);
        expect(await prepareSink(transfer)).toBeNull();
        expect(dialog.save).toHaveBeenCalledWith({ suggestedName: 'report.pdf' });
        expect(shellWrites()).toEqual([]);
    });

    it('setting ON + a chosen path: the transfer begins AT that path', async () => {
        flag.ask = true;
        dialog.save.mockResolvedValue('D:\\keep\\report.pdf');
        const sink = await prepareSink(transfer);
        expect(sink).not.toBeNull();
        const [cmd, args] = shellWrites()[0] as [string, Record<string, unknown>];
        expect(cmd).toBe('transfer_begin');
        expect(args.destPath).toBe('D:\\keep\\report.pdf');
    });
});

describe('attachment save', () => {
    it('setting ON + cancel: reports cancelled, fetches nothing, writes nothing', async () => {
        flag.ask = true;
        dialog.save.mockResolvedValue(null);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const res = await saveAttachment('blob:x', 'pic.png');
        expect(res).toEqual({ where: '', onDisk: false, cancelled: true });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(shellWrites()).toEqual([]);
        fetchSpy.mockRestore();
    });

    it('setting ON + a chosen path: the path rides to the native side as a header', async () => {
        flag.ask = true;
        dialog.save.mockResolvedValue('D:\\keep\\pic.png');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
        const res = await saveAttachment('blob:x', 'pic.png');
        expect(res.onDisk).toBe(true);
        const [cmd, , opts] = shellWrites()[0] as [string, unknown, { headers: Record<string, string> }];
        expect(cmd).toBe('attachment_save');
        expect(opts.headers['x-dest-path']).toBe(encodeURIComponent('D:\\keep\\pic.png'));
        fetchSpy.mockRestore();
    });

    it('setting OFF: no dialog, no destination header', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1])));
        await saveAttachment('blob:x', 'pic.png');
        expect(dialog.save).not.toHaveBeenCalled();
        const [, , opts] = core.invoke.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
        expect(opts.headers['x-dest-path']).toBeUndefined();
        fetchSpy.mockRestore();
    });
});
