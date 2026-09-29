/**
 * "Open Púca Notes to" — the Android app opening straight on a new note or a
 * new list (native/useNotesOpenTo.ts), through the real NotesShell and the
 * real composer, with the native bridge and the data layer faked.
 *
 * The contract, and what each block pins:
 *  - the account-menu row exists in the Android app ONLY: not on the web
 *    page, not in the desktop app's Notes (the app shell is the control);
 *  - at the app's START, signed in, the composer opens in the chosen mode —
 *    through the New note / New list shortcut's own path, so a server that
 *    keeps no note text gets a checklist — and never for "Your notes", never
 *    for a shell a sign-in mounted, never over what the launch itself asked
 *    for (a shortcut, a reminder tap, a share);
 *  - on COMING BACK after five minutes or more, with nothing open, it opens
 *    the same way; a quick switch, anything open, a search, the Trash /
 *    Reminders / Calendar pages, or a request that came with the return all
 *    leave the app as it was;
 *  - opening a composer saves nothing: closed untouched, no note.
 *
 * Every "nothing opens" has a sibling where it does, so a hook that never
 * fired would fail the positive control instead of passing the rest.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';

type Nav = { target: string | null; item: number | null };
type Shared = { text: string | null; subject: string | null; files: unknown[] };

const h = vi.hoisted(() => ({
    /** isAndroidApp(): the Púca Notes APK. */
    android: true,
    /** The NotesNative plugin answers. */
    native: true,
    /** A phone: the composer is the full-screen sheet. */
    coarse: true,
    openTo: 'note' as 'notes' | 'note' | 'list',
    features: { body: true, attachments: false, noteReminders: false, trash: false },
    known: true,
    /** What the launch carried (one-shot, like the plugin). */
    launchNav: null as Nav | null,
    launchShare: null as Shared | null,
    navListeners: new Set<(n: Nav) => void>(),
    shareListeners: new Set<() => void>(),
    /** Replaces the features ask, to hold a share on it. */
    ensure: null as null | (() => Promise<unknown>),
    created: [] as unknown[][],
    openToSet: [] as string[],
    cards: [] as unknown[],
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
}));
vi.mock('../api/taskReminders', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/taskReminders')>()),
    startTaskReminders: () => () => {},
}));
vi.mock('../components/IdentityBanner', () => ({ IdentityBanner: () => null }));
vi.mock('../notes/model/notesPrefs', async importOriginal => ({
    ...(await importOriginal<typeof import('../notes/model/notesPrefs')>()),
    setNotesOpenTo: (o: string) => { h.openToSet.push(o); },
}));
vi.mock('../notes/model/notesQueries', async importOriginal => {
    const real = await importOriginal<typeof import('../notes/model/notesQueries')>();
    const { EMPTY_KEEP_PREFS } = await import('../notes/model/notesPrefs');
    const noop = async () => null;
    // One object, its answers read live: the shell sees a stable `actions`
    // (as it does from the real hook) and a test can still change them.
    const content = {
        get features() { return h.features; },
        get featuresKnown() { return h.known; },
        trashEnabled: false,
        isSelfList: () => false,
        ensureFeatures: () => (h.ensure ? h.ensure() : Promise.resolve({ ...h.features })),
        setBody: async () => true,
    };
    const actions = {
        refreshAll: async () => {},
        createNote: async (...args: unknown[]) => { h.created.push(args); return { kind: 'list', id: 99 }; },
        content,
        deleteTaskFrom: noop, addTask: noop, setAttachments: noop, snoozeTask: noop, restoreCompleted: noop,
        toggleTask: noop, editTask: noop, moveTaskIn: noop, reorderTaskIn: noop, setDue: noop, setSchedule: noop,
        togglePin: noop, refreshNote: noop, renameNote: noop, restoreNote: noop,
    };
    return {
        ...real,
        useNoteCards: () => ({ cards: h.cards, sources: [], prefs: [], prefsReady: true, loading: false, error: null, tasksPending: false }),
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

// The page's visibility, as the WebView reports it.
let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const { NotesShell } = await import('../notes/components/NotesShell');
const { OPEN_TO_AWAY_MS, OPEN_TO_SETTLE_MS, useStartedSignedIn } = await import('../notes/native/useNotesOpenTo');
const { SHARE_ASK_MS } = await import('../notes/model/composeIntent');
type Embedding = NonNullable<Parameters<typeof NotesShell>[0]['embedded']>;

let root: Root | null = null;
let host: HTMLElement | null = null;
let path = '';
function Where() {
    const at = useLocation();
    useEffect(() => { path = at.pathname; }, [at]);
    return null;
}

function mount({ coldStart = true, embedded, at = '/' }: { coldStart?: boolean; embedded?: Embedding; at?: string } = {}) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient();
    const ui = () => (
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[at]}>
                <NotesShell onSignOut={() => {}} embedded={embedded} coldStart={coldStart} />
                <Where />
            </MemoryRouter>
        </QueryClientProvider>
    );
    act(() => { root!.render(ui()); });
    return { rerender: () => act(() => { root!.render(ui()); }) };
}
const EMBEDDED: Embedding = { active: true, ownsKey: () => true };

/** Real timers: let the launch drains and the renders they cause land. */
const settle = async () => {
    await act(async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); });
};
/** Fake timers: move the clock, with every promise and render in between. */
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const useFakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

