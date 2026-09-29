/**
 * A composer opened from OUTSIDE the page lands ready to type: a launcher
 * shortcut, the quick tile, the widget, another app sending the same intent
 * (MacroDroid: action VIEW, component com.sovereign.notes/.MainActivity,
 * extra notes_nav=compose-note), or "Open Púca Notes to". Through the real
 * NotesShell and the real composer, with the native bridge and the data
 * layer faked.
 *
 * The contract, and what each block pins:
 *  - a text note lands on its TEXT, a checklist on its first item (not the
 *    title the phone's sheet focuses when it opens), and the Android
 *    keyboard is asked for exactly once, after that field has the focus —
 *    at a cold start, on a warm start (the plugin's `navigate` event), and
 *    for Open Púca Notes to;
 *  - a drawing or a photo asks for no keyboard: a drawing leaves no field
 *    focused under its canvas, and both ask the Android app, once, to keep
 *    the keyboard DOWN (Android restores one that was up when the app left);
 *  - everything the page does itself keeps its old focus and never asks:
 *    the New note button, the wide screen's Take a note…, the `c` key, and
 *    a share (its content is already in);
 *  - a request that waited behind the sign-in page opens as it always did,
 *    keyboard down;
 *  - under another screen (the update gate's "Install the new Púca Notes
 *    app", which the shell mounts beneath at a cold start) neither the field
 *    nor the keyboard is taken;
 *  - an APK without the method (the helper answers false) changes nothing
 *    else, and the desktop app's Notes never asks.
 *
 * The native half — does asking raise the keyboard on a device, and does a
 * focus() alone not — is notes-app androidTest/NotesKeyboardTest; the
 * wrapper's own feature detection is notesNative.test.ts.
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
    };
    const actions = {
        refreshAll: async () => {},
        createNote: async () => ({ kind: 'list', id: 99 }),
        content,
        deleteTaskFrom: noop, addTask: noop, setAttachments: noop, snoozeTask: noop, restoreCompleted: noop,
        toggleTask: noop, editTask: noop, moveTaskIn: noop, reorderTaskIn: noop, setDue: noop, setSchedule: noop,
        togglePin: noop, refreshNote: noop, renameNote: noop, restoreNote: noop,
    };
    return {
        ...real,
        useNoteCards: () => ({ cards: [], sources: [], prefs: [], prefsReady: true, loading: false, error: null, tasksPending: false }),
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

/**
 * What the page draws at a point, for the one stacking these tests need: the
 * update gate's screen (position fixed, inset 0, z-index 1200 — over the
 * sheet's 900) wherever it is up, and otherwise the composer's own field.
 * jsdom has no layout and no elementFromPoint at all, so without this nothing
 * can count as covered. The device half is the emulator run.
 */
function layOut() {
    Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: () => document.querySelector('.notes-update-gate h2') ?? textArea() ?? items()[0] ?? null,
    });
}
const gateScreen = () => document.querySelector('.notes-update-gate[aria-label="Install the new Púca Notes app"]');

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
/** A tap that arrives while the app is already up (a warm start). */
const warmTap = async (target: string) => {
    act(() => { for (const cb of h.navListeners) cb({ target, item: null }); });
    await settle();
};

const composer = () => document.querySelector('.notes-quickadd[role="dialog"]');
const textArea = () => document.querySelector<HTMLTextAreaElement>('.notes-quickadd[role="dialog"] textarea.notes-quickadd-body');
const items = () => [...document.querySelectorAll<HTMLInputElement>('.notes-quickadd[role="dialog"] .notes-quickadd-item input')];
const titleField = () => document.querySelector<HTMLInputElement>('.notes-quickadd[role="dialog"] input.notes-quickadd-title');
const drawing = () => document.querySelector('.notes-draw-backdrop[aria-label="Drawing"]');
const active = () => document.activeElement;

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

