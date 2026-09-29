/**
 * NotesShell's embedded mode: Púca Notes mounted inside the Púca desktop app
 * (components/NotesDesktopView.tsx) rather than as a page of its own.
 *
 * The app already owns four things the shell brings on its own page, and a
 * second copy of any of them is a bug, not a duplicate: the toast bus has ONE
 * sink (a second MessageToasts takes Chat's toasts, then clears the sink on
 * unmount), the reminder loop guards itself so a second caller silently runs
 * nothing, App renders the identity banner, and Chat answers
 * `sovereign:open-reminders`. What must stay is Notes itself — and while the
 * view is hidden behind the rest of the app, it must take no keys.
 *
 * Each rule is checked against the page's own shell as its positive control,
 * so a check that could not fail (an element that never renders anywhere, a
 * spy on a call nobody makes) fails that control instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';

const h = vi.hoisted(() => ({
    reminderStarts: 0,
    refreshes: 0,
    granted: true,
    asked: 0,
    settings: { desktopNotifications: false } as Record<string, unknown>,
    /** The account's notes: none, unless a test opens one. */
    cards: [] as unknown[],
}));

vi.mock('../api/taskReminders', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/taskReminders')>()),
    startTaskReminders: () => { h.reminderStarts += 1; return () => {}; },
}));
vi.mock('../components/IdentityBanner', () => ({
    IdentityBanner: () => <div data-testid="identity-banner" />,
}));
vi.mock('../components/settingsStore', async importOriginal => {
    const real = await importOriginal<typeof import('../components/settingsStore')>();
    return {
        ...real,
        loadSettings: () => ({ ...real.defaultSettings, ...h.settings }),
        saveSettings: (s: Record<string, unknown>) => {
            h.settings = { ...h.settings, desktopNotifications: s.desktopNotifications };
            window.dispatchEvent(new CustomEvent('settingsChanged', { detail: s }));
        },
    };
});
vi.mock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted: async () => false,
    requestPermission: async () => { h.asked += 1; return h.granted ? 'granted' : 'denied'; },
}));
// The data layer: an account with no notes, and nothing on the network.
vi.mock('../notes/model/notesQueries', async importOriginal => {
    const real = await importOriginal<typeof import('../notes/model/notesQueries')>();
    const noop = async () => null;
    const actions = {
        refreshAll: async () => { h.refreshes += 1; },
        content: {
            features: { body: false, attachments: false, noteReminders: false },
            trashEnabled: false,
            isSelfList: () => false,
            ensureFeatures: async () => null,
            setBody: async () => true,
        },
        // What an open note may call; none of it is under test here.
        deleteTaskFrom: noop, addTask: noop, setAttachments: noop, snoozeTask: noop, restoreCompleted: noop,
        toggleTask: noop, editTask: noop, moveTaskIn: noop, reorderTaskIn: noop, setDue: noop, setSchedule: noop,
        togglePin: noop, refreshNote: noop, renameNote: noop,
    };
    return {
        ...real,
        useNoteCards: () => ({ cards: h.cards, sources: [], prefs: [], prefsReady: true, loading: false, error: null, tasksPending: false }),
        useNoteActions: () => actions,
        useNoteTasks: () => ({ data: [], isPending: false, isFetching: false }),
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

// jsdom has neither; the shell asks both at render.
Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);

const { NotesShell } = await import('../notes/components/NotesShell');
type Embedding = NonNullable<Parameters<typeof NotesShell>[0]['embedded']>;
const { pushMessageToast, setMessageToastSink } = await import('../components/messageToastBus');

let root: Root | null = null;
let host: HTMLElement | null = null;
let path = '';
let search = '';
function Where() {
    const at = useLocation();
    useEffect(() => { path = at.pathname; search = at.search; }, [at]);
    return null;
}

function shell(embedded: Embedding | undefined, onSignOut: () => void = () => {}) {
    return <NotesShell onSignOut={onSignOut} embedded={embedded} />;
}
function mount(ui: React.ReactElement, at = '/') {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient();
    const wrap = (node: React.ReactElement) => (
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[at]}>
                {node}
                <Where />
            </MemoryRouter>
        </QueryClientProvider>
    );
    act(() => { root!.render(wrap(ui)); });
    return {
        rerender: (next: React.ReactElement) => act(() => { root!.render(wrap(next)); }),
    };
}
const press = (key: string) => act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
});
const helpOpen = () => document.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]') !== null;
const on = (ownsKey: (e: KeyboardEvent) => boolean = () => true): Embedding => ({ active: true, ownsKey });

