/**
 * The pieces embedded Notes relies on below NotesShell, in the components it
 * shares with Púca's own Tasks view.
 *
 *  1. PORTALS. Inside the desktop app Notes is kept mounted but hidden, so
 *     anything it portals to document.body would stay on screen over the
 *     chat. Every portal the embedded shell can reach goes through
 *     usePortalTarget() — swept here over the shell's whole import closure,
 *     so the next dialog someone adds under Notes cannot quietly go back to
 *     the body — and lands in the host's layer when one is provided, and on
 *     the body when none is (Púca's own Tasks view).
 *  2. THE HOST'S VETO on keys (NotesShell's `embedded.ownsKey`), threaded
 *     into the three places below the shell that listen on the window: the
 *     calendar's single-key shortcuts, the open note's Escape, and the grid's
 *     Ctrl+A.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../api/openExternal', () => ({ openExternalUrl: vi.fn(), isExternalHref: () => true }));
vi.mock('../api/client', async orig => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } };
});
vi.mock('../notes/model/notesQueries', async orig => {
    const real = await orig<typeof import('../notes/model/notesQueries')>();
    return { ...real, useNoteTasks: () => ({ data: [], isPending: false, isFetching: false }) };
});
vi.mock('../api/taskFeatures', async orig => ({
    ...(await orig<typeof import('../api/taskFeatures')>()), useTaskFeature: () => true,
}));

const { PortalTargetContext } = await import('../components/portalTarget');
const { UndoBar } = await import('../notes/components/UndoBar');
const { Popover } = await import('../components/notes/Popover');
const { NotesDialog } = await import('../components/NotesDialog');
const { Calendar } = await import('../components/calendar/Calendar');
const { NoteEditor } = await import('../notes/components/NoteEditor');
const { isGridPath, useBulkPending, useNoteSelection } = await import('../notes/components/useNoteSelection');
type CalendarProps = Parameters<typeof Calendar>[0];
type NoteCard = import('../notes/model/notesModel').NoteCard;
type NoteActions = import('../notes/model/notesQueries').NoteActions;

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(ui: React.ReactElement) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(ui); });
}
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = '';
});
const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => { document.body.dispatchEvent(e); });
    return e;
};

// --- 1. Portals -------------------------------------------------------------------------

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
/** What is wrong with one file's portals, if anything (comments ignored). */
function portalOffences(text: string): string[] {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    if (!/\bcreatePortal\(/.test(code)) return [];
    const out: string[] = [];
    if (!/\busePortalTarget\(\)/.test(code)) out.push('portals without usePortalTarget()');
    if (/,\s*document\.body\s*,?\s*\)/.test(code)) out.push('portals to document.body');
    return out;
}
/** Portals the EMBEDDED shell never renders, each with why. */
const NEVER_EMBEDDED: Record<string, string> = {
    // The toast sink: NotesShell renders it only on its own page (embedded,
    // Chat's copy is the bus's one sink).
    [path.join('components', 'MessageToasts.tsx')]: 'rendered only on Notes’ own page',
};

