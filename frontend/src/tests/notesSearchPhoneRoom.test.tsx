/**
 * Notes' search on a phone: the owner's report, "on android searching notes
 * doesnt work properly - it searches but deleting the text afterwards doesnt
 * work".
 *
 * The cause was ROOM, not the event handling. On a 411 px Android screen the
 * search field sat between the Notes mark and four buttons in a 114 px pill;
 * once it held a letter, its Clear button took 44 px of that and the input
 * was 20 px wide (on a 360 px screen it was under 20 px before any letter).
 * In a field that narrow, Android's keyboard in the WebView lands every
 * letter at the START of the field: measured on a headless emulator with
 * Gboard 15.9 and WebView 151, Gboard's own keys typed "milk" as "klmi", and
 * each Backspace fired `beforeinput: deleteContentBackward` and no `input`, so
 * nothing was deleted and the results stayed filtered. A bare input injected
 * into the same WebView breaks at 32 px wide and is fine from 36 px; long text
 * overflowing a 100 px one is fine. While searching (the field focused or
 * holding text), notes.css now hides the mark, Refresh and the grid/list
 * switch on a narrow phone, so the field has the row (200 px or more at 360,
 * 390 and 411 px wide).
 *
 * jsdom has no layout and no keyboard, so the caret jump cannot happen here,
 * and the emulator run is the proof. What this file pins, through the REAL
 * NotesShell and its real search input:
 *  - the `searching` mark the phone rule keys on: on while the field is
 *    focused or holds text, off once it is empty and left;
 *  - the phone rule in notes.css, its selectors matched against the rendered
 *    bar: while searching it hides exactly the mark, Refresh and the view
 *    switch, and never the menu, the field, its Clear button or the account
 *    button; while not searching it hides nothing;
 *  - Clear keeps the field focused when the press began with the caret in
 *    it, so the bar does not collapse under the finger and put the grid/list
 *    switch where Clear was (a touch screen's pointerleave, which comes
 *    before the click, does not lose that); tapped with the field NOT focused
 *    it leaves the focus alone (no caret for single-key shortcuts to type
 *    into, no keyboard popping up) and the bar holds its shape a moment before
 *    it collapses; pressed from the keyboard or a screen reader (a click with
 *    detail 0) it puts the focus back in the field instead of dropping it on
 *    the page; a cancelled press is forgotten; Escape clears and leaves, and
 *    the bar is whole again;
 *  - a press anywhere on the pill focuses the field: unfocused, the input is
 *    only ~17 px of the pill on a 360 px phone (0 at 330 px), so a tap on the
 *    magnifier or the padding used to focus nothing; a press on Clear stays
 *    Clear's;
 *  - the field driven with the events an Android keyboard sends (keyCode 229
 *    keydowns, `beforeinput`/`input` insertText, a composition, Backspace as
 *    `deleteContentBackward`, select-all then delete): typing filters, and
 *    deleting one letter at a time or all at once brings the whole list back.
 *    These held before the fix too (the JavaScript side was never the bug);
 *    they are here so a change to the field that does break it fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const h = vi.hoisted(() => ({
    cards: [] as unknown[],
}));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isAndroidApp: () => true,
}));
vi.mock('../notes/native/notesNative', async importOriginal => ({
    ...(await importOriginal<typeof import('../notes/native/notesNative')>()),
    notesNativeAvailable: () => true,
    consumeNativeLaunchNav: async () => ({ target: null, item: null }),
    consumeNativeLaunchShare: async () => ({ text: null, subject: null, files: [] }),
    onNativeNavigate: () => () => {},
    onNativeShare: () => () => {},
    fetchSharedFiles: async () => [],
    syncNativeReminders: async () => ({ ok: true }),
    setNativeBackgroundRefresh: async () => undefined,
    raiseNativeKeyboard: async () => true,
    hideNativeKeyboard: async () => true,
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
    const features = { body: true, attachments: false, noteReminders: false, trash: false };
    const content = {
        features, featuresKnown: true, trashEnabled: false, isSelfList: () => false,
        ensureFeatures: () => Promise.resolve({ ...features }),
        setBody: async () => true, addNoteMedia: async () => true, setNoteAttachments: async () => true,
    };
    const actions = {
        refreshAll: async () => {}, createNote: async () => ({ kind: 'list', id: 99 }), content,
        deleteTaskFrom: noop, addTask: noop, setAttachments: noop, snoozeTask: noop, restoreCompleted: noop,
        toggleTask: noop, editTask: noop, moveTaskIn: noop, reorderTaskIn: noop, setDue: noop, setSchedule: noop,
        togglePin: noop, refreshNote: noop, renameNote: noop, restoreNote: noop,
    };
    return {
        ...real,
        useNoteCards: () => ({ cards: h.cards, sources: [], prefs: [], prefsReady: true, loading: false, error: null, tasksPending: false }),
        useNoteActions: () => actions,
        useNoteTasks: () => ({ data: [], isPending: false, isFetching: false }),
        useNotesPrefs: () => ({ ...EMPTY_KEEP_PREFS }),
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
        matches: q.includes('pointer: coarse'),
        media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }),
});
class NoObserver { observe() {} unobserve() {} disconnect() {} }

const { NotesShell } = await import('../notes/components/NotesShell');

/** A personal text note, as NotesShell's cards carry one. */
const card = (id: number, title: string, body: string) => ({
    key: `list:${id}`, ref: { kind: 'list', id }, title, body, tasks: [], pinned: false, color: 'default',
    labels: [], archived: false, total: 0, completed: 0, createdAt: '2026-10-01T08:00:00Z',
    updatedAt: '2026-10-12T08:00:00Z', contentRev: 1,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <QueryClientProvider client={new QueryClient()}>
                <MemoryRouter initialEntries={['/']}>
                    <NotesShell onSignOut={() => {}} coldStart={false} />
                </MemoryRouter>
            </QueryClientProvider>,
        );
    });
}
const settle = async () => {
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
};