const setVisibility = (v: DocumentVisibilityState) => act(() => {
    visibility = v;
    document.dispatchEvent(new Event('visibilitychange'));
});
/** Away for `ms`, then back — and the settle a return waits out. */
async function awayFor(ms: number) {
    setVisibility('hidden');
    await tick(ms);
    setVisibility('visible');
    await tick(OPEN_TO_SETTLE_MS);
}

const sheet = () => document.querySelector('.notes-quickadd-sheet');
const composer = () => document.querySelector('.notes-quickadd[role="dialog"]');
const textArea = () => document.querySelector<HTMLTextAreaElement>('.notes-quickadd[role="dialog"] textarea.notes-quickadd-body');
const items = () => [...document.querySelectorAll<HTMLInputElement>('.notes-quickadd[role="dialog"] .notes-quickadd-item input')];
const titleField = () => document.querySelector<HTMLInputElement>('.notes-quickadd[role="dialog"] input.notes-quickadd-title');
const openToRow = () => document.querySelector<HTMLSelectElement>('#notes-open-to');

/** React owns a field's value; assigning it directly is invisible to it. */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    act(() => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
function openAccountMenu() {
    act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Account and settings"]')!.click(); });
}

const note = {
    ref: { kind: 'list', id: 5 }, key: 'list:5', title: 'Trip', body: null, noteAttachments: null,
    tasks: [], pinned: false, color: 'default', labels: [], archived: false, total: 0, completed: 0,
};

beforeEach(() => {
    h.android = true;
    h.native = true;
    h.coarse = true;
    h.openTo = 'note';
    h.features = { body: true, attachments: false, noteReminders: false, trash: false };
    h.known = true;
    h.launchNav = null;
    h.launchShare = null;
    h.navListeners.clear();
    h.shareListeners.clear();
    h.ensure = null;
    h.created = [];
    h.openToSet = [];
    h.cards = [];
    visibility = 'visible';
    path = '';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('the setting, in the account menu', () => {
    it('POSITIVE CONTROL: the Android app has "Open Púca Notes to", on Your notes, with the three choices', async () => {
        h.openTo = 'notes';
        mount();
        await settle();
        openAccountMenu();
        const row = openToRow();
        expect(row).not.toBeNull();
        expect(row!.value).toBe('notes');
        expect([...row!.options].map(o => [o.value, o.textContent])).toEqual([
            ['notes', 'Your notes'], ['note', 'A new note'], ['list', 'A new list'],
        ]);
        expect(document.querySelector('label[for="notes-open-to"]')?.textContent).toBe('Open Púca Notes to');
    });

    it('choosing one stores it (on this device, through the prefs store)', async () => {
        h.openTo = 'notes';
        mount();
        await settle();
        openAccountMenu();
        const row = openToRow()!;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(row, 'list');
            row.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(h.openToSet).toEqual(['list']);
    });

    it('is not on the web page', async () => {
        h.android = false;
        mount();
        await settle();
        openAccountMenu();
        expect(document.querySelector('#notes-sort'), 'the menu did open').not.toBeNull();
        expect(openToRow()).toBeNull();
    });

    it('is not in the desktop app’s Notes', async () => {
        mount({ embedded: EMBEDDED });
        await settle();
        openAccountMenu();
        expect(document.querySelector('#notes-sort'), 'the menu did open').not.toBeNull();
        expect(openToRow()).toBeNull();
    });
});

describe('when the app starts', () => {
    it('A new note: the composer opens as a text note, the phone’s sheet, once the launch is read', async () => {
        mount();
        await settle();
        expect(sheet()).not.toBeNull();
        expect(textArea()).not.toBeNull();
        expect(items()).toHaveLength(0);
    });

    it('A new list: it opens as a checklist', async () => {
        h.openTo = 'list';
        mount();
        await settle();
        expect(sheet()).not.toBeNull();
        expect(items().length).toBeGreaterThan(0);
        expect(textArea()).toBeNull();
    });

    it('Your notes (the default): nothing opens', async () => {
        h.openTo = 'notes';
        mount();
        await settle();
        expect(composer()).toBeNull();
    });

    it('a server that keeps no note text: A new note opens a checklist, as the New note shortcut does there', async () => {
        h.features = { ...h.features, body: false };
        mount();
        await settle();
        expect(sheet()).not.toBeNull();
        expect(items().length).toBeGreaterThan(0);
        expect(textArea()).toBeNull();
    });

    it('waits for the server’s answer before it picks text or checklist', async () => {
        h.known = false;
        const view = mount();
        await settle();
        expect(composer(), 'not before the answer').toBeNull();
        h.known = true;
        view.rerender();
        await settle();
        expect(textArea()).not.toBeNull();
    });

    it('offline, it stops waiting after the same bound a share has, and opens on what the page believes', async () => {
        useFakeClock();
        h.known = false;
        h.features = { ...h.features, body: false };   // the stand-in: no note text
        mount();
        await tick(0);
        await tick(SHARE_ASK_MS - 1);
        expect(composer()).toBeNull();
        await tick(1);
        expect(sheet()).not.toBeNull();
        expect(items().length).toBeGreaterThan(0);
    });

    it('a launcher shortcut the app was started with wins: New list opens a checklist, not the chosen note', async () => {
        h.launchNav = { target: 'compose-list', item: null };
        mount();
        await settle();
        expect(items().length).toBeGreaterThan(0);
        expect(textArea()).toBeNull();
    });

    it('a shortcut from a newer app that this page does not know still wins: the app opens as it does today', async () => {
        h.launchNav = { target: 'compose-something-later', item: null };
        mount();
        await settle();
        expect(composer()).toBeNull();
    });

    it('a reminder tap the app was started with wins: Reminders, and no composer over it', async () => {
        h.launchNav = { target: 'reminders', item: null };
        mount();
        await settle();
        expect(path).toBe('/reminders');
        expect(composer()).toBeNull();
    });

    it('a share the app was started with wins: nothing opens while it waits for the server, then the share does', async () => {
        h.openTo = 'list';
        let release: () => void = () => {};
        h.ensure = () => new Promise(r => { release = () => r({ ...h.features }); });
        h.launchShare = { text: 'Milk and bread', subject: null, files: [] };
        mount();
        await settle();
        expect(composer(), 'nothing opened over the share still on its way').toBeNull();
        await act(async () => { release(); });
        await settle();
        expect(titleField()?.value).toBe('Milk and bread');
        expect(textArea(), 'the share’s own text composer, not the chosen checklist').not.toBeNull();
    });

    it('a shell a sign-in mounted is not the app starting: nothing opens', async () => {
        mount({ coldStart: false });
        await settle();
        expect(composer()).toBeNull();
    });

    it('not in the desktop app’s Notes', async () => {
        mount({ embedded: EMBEDDED });
        await settle();
        expect(composer()).toBeNull();
    });

    it('not on the web page', async () => {
        h.android = false;
        mount();
        await settle();
        expect(composer()).toBeNull();
    });

    it('not over a note the page opened on', async () => {
        h.cards = [note];
        mount({ at: '/?note=list%3A5' });
        await settle();
        expect(document.querySelector('.notes-editor')).not.toBeNull();
        expect(composer()).toBeNull();
    });

    it('not over a note in the address whose notes are still loading (no editor drawn yet)', async () => {
        mount({ at: '/?note=list%3A5' });
        await settle();
        expect(document.querySelector('.notes-editor'), 'nothing drawn for it yet').toBeNull();
        expect(composer()).toBeNull();
    });
});

describe('the composer it opens saves nothing by itself', () => {
    it('closed untouched: no note', async () => {
        mount();
        await settle();
        expect(sheet()).not.toBeNull();
        act(() => { document.querySelector<HTMLButtonElement>('.notes-quickadd-sheet .notes-textbtn')!.click(); });
        await settle();
        expect(sheet()).toBeNull();
        expect(h.created).toHaveLength(0);
    });

    it('POSITIVE CONTROL: typed in and closed, it is a note', async () => {
        mount();
        await settle();
        typeInto(textArea()!, 'Call the plumber');
        act(() => { document.querySelector<HTMLButtonElement>('.notes-quickadd-sheet .notes-textbtn')!.click(); });
        await settle();
        expect(h.created).toHaveLength(1);
    });
});

describe('coming back to the app', () => {
    beforeEach(() => { useFakeClock(); });

    it('after five minutes away, with nothing open: the composer opens in the chosen mode', async () => {
        mount({ coldStart: false });
        await tick(0);
        expect(composer()).toBeNull();
        await awayFor(OPEN_TO_AWAY_MS);
        expect(sheet()).not.toBeNull();
        expect(textArea()).not.toBeNull();
    });

    it('A new list comes back as a checklist', async () => {
        h.openTo = 'list';
        mount({ coldStart: false });
        await tick(0);
        await awayFor(OPEN_TO_AWAY_MS);
        expect(items().length).toBeGreaterThan(0);
        expect(textArea()).toBeNull();
    });

    it('a quick switch away and back (under five minutes) opens nothing', async () => {
        mount({ coldStart: false });
        await tick(0);
        await awayFor(OPEN_TO_AWAY_MS - 1000);
        await tick(5000);
        expect(composer()).toBeNull();
    });

    it('Your notes: nothing, however long away', async () => {
        h.openTo = 'notes';
        mount({ coldStart: false });
        await tick(0);
        await awayFor(OPEN_TO_AWAY_MS * 3);
        expect(composer()).toBeNull();
    });

    it('with a note open: the note stays, and no composer', async () => {
        h.cards = [note];
        mount({ coldStart: false, at: '/?note=list%3A5' });
        await tick(0);
        await awayFor(OPEN_TO_AWAY_MS);
        expect(document.querySelector('.notes-editor')).not.toBeNull();
        expect(composer()).toBeNull();
    });

    it('with the composer already open: what is in it is left alone', async () => {
        mount({ coldStart: false });
        await tick(0);
        act(() => { document.querySelector<HTMLButtonElement>('.notes-fab')!.click(); });
        typeInto(items()[0], 'Milk');
        await awayFor(OPEN_TO_AWAY_MS);
        expect(textArea(), 'not turned into the chosen text note').toBeNull();
        expect(items()[0]?.value).toBe('Milk');
    });

    it('with the wide screen’s inline composer open (not the shell’s own state): left alone too', async () => {
        h.coarse = false;
        mount({ coldStart: false });
        await tick(0);
        act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Take a note"]')!.click(); });
        typeInto(items()[0], 'Milk');
        await awayFor(OPEN_TO_AWAY_MS);
        expect(textArea()).toBeNull();
        expect(items()[0]?.value).toBe('Milk');
    });

    it('POSITIVE CONTROL for the wide screen: nothing open, the inline composer opens', async () => {
        h.coarse = false;
        mount({ coldStart: false });
        await tick(0);
        await awayFor(OPEN_TO_AWAY_MS);
        expect(textArea()).not.toBeNull();
    });

    it('with a dialog open (the shortcuts help): nothing', async () => {
        mount({ coldStart: false });
        await tick(0);
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true })); });
        expect(document.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]')).not.toBeNull();
        await awayFor(OPEN_TO_AWAY_MS);
        expect(composer()).toBeNull();
    });

    it('with the account menu open: nothing', async () => {
        mount({ coldStart: false });
        await tick(0);
        openAccountMenu();
        await awayFor(OPEN_TO_AWAY_MS);
        expect(composer()).toBeNull();
    });

    it('with the navigation drawer open: nothing', async () => {
        mount({ coldStart: false });
        await tick(0);
        act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]')!.click(); });
        expect(document.querySelector('.notes-rail.open')).not.toBeNull();
        await awayFor(OPEN_TO_AWAY_MS);
        expect(composer()).toBeNull();
    });

    it('with notes selected: nothing', async () => {
        h.cards = [note];
        mount({ coldStart: false });
        await tick(0);
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })); });
        expect(document.querySelector('.notes-selectbar')).not.toBeNull();
        await awayFor(OPEN_TO_AWAY_MS);
        expect(composer()).toBeNull();
    });

    it('with a search typed: nothing', async () => {
        mount({ coldStart: false });
        await tick(0);
        typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Search notes"]')!, 'milk');
        await awayFor(OPEN_TO_AWAY_MS);
        expect(composer()).toBeNull();
    });

    for (const at of ['/reminders', '/trash', '/calendar']) {
        it(`on ${at}: nothing, and the page stays`, async () => {
            mount({ coldStart: false, at });
            await tick(0);
            await awayFor(OPEN_TO_AWAY_MS);
            expect(composer()).toBeNull();
            expect(path).toBe(at);
        });
    }

    it('a share that brought the app back wins, landing before the page turns visible', async () => {
        let release: () => void = () => {};
        h.ensure = () => new Promise(r => { release = () => r({ ...h.features }); });
        mount({ coldStart: false });
        await tick(0);
        setVisibility('hidden');
        await tick(OPEN_TO_AWAY_MS);
        h.launchShare = { text: 'Milk and bread', subject: null, files: [] };
        act(() => { for (const cb of h.shareListeners) cb(); });
        setVisibility('visible');
        await tick(OPEN_TO_SETTLE_MS);
        expect(composer(), 'nothing opened over the share still on its way').toBeNull();
        await act(async () => { release(); });
        await tick(0);
        expect(titleField()?.value).toBe('Milk and bread');
    });

    it('…and landing just after it', async () => {
        let release: () => void = () => {};
        h.ensure = () => new Promise(r => { release = () => r({ ...h.features }); });
        mount({ coldStart: false });
        await tick(0);
        setVisibility('hidden');
        await tick(OPEN_TO_AWAY_MS);
        setVisibility('visible');
        await tick(OPEN_TO_SETTLE_MS / 4);
        h.launchShare = { text: 'Milk and bread', subject: null, files: [] };
        act(() => { for (const cb of h.shareListeners) cb(); });
        await tick(OPEN_TO_SETTLE_MS);
        expect(composer()).toBeNull();
        await act(async () => { release(); });
        await tick(0);
        expect(titleField()?.value).toBe('Milk and bread');
    });

    it('not in the desktop app’s Notes', async () => {
        mount({ coldStart: false, embedded: EMBEDDED });
        await tick(0);
        await awayFor(OPEN_TO_AWAY_MS);
        expect(composer()).toBeNull();
    });

    it('not on the web page', async () => {
        h.android = false;
        mount({ coldStart: false });
        await tick(0);
        await awayFor(OPEN_TO_AWAY_MS);
        expect(composer()).toBeNull();
    });
});

describe('which shell is the app starting (useStartedSignedIn)', () => {
    const seen: boolean[] = [];
    function Probe({ signedIn }: { signedIn: boolean }) {
        const started = useStartedSignedIn(signedIn);
        useEffect(() => { seen.push(started); });
        return null;
    }
    beforeEach(() => { seen.length = 0; });

    it('signed in at load: yes — until the first sign-out, and never again after it', () => {
        host = document.createElement('div');
        root = createRoot(host);
        act(() => { root!.render(<Probe signedIn />); });
        expect(seen.at(-1)).toBe(true);
        act(() => { root!.render(<Probe signedIn={false} />); });
        expect(seen.at(-1)).toBe(false);
        act(() => { root!.render(<Probe signedIn />); });
        expect(seen.at(-1)).toBe(false);
    });

    it('signed out at load: a sign-in later is not the app starting', () => {
        host = document.createElement('div');
        root = createRoot(host);
        act(() => { root!.render(<Probe signedIn={false} />); });
        act(() => { root!.render(<Probe signedIn />); });
        expect(seen.at(-1)).toBe(false);
    });
});
