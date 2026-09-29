/**
 * Púca Notes hosted inside the desktop app (components/NotesDesktopView.tsx).
 *
 * What the host itself promises, with NotesShell stood in by a probe (its own
 * embedded mode is notesEmbedded.test.tsx):
 *
 *  - a query client of its OWN per mount, and that client cleared when the
 *    view goes — the decrypted notes must not outlive the session into the
 *    next account (Notes' own page keeps one at module scope, which is right
 *    only because the page IS the session);
 *  - its own React root under a MemoryRouter, never the app's address;
 *  - kept mounted while hidden (state intact, nothing remounted), hidden as
 *    `inert`, and whatever Notes portals landing inside the view's own layer
 *    — so it hides with it — not on the body;
 *  - notes.css put in FIRST, once, ahead of the app's stylesheets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { useLocation } from 'react-router-dom';
import type { QueryClient } from '@tanstack/react-query';

const h = vi.hoisted(() => ({
    clients: [] as QueryClient[],
    cleared: [] as QueryClient[],
    hydrated: [] as QueryClient[],
    invalidated: [] as unknown[],
    shellMounts: 0,
    shellUnmounts: 0,
    lastProps: null as null | { active: boolean; ownsKey: (e: KeyboardEvent) => boolean; onSignOut: () => void },
    onScreen: null as null | boolean,
    path: '',
    counter: 0,
    identityLate: null as null | boolean,
}));

vi.mock('../notes/model/notesQueries', async importOriginal => {
    const real = await importOriginal<typeof import('../notes/model/notesQueries')>();
    return {
        ...real,
        makeNotesQueryClient: () => {
            const qc = real.makeNotesQueryClient();
            const clear = qc.clear.bind(qc);
            qc.clear = () => { h.cleared.push(qc); clear(); };
            const invalidate = qc.invalidateQueries.bind(qc);
            qc.invalidateQueries = ((f?: unknown) => { h.invalidated.push(f); return invalidate(f as never); }) as typeof qc.invalidateQueries;
            h.clients.push(qc);
            return qc;
        },
    };
});
vi.mock('../notes/model/notesCache', async importOriginal => ({
    ...(await importOriginal<typeof import('../notes/model/notesCache')>()),
    hydrateNotesCache: async (qc: QueryClient) => { h.hydrated.push(qc); return 0; },
}));
vi.mock('../components/notesDesktopView.utils', async importOriginal => ({
    ...(await importOriginal<typeof import('../components/notesDesktopView.utils')>()),
    // null: the keys never come; true/false: they are there, late or at once.
    whenIdentityReady: (cb: (late: boolean) => void) => {
        if (h.identityLate !== null) cb(h.identityLate);
        return () => {};
    },
}));
vi.mock('../notes/components/NotesShell', async () => {
    const { useLayerOnScreen, usePortalTarget } = await import('../components/portalTarget');
    function NotesShell(props: { onSignOut: () => void; embedded?: { active: boolean; ownsKey: (e: KeyboardEvent) => boolean } }) {
        const where = useLocation().pathname;
        const onScreen = useLayerOnScreen();
        useEffect(() => { h.onScreen = onScreen; }, [onScreen]);
        // After every commit, which is when the host's props have landed.
        useEffect(() => {
            h.path = where;
            h.lastProps = { active: props.embedded?.active ?? false, ownsKey: props.embedded!.ownsKey, onSignOut: props.onSignOut };
        });
        const [n, setN] = useState(0);
        useEffect(() => { h.shellMounts += 1; return () => { h.shellUnmounts += 1; }; }, []);
        const target = usePortalTarget();
        return (
            <>
                <button type="button" data-testid="bump" onClick={() => { setN(n + 1); h.counter = n + 1; }}>{n}</button>
                {createPortal(<div data-testid="portaled"><audio data-testid="voice" /></div>, target)}
            </>
        );
    }
    return { NotesShell };
});

const { NotesDesktopView } = await import('../components/NotesDesktopView');

let root: Root | null = null;
let host: HTMLElement | null = null;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function mount(active: boolean, onSignOut: () => void = () => {}) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<NotesDesktopView active={active} onSignOut={onSignOut} />); });
    return {
        rerender: (a: boolean, s: () => void = onSignOut) => act(() => { root!.render(<NotesDesktopView active={a} onSignOut={s} />); }),
    };
}
async function unmount() {
    act(() => { root?.unmount(); });
    root = null;
    await flush();
}
const view = () => document.querySelector<HTMLElement>('.notes-desktop-view');
let pause: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    h.clients = [];
    h.cleared = [];
    h.hydrated = [];
    h.invalidated = [];
    h.shellMounts = 0;
    h.shellUnmounts = 0;
    h.lastProps = null;
    h.onScreen = null;
    h.path = '';
    h.counter = 0;
    h.identityLate = false;
    // jsdom implements no media playback; this is the one call the view makes.
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    document.head.querySelectorAll('style[data-notes-desktop]').forEach(s => s.remove());
});
afterEach(async () => {
    await unmount();
    host?.remove();
    host = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('one query client per mount, gone with it', () => {
    it('mounting makes a fresh client, and Notes is rendered with it under its own router', async () => {
        window.history.replaceState(null, '', '/chat');   // the app's own address
        mount(true);
        await flush();
        expect(h.clients).toHaveLength(1);
        expect(h.shellMounts).toBeGreaterThanOrEqual(1);
        // Notes starts at ITS '/', and the app's address is left alone.
        expect(h.path).toBe('/');
        expect(window.location.pathname).toBe('/chat');
        window.history.replaceState(null, '', '/');
    });

    it('unmounting clears exactly that client, and unmounts Notes with it', async () => {
        mount(true);
        await flush();
        const [qc] = h.clients;
        const mountsBefore = h.shellMounts;
        await unmount();
        expect(h.cleared).toContain(qc);
        expect(h.shellUnmounts).toBe(mountsBefore);
    });

    // Clearing is not the end of it: the sealed cache being read back, a
    // create's answer or a refetch can still be on the way in when the view
    // goes, and landing after the clear it built a fresh query — decrypted
    // rows of the signed-out account, held by a 30-minute gc timer in a
    // client nothing reads, into the next account's session.
    it('whatever lands in that client after it was cleared is dropped as it arrives', async () => {
        mount(true);
        await flush();
        const [qc] = h.clients;
        // POSITIVE CONTROL: while the view is up, a write is kept.
        qc.setQueryData(['notes', 'x'], 1);
        expect(qc.getQueryData(['notes', 'x'])).toBe(1);
        await unmount();
        expect(h.cleared).toContain(qc);
        qc.setQueryData(['notes', 'tasks', 'list', 1], [{ id: 1, description: 'Buy oat milk' }]);
        qc.setQueryData(['notes', 'lists'], (prev: unknown[] | undefined) => [...(prev ?? []), { id: 1, title: 'Groceries' }]);
        expect(qc.getQueryData(['notes', 'tasks', 'list', 1])).toBeUndefined();
        expect(qc.getQueryData(['notes', 'lists'])).toBeUndefined();
        expect(qc.getQueryCache().getAll()).toEqual([]);
    });

    it('a second mount — the next session — gets a new client, not the last one', async () => {
        mount(true);
        await flush();
        await unmount();
        mount(true);
        await flush();
        const live = h.clients.filter(c => !h.cleared.includes(c));
        expect(live).toHaveLength(1);
        expect(h.clients.length).toBeGreaterThanOrEqual(2);
        expect(live[0]).not.toBe(h.clients[0]);
    });
});

describe('the sealed cache, read back once the keys are there', () => {
    it('keys in hand at mount: that client is hydrated, and nothing is re-read', async () => {
        h.identityLate = false;
        mount(true);
        await flush();
        const live = h.clients.filter(c => !h.cleared.includes(c));
        expect(h.hydrated).toEqual(live);
        expect(h.invalidated).toEqual([]);
    });

    it('keys arriving late: hydrated, then everything fetched without them is fetched again', async () => {
        h.identityLate = true;
        mount(true);
        await flush();
        expect(h.hydrated.length).toBeGreaterThan(0);
        expect(h.invalidated).toContainEqual({ queryKey: ['notes'] });
    });

    it('no keys: nothing is hydrated', async () => {
        h.identityLate = null;
        mount(true);
        await flush();
        expect(h.hydrated).toEqual([]);
    });
});

describe('hidden, not unmounted', () => {
    it('switching away keeps Notes mounted with its state, marks the view inert, and tells Notes', async () => {
        const v = mount(true);
        await flush();
        act(() => { document.querySelector<HTMLButtonElement>('[data-testid="bump"]')!.click(); });
        expect(h.counter).toBe(1);
        // Deltas, not totals: StrictMode mounts the probe twice on the way in.
        const mounts = h.shellMounts;
        const unmounts = h.shellUnmounts;
        v.rerender(false);
        await flush();
        expect(view()!.hasAttribute('inert')).toBe(true);
        expect(h.lastProps!.active).toBe(false);
        expect(h.shellMounts).toBe(mounts);
        expect(h.shellUnmounts).toBe(unmounts);
        v.rerender(true);
        await flush();
        expect(view()!.hasAttribute('inert')).toBe(false);
        expect(document.querySelector('[data-testid="bump"]')!.textContent).toBe('1');
    });

    it('Notes’ portals land in the view’s own layer, so they hide with it', async () => {
        mount(true);
        await flush();
        const portaled = document.querySelector('[data-testid="portaled"]')!;
        expect(portaled).not.toBeNull();
        expect(view()!.contains(portaled)).toBe(true);
        expect(portaled.parentElement!.classList.contains('notes-desktop-layer')).toBe(true);
    });

    it('whatever only the foreground may hold (the recorder’s microphone) is told Notes left the screen', async () => {
        const v = mount(true);
        await flush();
        expect(h.onScreen).toBe(true);
        v.rerender(false);
        await flush();
        expect(h.onScreen).toBe(false);
    });

    it('a voice note playing when the view is left is paused', async () => {
        const v = mount(true);
        await flush();
        expect(pause).not.toHaveBeenCalled();
        v.rerender(false);
        expect(pause).toHaveBeenCalled();
    });

    it('the key gate Notes is given says no while the view is hidden', async () => {
        const v = mount(true);
        await flush();
        const e = new KeyboardEvent('keydown', { key: 'c' });
        Object.defineProperty(e, 'target', { value: document.body });
        expect(h.lastProps!.ownsKey(e)).toBe(true);
        v.rerender(false);
        await flush();
        expect(h.lastProps!.ownsKey(e)).toBe(false);
    });
});

describe('sign-out and stylesheet', () => {
    it('Notes’ sign-out is the app’s — the latest one it was handed', async () => {
        const first = vi.fn();
        const second = vi.fn();
        const v = mount(true, first);
        await flush();
        v.rerender(true, second);
        act(() => { h.lastProps!.onSignOut(); });
        expect(second).toHaveBeenCalledTimes(1);
        expect(first).not.toHaveBeenCalled();
    });

    it('notes.css goes in first in <head>, and only once however often the view mounts', async () => {
        const appSheet = document.createElement('style');
        appSheet.textContent = '/* the app’s own */';
        document.head.appendChild(appSheet);
        mount(true);
        await flush();
        await unmount();
        mount(true);
        await flush();
        const ours = document.head.querySelectorAll('style[data-notes-desktop]');
        expect(ours).toHaveLength(1);
        expect(document.head.firstElementChild).toBe(ours[0]);
        appSheet.remove();
    });
});