beforeEach(() => {
    h.reminderStarts = 0;
    h.refreshes = 0;
    h.asked = 0;
    h.granted = true;
    h.settings = { desktopNotifications: false };
    h.cards = [];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    setMessageToastSink(null);
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

describe('what the app already owns, embedded Notes leaves alone', () => {
    it('the toast sink stays Chat’s: mounting and unmounting it neither takes nor clears it', () => {
        const chat: string[] = [];
        setMessageToastSink(t => chat.push(t.title));
        mount(shell(on()));
        pushMessageToast({ title: 'while Notes is up' });
        act(() => { root!.unmount(); });
        root = null;
        pushMessageToast({ title: 'after Notes went' });
        expect(chat).toEqual(['while Notes is up', 'after Notes went']);
    });

    it('POSITIVE CONTROL: the page’s own shell does take the sink', () => {
        const chat: string[] = [];
        setMessageToastSink(t => chat.push(t.title));
        mount(shell(undefined));
        pushMessageToast({ title: 'to the Notes page' });
        expect(chat).toEqual([]);
    });

    it('starts no reminder loop (Chat runs the page’s one), where the page’s own shell starts one', () => {
        mount(shell(on()));
        expect(h.reminderStarts).toBe(0);
        act(() => { root!.unmount(); });
        root = null;
        mount(shell(undefined));
        expect(h.reminderStarts).toBe(1);
    });

    it('renders no identity banner of its own (App has one); the page’s own shell does', () => {
        mount(shell(on()));
        expect(document.querySelector('[data-testid="identity-banner"]')).toBeNull();
        act(() => { root!.unmount(); });
        root = null;
        mount(shell(undefined));
        expect(document.querySelector('[data-testid="identity-banner"]')).not.toBeNull();
    });

    it('does not answer sovereign:open-reminders — that door is Chat’s — where the page’s own shell goes to Reminders', () => {
        mount(shell(on()));
        act(() => { window.dispatchEvent(new CustomEvent('sovereign:open-reminders', { detail: { ids: [] } })); });
        expect(path).toBe('/');
        act(() => { root!.unmount(); });
        root = null;
        mount(shell(undefined));
        act(() => { window.dispatchEvent(new CustomEvent('sovereign:open-reminders', { detail: { ids: [] } })); });
        expect(path).toBe('/reminders');
    });

    it('offers no "Open Púca" — Notes is in it — where the page’s own rail does', () => {
        mount(shell(on()));
        const links = () => [...document.querySelectorAll('a')].filter(a => a.textContent?.includes('Open Púca'));
        expect(links()).toHaveLength(0);
        act(() => { root!.unmount(); });
        root = null;
        mount(shell(undefined));
        expect(links().length).toBeGreaterThan(0);
    });
});

describe('the keyboard, while the view is hidden or covered', () => {
    const search = () => document.querySelector('input[aria-label="Search notes"]');

    it('POSITIVE CONTROL: on screen, `?` opens the help, `r` refreshes and `/` goes to the search box', () => {
        mount(shell(on()));
        press('r');
        expect(h.refreshes).toBe(1);
        press('/');
        expect(document.activeElement).toBe(search());
        (document.activeElement as HTMLElement).blur();
        press('?');
        expect(helpOpen()).toBe(true);
    });

    it('hidden behind the rest of the app, `?` `c` `/` `r` do nothing — and take no focus', () => {
        mount(shell({ active: false, ownsKey: () => true }));
        for (const k of ['?', 'c', '/', 'r']) press(k);
        expect(helpOpen()).toBe(false);
        expect(h.refreshes).toBe(0);
        expect(search()).not.toBeNull();
        expect(document.activeElement).not.toBe(search());
    });

    it('on screen but vetoed by the app (one of its dialogs is over Notes): `?` does nothing', () => {
        const ownsKey = vi.fn(() => false);
        mount(shell(on(ownsKey)));
        press('?');
        expect(helpOpen()).toBe(false);
        expect(ownsKey).toHaveBeenCalled();
    });

    it('the app is asked only about keys Notes acts on', () => {
        const ownsKey = vi.fn(() => true);
        mount(shell(on(ownsKey)));
        press('x');
        press('Enter');
        expect(ownsKey).not.toHaveBeenCalled();
    });

    it('Ctrl+A selects no notes behind the app’s back, and is not swallowed', () => {
        mount(shell({ active: false, ownsKey: () => true }));
        const ev = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
        act(() => { window.dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(false);
    });

    it('POSITIVE CONTROL: on screen, Ctrl+A is Notes’ select-all', () => {
        mount(shell(on()));
        const ev = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
        act(() => { window.dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(true);
    });

    it('switching away closes the shell’s own menus (their Escape would outlive the view)', () => {
        const view = mount(shell(on()));
        press('?');
        expect(helpOpen()).toBe(true);
        view.rerender(shell({ active: false, ownsKey: () => true }));
        expect(helpOpen()).toBe(false);
    });
});

/**
 * The composer's paste question takes the focus off the field it was pasted
 * into (PastedLinesDialog: a reflexive Enter must answer nothing), onto an
 * element that is not editable — and every key gate here had relied on the
 * focus sitting in an input. It is none of the shell's own popups, so
 * nothing else switched the shortcuts off: `r` refreshed, `?` stacked the
 * help over it, `/` took the focus into the search box behind it and Ctrl+A
 * selected the notes under it. Keys typed at the question are the
 * question's, on Notes' own page and embedded alike.
 */
describe('the composer’s paste question holds the keys', () => {
    const question = () => document.querySelector<HTMLElement>('.notes-paste-dialog');
    const at = (key: string, init: KeyboardEventInit = {}) => {
        const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
        act(() => { (document.activeElement ?? document.body).dispatchEvent(e); });
        return e;
    };
    function pasteIntoComposer() {
        act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Take a note"]')!.click(); });
        const item = document.querySelector<HTMLInputElement>('input[aria-label="Item 1"]')!;
        item.focus();
        const ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: { files: [], items: [], types: ['text/plain'], getData: () => 'Milk\nBread\nEggs' } });
        act(() => { item.dispatchEvent(ev); });
        expect(question(), 'the question is open').not.toBeNull();
        expect(document.activeElement, 'and has the focus').toBe(question());
    }

    for (const mode of ['embedded', 'page'] as const) {
        it(`${mode}: \`r\` \`?\` \`/\` and Ctrl+A at the question do nothing behind it`, () => {
            mount(shell(mode === 'embedded' ? on() : undefined));
            pasteIntoComposer();
            at('r');
            expect(h.refreshes, 'r').toBe(0);
            at('?');
            expect(helpOpen(), '?').toBe(false);
            at('/');
            expect(document.activeElement, '/').toBe(question());
            expect(at('a', { ctrlKey: true }).defaultPrevented, 'Ctrl+A').toBe(false);
            // Tabbed on to an answer, or back to the X: still the question's.
            for (const b of document.querySelectorAll<HTMLButtonElement>('.notes-dialog button')) {
                b.focus();
                at('r');
            }
            expect(h.refreshes, 'r from its buttons').toBe(0);
            // POSITIVE CONTROL: the shortcuts are live, and answer from anywhere else.
            act(() => { [...document.querySelectorAll<HTMLButtonElement>('.notes-paste-actions button')].find(b => b.textContent === 'Cancel')!.click(); });
            expect(question()).toBeNull();
            (document.activeElement as HTMLElement).blur();
            at('r');
            expect(h.refreshes).toBe(1);
        });
    }
});

describe('below the shell: the calendar and the open note', () => {
    it('POSITIVE CONTROL: on the calendar, `m` goes to the month', () => {
        mount(shell(on()), '/calendar');
        press('m');
        expect(search).toContain('v=month');
    });

    it('hidden, or vetoed by the app, the calendar’s `m` does nothing', () => {
        mount(shell({ active: false, ownsKey: () => true }), '/calendar');
        press('m');
        expect(search).not.toContain('v=month');
        act(() => { root!.unmount(); });
        root = null;
        mount(shell(on(() => false)), '/calendar');
        press('m');
        expect(search).not.toContain('v=month');
    });

    const note = {
        ref: { kind: 'list', id: 5 }, key: 'list:5', title: 'Trip', body: null, noteAttachments: null,
        tasks: [], pinned: false, color: 'default', labels: [], archived: false, total: 0, completed: 0,
    };
    const escape = () => act(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    it('POSITIVE CONTROL: an open note closes on Escape', () => {
        h.cards = [note];
        mount(shell(on()), '/?note=list%3A5');
        expect(document.querySelector('.notes-editor')).not.toBeNull();
        escape();
        expect(search).not.toContain('note=');
    });

    it('hidden, or with one of the app’s dialogs over it, the open note stays open on Escape', () => {
        h.cards = [note];
        mount(shell({ active: false, ownsKey: () => true }), '/?note=list%3A5');
        escape();
        expect(search).toContain('note=list');
        act(() => { root!.unmount(); });
        root = null;
        mount(shell(on(() => false)), '/?note=list%3A5');
        escape();
        expect(search).toContain('note=list');
    });
});

describe('signing out', () => {
    it('Sign out in the account menu calls the app’s own sign-out', () => {
        const signOut = vi.fn();
        mount(shell(on(), signOut));
        act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Account and settings"]')!.click(); });
        const button = [...document.querySelectorAll<HTMLButtonElement>('.notes-menu-item')].find(b => b.textContent?.trim() === 'Sign out');
        expect(button).toBeDefined();
        act(() => { button!.click(); });
        expect(signOut).toHaveBeenCalledTimes(1);
    });
});

describe('the Reminders banner speaks for Púca’s desktop notifications', () => {
    const banner = () => document.querySelector('.notes-reminders .notes-status, .notes-status')?.textContent ?? '';

    it('setting on: no banner, even though the webview’s permission reads "denied"', () => {
        vi.stubGlobal('Notification', { permission: 'denied', requestPermission: async () => 'denied' });
        h.settings = { desktopNotifications: true };
        mount(shell(on()), '/reminders');
        expect(banner()).not.toMatch(/blocked/i);
        expect(banner()).not.toMatch(/Enable/);
    });

    it('POSITIVE CONTROL: the page’s own shell reads the webview’s permission and says blocked', () => {
        vi.stubGlobal('Notification', { permission: 'denied', requestPermission: async () => 'denied' });
        h.settings = { desktopNotifications: true };
        mount(shell(undefined), '/reminders');
        expect(banner()).toMatch(/blocked/i);
    });

    it('setting off: offers to turn it on, which asks the OS through Tauri and turns the setting on', async () => {
        vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn(async () => 'denied') });
        mount(shell(on()), '/reminders');
        expect(banner()).toMatch(/Desktop notifications are off/);
        const turnOn = [...document.querySelectorAll<HTMLButtonElement>('.notes-status button')].find(b => b.textContent === 'Turn on');
        await act(async () => { turnOn!.click(); await Promise.resolve(); });
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(h.asked).toBe(1);
        expect(h.settings.desktopNotifications).toBe(true);
        expect((globalThis.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission).not.toHaveBeenCalled();
        expect(banner()).not.toMatch(/Desktop notifications are off/);
    });

    // That setting is Púca's ONE desktop switch — Settings' "Enable Desktop
    // Notifications", which every message notification is gated on too — and
    // Chat's loop fires due items whenever Púca runs, Notes open or not. The
    // banner must not sell it as a reminders-only, while-Notes-is-open opt-in:
    // someone who turned message popups off on purpose would get them back
    // from one click they were never told about.
    it('it says, before the click, that the same switch turns on message notifications too', () => {
        mount(shell(on()), '/reminders');
        expect(banner()).toMatch(/new messages/);
        expect(banner()).not.toMatch(/while Notes is open/);
        expect([...document.querySelectorAll('.notes-status button')].map(b => b.textContent)).not.toContain('Enable');
    });

    it('POSITIVE CONTROL: on Notes’ own page the banner is the page’s own, reminders only, while it is open', () => {
        vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'default' });
        mount(shell(undefined), '/reminders');
        expect(banner()).toMatch(/Get a notification when an item comes due while Notes is open/);
        expect(banner()).not.toMatch(/new messages/);
    });

    it('turned on from Settings instead, the banner follows', () => {
        mount(shell(on()), '/reminders');
        expect(banner()).toMatch(/Desktop notifications are off/);
        act(() => {
            h.settings = { desktopNotifications: true };
            window.dispatchEvent(new CustomEvent('settingsChanged'));
        });
        expect(banner()).not.toMatch(/Desktop notifications are off/);
    });
});