describe('every portal embedded Notes can reach goes through usePortalTarget()', () => {
    it('the sweep finds none that portal to the body', () => {
        const offenders: string[] = [];
        for (const f of shellClosure()) {
            const rel = path.relative(SRC, f);
            if (NEVER_EMBEDDED[rel]) continue;
            for (const o of portalOffences(fs.readFileSync(f, 'utf8'))) offenders.push(`${rel}: ${o}`);
        }
        expect(offenders).toEqual([]);
    });

    it('it actually swept portals (the Notes editor, the Undo bar and the shared pickers among them)', () => {
        const withPortals = shellClosure().filter(f => /\bcreatePortal\(/.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(SRC, f));
        expect(withPortals.length).toBeGreaterThanOrEqual(12);
        for (const f of ['NoteEditor.tsx', 'UndoBar.tsx', 'Popover.tsx', 'ScheduleEditor.tsx', 'ImageLightbox.tsx']) {
            expect(withPortals.some(p => p.endsWith(f)), f).toBe(true);
        }
    });

    it('MUTATION: the checker flags a portal to the body, and one that never asks for the target', () => {
        const ok = "const t = usePortalTarget();\nreturn createPortal(<div />, t);";
        expect(portalOffences(ok)).toEqual([]);
        expect(portalOffences("const t = usePortalTarget();\nreturn createPortal(<div />,\n    document.body,\n);")).toEqual(['portals to document.body']);
        expect(portalOffences('return createPortal(<div />, somewhere);')).toEqual(['portals without usePortalTarget()']);
    });

    it('with a layer provided, the Undo bar, a popover and a dialog land in it; with none, on the body', () => {
        const layer = document.createElement('div');
        document.body.appendChild(layer);
        const anchor = document.createElement('button');
        document.body.appendChild(anchor);
        const ui = (
            <>
                <UndoBar message="Archived" token={1} onUndo={() => {}} onExpire={() => {}} />
                <Popover anchor={anchor} onClose={() => {}} label="Colour"><span>pick</span></Popover>
                <NotesDialog title="Keyboard shortcuts" onClose={() => {}}><span>help</span></NotesDialog>
            </>
        );
        mount(<PortalTargetContext.Provider value={layer}>{ui}</PortalTargetContext.Provider>);
        for (const sel of ['.notes-undo', '.notes-popover', '[role="dialog"]']) {
            const el = document.querySelector(sel);
            expect(el, sel).not.toBeNull();
            expect(layer.contains(el), sel).toBe(true);
        }
        act(() => { root!.unmount(); });
        root = null;
        mount(ui);
        for (const sel of ['.notes-undo', '.notes-popover', '[role="dialog"]']) {
            const el = document.querySelector(sel);
            expect(el, sel).not.toBeNull();
            expect(layer.contains(el), sel).toBe(false);
            expect(el!.closest('body')).toBe(document.body);
        }
    });
});

// --- 2. The host's veto -----------------------------------------------------------------

describe('the calendar’s shortcuts', () => {
    function calendar(over: Partial<CalendarProps>) {
        const props: CalendarProps = {
            sources: [], view: 'day', date: '2030-10-07', onNavigate: () => {}, showCompleted: false, showPlain: true,
            onToggleCompleted: () => {}, onTogglePlain: () => {}, weekStart: 1, now: Date.parse('2030-10-01T12:00:00Z'), coarse: false,
            onOpen: () => {}, onMove: () => {}, onAdd: () => {}, onToggleDone: () => {}, shortcutsEnabled: true, ...over,
        };
        mount(<Calendar {...props} />);
    }

    it('POSITIVE CONTROL: `m` switches to the month', () => {
        const onNavigate = vi.fn();
        calendar({ onNavigate });
        press({ key: 'm' });
        expect(onNavigate).toHaveBeenCalledWith('month', '2030-10-07');
    });

    it('vetoed by the host, `m` does nothing and is not taken', () => {
        const onNavigate = vi.fn();
        calendar({ onNavigate, acceptKey: () => false });
        const e = press({ key: 'm' });
        expect(onNavigate).not.toHaveBeenCalled();
        expect(e.defaultPrevented).toBe(false);
    });

    it('the host is asked only about the calendar’s own keys', () => {
        const acceptKey = vi.fn(() => true);
        calendar({ acceptKey });
        press({ key: 'x' });
        press({ key: 'Enter' });
        expect(acceptKey).not.toHaveBeenCalled();
        press({ key: 'd' });
        expect(acceptKey).toHaveBeenCalledTimes(1);
    });
});

describe('the open note’s Escape', () => {
    const card = {
        ref: { kind: 'list', id: 5 }, key: 'list:5', title: 'Trip', body: null, noteAttachments: null,
        tasks: [], pinned: false, color: 'default', labels: [], archived: false, total: 0, completed: 0,
    } as unknown as NoteCard;
    const actions = {
        content: { features: { body: false, attachments: false }, setBody: vi.fn(async () => true) },
        deleteTaskFrom: vi.fn(), addTask: vi.fn(), setAttachments: vi.fn(), snoozeTask: vi.fn(),
        restoreCompleted: vi.fn(), toggleTask: vi.fn(), editTask: vi.fn(), moveTaskIn: vi.fn(),
        reorderTaskIn: vi.fn(), setDue: vi.fn(), setSchedule: vi.fn(), togglePin: vi.fn(),
        refreshNote: vi.fn(), renameNote: vi.fn(),
    } as unknown as NoteActions;
    const noop = () => {};
    function editor(onClose: () => void, acceptKey?: (e: KeyboardEvent) => boolean) {
        mount(
            <NoteEditor
                card={card} actions={actions} onClose={onClose} onMenu={noop} onPickColor={noop}
                onPickLabels={noop} onArchive={noop} onSendToPuca={noop} pucaHref={null} acceptKey={acceptKey}
            />,
        );
        (document.activeElement as HTMLElement | null)?.blur();
    }

    it('POSITIVE CONTROL: Escape closes the note', () => {
        const onClose = vi.fn();
        editor(onClose);
        press({ key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('vetoed by the host (one of its dialogs is over the note), Escape leaves it open', () => {
        const onClose = vi.fn();
        editor(onClose, () => false);
        press({ key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
    });
});

describe('the grid’s Ctrl+A', () => {
    const card = (id: number) => ({ key: `list:${id}`, ref: { kind: 'list', id }, title: `Note ${id}`, pinned: false, archived: false, color: 'default', labels: [] }) as unknown as NoteCard;
    const CARDS = [card(1), card(2)];
    const actions = { deleteNote: vi.fn(async () => true), content: { trashEnabled: true, isSelfList: () => false } } as unknown as NoteActions;
    let selected = -1;
    function Grid({ accept }: { accept?: (e: KeyboardEvent) => boolean }) {
        const bulk = useBulkPending(actions);
        const selection = useNoteSelection({ visible: CARDS, actions, labels: [], bulk, grid: isGridPath('/'), enabled: true, accept });
        const n = selection.selected.size;
        useEffect(() => { selected = n; }, [n]);
        return null;
    }
    beforeEach(() => { selected = -1; });

    it('POSITIVE CONTROL: it selects every note and takes the key', () => {
        mount(<Grid />);
        const e = press({ key: 'a', ctrlKey: true });
        expect(selected).toBe(2);
        expect(e.defaultPrevented).toBe(true);
    });

    it('vetoed by the host, it selects nothing and leaves the key to the page', () => {
        mount(<Grid accept={() => false} />);
        const e = press({ key: 'a', ctrlKey: true });
        expect(selected).toBe(0);
        expect(e.defaultPrevented).toBe(false);
    });
});
