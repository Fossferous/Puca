/**
 * New note, ready to type, opens TODAY's note (notes/model/dailyNote.ts):
 * the note titled with today's date with the caret at the end of its text,
 * or — when there is none yet — the composer with that title already in and
 * the caret in the text. Through the real NotesShell, composer and editor,
 * with the native bridge and the data layer faked (the harness is
 * notesComposeKeyboard.test.tsx's).
 *
 * What it pins:
 *  - no note for today: the composer opens on the text with today's date as
 *    the title, keyboard up — and closed untouched it creates NOTHING (the
 *    composer saves only on Done, and a suggested title is not content);
 *  - typed in and Done: the note is created under today's date;
 *  - a note titled today exists: THAT note opens in its editor, caret at the
 *    end of its text, keyboard up once — no composer, nothing created; and a
 *    later plain tap on it does not bring the keyboard back;
 *  - yesterday's note and a channel's checklist are not today's;
 *  - the notes still loading when the request lands: it waits for them;
 *  - New list, a server without note text and the page's own New note
 *    button are unchanged.
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
/** A tap that arrives while the app is already up (a warm start). */
const warmTap = async (target: string) => {
    act(() => { for (const cb of h.navListeners) cb({ target, item: null }); });
    await settle();
};

const composer = () => document.querySelector('.notes-quickadd[role="dialog"]');
const textArea = () => document.querySelector<HTMLTextAreaElement>('.notes-quickadd[role="dialog"] textarea.notes-quickadd-body');
const items = () => [...document.querySelectorAll<HTMLInputElement>('.notes-quickadd[role="dialog"] .notes-quickadd-item input')];
const titleField = () => document.querySelector<HTMLInputElement>('.notes-quickadd[role="dialog"] input.notes-quickadd-title');
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


const { dailyTitle } = await import('../notes/model/dailyNote');

