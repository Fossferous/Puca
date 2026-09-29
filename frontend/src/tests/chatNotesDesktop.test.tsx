/**
 * Chat's "Tasks & notes" rail button on the desktop app versus everywhere
 * else, driven through the real Chat.
 *
 * Desktop (Tauri): it opens Púca Notes INSIDE the app (NotesDesktopView,
 * stood in here by a probe), the rail's highlight follows that view, the
 * button toggles, and the view is kept mounted — hidden, not unmounted —
 * when anything else takes the slot. The Tasks view is still one click away
 * on the home dashboard. Web (and the phone apps): the same button keeps
 * opening the Tasks view, and Notes' chunk is never rendered at all.
 *
 * Plus two pins on Chat's source for wiring no click here can reach: the
 * "Saved to …" toast, and every place another full view opens also closing
 * Notes — the list that grows each time a view is added, and the one a new
 * entry point silently forgets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const h = vi.hoisted(() => ({ tauri: false, servers: [] as unknown[], dms: [] as unknown[], viewProps: [] as { active: boolean }[], viewMounts: 0, viewUnmounts: 0 }));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => h.tauri,
}));
vi.mock('../components/NotesDesktopView', async () => {
    const { useEffect } = await import('react');
    function NotesDesktopView({ active }: { active: boolean; onSignOut: () => void }) {
        h.viewProps.push({ active });
        useEffect(() => { h.viewMounts += 1; return () => { h.viewUnmounts += 1; }; }, []);
        return <div data-testid="notes-desktop" data-active={String(active)} />;
    }
    return { NotesDesktopView };
});

// jsdom lacks these; Chat and its children ask for them at render.
Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);
// Before Chat loads, not per test: modules that hold `fetch` from import time
// would otherwise reach for the network. One server list, the rest empty.
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const body = /\/servers$/.test(u) ? h.servers : /\/dms$/.test(u) ? h.dms : /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : [];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() } as unknown as Response;
}));

const { Chat } = await import('../components/Chat');

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountChat() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}
const click = async (el: Element | null) => {
    expect(el).not.toBeNull();
    await act(async () => { (el as HTMLElement).click(); await new Promise(r => setTimeout(r, 0)); });
};
const railNotes = () => host!.querySelector('.server-icon.notes-self');
const railHome = () => host!.querySelector('.server-icon.home-button');
const notesView = () => host!.querySelector<HTMLElement>('[data-testid="notes-desktop"]');
const dashboard = () => host!.querySelector('.friends-dashboard');

beforeEach(() => {
    h.tauri = false;
    h.servers = [];
    h.dms = [];
    h.viewProps = [];
    h.viewMounts = 0;
    h.viewUnmounts = 0;
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = '';
});

describe('desktop: the rail opens Púca Notes inside the app', () => {
    beforeEach(() => { h.tauri = true; });

    it('opens the Notes view, closes the dashboard, and lights the rail button', async () => {
        await mountChat();
        expect(notesView()).toBeNull();          // nothing fetched before it is asked for
        expect(dashboard()).not.toBeNull();      // a server-less account lands on the dashboard
        await click(railNotes());
        expect(notesView()?.dataset.active).toBe('true');
        expect(dashboard()).toBeNull();
        expect(railNotes()!.classList.contains('active')).toBe(true);
        expect(railHome()!.classList.contains('active')).toBe(false);
    });

    it('the button again returns to where you were, and Notes stays mounted, hidden', async () => {
        await mountChat();
        await click(railNotes());
        await click(railNotes());
        expect(notesView()?.dataset.active).toBe('false');
        expect(h.viewUnmounts).toBe(0);
        expect(dashboard()).not.toBeNull();      // no server under it: the home dashboard
        expect(railNotes()!.classList.contains('active')).toBe(false);
    });

    it('another view taking the slot hides Notes without unmounting it; the rail follows', async () => {
        await mountChat();
        await click(railNotes());
        await click(railHome());
        expect(notesView()?.dataset.active).toBe('false');
        expect(h.viewUnmounts).toBe(0);
        expect(dashboard()).not.toBeNull();
        expect(railHome()!.classList.contains('active')).toBe(true);
        expect(railNotes()!.classList.contains('active')).toBe(false);
        await click(railNotes());
        expect(notesView()?.dataset.active).toBe('true');
        expect(h.viewMounts).toBe(1);
    });

    it('the Tasks view is still on the dashboard, and opening it lights home, not Notes', async () => {
        await mountChat();
        const tasksNav = [...host!.querySelectorAll<HTMLElement>('.friends-dashboard .sidebar-nav .nav-item')]
            .find(b => b.textContent?.trim() === 'Tasks');
        await click(tasksNav ?? null);
        expect(dashboard()!.classList.contains('tasks-active')).toBe(true);
        expect(railNotes()!.classList.contains('active')).toBe(false);
        expect(railHome()!.classList.contains('active')).toBe(true);
        expect(notesView()).toBeNull();
    });

    it('opened from the home dashboard with no server chosen, the button again goes back to that dashboard — not to a server', async () => {
        h.servers = [{ id: 's1', name: 'Alpha', owner_id: 99, icon_file_id: null }];
        h.dms = [{ id: 'd1', other_user_id: 2, other_username: 'bob', other_display_name: null, last_message: null, last_message_at: null, created_at: '2026-09-01' }];
        await mountChat();
        // Alpha is picked on its own; the home dashboard, a DM and back out of
        // it leave NO server chosen, which is where this starts.
        await click(railHome());
        await click(host!.querySelector('.friends-dashboard .dm-item'));
        await click(host!.querySelector('.back-to-server-btn'));
        expect(dashboard()).not.toBeNull();
        await click(railNotes());
        expect(notesView()?.dataset.active).toBe('true');
        await click(railNotes());
        expect(dashboard()).not.toBeNull();
        expect(host!.querySelector('.server-icon[title="Alpha"]')!.classList.contains('active')).toBe(false);
    });

    it('selecting a server hides Notes', async () => {
        h.servers = [{ id: 's1', name: 'Alpha', owner_id: 99, icon_file_id: null }];
        await mountChat();
        await click(railNotes());
        expect(notesView()?.dataset.active).toBe('true');
        await click(host!.querySelector('.server-icon[title="Alpha"]'));
        expect(notesView()?.dataset.active).toBe('false');
    });
});

describe('web and the phone apps: the rail keeps opening the Tasks view', () => {
    it('opens the dashboard on its Tasks tab, lights the rail button, and never renders Notes', async () => {
        await mountChat();
        await click(railNotes());
        expect(dashboard()!.classList.contains('tasks-active')).toBe(true);
        expect(railNotes()!.classList.contains('active')).toBe(true);
        expect(notesView()).toBeNull();
        expect(h.viewProps).toEqual([]);
    });
});

// --- Pins on Chat's source ------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const CHAT = stripComments(readFileSync(join(here, '..', 'components', 'Chat.tsx'), 'utf8'));

/** Every setShowDevicesView(...) call — bar the two that are not another view
 *  opening: Devices' own way out, and Notes' own way in — and whether the
 *  statement after it closes Notes. */
