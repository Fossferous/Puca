/**
 * The open note on a phone keeps the top of the screen for the note.
 *
 * The owner's report: tapping a note in Púca Notes on the phone, the things
 * along the top took half the screen. Measured at 390x844 (e2e, the report
 * of the change): the title row, then a wrapping block of Add photo / Add
 * file / Take photo / Draw / Voice note pills and a Hide checkboxes row put
 * a checklist's first item at y=420, and the footer wrapped onto a second
 * row for Close. Now, Google Keep's way: those tools are ONE "Add to note"
 * button at the start of the footer (NoteAddMenu), every action still there
 * and running the same handler; Labels and Archive are in the More menu,
 * and the X at the top closes. The wide screen is unchanged.
 *
 * Through the real NotesShell and NoteEditor (the harness is
 * notesComposeKeyboard.test.tsx's), with a coarse pointer and without.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

type Nav = { target: string | null; item: number | null };
type Shared = { text: string | null; subject: string | null; files: unknown[] };

const h = vi.hoisted(() => ({
    android: true,
    native: true,
    coarse: true,
    openTo: 'notes' as 'notes' | 'note' | 'list',
    features: { body: true, attachments: true, noteReminders: false, trash: false },
    known: true,
    launchNav: null as Nav | null,
    launchShare: null as Shared | null,
    navListeners: new Set<(n: Nav) => void>(),
    shareListeners: new Set<() => void>(),
    /** raiseNativeKeyboard: what it was called with, and what the page had
     *  focused at that moment (the keyboard types into THAT). */
    raised: [] as { active: Element | null }[],
    raiseAnswer: true,
    /** hideNativeKeyboard: what the page had focused when it asked. */
    lowered: [] as { active: Element | null }[],
    /** The native floor the served Notes manifest names (null = none): above
     *  the installed APK, the update gate puts its full-screen "Install the
     *  new Púca Notes app" over the shell it mounts. */
    gateMin: null as string | null,
    /** The notes the shell has, and whether they are still loading. */
    cards: [] as unknown[],
    loading: false,
    created: [] as { title: string; items: string[]; body?: string }[],
    /** What each note-media upload was handed (file names). */
    media: [] as string[][],
}));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isAndroidApp: () => h.android,
}));
vi.mock('../notes/native/notesNative', async importOriginal => ({
    ...(await importOriginal<typeof import('../notes/native/notesNative')>()),
    notesNativeAvailable: () => h.native,
    consumeNativeLaunchNav: async (): Promise<Nav> => {
        const n = h.launchNav ?? { target: null, item: null };
        h.launchNav = null;
        return n;
    },
    consumeNativeLaunchShare: async (): Promise<Shared> => {
        const s = h.launchShare ?? { text: null, subject: null, files: [] };
        h.launchShare = null;
        return s;
    },
    onNativeNavigate: (cb: (n: Nav) => void) => { h.navListeners.add(cb); return () => { h.navListeners.delete(cb); }; },
    onNativeShare: (cb: () => void) => { h.shareListeners.add(cb); return () => { h.shareListeners.delete(cb); }; },
    fetchSharedFiles: async () => [],
    syncNativeReminders: async () => ({ ok: true }),
    setNativeBackgroundRefresh: async () => undefined,
    raiseNativeKeyboard: async () => {
        h.raised.push({ active: document.activeElement });
        return h.raiseAnswer;
    },
    hideNativeKeyboard: async () => {
        h.lowered.push({ active: document.activeElement });
        return h.raiseAnswer;
    },
}));
// The update gate's engine, answered the way a server whose Notes manifest
// names `h.gateMin` answers it: the gate's own onManifest decides the prompt
// (a floor above the APK holds the bundle and shows the screen), and the run
// ends in the app, as the real one does.
vi.mock('../api/mobileOta', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/mobileOta')>()),
    runCapacitorOta: async (opts: import('../api/mobileOta').RunCapacitorOtaOptions) => {
        const manifest = { version: '0.9.999', url: 'https://chat.example.com/n.zip', variant: 'notes', native: h.gateMin ? { min: h.gateMin } : undefined };
        const go = opts.onManifest?.(manifest, { answeringBase: 'https://chat.example.com', runningVersion: '0.9.826', nativeVersion: '0.9.826' }) ?? true;
        opts.setState(s => ({ ...s, status: 'upToDate' }));
        return go ? 'nothing' as const : 'held' as const;
    },
}));
vi.mock('../api/taskReminders', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/taskReminders')>()),
    startTaskReminders: () => () => {},
}));
vi.mock('../components/IdentityBanner', () => ({ IdentityBanner: () => null }));
vi.mock('../notes/model/notesQueries', async importOriginal => {
    const real = await importOriginal<typeof import('../notes/model/notesQueries')>();
    const { EMPTY_KEEP_PREFS } = await import('../notes/model/notesPrefs');
    const noop = async () => null;
    const content = {
        get features() { return h.features; },
        get featuresKnown() { return h.known; },
        trashEnabled: false,
        isSelfList: () => false,
        ensureFeatures: () => Promise.resolve({ ...h.features }),
        setBody: async () => true,
        addNoteMedia: async (_id: number, photos: File[]) => { h.media.push(photos.map(f => f.name)); return true; },
        setNoteAttachments: async () => true,
    };
    const actions = {
        refreshAll: async () => {},
        createNote: async (title: string, items: string[], extra?: { body?: string }) => {
            h.created.push({ title, items, body: extra?.body });
            return { kind: 'list', id: 99 };
        },
        content,
        deleteTaskFrom: noop, addTask: noop, setAttachments: noop, snoozeTask: noop, restoreCompleted: noop,
        toggleTask: noop, editTask: noop, moveTaskIn: noop, reorderTaskIn: noop, setDue: noop, setSchedule: noop,
        togglePin: noop, refreshNote: noop, renameNote: noop, restoreNote: noop,
    };
    return {
        ...real,
        useNoteCards: () => ({ cards: h.cards, sources: [], prefs: [], prefsReady: true, loading: h.loading, error: null, tasksPending: false }),
        useNoteActions: () => actions,
        useNoteTasks: () => ({ data: [], isPending: false, isFetching: false }),
        useNotesPrefs: () => ({ ...EMPTY_KEEP_PREFS, openTo: h.openTo }),
    };
});
vi.mock('../notes/model/notesPrefsSync', async importOriginal => ({
    ...(await importOriginal<typeof import('../notes/model/notesPrefsSync')>()),
    useNotesPrefsSync: () => 'synced',
    useNotesUnsyncedFlag: () => {},
}));
vi.mock('../notes/model/taskEvents', async importOriginal => ({
    ...(await importOriginal<typeof import('../notes/model/taskEvents')>()),
    useTaskEvents: () => {},
}));
vi.mock('../notes/model/notesOutbox', async importOriginal => ({
    ...(await importOriginal<typeof import('../notes/model/notesOutbox')>()),
    useNotesOutbox: () => {},
    useOutboxPending: () => 0,
    useQueuedListDeletes: () => new Set<number>(),
}));
vi.mock('../notes/model/notesCache', async importOriginal => ({
    ...(await importOriginal<typeof import('../notes/model/notesCache')>()),
    useNotesCachePersistence: () => {},
}));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
        matches: q.includes('pointer: coarse') ? h.coarse : false,
        media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }),
});
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);

