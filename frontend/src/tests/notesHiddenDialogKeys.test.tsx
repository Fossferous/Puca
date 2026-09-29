/**
 * A dialog left open inside a HIDDEN Notes lets go of the keyboard.
 *
 * Inside the desktop app Notes stays mounted, hidden, while the person is in
 * another view — and a toast click (the toasts sit above Notes' layer) can
 * take them there with a picture, a schedule, a snooze menu or a half-made
 * drawing still open inside it. Every one of those takes Escape on the
 * document or window in the CAPTURE phase and stops it. Left listening, the
 * next Escape pressed in the chat closed a dialog nobody could see (a dirty
 * drawing asked "Discard the changes to this drawing?" over the chat) and
 * never reached anything else — not the chat, not remote control's "Escape
 * always revokes", which listens on the window in the bubble phase
 * (api/remoteControl.ts). The check below is exactly that listener.
 *
 * The host says whether its layer is on screen (portalTarget.ts,
 * LayerOnScreenContext); each dialog listens only while it is, and is still
 * open — listening again — when Notes comes back. Púca's own Tasks view
 * provides nothing, so there they always listen (the positive controls).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task } from '../api/tasks';
import type { CalendarSource } from '../api/taskCalendar';

const { LayerOnScreenContext } = await import('../components/portalTarget');
const { ImageLightbox } = await import('../components/ImageLightbox');
const { DrawingCanvas } = await import('../components/DrawingCanvas');
const { NotesDialog } = await import('../components/NotesDialog');
const { ScheduleEditor } = await import('../components/schedule/ScheduleEditor');
const { CalendarAddSheet } = await import('../components/calendar/CalendarAddSheet');
const { SnoozeControl } = await import('../components/reminders/SnoozeControl');
const { Popover } = await import('../components/notes/Popover');
const { Calendar } = await import('../components/calendar/Calendar');

let root: Root | null = null;
let host: HTMLElement | null = null;
/** What reached the window's BUBBLE phase — remote control's kill switch. */
let reachedWindow: string[] = [];
const onWindowKey = (e: KeyboardEvent) => { reachedWindow.push(e.key); };

