/**
 * Sticky notes on the desktop (components/sticky/; docs/STICKY_NOTES.md),
 * the page's half, with the shell faked (the pop-out tests' way:
 * window.open hands back a stand-in window with a real document of its own).
 *
 * What is pinned here:
 *  - the contract with the shell: a slot is BOUND to the note (`<user>/list:
 *    <id>`) before window.open, the URL is `about:blank#puca-sticky-<slot>`,
 *    and closing goes through `sticky_close`, never window.close;
 *  - the note is drawn INTO the window's document, dressed in the app's
 *    stylesheets and theme, and a link in it goes through the app's router;
 *  - a reopened note's window waits for Notes to have the note, and a note
 *    Notes no longer has leaves the desktop — but a note this window just
 *    MADE is not taken for one that is gone;
 *  - a new sticky note is a draft: nothing is made until words go in, and
 *    then exactly ONE note, however many saves the field asks for;
 *  - the keys of Microsoft's table in the window (Ctrl+N, Ctrl+W, Ctrl+D),
 *    the person closing the window (pagehide), Delete asking first and
 *    "Don't ask again", the pin and the dock through the shell.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({
    calls: [] as { cmd: string; args?: Record<string, unknown> }[],
    pins: new Map<number, boolean>(),
    opened: [] as { url: string; name: string; win: unknown }[],
    openedExternal: [] as string[],
    /** The shell's events, as listen() registered them. */
    events: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => true,
    isMobile: () => false,
}));
vi.mock('../api/auth', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/auth')>()),
    currentUserIdFromToken: () => 7,
}));
vi.mock('../api/openExternal', () => ({
    openExternalUrl: (u: string) => { h.openedExternal.push(u); },
    isExternalHref: (u: string) => /^https?:/.test(u),
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event: string, cb: (e: { payload: unknown }) => void) => {
        h.events.set(event, cb);
        return () => { if (h.events.get(event) === cb) h.events.delete(event); };
    },
}));
vi.mock('@tauri-apps/api/core', async importOriginal => ({
    ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
        h.calls.push({ cmd, args });
        switch (cmd) {
            case 'sticky_supported': return true;
            case 'sticky_pin': {
                const slot = args?.slot as number;
                if (typeof args?.onTop === 'boolean') h.pins.set(slot, args.onTop);
                return h.pins.get(slot) ?? false;
            }
            case 'sticky_dock': return (args?.side as string | null) ?? null;
            case 'sticky_dock_state': return null;
            case 'sticky_bind': case 'sticky_rekey': case 'sticky_close': case 'sticky_drag':
            case 'sticky_raise': case 'sticky_forget': case 'sticky_show_main':
                return null;
            default: throw new Error(`no shell command ${cmd}`);
        }
    },
}));
// The items section reads the note's tasks through Notes' query; the notes
// here have none.
vi.mock('../notes/model/notesQueries', async importOriginal => ({
    ...(await importOriginal<typeof import('../notes/model/notesQueries')>()),
    useNoteTasks: () => ({ data: [], isPending: false }),
}));

const { StickyNotesLayer } = await import('../components/sticky/StickyNotesLayer');
const store = await import('../components/sticky/stickyStore');
const { primeStickySupport, __resetStickyShellForTests, stickyPlace } = await import('../components/sticky/stickyShell');
const { BODY_SAVE_DELAY_MS } = await import('../api/listContent');
const { loadSettings, saveSettings, defaultSettings } = await import('../components/settingsStore');
import type { NoteActions } from '../notes/model/notesQueries';
import type { NoteCard } from '../notes/model/notesModel';

interface FakeWin {
    document: Document;
    closed: boolean;
    close: ReturnType<typeof vi.fn>;
    addEventListener: (n: string, cb: () => void) => void;
    removeEventListener: (n: string, cb: () => void) => void;
    fire: (n: string) => void;
}
function fakeWin(): FakeWin {
    const doc = document.implementation.createHTMLDocument('');
    const listeners = new Map<string, Set<() => void>>();
    return {
        document: doc,
        closed: false,
        close: vi.fn(),
        addEventListener: (n, cb) => { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n)!.add(cb); },
        removeEventListener: (n, cb) => { listeners.get(n)?.delete(cb); },
        fire: n => { for (const cb of listeners.get(n) ?? []) cb(); },
    };
}