const field = () => document.querySelector<HTMLInputElement>('.notes-search input')!;
const bar = () => document.querySelector<HTMLElement>('.notes-topbar')!;
const shownTitles = () => [...document.querySelectorAll('.notes-card')].map(c => c.querySelector('.notes-card-title')?.textContent?.trim() ?? '').sort();
const ALL = ['Groceries', 'Weekend'];

// --- What an Android keyboard sends ------------------------------------------------
// Recorded off the emulator (Gboard 15.9, WebView 151) on this very field: a
// letter is a keyDown with key "Unidentified" / keyCode 229, then
// beforeinput + input "insertText"; Gboard's delete key is keyDown
// "Backspace" / 8, then beforeinput + input "deleteContentBackward". The
// browser edits the text between the two; here that edit is done by hand at
// the caret, the way the browser would.
const setNative = (el: HTMLInputElement, v: string) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
function key(el: HTMLElement, type: 'keydown' | 'keyup', k: string, code: number) {
    const e = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { value: code });
    Object.defineProperty(e, 'which', { value: code });
    return el.dispatchEvent(e);
}
function edit(el: HTMLInputElement, inputType: string, data: string | null, apply: () => void, isComposing = false) {
    const before = new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true, isComposing });
    if (!el.dispatchEvent(before)) return;
    apply();
    el.dispatchEvent(new InputEvent('input', { inputType, data, bubbles: true, isComposing }));
}
function imeLetter(el: HTMLInputElement, ch: string) {
    act(() => {
        key(el, 'keydown', 'Unidentified', 229);
        const at = el.selectionStart ?? el.value.length;
        edit(el, 'insertText', ch, () => { setNative(el, el.value.slice(0, at) + ch + el.value.slice(at)); el.setSelectionRange(at + 1, at + 1); });
        key(el, 'keyup', 'Unidentified', 229);
    });
}
function imeBackspace(el: HTMLInputElement, code = 8) {
    act(() => {
        key(el, 'keydown', code === 229 ? 'Unidentified' : 'Backspace', code);
        const s = el.selectionStart ?? el.value.length;
        const e = el.selectionEnd ?? s;
        if (s === e && s === 0) { edit(el, 'deleteContentBackward', null, () => {}); return; }
        const from = s === e ? s - 1 : s;
        edit(el, 'deleteContentBackward', null, () => { setNative(el, el.value.slice(0, from) + el.value.slice(e)); el.setSelectionRange(from, from); });
        key(el, 'keyup', code === 229 ? 'Unidentified' : 'Backspace', code);
    });
}
/** A pointer or mouse event on `el`; false when a handler prevented its default. */
function press(el: Element, type: 'pointerdown' | 'pointerup' | 'pointerout' | 'pointerleave' | 'pointercancel' | 'mousedown') {
    return el.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'pointerleave', cancelable: true, button: 0 }));
}
/** A click with the fields a browser fills in. jsdom's `click()` has detail
 *  0, which is what Enter or Space on a button gives; `pointerType` is how a
 *  Chromium click (a PointerEvent there) says what made it. */