function viewSitesMissingNotes(code: string): string[] {
    const lines = code.split(/\r?\n/);
    const missing: string[] = [];
    let inOpenNotes = false;
    lines.forEach((l, i) => {
        if (/const openNotesView = \(\) => \{/.test(l)) inOpenNotes = true;
        else if (inOpenNotes && /^\s*\};\s*$/.test(l)) inOpenNotes = false;
        if (!/setShowDevicesView\((true|false)\);/.test(l)) return;
        if (inOpenNotes || /const leaveDevicesView = /.test(lines[i - 1] ?? '')) return;
        if (!/setShowNotesView\(false\);/.test(lines[i + 1] ?? '')) missing.push(`${i + 1}: ${l.trim()}`);
    });
    return missing;
}

/** The SaveToNoteModal toast's click handler goes to Notes on desktop. */
function savedToastOpensNotes(code: string): boolean {
    const at = code.indexOf('<SaveToNoteModal');
    if (at === -1) return false;
    const el = code.slice(at, code.indexOf('/>', code.indexOf('onSaved=', at)) + 2);
    return /onClick: \(\) => \(notesInApp \? openNotesView\(\) : openTasksView\(\)\)/.test(el);
}

describe('Chat’s wiring no click here reaches', () => {
    it('every other full view that opens closes Notes as well', () => {
        expect(viewSitesMissingNotes(CHAT)).toEqual([]);
        // It found the sites at all (a pin over nothing proves nothing).
        expect(CHAT.match(/setShowDevicesView\((true|false)\);/g)!.length).toBeGreaterThan(15);
    });

    it('MUTATION: a site that forgets is caught', () => {
        // The channel click, the commonest way out of Notes.
        const forgot = CHAT.replace(/setShowNotesView\(false\);(\s*if \(channel\.channel_type === 0\))/, '$1');
        expect(forgot).not.toBe(CHAT);
        expect(viewSitesMissingNotes(forgot)).toHaveLength(1);
    });

    it('"Saved to …" opens Notes on desktop, the Tasks view elsewhere', () => {
        expect(savedToastOpensNotes(CHAT)).toBe(true);
        const reverted = CHAT.replace('onClick: () => (notesInApp ? openNotesView() : openTasksView()),', 'onClick: () => openTasksView(),');
        expect(reverted).not.toBe(CHAT);
        expect(savedToastOpensNotes(reverted)).toBe(false);
    });
});