const { NotesShell } = await import('../notes/components/NotesShell');
const { NotesUpdateGate } = await import('../notes/components/NotesUpdateGate');
const { setNativePrompt } = await import('../notes/model/notesUpdate');
type Embedding = NonNullable<Parameters<typeof NotesShell>[0]['embedded']>;

let root: Root | null = null;
let host: HTMLElement | null = null;

/** `gate`: inside the Android app's update gate, as notes/main.tsx mounts it. */
function mount({ coldStart = true, embedded, gate = false }: { coldStart?: boolean; embedded?: Embedding; gate?: boolean } = {}) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient();
    const shell = <NotesShell onSignOut={() => {}} embedded={embedded} coldStart={coldStart} />;
    act(() => {
        root!.render(
            <QueryClientProvider client={qc}>
                <MemoryRouter initialEntries={['/']}>
                    {gate ? <NotesUpdateGate native>{shell}</NotesUpdateGate> : shell}
                </MemoryRouter>
            </QueryClientProvider>,
        );
    });
}


/** requestAnimationFrame callbacks, run by settle() only once React has
 *  drawn what the state changes before them asked for — the order a browser
 *  gives them. The old focus paths (Take a note…, the sheet's title) depend
 *  on it: run synchronously, or on a bare timer that can beat React's
 *  render, they would focus a field that is about to be replaced. */
let frames: FrameRequestCallback[] = [];
const settle = async () => {
    for (let round = 0; round < 4; round++) {
        await act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
        const due = frames;
        frames = [];
        if (due.length) act(() => { for (const f of due) f(0); });
    }
};


beforeEach(() => {
    h.android = true;
    h.native = true;
    h.coarse = true;
    h.openTo = 'notes';
    h.features = { body: true, attachments: true, noteReminders: false, trash: false };
    h.known = true;
    h.launchNav = null;
    h.launchShare = null;
    h.navListeners.clear();
    h.shareListeners.clear();
    h.raised = [];
    h.raiseAnswer = true;
    h.lowered = [];
    h.gateMin = null;
    h.cards = [];
    h.loading = false;
    h.created = [];
    h.media = [];
    setNativePrompt(null);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, 'elementFromPoint');
    setNativePrompt(null);
});