describe('New note from outside the app (the shortcut, the tile, the widget, a MacroDroid intent)', () => {
    it('cold start: the note’s TEXT has the focus, and the keyboard is asked for once, after it', async () => {
        h.launchNav = { target: 'compose-note', item: null };
        mount();
        await settle();
        expect(textArea()).not.toBeNull();
        expect(active()).toBe(textArea());
        expect(h.raised).toHaveLength(1);
        expect(h.raised[0].active, 'asked with the text already focused').toBe(textArea());
        expect(h.lowered, 'a note to type in never asks for it to go').toHaveLength(0);
    });

    it('warm start (the app was in the background): the same', async () => {
        mount();
        await settle();
        expect(composer(), 'nothing open before the tap').toBeNull();
        await warmTap('compose-note');
        expect(active()).toBe(textArea());
        expect(h.raised).toHaveLength(1);
        expect(h.raised[0].active).toBe(textArea());
    });

    it('the wide screen’s inline composer (a tablet): the text too, once', async () => {
        h.coarse = false;
        mount();
        await settle();
        await warmTap('compose-note');
        expect(active()).toBe(textArea());
        expect(h.raised).toHaveLength(1);
    });

    it('asked again with the composer already open: its text again, and one more ask — not two', async () => {
        mount();
        await settle();
        await warmTap('compose-note');
        await warmTap('compose-note');
        expect(active()).toBe(textArea());
        expect(h.raised).toHaveLength(2);
    });
});

describe('New list from outside the app', () => {
    it('cold start: the first item has the focus, and the keyboard is asked for once', async () => {
        h.launchNav = { target: 'compose-list', item: null };
        mount();
        await settle();
        expect(items().length).toBeGreaterThan(0);
        expect(active()).toBe(items()[0]);
        expect(h.raised).toHaveLength(1);
        expect(h.raised[0].active).toBe(items()[0]);
    });

    it('warm start: the same', async () => {
        mount();
        await settle();
        await warmTap('compose-list');
        expect(active()).toBe(items()[0]);
        expect(h.raised).toHaveLength(1);
    });

    it('a server that keeps no note text: New note opens the checklist, ready on its first item', async () => {
        h.features = { ...h.features, body: false };
        h.launchNav = { target: 'compose-note', item: null };
        mount();
        await settle();
        expect(textArea()).toBeNull();
        expect(active()).toBe(items()[0]);
        expect(h.raised).toHaveLength(1);
    });
});

describe('a drawing or a photo: no keyboard', () => {
    it('Draw: the canvas opens, nothing is asked for, and no field keeps the focus under it', async () => {
        h.launchNav = { target: 'compose-draw', item: null };
        mount();
        await settle();
        expect(drawing(), 'the drawing opened').not.toBeNull();
        expect(h.raised).toHaveLength(0);
        expect(composer()!.contains(active()), 'no field under the canvas is focused').toBe(false);
        expect(h.lowered, 'the app is asked to keep the keyboard down, once').toHaveLength(1);
        expect(composer()!.contains(h.lowered[0].active), 'asked after the composer let go of the focus').toBe(false);
    });

    it('Draw over a checklist already open with its item focused: that field lets go', async () => {
        mount();
        await settle();
        await warmTap('compose-list');
        expect(active(), 'precondition: the item has the focus').toBe(items()[0]);
        await warmTap('compose-draw');
        expect(drawing()).not.toBeNull();
        expect(composer()!.contains(active())).toBe(false);
        expect(h.raised, 'only the list asked').toHaveLength(1);
        // The case the native half exists for: the list's keyboard was up
        // when the app left, and Android puts it back as the window returns.
        expect(h.lowered).toHaveLength(1);
        expect(composer()!.contains(h.lowered[0].active)).toBe(false);
    });

    it('Photo: the Take photo button has the focus, and nothing is asked for', async () => {
        h.launchNav = { target: 'compose-photo', item: null };
        mount();
        await settle();
        expect(active()?.getAttribute('aria-label')).toBe('Take photo');
        expect(h.raised).toHaveLength(0);
        expect(h.lowered, 'kept down, once, with the button already focused').toHaveLength(1);
        expect(h.lowered[0].active?.getAttribute('aria-label')).toBe('Take photo');
    });

    it('Draw on a server that keeps no pictures opens a checklist — and THAT is typed: keyboard up, not down', async () => {
        h.features = { ...h.features, attachments: false };
        h.launchNav = { target: 'compose-draw', item: null };
        mount();
        await settle();
        expect(drawing()).toBeNull();
        expect(active()).toBe(items()[0]);
        expect(h.raised).toHaveLength(1);
        expect(h.lowered).toHaveLength(0);
    });
});