function clickWith(el: Element, { detail, buttons = 0, pointerType }: { detail: number; buttons?: number; pointerType?: string }) {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, buttons, detail });
    if (pointerType !== undefined) Object.defineProperty(ev, 'pointerType', { value: pointerType });
    return el.dispatchEvent(ev);
}
/** The click a mouse or a finger ends with: `detail` 1, the button released. */
const pointerClick = (el: Element, pointerType?: string) => clickWith(el, { detail: 1, pointerType });
/** The click Enter or Space on a focused button, or a screen reader, gives: no pointer, detail 0. */
const keyClick = (el: Element) => clickWith(el, { detail: 0, pointerType: '' });
/** A tap on `el` in a touch screen's order: pointerdown, pointerup, then
 *  pointerout/pointerleave (touch has no hover, so they come BEFORE the
 *  click), the focus moving at the compat mousedown, then the click. */
function tap(el: HTMLElement, pointerType?: string) {
    press(el, 'pointerdown');
    press(el, 'pointerup');
    press(el, 'pointerout');
    press(el, 'pointerleave');
    el.focus();
    pointerClick(el, pointerType);
}
/** For the length of `fn`, a user agent that says Android (Chrome on a phone, the WebView). */
async function asAndroid(fn: () => Promise<void> | void) {
    const spy = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 16; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Mobile Safari/537.36');
    try { await fn(); } finally { spy.mockRestore(); }
}
/** A search typed, then the field left: the caret is nowhere. */
function typedAndLeft(word: string) {
    act(() => { field().focus(); });
    for (const ch of word) imeLetter(field(), ch);
    act(() => { field().blur(); });
    return bar().querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
}
/** Real time, in act: the bar's hold after a Clear is a timer. */
const wait = async (ms: number) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
/** A word typed as a composition (Gboard with suggestions on, Samsung's keyboard). */
function imeCompose(el: HTMLInputElement, word: string) {
    act(() => {
        const at = el.selectionStart ?? el.value.length;
        const head = el.value.slice(0, at);
        const tail = el.value.slice(at);
        el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
        for (let i = 1; i <= word.length; i++) {
            key(el, 'keydown', 'Unidentified', 229);
            const part = word.slice(0, i);
            el.dispatchEvent(new CompositionEvent('compositionupdate', { data: part, bubbles: true }));
            edit(el, 'insertCompositionText', part, () => { setNative(el, head + part + tail); el.setSelectionRange(at + i, at + i); }, true);
        }
        el.dispatchEvent(new CompositionEvent('compositionend', { data: word, bubbles: true }));
    });
}

// --- The phone rule, read from the stylesheet ----------------------------------------
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'notes', 'notes.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** Every selector, inside a narrow coarse-pointer block, whose rule sets display: none
 *  and which only applies to a searching bar. */
function phoneSearchingHides(): string[] {
    const out: string[] = [];
    for (const m of css.matchAll(/@media\s*\(pointer:\s*coarse\)\s*and\s*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/g)) {
        if (Number(m[1]) < 411) continue; // must cover a 411 px phone (and anything narrower)
        for (const r of m[2].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            if (!/display\s*:\s*none/.test(r[2])) continue;
            for (const sel of r[1].split(',').map(s => s.trim())) if (sel.includes('.notes-topbar.searching')) out.push(sel);
        }
    }
    return out;
}
const hiddenBy = (sels: string[]) => [...bar().querySelectorAll<HTMLElement>('*')].filter(el => sels.some(s => el.matches(s)));
const label = (el: HTMLElement) => el.getAttribute('aria-label') ?? el.className;