function card(id: number, body: string, extra: Partial<NoteCard> = {}): NoteCard {
    return {
        key: `list:${id}`, ref: { kind: 'list', id }, title: body.split('\n')[0] || 'Untitled note', body,
        tasks: [], pinned: false, color: 'mint', labels: [], archived: false, total: 0, completed: 0,
        noteAttachments: null, contentRev: 3, ...extra,
    } as NoteCard;
}

function fakeActions() {
    const created = { n: 0 };
    const actions = {
        content: {
            features: { body: true, attachments: true },
            trashEnabled: true,
            isSelfList: () => false,
            setBody: vi.fn(async () => ({ rev: 4 })),
            addNoteMedia: vi.fn(async () => true),
        },
        createNote: vi.fn(async () => { created.n++; await new Promise(r => setTimeout(r, 30)); return { kind: 'list' as const, id: 500 + created.n }; }),
        setColor: vi.fn(),
        deleteNote: vi.fn(async () => true),
        toggleTask: vi.fn(async () => {}),
        addTask: vi.fn(async () => null),
    };
    return actions as unknown as NoteActions & { createNote: ReturnType<typeof vi.fn>; deleteNote: ReturnType<typeof vi.fn>; content: { setBody: ReturnType<typeof vi.fn> } };
}

let root: Root;
let container: HTMLDivElement;
const calls = (cmd: string) => h.calls.filter(c => c.cmd === cmd);
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const win = (i: number) => h.opened[i].win as FakeWin;

// The global test setup replaces localStorage with bare vi.fn() stubs; give
// the store and the settings a real backing store.
const backing = new Map<string, string>();
function realStorage() {
    (localStorage.getItem as Mock).mockImplementation((k: string) => backing.get(k) ?? null);
    (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { backing.set(k, String(v)); });
    (localStorage.removeItem as Mock).mockImplementation((k: string) => { backing.delete(k); });
    (localStorage.clear as Mock).mockImplementation(() => backing.clear());
}

beforeEach(async () => {
    realStorage();
    h.calls = [];
    h.pins.clear();
    h.opened = [];
    h.openedExternal = [];
    h.events.clear();
    localStorage.clear();
    store.__resetStickiesForTests();
    __resetStickyShellForTests();
    await primeStickySupport();
    vi.spyOn(window, 'open').mockImplementation(((url: string, name: string) => {
        h.calls.push({ cmd: 'window.open', args: { url } });
        const w = fakeWin();
        h.opened.push({ url, name, win: w });
        return w as unknown as Window;
    }) as typeof window.open);
    // The app's look, to be copied into every sticky window.
    const style = document.createElement('style');
    style.setAttribute('data-test-sheet', '');
    style.textContent = '.x{}';
    document.head.appendChild(style);
    document.documentElement.setAttribute('data-theme', 'light');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.head.querySelector('style[data-test-sheet]')?.remove();
    document.documentElement.removeAttribute('data-theme');
    vi.restoreAllMocks();
});

type Gens = { list: number; channel: number; channelOldest?: number };
type LayerProps = { cards: NoteCard[]; ready: boolean; actions: NoteActions; gens?: Gens; openInNotes?: (k: string | null, s: boolean) => void };
/** A fetch "by this page": after the layer mounted. */
const fresh = (dt = 1000): Gens => ({ list: Date.now() + dt, channel: Date.now() + dt, channelOldest: Date.now() + dt });
const render = async (p: LayerProps) => {
    await act(async () => {
        root.render(<StickyNotesLayer cards={p.cards} ready={p.ready} gens={p.gens ?? { list: 0, channel: 0, channelOldest: 0 }} actions={p.actions} openInNotes={p.openInNotes ?? (() => {})} />);
    });
    await flush();
};

describe('the place a note is filed under', () => {
    it('is the account and the note; an offline note and a draft have their own', () => {
        expect(stickyPlace(7, 'list:12')).toBe('7/list:12');
        expect(stickyPlace(7, 'channel:3')).toBe('7/channel:3');
        expect(stickyPlace(7, 'list:-4')).toBe('7/temp:4');
        expect(stickyPlace(7, 'new:2')).toBe('7/new:2');
        for (const bad of ['list:0', 'channel:-1', 'task:1', 'list:1x', '']) expect(stickyPlace(7, bad), bad).toBeNull();
        expect(stickyPlace(null, 'list:1')).toBeNull();
    });
});