/** A personal note with text and one item, as NotesShell's cards carry one. */
const card = (id: number, title: string, body: string) => ({
    key: `list:${id}`, ref: { kind: 'list', id }, title, body,
    tasks: [{ id: 501, description: 'Milk', is_completed: false, parent_id: null, position: 0 }],
    pinned: false, color: 'default', labels: [], archived: false, total: 1, completed: 0,
    createdAt: '2026-10-01T08:00:00Z', updatedAt: '2026-10-12T08:00:00Z', contentRev: 1,
});
const editorEl = () => document.querySelector('.notes-editor:not(.notes-quickadd-sheet)');
const foot = () => document.querySelector('.notes-editor-foot');
const addButton = () => document.querySelector<HTMLButtonElement>('.notes-editor-foot button[aria-label="Add to note"]');
const menuItems = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(b => b.textContent?.trim());
const openNoteByTap = async () => {
    act(() => { document.querySelector<HTMLElement>('.notes-card')!.click(); });
    await settle();
};

describe('the open note on a phone', () => {
    it('no add pills and no conversion row above the items: one "Add to note" in the footer instead', async () => {
        h.cards = [card(1, 'Groceries', 'some text')];
        mount();
        await settle();
        await openNoteByTap();
        expect(editorEl()).not.toBeNull();
        expect(editorEl()!.querySelector('.ni-actions'), 'the pill block is gone from the top').toBeNull();
        expect(editorEl()!.querySelector('.notes-convert-row'), 'so is the checkbox row').toBeNull();
        expect(addButton(), 'the footer has the one button').not.toBeNull();
        expect(foot()!.firstElementChild?.contains(addButton()), 'first in the row, where Keep has it').toBe(true);
    });

    it('nothing is lost: the menu holds every action the pills and the row had', async () => {
        h.cards = [card(1, 'Groceries', 'some text')];
        mount();
        await settle();
        await openNoteByTap();
        act(() => { addButton()!.click(); });
        await settle();
        // The harness's note has text and no items loaded (useNoteTasks
        // answers []), so Show checkboxes is offered and Hide is not — the
        // row's own rule. jsdom cannot record, so no Voice note either.
        expect(menuItems()).toEqual(['Add photo', 'Add file', 'Take photo', 'Draw', 'Show checkboxes']);
    });

    it('a menu choice runs: Draw opens the drawing, and the menu closes', async () => {
        h.cards = [card(1, 'Groceries', 'some text')];
        mount();
        await settle();
        await openNoteByTap();
        act(() => { addButton()!.click(); });
        await settle();
        const draw = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent?.trim() === 'Draw')!;
        act(() => { draw.click(); });
        await settle();
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(document.querySelector('.notes-draw-backdrop[aria-label="Drawing"]')).not.toBeNull();
    });

    it('Add photo hands the picked file to the same upload the pill used', async () => {
        h.cards = [card(1, 'Groceries', 'some text')];
        h.media = [];
        mount();
        await settle();
        await openNoteByTap();
        const input = document.querySelector<HTMLInputElement>('[data-testid="nam-pick"]')!;
        expect(input, 'the picker lives outside the menu, so it outlives it').not.toBeNull();
        const file = new File(['x'], 'a.png', { type: 'image/png' });
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        await settle();
        expect(h.media).toEqual([['a.png']]);
    });

    it('Labels, Archive and Close are marked to leave the phone footer — the More menu and the X still do them', async () => {
        h.cards = [card(1, 'Groceries', 'some text')];
        mount();
        await settle();
        await openNoteByTap();
        const wide = [...foot()!.querySelectorAll('.notes-foot-wide')].map(b => b.getAttribute('aria-label') ?? b.textContent?.trim());
        expect(wide).toEqual(['Labels', 'Archive', 'Close']);
        expect(foot()!.querySelector('button[aria-label="More actions"]')).not.toBeNull();
        expect(editorEl()!.querySelector('.notes-editor-head button[aria-label="Close note"]')).not.toBeNull();
    });
});

describe('the wide screen is unchanged', () => {
    it('the pills and the conversion row stay in the note; no "Add to note"', async () => {
        h.coarse = false;
        h.cards = [card(1, 'Groceries', 'some text')];
        mount();
        await settle();
        await openNoteByTap();
        expect(editorEl()!.querySelector('.ni-actions')).not.toBeNull();
        expect(editorEl()!.querySelector('.notes-convert-row')).not.toBeNull();
        expect(addButton()).toBeNull();
    });
});