describe('"Open Púca Notes to"', () => {
    it('A new note, at the app’s start: the text, and the keyboard once', async () => {
        h.openTo = 'note';
        mount();
        await settle();
        expect(active()).toBe(textArea());
        expect(h.raised).toHaveLength(1);
    });

    it('A new list, at the app’s start: the first item, and the keyboard once', async () => {
        h.openTo = 'list';
        mount();
        await settle();
        expect(active()).toBe(items()[0]);
        expect(h.raised).toHaveLength(1);
    });
});

describe('what the page opens itself keeps its old focus and never asks', () => {
    it('the phone’s New note button: the title, as before', async () => {
        mount();
        await settle();
        act(() => { document.querySelector<HTMLButtonElement>('.notes-fab')!.click(); });
        await settle();
        expect(composer()).not.toBeNull();
        expect(active()).toBe(titleField());
        expect(h.raised).toHaveLength(0);
        expect(h.lowered).toHaveLength(0);
    });

    it('the wide screen’s Take a note…: the first item, as before', async () => {
        h.coarse = false;
        mount();
        await settle();
        act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Take a note"]')!.click(); });
        await settle();
        expect(active()).toBe(items()[0]);
        expect(h.raised).toHaveLength(0);
    });

    it('the c key', async () => {
        h.coarse = false;
        mount();
        await settle();
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true })); });
        await settle();
        expect(composer()).not.toBeNull();
        expect(h.raised).toHaveLength(0);
    });

    it('a share from another app: the composer opens with it, focused as before, no ask', async () => {
        h.launchShare = { text: 'Milk and bread', subject: null, files: [] };
        mount();
        await settle();
        expect(titleField()?.value).toBe('Milk and bread');
        expect(active()).toBe(titleField());
        expect(h.raised).toHaveLength(0);
        expect(h.lowered).toHaveLength(0);
    });
});

describe('signed out, then signed in', () => {
    it('a New note that waited behind the sign-in page opens as it always did — title focused, keyboard down', async () => {
        // The shell a sign-in mounts is not the app's start (coldStart false)
        // and drains the request that has been parked since.
        h.launchNav = { target: 'compose-note', item: null };
        mount({ coldStart: false });
        await settle();
        expect(textArea(), 'the composer still opens').not.toBeNull();
        expect(active()).toBe(titleField());
        expect(h.raised).toHaveLength(0);
    });

    it('a Draw that waited behind the sign-in page: the canvas, and the keyboard left to Android as before', async () => {
        h.launchNav = { target: 'compose-draw', item: null };
        mount({ coldStart: false });
        await settle();
        expect(drawing()).not.toBeNull();
        expect(h.raised).toHaveLength(0);
        expect(h.lowered).toHaveLength(0);
    });

    it('POSITIVE CONTROL: a tap AFTER that sign-in is fresh, and gets the keyboard', async () => {
        mount({ coldStart: false });
        await settle();
        await warmTap('compose-note');
        expect(active()).toBe(textArea());
        expect(h.raised).toHaveLength(1);
    });
});