describe('a note out on the desktop', () => {
    it('binds the slot, THEN opens about:blank#puca-sticky-1, and draws the note in that window', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'buy **milk**')], ready: true, actions });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        const bindAt = h.calls.findIndex(c => c.cmd === 'sticky_bind');
        const openAt = h.calls.findIndex(c => c.cmd === 'window.open');
        expect(h.calls[bindAt].args).toEqual({ slot: 1, place: '7/list:12', focus: true });
        // The shell refuses a window for a slot nothing is bound to.
        expect(openAt).toBeGreaterThan(bindAt);
        expect(h.opened.map(o => [o.url, o.name])).toEqual([['about:blank#puca-sticky-1', 'puca-sticky-1']]);
        const doc = win(0).document;
        const note = doc.querySelector('[data-testid="sticky-note"]') as HTMLElement;
        expect(note).not.toBeNull();
        expect(note.getAttribute('data-color')).toBe('mint');
        // Nothing of the note in the main document.
        expect(document.querySelector('[data-testid="sticky-note"]')).toBeNull();
        // Dressed as the app: its stylesheets and its theme.
        expect(doc.head.querySelector('style[data-test-sheet]')).not.toBeNull();
        expect(doc.documentElement.getAttribute('data-theme')).toBe('light');
        expect(doc.title).toBe('Sticky note');
        // and a theme change reaches it.
        act(() => { document.documentElement.setAttribute('data-theme', 'amoled'); });
        await flush(1);
        expect(doc.documentElement.getAttribute('data-theme')).toBe('amoled');
    });

    it('a second ask for the same note is the same window', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'x')], ready: true, actions });
        act(() => { store.openStickyNote('list:12'); store.openStickyNote('list:12'); });
        await flush();
        expect(h.opened).toHaveLength(1);
    });

    it('X closes the window through the shell; the note stays in Notes', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'x')], ready: true, actions });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        const btn = win(0).document.querySelector('button[aria-label="Close sticky note"]') as HTMLButtonElement;
        act(() => { btn.click(); });
        await flush();
        expect(calls('sticky_close').map(c => c.args)).toEqual([{ slot: 1 }]);
        expect(win(0).close).not.toHaveBeenCalled();
        expect(actions.deleteNote).not.toHaveBeenCalled();
        expect(store.readStoredStickies(7)).toEqual([]);
    });

    it('the person closing the window (Alt+F4, the shell\'s close request) takes it off the desktop', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'x')], ready: true, actions });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        expect(store.readStoredStickies(7)).toEqual(['list:12']);
        act(() => { h.events.get('sticky://closed')?.({ payload: 1 }); });
        await flush();
        expect(store.stickyEntries()).toHaveLength(0);
        expect(store.readStoredStickies(7)).toEqual([]);
    });

    it('a window that just GOES (the page reloading, Púca quitting) keeps its note for the next start', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'x')], ready: true, actions });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        // The shell destroys it with no close request: only pagehide.
        act(() => { win(0).fire('pagehide'); });
        await flush();
        expect(store.stickyEntries()).toHaveLength(0);
        expect(store.readStoredStickies(7)).toEqual(['list:12']);
    });

    it('the window is titled "Sticky note", never with the note\'s decrypted title', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'Bank PIN reminder')], ready: true, actions });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        expect(win(0).document.title).toBe('Sticky note');
    });

    it('a link in the note goes through the app’s router (the system browser)', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'see https://example.org/s')], ready: true, actions });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        const a = win(0).document.querySelector('a.note-link') as HTMLAnchorElement;
        expect(a).not.toBeNull();
        act(() => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); });
        expect(h.openedExternal).toEqual(['https://example.org/s']);
    });

    it('the pin and the dock go to the shell', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'x')], ready: true, actions });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        const doc = win(0).document;
        act(() => { (doc.querySelector('button[aria-label="Keep on top"]') as HTMLButtonElement).click(); });
        await flush();
        expect(calls('sticky_pin').at(-1)?.args).toEqual({ slot: 1, onTop: true });
        expect(doc.querySelector('button[aria-label="Keep on top"]')?.getAttribute('aria-pressed')).toBe('true');
        act(() => { (doc.querySelector('button[aria-label="Menu"]') as HTMLButtonElement).click(); });
        const dock = [...doc.querySelectorAll('.sticky-menuitem')].find(b => b.textContent?.includes('Dock right')) as HTMLButtonElement;
        act(() => { dock.click(); });
        await flush();
        expect(calls('sticky_dock').at(-1)?.args).toEqual({ slot: 1, side: 'right' });
    });
});

