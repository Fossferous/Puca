/**
 * Púca Notes' export inside the DESKTOP app (Notes in Púca,
 * components/NotesDesktopView.tsx). The account menu's "Export notes as
 * Markdown / JSON" used to fall through to the browser's `<a download>`,
 * which in the desktop shell is no reliable download: it could write nothing
 * and say nothing. It now goes the way every other file the desktop app
 * writes goes — the Save As dialog, then the shell's `attachment_save` —
 * through savePath.saveTextAs, which the calendar's .ics export shares.
 *
 * The must-nots: a cancel writes nothing and reports nothing; the anchor is
 * never reached under the shell; a name or a folder outside ASCII arrives
 * whole (headers are ASCII, so both travel percent-encoded). The positive
 * control is the same call in a browser, which must still be the download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteCard } from '../notes/model/notesModel';
import type { Task } from '../api/tasks';

const h = vi.hoisted(() => ({ tauri: true }));
const dialog = vi.hoisted(() => ({ save: vi.fn<(o: { defaultPath?: string; title?: string }) => Promise<string | null>>() }));
const core = vi.hoisted(() => ({ invoke: vi.fn<(cmd: string, body?: unknown, opts?: unknown) => Promise<unknown>>() }));

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: dialog.save }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: core.invoke }));
vi.mock('../api/platform', async (orig) => ({
    ...(await orig<typeof import('../api/platform')>()),
    isTauri: () => h.tauri,
    isMobile: () => false,
}));

const { saveNotesExport } = await import('../notes/model/noteText');
const { exportNotes } = await import('../notes/native/notesExport');
const { deliverIcs } = await import('../api/icsDelivery');
const { setMessageToastSink } = await import('../components/messageToastBus');

/** Somewhere a person with a non-ASCII name keeps a non-ASCII file name. */
const DEST = 'C:\\Users\\Zoë\\Documents\\Púca notes – 2026.md';
const WRITTEN = 'C:\\Users\\Zoë\\Documents\\Púca notes – 2026.md';
const ASCII = /^[\x20-\x7e]*$/;

let anchorClick: ReturnType<typeof vi.spyOn>;
let toasts: string[];

beforeEach(() => {
    h.tauri = true;
    dialog.save.mockReset().mockResolvedValue(DEST);
    core.invoke.mockReset().mockImplementation(async (cmd: string) => (cmd === 'attachment_save' ? WRITTEN : undefined));
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:export');
    URL.revokeObjectURL = vi.fn();
    toasts = [];
    setMessageToastSink(t => { toasts.push(t.title); });
});
afterEach(() => {
    anchorClick.mockRestore();
    setMessageToastSink(null);
});

/** What the one attachment_save call carried, decoded. */
function written() {
    const saves = core.invoke.mock.calls.filter(c => c[0] === 'attachment_save');
    expect(saves, 'exactly one native write').toHaveLength(1);
    const [, body, opts] = saves[0] as [string, Uint8Array, { headers: Record<string, string> }];
    // A raw body, not JSON args: the shell reads InvokeBody::Raw. (Checked by
    // tag: jsdom's Uint8Array and the encoder's are different realms.)
    expect(Object.prototype.toString.call(body)).toBe('[object Uint8Array]');
    return { text: new TextDecoder().decode(body), headers: opts.headers };
}