beforeEach(() => {
    h.cards = [card(1, 'Groceries', 'milk, bread, eggs'), card(2, 'Weekend', 'call Sam, fix the bike')];
    // Here, not at the top: afterEach's unstubAllGlobals takes these away too.
    vi.stubGlobal('ResizeObserver', NoObserver);
    vi.stubGlobal('IntersectionObserver', NoObserver);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

describe('Notes search on a phone has the room an Android keyboard needs', () => {
    it('the bar is marked searching while the field is focused or holds text, and not otherwise', async () => {
        mount();
        await settle();
        expect(bar().classList.contains('searching')).toBe(false);
        act(() => { field().focus(); });
        expect(bar().classList.contains('searching')).toBe(true);
        imeLetter(field(), 'm');
        act(() => { field().blur(); });
        // Still holding text, left: still searching (the results are on screen).
        expect(bar().classList.contains('searching')).toBe(true);
        act(() => { field().focus(); });
        imeBackspace(field());
        act(() => { field().blur(); });
        expect(field().value).toBe('');
        expect(bar().classList.contains('searching')).toBe(false);
    });

    it('while searching, the phone rule hides the mark, Refresh and the view switch, and nothing else', async () => {
        mount();
        await settle();
        const sels = phoneSearchingHides();
        expect(sels.length).toBeGreaterThan(0);
        // Not searching: the rule takes nothing away.
        expect(hiddenBy(sels).map(label)).toEqual([]);
        act(() => { field().focus(); });
        imeLetter(field(), 'm');
        const hidden = hiddenBy(sels);
        expect(hidden.map(label).sort()).toEqual(['Púca Notes — all notes', 'Refresh', 'Switch to list view'].sort());
        // What stays: the menu, the field and its Clear button, the account button.
        const stays = [
            bar().querySelector('button[aria-label="Open navigation"]'),
            bar().querySelector('.notes-search'),
            field(),
            bar().querySelector('button[aria-label="Clear search"]'),
            bar().querySelector('button[aria-label="Account and settings"]'),
        ];
        for (const el of stays) {
            expect(el).not.toBeNull();
            expect(hidden.some(x => x === el || x.contains(el!))).toBe(false);
        }
    });

    it('Clear keeps the field focused and the bar searching; Escape clears and gives the bar back', async () => {
        mount();
        await settle();
        act(() => { field().focus(); });
        for (const ch of 'milk') imeLetter(field(), ch);
        const clear = bar().querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
        // A tap with the caret in the field, in a touch screen's order: the
        // pointerleave before the click must not lose what pointerdown saw.
        act(() => { tap(clear); });
        expect(field().value).toBe('');
        expect(document.activeElement).toBe(field());
        expect(bar().classList.contains('searching')).toBe(true);
        expect(shownTitles()).toEqual(ALL);
        for (const ch of 'bike') imeLetter(field(), ch);
        act(() => { field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(field().value).toBe('');
        expect(document.activeElement).not.toBe(field());
        expect(bar().classList.contains('searching')).toBe(false);
        expect(shownTitles()).toEqual(ALL);
    });

    it('Clear pressed with the field NOT focused leaves the focus alone (no caret, no keyboard, the shortcuts keep working)', async () => {
        mount();
        await settle();
        act(() => { field().focus(); });
        for (const ch of 'milk') imeLetter(field(), ch);
        // Left with its text in (a desktop click elsewhere, or a phone whose keyboard went down).
        act(() => { field().blur(); });
        expect(bar().classList.contains('searching')).toBe(true);
        const clear = bar().querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
        act(() => { tap(clear); });
        expect(field().value).toBe('');
        expect(shownTitles()).toEqual(ALL);
        expect(document.activeElement).not.toBe(field());
        // The bar holds its shape a moment, so it does not collapse under the
        // finger and put the grid/list switch where Clear was...
        expect(bar().classList.contains('searching')).toBe(true);
        expect(document.activeElement).not.toBe(field());
        // ...and then is whole again, still with no caret in the field.
        await wait(700);
        expect(bar().classList.contains('searching')).toBe(false);
        expect(document.activeElement).not.toBe(field());
    });

    it('Clear from the keyboard (Enter or Space) or a screen reader puts the focus back in the field, not on the page', async () => {
        mount();
        await settle();
        act(() => { field().focus(); });
        for (const ch of 'milk') imeLetter(field(), ch);
        const clear = bar().querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
        // Tab to it: the field blurs, the button has the focus, no pointer anywhere.
        act(() => { clear.focus(); });
        act(() => { keyClick(clear); });
        expect(field().value).toBe('');
        expect(document.activeElement).toBe(field());
        expect(bar().classList.contains('searching')).toBe(true);
        // The same from a field that had been left (a screen reader moves no caret first).
        for (const ch of 'bike') imeLetter(field(), ch);
        act(() => { field().blur(); });
        const clear2 = bar().querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
        act(() => { keyClick(clear2); });
        expect(field().value).toBe('');
        expect(document.activeElement).toBe(field());
    });

    it('Enter or Space on Clear puts the focus back even after a mouse press that was dragged off it', async () => {
        mount();
        await settle();
        const clear = typedAndLeft('milk');
        // Pressed with the mouse, dragged off, released elsewhere: no click, no cancel.
        act(() => { press(clear, 'pointerdown'); });
        // Then Tab to it and Enter: detail 0 says keyboard, whatever the stale press says.
        act(() => { clear.focus(); keyClick(clear); });
        expect(field().value).toBe('');
        expect(document.activeElement).toBe(field());
    });

    it('a click no pointer press led to (an accessibility service\'s activation) puts the focus back', async () => {
        mount();
        await settle();
        const clear = typedAndLeft('milk');
        // detail 1 and the button released, like a tap's, but no pointerdown on the button first.
        act(() => { clear.focus(); pointerClick(clear); });
        expect(field().value).toBe('');
        expect(document.activeElement).toBe(field());
    });

    it('Android TalkBack\'s activation (a pointer type, the button still held) puts the focus back', async () => {
        await asAndroid(async () => {
            mount();
            await settle();
            const clear = typedAndLeft('milk');
            // TalkBack's double-tap: pointerdown on the button, then a click whose
            // `buttons` still reports the button and whose `detail` is not 0.
            act(() => { press(clear, 'pointerdown'); clear.focus(); clickWith(clear, { detail: 1, buttons: 1, pointerType: 'touch' }); });
            expect(field().value).toBe('');
            expect(document.activeElement).toBe(field());
        });
    });

    it('on Android a real tap on Clear with the field left is not taken for TalkBack: no caret, the bar held', async () => {
        await asAndroid(async () => {
            mount();
            await settle();
            const clear = typedAndLeft('milk');
            act(() => { tap(clear, 'touch'); });
            expect(field().value).toBe('');
            expect(document.activeElement).not.toBe(field());
            expect(bar().classList.contains('searching')).toBe(true);
            await wait(700);
            expect(bar().classList.contains('searching')).toBe(false);
        });
    });

    it('a cancelled press on Clear is forgotten: a later click with no press of its own is judged as one', async () => {
        mount();
        await settle();
        const clear = typedAndLeft('milk');
        // A press with the field left, then the finger turned it into a scroll.
        act(() => { press(clear, 'pointerdown'); press(clear, 'pointercancel'); });
        // An activation with no pointerdown of its own: not the cancelled press's click.
        act(() => { clear.focus(); pointerClick(clear); });
        expect(field().value).toBe('');
        expect(document.activeElement).toBe(field());
    });

    it('a press anywhere on the pill (the magnifier, the padding) focuses the field; a press on Clear or the field itself is left alone', async () => {
        mount();
        await settle();
        const pill = bar().querySelector<HTMLElement>('.notes-search')!;
        const magnifier = pill.querySelector('svg')!;
        expect(document.activeElement).not.toBe(field());
        let allowed = true;
        act(() => { allowed = press(magnifier, 'mousedown'); });
        expect(document.activeElement).toBe(field());
        expect(allowed).toBe(false); // prevented: the press must not blur what it just focused
        expect(bar().classList.contains('searching')).toBe(true);
        act(() => { field().blur(); });
        act(() => { allowed = press(pill, 'mousedown'); });
        expect(document.activeElement).toBe(field());
        expect(allowed).toBe(false);
        // On the field itself the browser places the caret: nothing is prevented.
        act(() => { allowed = press(field(), 'mousedown'); });
        expect(allowed).toBe(true);
        // On Clear the press is the button's: not prevented, and the pill does not take it.
        for (const ch of 'milk') imeLetter(field(), ch);
        act(() => { field().blur(); });
        const clear = pill.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
        act(() => { allowed = press(clear.querySelector('svg') ?? clear, 'mousedown'); });
        expect(allowed).toBe(true);
        expect(document.activeElement).not.toBe(field());
    });

    it('Android-shaped typing filters, and deleting letter by letter brings the whole list back', async () => {
        mount();
        await settle();
        expect(shownTitles()).toEqual(ALL);
        act(() => { field().focus(); });
        for (const ch of 'milk') imeLetter(field(), ch);
        expect(field().value).toBe('milk');
        expect(shownTitles()).toEqual(['Groceries']);
        const seen: string[] = [];
        for (let i = 0; i < 4; i++) { imeBackspace(field()); seen.push(field().value); }
        expect(seen).toEqual(['mil', 'mi', 'm', '']);
        expect(shownTitles()).toEqual(ALL);
        // A keyboard whose delete also arrives as keyCode 229.
        for (const ch of 'bike') imeLetter(field(), ch);
        expect(shownTitles()).toEqual(['Weekend']);
        for (let i = 0; i < 4; i++) imeBackspace(field(), 229);
        expect(field().value).toBe('');
        expect(shownTitles()).toEqual(ALL);
    });

    it('a composed word filters, and select-all then delete brings the whole list back', async () => {
        mount();
        await settle();
        act(() => { field().focus(); });
        imeCompose(field(), 'bread');
        expect(field().value).toBe('bread');
        expect(shownTitles()).toEqual(['Groceries']);
        act(() => { field().setSelectionRange(0, field().value.length); });
        imeBackspace(field());
        expect(field().value).toBe('');
        expect(shownTitles()).toEqual(ALL);
    });
});