describe('reopening, and notes that are gone', () => {
    it('a note open last time comes back — once Notes has it, never as an empty page before', async () => {
        localStorage.setItem('pucaStickyOpen:7', JSON.stringify(['list:12']));
        const actions = fakeActions();
        // Notes is still loading: no window, so nothing can be typed into an
        // empty page that would make a NEW note.
        await render({ cards: [], ready: false, actions });
        expect(h.opened).toHaveLength(0);
        await render({ cards: [card(12, 'back again')], ready: true, actions });
        expect(h.opened).toHaveLength(1);
        expect(calls('sticky_bind')[0].args).toEqual({ slot: 1, place: '7/list:12', focus: false });
        expect(win(0).document.body.textContent).toContain('back again');
    });

    it('with Reopen off, nothing comes back and the old set is forgotten', async () => {
        localStorage.setItem('pucaStickyOpen:7', JSON.stringify(['list:12']));
        saveSettings({ ...loadSettings(), stickyReopen: false });
        const actions = fakeActions();
        await render({ cards: [card(12, 'x')], ready: true, actions });
        expect(h.opened).toHaveLength(0);
        expect(store.readStoredStickies(7)).toEqual([]);
        saveSettings({ ...defaultSettings });
    });

    it('a note Notes no longer has loses its window at once, and the stored set only after fresh fetches a minute apart', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'x')], ready: true, actions, gens: fresh() });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        expect(h.opened).toHaveLength(1);
        // Trashed elsewhere: the window goes at once…
        const t0 = Date.now();
        await render({ cards: [], ready: true, actions, gens: fresh(2000) });
        expect(calls('sticky_close')).toHaveLength(1);
        // …but one look is not proof: still in the set.
        expect(store.readStoredStickies(7)).toEqual(['list:12']);
        // The same fetch again, or a second one too soon: still kept.
        await render({ cards: [], ready: true, actions, gens: { list: t0 + 3000, channel: t0 + 3000, channelOldest: t0 + 3000 } });
        expect(store.readStoredStickies(7)).toEqual(['list:12']);
        // A second fresh fetch a minute later, still without it: gone.
        const later = vi.spyOn(Date, 'now').mockReturnValue(t0 + 65_000);
        await render({ cards: [], ready: true, actions, gens: { list: t0 + 64_000, channel: t0 + 64_000, channelOldest: t0 + 64_000 } });
        later.mockRestore();
        expect(store.readStoredStickies(7)).toEqual([]);
    });

    it('CONTROL: a view restored from the device cache, or half loaded, never takes a note off the desktop', async () => {
        localStorage.setItem('pucaStickyOpen:7', JSON.stringify(['list:12', 'channel:3']));
        const actions = fakeActions();
        const t0 = Date.now();
        // The cache's old fetch times, the note missing from it (made after
        // the cache was written).
        await render({ cards: [], ready: true, actions, gens: { list: t0 - 3_600_000, channel: t0 - 3_600_000, channelOldest: t0 - 3_600_000 } });
        const later = vi.spyOn(Date, 'now').mockReturnValue(t0 + 120_000);
        await render({ cards: [], ready: true, actions, gens: { list: t0 - 3_500_000, channel: t0 - 3_500_000, channelOldest: t0 - 3_500_000 } });
        // Half loaded (a server's channels not read yet): not ready.
        await render({ cards: [card(12, 'x')], ready: false, actions, gens: { list: t0 + 119_000, channel: t0 + 119_000, channelOldest: t0 - 3_500_000 } });
        later.mockRestore();
        expect(store.readStoredStickies(7)).toEqual(['list:12', 'channel:3']);
    });
});