describe('saveNotesExport in the desktop app', () => {
    it('asks where, then the shell writes the text there — never the anchor', async () => {
        const text = '# Café list\n\n- [ ] Crème brûlée\n';
        const r = await saveNotesExport('puca-notes-2026-09-29.md', text, 'text/markdown;charset=utf-8');
        expect(dialog.save).toHaveBeenCalledTimes(1);
        expect(dialog.save.mock.calls[0][0]).toMatchObject({ defaultPath: 'puca-notes-2026-09-29.md' });
        const w = written();
        expect(w.text).toBe(text);
        expect(decodeURIComponent(w.headers['x-dest-path'])).toBe(DEST);
        expect(decodeURIComponent(w.headers['x-file-name'])).toBe('puca-notes-2026-09-29.md');
        expect(r).toEqual({ where: WRITTEN, onDisk: true });
        expect(anchorClick, 'the browser download must not be reached in the shell').not.toHaveBeenCalled();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('a name and a folder outside ASCII travel as ASCII headers and arrive whole', async () => {
        await saveNotesExport('Púca – notes.md', 'x', 'text/markdown');
        const w = written();
        for (const v of Object.values(w.headers)) expect(v).toMatch(ASCII);
        expect(decodeURIComponent(w.headers['x-dest-path'])).toBe(DEST);
        expect(decodeURIComponent(w.headers['x-file-name'])).toBe('Púca – notes.md');
    });

    it('a cancel writes nothing, downloads nothing, and says it was cancelled', async () => {
        dialog.save.mockResolvedValue(null);
        await expect(saveNotesExport('a.md', 'x', 'text/markdown')).resolves.toEqual({ where: '', onDisk: false, cancelled: true });
        expect(core.invoke).not.toHaveBeenCalled();
        expect(anchorClick).not.toHaveBeenCalled();
    });

    it('a failed write rejects with the shell\'s reason, never "saved"', async () => {
        core.invoke.mockRejectedValue('could not write "C:\\\\x.md": access denied');
        await expect(saveNotesExport('a.md', 'x', 'text/markdown')).rejects.toMatch(/access denied/);
        expect(anchorClick).not.toHaveBeenCalled();
    });

    it('positive control: in a browser it is still the download, and the shell is never asked', async () => {
        h.tauri = false;
        await expect(saveNotesExport('a.md', 'x', 'text/markdown')).resolves.toEqual({ where: 'a.md', onDisk: false });
        expect(anchorClick).toHaveBeenCalledTimes(1);
        expect(dialog.save).not.toHaveBeenCalled();
        expect(core.invoke).not.toHaveBeenCalled();
    });
});

const task = (id: number, description: string): Task => ({ id, description, is_completed: false, parent_id: null, position: id } as unknown as Task);
const card = {
    key: 'list:7', ref: { kind: 'list', id: 7 }, title: 'Café list', body: null, noteAttachments: null,
    pinned: false, archived: false, color: 'default', labels: ['Errands'], tasks: [task(1, 'Crème brûlée'), task(2, 'Oat milk')],
    total: 2, completed: 0,
} as unknown as NoteCard;

describe('the account menu\'s export (exportNotes) in the desktop app', () => {
    it('Markdown: the notes go to the shell, and the toast says where and that it is not encrypted', async () => {
        await exportNotes([card], 'md');
        const w = written();
        expect(w.text).toContain('# Café list');
        expect(w.text).toContain('- [ ] Crème brûlée');
        expect(w.text).toContain('- [ ] Oat milk');
        expect(decodeURIComponent(w.headers['x-file-name'])).toMatch(/^puca-notes-\d{4}-\d{2}-\d{2}\.md$/);
        expect(toasts).toEqual([`Saved to ${WRITTEN} — this copy is not encrypted`]);
    });

    it('JSON: the same way out', async () => {
        await exportNotes([card], 'json');
        const w = written();
        expect(JSON.parse(w.text).notes[0].title).toBe('Café list');
        expect(decodeURIComponent(w.headers['x-file-name'])).toMatch(/^puca-notes-\d{4}-\d{2}-\d{2}\.json$/);
    });

    it('a cancel says nothing', async () => {
        dialog.save.mockResolvedValue(null);
        await exportNotes([card], 'md');
        expect(toasts).toEqual([]);
    });

    it('a failed write is a toast with the reason', async () => {
        core.invoke.mockRejectedValue(new Error('disk full'));
        await exportNotes([card], 'md');
        expect(toasts).toEqual(['disk full']);
    });
});

describe('the calendar .ics shares the same way out (deliverIcs)', () => {
    it('saved, at the path the shell wrote', async () => {
        await expect(deliverIcs('puca-notes.ics', 'BEGIN:VCALENDAR')).resolves.toEqual({ how: 'saved', where: WRITTEN });
        expect(written().text).toBe('BEGIN:VCALENDAR');
    });

    it('cancelled, with nothing written', async () => {
        dialog.save.mockResolvedValue(null);
        await expect(deliverIcs('puca-notes.ics', 'BEGIN:VCALENDAR')).resolves.toEqual({ how: 'cancelled' });
        expect(core.invoke).not.toHaveBeenCalled();
    });
});