/** A personal text note, as NotesShell's cards carry one. */
const card = (id: number, title: string, body: string, extra: Record<string, unknown> = {}) => ({
    key: `list:${id}`, ref: { kind: 'list', id }, title, body, tasks: [], pinned: false, color: 'default',
    labels: [], archived: false, total: 0, completed: 0, createdAt: '2026-10-01T08:00:00Z',
    updatedAt: '2026-10-12T08:00:00Z', contentRev: 1, ...extra,
});
const editor = () => document.querySelector('.notes-editor:not(.notes-quickadd-sheet)');
const editorText = () => document.querySelector<HTMLTextAreaElement>('.notes-editor:not(.notes-quickadd-sheet) .note-body-field textarea');
const doneButton = () => [...document.querySelectorAll<HTMLButtonElement>('.notes-quickadd[role="dialog"] button')].find(b => b.textContent?.trim() === 'Done') ?? null;
const today = () => dailyTitle(new Date());
/** Type into a controlled field the way React hears it. */
const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    act(() => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

describe('New note opens today’s note', () => {
    it('none yet (cold start): the composer, titled today, on its text, keyboard up once', async () => {
        h.cards = [card(1, 'Groceries', 'milk')];
        h.launchNav = { target: 'compose-note', item: null };
        mount();
        await settle();
        expect(titleField()?.value).toBe(today());
        expect(active()).toBe(textArea());
        expect(h.raised).toHaveLength(1);
        expect(editor()).toBeNull();
    });

    it('the same on a warm start', async () => {
        mount();
        await settle();
        await warmTap('compose-note');
        expect(titleField()?.value).toBe(today());
        expect(active()).toBe(textArea());
    });

    it('closed untouched, the dated composer creates nothing', async () => {
        h.launchNav = { target: 'compose-note', item: null };
        mount();
        await settle();
        expect(titleField()?.value, 'precondition: the date is in').toBe(today());
        act(() => { doneButton()!.click(); });
        await settle();
        expect(composer(), 'the composer closed').toBeNull();
        expect(h.created, 'no empty dated note').toHaveLength(0);
    });

    it('typed in and Done: the note is made under today’s date', async () => {
        h.launchNav = { target: 'compose-note', item: null };
        mount();
        await settle();
        typeInto(textArea()!, 'Walked the dog');
        act(() => { doneButton()!.click(); });
        await settle();
        expect(h.created).toHaveLength(1);
        expect(h.created[0].title).toBe(today());
        expect(h.created[0].body).toBe('Walked the dog');
    });

    it('the date changed to another title counts as typed: Done makes that note', async () => {
        h.launchNav = { target: 'compose-note', item: null };
        mount();
        await settle();
        typeInto(titleField()!, 'Plans');
        act(() => { doneButton()!.click(); });
        await settle();
        expect(h.created.map(c => c.title)).toEqual(['Plans']);
    });

    it('today’s note exists: IT opens, caret at the end of its text, keyboard up once — no composer', async () => {
        h.cards = [card(1, 'Groceries', 'milk'), card(7, today(), 'Line one\nLine two')];
        h.launchNav = { target: 'compose-note', item: null };
        mount();
        await settle();
        expect(composer(), 'no composer').toBeNull();
        expect(editor()?.getAttribute('aria-label')).toBe(today());
        const area = editorText();
        expect(area).not.toBeNull();
        expect(active()).toBe(area);
        expect(area!.selectionStart).toBe('Line one\nLine two'.length);
        expect(area!.selectionEnd).toBe('Line one\nLine two'.length);
        expect(h.raised).toHaveLength(1);
        expect(h.raised[0].active).toBe(area);
        expect(h.created).toHaveLength(0);
    });

    it('its text holds a link (a read view): it still lands at the end, keyboard up', async () => {
        const text = 'See https://example.com';
        h.cards = [card(7, today(), text)];
        mount();
        await settle();
        await warmTap('compose-note');
        const area = editorText();
        expect(area).not.toBeNull();
        expect(active()).toBe(area);
        expect(area!.selectionStart).toBe(text.length);
        expect(h.raised).toHaveLength(1);
    });

    it('closed and opened again by a tap: no keyboard this time', async () => {
        h.cards = [card(7, today(), 'Hello')];
        mount();
        await settle();
        await warmTap('compose-note');
        expect(h.raised).toHaveLength(1);
        act(() => { document.querySelector<HTMLButtonElement>('.notes-editor button[aria-label="Close note"]')!.click(); });
        await settle();
        expect(editor()).toBeNull();
        act(() => { document.querySelector<HTMLElement>('.notes-card')!.click(); });
        await settle();
        expect(editor(), 'the tap opened it').not.toBeNull();
        expect(h.raised, 'a tap is not New note').toHaveLength(1);
    });

    it('asked twice in a row: today’s note both times, and the keyboard each time', async () => {
        h.cards = [card(7, today(), 'Hello')];
        mount();
        await settle();
        await warmTap('compose-note');
        await warmTap('compose-note');
        expect(editor()?.getAttribute('aria-label')).toBe(today());
        expect(composer()).toBeNull();
        expect(h.raised).toHaveLength(2);
    });

    it('several titled today: the most recently edited', async () => {
        h.cards = [
            card(7, today(), 'older', { updatedAt: '2026-10-12T07:00:00Z' }),
            card(8, today(), 'newer', { updatedAt: '2026-10-12T09:00:00Z' }),
        ];
        mount();
        await settle();
        await warmTap('compose-note');
        expect(editorText()?.value).toBe('newer');
    });

    it('yesterday’s note and a channel named today are not today’s note', async () => {
        const y = new Date();
        y.setDate(y.getDate() - 1);
        h.cards = [
            card(5, dailyTitle(y), 'yesterday'),
            card(6, today(), '', { key: 'channel:6', ref: { kind: 'channel', id: 6 } }),
        ];
        mount();
        await settle();
        await warmTap('compose-note');
        expect(editor()).toBeNull();
        expect(titleField()?.value).toBe(today());
    });

    it('the notes still loading: it waits, then opens today’s note', async () => {
        h.loading = true;
        h.launchNav = { target: 'compose-note', item: null };
        mount();
        await settle();
        expect(composer(), 'nothing decided while the notes load').toBeNull();
        expect(editor()).toBeNull();
        h.loading = false;
        h.cards = [card(7, today(), 'Hello')];
        // The query settling, as the shell sees it: a render with the notes in.
        act(() => {
            root!.render(
                <QueryClientProvider client={new QueryClient()}>
                    <MemoryRouter initialEntries={['/']}><NotesShell onSignOut={() => {}} coldStart /></MemoryRouter>
                </QueryClientProvider>,
            );
        });
        await settle();
        expect(editor()?.getAttribute('aria-label')).toBe(today());
        expect(composer()).toBeNull();
    });
});

describe('unchanged', () => {
    it('New list: an empty checklist composer, no date', async () => {
        h.cards = [card(7, today(), 'Hello')];
        h.launchNav = { target: 'compose-list', item: null };
        mount();
        await settle();
        expect(editor()).toBeNull();
        expect(titleField()?.value).toBe('');
        expect(active()).toBe(items()[0]);
    });

    it('a server that keeps no note text: New note is the checklist, as before', async () => {
        h.features = { ...h.features, body: false };
        h.launchNav = { target: 'compose-note', item: null };
        mount();
        await settle();
        expect(textArea()).toBeNull();
        expect(titleField()?.value).toBe('');
        expect(active()).toBe(items()[0]);
    });

    it('the phone’s own New note button: no date, the title focused', async () => {
        mount();
        await settle();
        act(() => { document.querySelector<HTMLButtonElement>('.notes-fab')!.click(); });
        await settle();
        expect(titleField()?.value).toBe('');
        expect(h.raised).toHaveLength(0);
    });
});