describe('a new sticky note', () => {
    it('is a draft: a window, nothing saved — then its first words make ONE note, which keeps the window', async () => {
        const actions = fakeActions();
        await render({ cards: [], ready: true, actions });
        act(() => { store.requestNewSticky(); });
        await flush();
        expect(h.opened).toHaveLength(1);
        expect(calls('sticky_bind')[0].args).toEqual({ slot: 1, place: '7/new:1', focus: true });
        expect(actions.createNote).not.toHaveBeenCalled();
        const doc = win(0).document;
        const area = doc.querySelector('textarea') as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        act(() => { setter.call(area, 'Call the plumber'); area.dispatchEvent(new Event('input', { bubbles: true })); });
        // A pause saves; a blur while that save is out asks again.
        await act(async () => { await new Promise(r => setTimeout(r, BODY_SAVE_DELAY_MS + 20)); });
        act(() => { setter.call(area, 'Call the plumber today'); area.dispatchEvent(new Event('input', { bubbles: true })); });
        act(() => { area.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
        await act(async () => { await new Promise(r => setTimeout(r, BODY_SAVE_DELAY_MS + 80)); });
        await flush();
        expect(actions.createNote).toHaveBeenCalledTimes(1);
        expect(actions.createNote).toHaveBeenCalledWith('', [], { body: 'Call the plumber' });
        // The words typed while it was being made went to THAT note.
        expect(actions.content.setBody).toHaveBeenCalledWith(501, 'Call the plumber today', undefined);
        expect(actions.setColor).toHaveBeenCalledWith({ kind: 'list', id: 501 }, 'sand');
        // The same window, now filed under the note.
        expect(calls('sticky_rekey').at(-1)?.args).toEqual({ slot: 1, place: '7/list:501' });
        expect(h.opened).toHaveLength(1);
        // Notes has not caught up with the new note yet: the window stays.
        await render({ cards: [], ready: true, actions });
        expect(calls('sticky_close')).toHaveLength(0);
        expect(store.readStoredStickies(7)).toEqual(['list:501']);
    });

    it('a first save ending in a new line keeps it: the trimmed create is followed by the words as typed', async () => {
        const actions = fakeActions();
        await render({ cards: [], ready: true, actions });
        act(() => { store.requestNewSticky(); });
        await flush();
        const area = win(0).document.querySelector('textarea') as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        act(() => { setter.call(area, 'Shopping\n'); area.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(async () => { await new Promise(r => setTimeout(r, BODY_SAVE_DELAY_MS + 80)); });
        await flush();
        expect(actions.createNote).toHaveBeenCalledTimes(1);
        // The data layer trims the end of a new note's text; the words as
        // they stand went in straight behind it.
        expect(actions.content.setBody).toHaveBeenCalledWith(501, 'Shopping\n');
        expect((win(0).document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Shopping\n');
    });

    it('the same words are never sent twice at once when the draft becomes a note (no false clash)', async () => {
        const actions = fakeActions();
        // The follow-up save is a real round trip, as on a network.
        actions.content.setBody.mockImplementation(async () => { await new Promise(r => setTimeout(r, 60)); return { rev: 4 }; });
        await render({ cards: [], ready: true, actions });
        act(() => { store.requestNewSticky(); });
        await flush();
        const area = win(0).document.querySelector('textarea') as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        act(() => { setter.call(area, 'Shopping\n'); area.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(async () => { await new Promise(r => setTimeout(r, BODY_SAVE_DELAY_MS + 200)); });
        await flush();
        const sends = actions.content.setBody.mock.calls.filter(c => c[1] === 'Shopping\n');
        expect(sends).toHaveLength(1);
        expect(win(0).document.querySelector('[data-conflict]')).toBeNull();
    });

    it('Delete inside the save pause asks, deletes, and makes no note as the window closes', async () => {
        const actions = fakeActions();
        await render({ cards: [], ready: true, actions });
        act(() => { store.requestNewSticky(); });
        await flush();
        const doc = win(0).document;
        const area = doc.querySelector('textarea') as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        act(() => { setter.call(area, 'never mind'); area.dispatchEvent(new Event('input', { bubbles: true })); });
        // Before the pause ends: no save has started.
        act(() => { area.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true })); });
        await flush(1);
        expect(doc.querySelector('[role="alertdialog"]')).not.toBeNull();
        act(() => { (doc.querySelector('.sticky-confirm .danger') as HTMLButtonElement).click(); });
        await act(async () => { await new Promise(r => setTimeout(r, BODY_SAVE_DELAY_MS + 100)); });
        await flush();
        expect(calls('sticky_close')).toHaveLength(1);
        expect(actions.createNote).not.toHaveBeenCalled();
    });

    it('a note this window made that Notes never shows (deleted meanwhile) leaves after fresh fetches a minute apart', async () => {
        const actions = fakeActions();
        await render({ cards: [], ready: true, actions, gens: fresh() });
        act(() => { store.requestNewSticky(); });
        await flush();
        const area = win(0).document.querySelector('textarea') as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        act(() => { setter.call(area, 'short-lived'); area.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(async () => { await new Promise(r => setTimeout(r, BODY_SAVE_DELAY_MS + 80)); });
        await flush();
        expect(store.readStoredStickies(7)).toEqual(['list:501']);
        const t0 = Date.now();
        await render({ cards: [], ready: true, actions, gens: { list: t0 + 2000, channel: t0 + 2000, channelOldest: t0 + 2000 } });
        expect(store.readStoredStickies(7)).toEqual(['list:501']);
        const later = vi.spyOn(Date, 'now').mockReturnValue(t0 + 65_000);
        await render({ cards: [], ready: true, actions, gens: { list: t0 + 64_000, channel: t0 + 64_000, channelOldest: t0 + 64_000 } });
        later.mockRestore();
        expect(store.readStoredStickies(7)).toEqual([]);
        expect(calls('sticky_close')).toHaveLength(1);
    });

    it('a note whose key moves under its window (made offline, now saved) keeps its words and makes no new note', async () => {
        const actions = fakeActions();
        await render({ cards: [card(-5, 'made offline')], ready: true, actions });
        act(() => { store.openStickyNote('list:-5'); });
        await flush();
        expect(calls('sticky_bind')[0].args).toMatchObject({ place: '7/temp:5' });
        // The outbox saved it as list 123; the cache has not caught up yet.
        act(() => { store.noteKeyMoved('list:-5', 'list:123'); });
        await render({ cards: [], ready: true, actions });
        expect(calls('sticky_close')).toHaveLength(0);
        expect(calls('sticky_rekey').at(-1)?.args).toEqual({ slot: 1, place: '7/list:123' });
        const area = win(0).document.querySelector('textarea') as HTMLTextAreaElement;
        expect(area.value).toBe('made offline');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        act(() => { setter.call(area, 'made offline, and more'); area.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(async () => { await new Promise(r => setTimeout(r, BODY_SAVE_DELAY_MS + 80)); });
        expect(actions.createNote).not.toHaveBeenCalled();
        expect(actions.content.setBody).toHaveBeenCalledWith(123, 'made offline, and more', 3);
    });

    it('Delete on a draft whose words are being saved deletes the note they made', async () => {
        const actions = fakeActions();
        await render({ cards: [], ready: true, actions });
        act(() => { store.requestNewSticky(); });
        await flush();
        const doc = win(0).document;
        const area = doc.querySelector('textarea') as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        act(() => { setter.call(area, 'to be deleted'); area.dispatchEvent(new Event('input', { bubbles: true })); });
        // The save starts; its create is still out (30 ms in the fake).
        await act(async () => { await new Promise(r => setTimeout(r, BODY_SAVE_DELAY_MS + 5)); });
        act(() => { area.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true })); });
        await flush(1);
        expect(doc.querySelector('[role="alertdialog"]')).not.toBeNull();
        act(() => { (doc.querySelector('.sticky-confirm .danger') as HTMLButtonElement).click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 80)); });
        await flush();
        expect(actions.deleteNote).toHaveBeenCalledWith({ kind: 'list', id: 501 });
    });

    it('closing an untouched draft saves nothing', async () => {
        const actions = fakeActions();
        await render({ cards: [], ready: true, actions });
        act(() => { store.requestNewSticky(); });
        await flush();
        act(() => { (win(0).document.querySelector('button[aria-label="Close sticky note"]') as HTMLButtonElement).click(); });
        await flush();
        expect(actions.createNote).not.toHaveBeenCalled();
        expect(store.readStoredStickies(7)).toEqual([]);
        // and leaves no place behind for a later draft of the same number.
        expect(calls('sticky_forget').map(c => c.args)).toEqual([{ place: '7/new:1' }]);
    });

    it('asked for before the layer exists (the shortcut, the tray), it is made when it comes', async () => {
        store.requestNewSticky();
        const actions = fakeActions();
        await render({ cards: [], ready: true, actions });
        expect(h.opened).toHaveLength(1);
        expect(calls('sticky_bind')[0].args).toMatchObject({ place: '7/new:1' });
    });
});

describe('the keys in a sticky note', () => {
    const key = (doc: Document, init: KeyboardEventInit) => act(() => {
        (doc.activeElement ?? doc.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });

    it('Ctrl+N makes a new one, Ctrl+W closes this one', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'x')], ready: true, actions });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        key(win(0).document, { key: 'n', ctrlKey: true });
        await flush();
        expect(h.opened).toHaveLength(2);
        key(win(0).document, { key: 'w', ctrlKey: true });
        await flush();
        expect(calls('sticky_close').map(c => c.args)).toEqual([{ slot: 1 }]);
    });

    it('Ctrl+H and Ctrl+F bring Notes up', async () => {
        const actions = fakeActions();
        const openInNotes = vi.fn();
        await render({ cards: [card(12, 'x')], ready: true, actions, openInNotes });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        key(win(0).document, { key: 'h', ctrlKey: true });
        key(win(0).document, { key: 'f', ctrlKey: true });
        expect(openInNotes.mock.calls).toEqual([['list:12', false], [null, true]]);
    });

    it('Ctrl+D asks first, Delete moves it to the trash and closes it, and "Don’t ask again" sticks', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'x')], ready: true, actions });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        const doc = win(0).document;
        key(doc, { key: 'd', ctrlKey: true });
        await flush(1);
        expect(doc.querySelector('[role="alertdialog"]')).not.toBeNull();
        expect(actions.deleteNote).not.toHaveBeenCalled();
        act(() => { (doc.querySelector('.sticky-confirm-ask input') as HTMLInputElement).click(); });
        act(() => { (doc.querySelector('.sticky-confirm .danger') as HTMLButtonElement).click(); });
        await flush();
        expect(actions.deleteNote).toHaveBeenCalledWith({ kind: 'list', id: 12 });
        expect(calls('sticky_forget').map(c => c.args)).toEqual([{ place: '7/list:12' }]);
        expect(calls('sticky_close')).toHaveLength(1);
        expect(loadSettings().stickyConfirmDelete).toBe(false);
        saveSettings({ ...defaultSettings });
    });

    it('Escape closes the menu and answers the question with Cancel', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'x')], ready: true, actions });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        const doc = win(0).document;
        act(() => { (doc.querySelector('button[aria-label="Menu"]') as HTMLButtonElement).click(); });
        expect(doc.querySelector('[role="menu"]')).not.toBeNull();
        key(doc, { key: 'Escape' });
        expect(doc.querySelector('[role="menu"]')).toBeNull();
        key(doc, { key: 'd', ctrlKey: true });
        await flush(1);
        key(doc, { key: 'Escape' });
        expect(doc.querySelector('[role="alertdialog"]')).toBeNull();
        expect(actions.deleteNote).not.toHaveBeenCalled();
    });

    it('CONTROL: Cancel deletes nothing', async () => {
        const actions = fakeActions();
        await render({ cards: [card(12, 'x')], ready: true, actions });
        act(() => { store.openStickyNote('list:12'); });
        await flush();
        const doc = win(0).document;
        key(doc, { key: 'd', ctrlKey: true });
        await flush(1);
        const cancel = [...doc.querySelectorAll('.sticky-confirm button')].find(b => b.textContent === 'Cancel') as HTMLButtonElement;
        act(() => { cancel.click(); });
        await flush();
        expect(actions.deleteNote).not.toHaveBeenCalled();
        expect(calls('sticky_close')).toHaveLength(0);
    });
});