describe('under another screen: the update gate’s "Install the new Púca Notes app"', () => {
    // Served a manifest whose native floor is above this APK, the gate holds
    // the bundle and, at a cold start, mounts the shell UNDER its full-screen
    // prompt. A New note from outside still opens its composer there, but the
    // keyboard must not come up over the prompt and type into a composer
    // nobody can see — it did, measured on the emulator.
    it('POSITIVE CONTROL — the floor met, no screen: the same layout lands on the text and asks', async () => {
        layOut();
        h.launchNav = { target: 'compose-note', item: null };
        mount({ gate: true });
        await settle();
        expect(gateScreen()).toBeNull();
        expect(active()).toBe(textArea());
        expect(h.raised).toHaveLength(1);
    });

    it('something over the field that is not a screen (a strip, a toast) does not cost the keyboard', async () => {
        const toast = document.createElement('div');
        toast.className = 'a-toast';
        document.body.appendChild(toast);
        Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => toast });
        h.launchNav = { target: 'compose-note', item: null };
        mount({ gate: true });
        await settle();
        expect(active()).toBe(textArea());
        expect(h.raised).toHaveLength(1);
    });

    it('a New note at a cold start: the composer opens beneath, as it always did — title, no keyboard', async () => {
        layOut();
        h.gateMin = '99.0.0';
        h.launchNav = { target: 'compose-note', item: null };
        mount({ gate: true });
        await settle();
        expect(gateScreen(), 'the prompt is up').not.toBeNull();
        expect(textArea(), 'the composer still opens, beneath it').not.toBeNull();
        expect(active(), 'the sheet keeps its own opening focus, not the text').toBe(titleField());
        expect(h.raised).toHaveLength(0);
    });

    it('a New list: its first item is not taken either, and nothing is asked for', async () => {
        layOut();
        h.gateMin = '99.0.0';
        h.launchNav = { target: 'compose-list', item: null };
        mount({ gate: true });
        await settle();
        expect(gateScreen()).not.toBeNull();
        expect(items().length).toBeGreaterThan(0);
        expect(active()).not.toBe(items()[0]);
        expect(h.raised).toHaveLength(0);
    });

    it('Continue shows that composer with no late keyboard, and the next New note gets it', async () => {
        layOut();
        h.gateMin = '99.0.0';
        h.launchNav = { target: 'compose-note', item: null };
        mount({ gate: true });
        await settle();
        const cont = [...document.querySelectorAll<HTMLButtonElement>('.notes-update-gate button')].find(b => b.textContent === 'Continue');
        expect(cont).toBeDefined();
        act(() => { cont!.click(); });
        await settle();
        expect(gateScreen()).toBeNull();
        expect(textArea()).not.toBeNull();
        expect(h.raised, 'a request is not kept for later').toHaveLength(0);
        await warmTap('compose-note');
        expect(active()).toBe(textArea());
        expect(h.raised).toHaveLength(1);
    });
});

describe('where there is no keyboard to ask for', () => {
    it('an APK without the method (the helper answers false): the field keeps the focus, nothing else changes', async () => {
        h.raiseAnswer = false;
        h.launchNav = { target: 'compose-note', item: null };
        mount();
        await settle();
        expect(active()).toBe(textArea());
        expect(h.raised).toHaveLength(1);
        expect(composer()).not.toBeNull();
    });

    it('the desktop app’s Notes: no launch is read, and its own composer never asks', async () => {
        h.coarse = false;
        h.launchNav = { target: 'compose-note', item: null };
        mount({ embedded: { active: true, ownsKey: () => true } });
        await settle();
        expect(composer(), 'no launch is read inside the desktop app').toBeNull();
        act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Take a note"]')!.click(); });
        await settle();
        expect(composer()).not.toBeNull();
        expect(h.raised).toHaveLength(0);
        expect(h.lowered).toHaveLength(0);
    });

    it('the web page: no launch, and its own composer never asks', async () => {
        h.android = false;
        h.native = false;
        h.coarse = false;
        h.launchNav = { target: 'compose-note', item: null };
        mount();
        await settle();
        expect(composer()).toBeNull();
        act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Take a note"]')!.click(); });
        await settle();
        expect(composer()).not.toBeNull();
        expect(h.raised).toHaveLength(0);
        expect(h.lowered).toHaveLength(0);
    });
});