beforeEach(() => {
    reachedWindow = [];
    window.addEventListener('keydown', onWindowKey);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    window.removeEventListener('keydown', onWindowKey);
    act(() => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

const render = (ui: ReactElement, onScreen: boolean) => {
    act(() => { root!.render(<LayerOnScreenContext.Provider value={onScreen}>{ui}</LayerOnScreenContext.Provider>); });
};
const escape = () => {
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { document.body.dispatchEvent(e); });
    return e;
};

const DUE = '2030-10-07T09:00:00.000Z';
const task: Task = {
    id: 5, channel_id: null, list_id: 7, parent_id: null, description: 'Bins out', is_completed: false, position: 1,
    created_at: '2030-09-01T00:00:00Z', created_by: 2, attachments: null, due_at: DUE,
};

interface Case {
    name: string;
    /** The dialog, open, reporting its closing through `closed`. */
    ui: (closed: () => void) => ReactElement;
    /** Some are opened by a click once rendered. */
    open?: () => void;
    /** Still open? (for the ones whose closing is internal state) */
    isOpen?: () => boolean;
}
const anchor = () => {
    const b = document.createElement('button');
    document.body.appendChild(b);
    return b;
};
const CASES: Case[] = [
    { name: 'a picture (ImageLightbox)', ui: c => <ImageLightbox url="blob:picture" name="p.png" onClose={c} /> },
    { name: 'a drawing (DrawingCanvas)', ui: c => <DrawingCanvas onCancel={c} onSave={async () => true} /> },
    { name: 'a dialog (NotesDialog: help, a confirm, Send to Púca)', ui: c => <NotesDialog title="Keyboard shortcuts" onClose={c}><span>help</span></NotesDialog> },
    { name: 'Date & repeat (ScheduleEditor)', ui: c => <ScheduleEditor task={task} onSave={() => {}} onClose={c} now={Date.parse('2030-10-01T00:00:00Z')} /> },
    {
        name: 'the calendar’s add sheet (CalendarAddSheet)',
        ui: c => <CalendarAddSheet dayKey="2030-10-07" targets={[{ key: 'list:7', title: 'Home' }]} defaultTarget="list:7" scheduleSupported onSubmit={async () => true} onClose={c} />,
    },
    { name: 'a colour or label picker (Popover)', ui: c => <Popover anchor={anchor()} onClose={c} label="Colour"><span>pick</span></Popover> },
    {
        name: 'a snooze menu (SnoozeControl)',
        ui: () => <SnoozeControl task={task} now={Date.parse('2030-10-07T08:00:00Z')} onSnooze={() => {}} />,
        open: () => { act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Snooze"]')!.click(); }); },
        isOpen: () => document.querySelector('.notes-snooze-menu') !== null,
    },
    {
        name: 'a calendar entry’s menu (Calendar’s EntryMenu)',
        ui: () => {
            const src: CalendarSource = { task, noteKey: 'list:7', noteTitle: 'Home', canEdit: true };
            return (
                <Calendar
                    sources={[src]} view="day" date="2030-10-07" onNavigate={() => {}} showCompleted={false} showPlain
                    onToggleCompleted={() => {}} onTogglePlain={() => {}} weekStart={1} now={Date.parse('2030-10-01T00:00:00Z')} coarse
                    onOpen={() => {}} onMove={() => {}} onAdd={() => {}} onToggleDone={() => {}}
                />
            );
        },
        open: () => { act(() => { document.querySelector<HTMLButtonElement>(`button[aria-label="More for ${task.description}"]`)!.click(); }); },
        isOpen: () => document.querySelector('.cal-menu') !== null,
    },
];

describe.each(CASES)('$name', ({ ui, open, isOpen }) => {
    function setUp(onScreen: boolean) {
        const closed = vi.fn();
        const el = ui(closed);
        render(el, true);
        open?.();
        if (!onScreen) render(el, false);
        const stillOpen = () => (isOpen ? isOpen() : closed.mock.calls.length === 0);
        expect(stillOpen(), 'opened').toBe(true);
        return { el, closed, stillOpen };
    }

    it('POSITIVE CONTROL: on screen it takes Escape, closes, and nothing else gets the key', () => {
        const { stillOpen } = setUp(true);
        escape();
        expect(stillOpen()).toBe(false);
        expect(reachedWindow).toEqual([]);
    });

    it('hidden with Notes, Escape is not its: it stays open, and the key goes on to the window', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { stillOpen } = setUp(false);
        const e = escape();
        expect(stillOpen()).toBe(true);
        expect(reachedWindow).toEqual(['Escape']);
        expect(e.defaultPrevented).toBe(false);
        expect(confirm).not.toHaveBeenCalled();
    });

    it('back on screen it is still open, and Escape is its again', () => {
        const { el, stillOpen } = setUp(false);
        escape();
        render(el, true);
        expect(stillOpen()).toBe(true);
        reachedWindow = [];
        escape();
        expect(stillOpen()).toBe(false);
        expect(reachedWindow).toEqual([]);
    });
});

// --- Every other window- or document-level key listener Notes can reach ----------------------

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = /\b(?:import|export)[\w\s,{}*$]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;
function resolveRelative(fromFile: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
        if (/\.tsx?$/.test(c) && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
}
/** Every source file the embedded shell pulls in, however deep. */
function shellClosure(): string[] {
    const start = path.join(SRC, 'notes', 'components', 'NotesShell.tsx');
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
        const file = queue.pop()!;
        for (const m of fs.readFileSync(file, 'utf8').matchAll(SPEC)) {
            const t = resolveRelative(file, m[1] ?? m[2] ?? m[3]);
            if (t && !seen.has(t)) { seen.add(t); queue.push(t); }
        }
    }
    return [...seen];
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
/** A key listener on the window or the document that never asks whether its
 *  layer is on screen. */
function ungated(text: string): boolean {
    const code = stripComments(text);
    return /\b(window|document)\.addEventListener\(\s*['"]keydown['"]/.test(code) && !/\buseLayerOnScreen\(\)/.test(code);
}
/** Key listeners gated another way, each with how. */
const GATED_ELSEWHERE: Record<string, string> = {
    [path.join('notes', 'components', 'useNotesShortcuts.ts')]: 'NotesShell passes enabled = onScreen && …',
    [path.join('notes', 'components', 'useNoteSelection.tsx')]: 'NotesShell passes enabled: onScreen && …',
    [path.join('notes', 'components', 'NoteEditor.tsx')]: 'NotesShell passes escapeBlocked = !onScreen || …',
    [path.join('notes', 'components', 'LabelManager.tsx')]: 'NotesShell closes it when Notes leaves the screen',
    [path.join('components', 'ContextMenu.tsx')]: 'the shell’s own menu, closed when Notes leaves the screen; and it stops nothing',
    [path.join('api', 'hotkeys.ts')]: 'Púca’s own hotkeys: the app’s, not a Notes dialog',
    [path.join('hooks', 'useDragReorder.ts')]: 'only while a pointer is held on a card, and it stops nothing',
    [path.join('hooks', 'useDropOnTarget.ts')]: 'only while a pointer is held on a card, and it stops nothing',
};

describe('every key listener embedded Notes can reach asks whether it is on screen', () => {
    it('the sweep finds none that does not', () => {
        const offenders = shellClosure()
            .map(f => path.relative(SRC, f))
            .filter(rel => !GATED_ELSEWHERE[rel] && ungated(fs.readFileSync(path.join(SRC, rel), 'utf8')));
        expect(offenders).toEqual([]);
    });

    it('it swept real listeners: the dialogs above among them, and every exemption still listens', () => {
        const withKeys = shellClosure().map(f => path.relative(SRC, f))
            .filter(rel => /\b(window|document)\.addEventListener\(\s*['"]keydown['"]/.test(stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'))));
        for (const f of ['ImageLightbox.tsx', 'DrawingCanvas.tsx', 'NotesDialog.tsx', 'ScheduleEditor.tsx', 'CalendarAddSheet.tsx', 'SnoozeControl.tsx', 'Popover.tsx', 'Calendar.tsx']) {
            expect(withKeys.some(p => p.endsWith(path.sep + f)), f).toBe(true);
        }
        // An exemption whose file no longer listens is a stale excuse.
        for (const rel of Object.keys(GATED_ELSEWHERE)) expect(withKeys, rel).toContain(rel);
    });

    it('MUTATION: the checker flags a listener that never asks', () => {
        expect(ungated("useEffect(() => { document.addEventListener('keydown', onKey, true); });")).toBe(true);
        expect(ungated("const on = useLayerOnScreen();\nuseEffect(() => { if (!on) return; window.addEventListener('keydown', k, true); });")).toBe(false);
        expect(ungated("// window.addEventListener('keydown', k)\nconst x = 1;")).toBe(false);
    });
});
