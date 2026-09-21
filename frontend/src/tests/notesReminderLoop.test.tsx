/**
 * useNotesReminderLoop — which loop the shell runs, and where a reminder tap
 * lands.
 *
 *  - Browser / older APK: Púca's loop exactly as before (no options). The
 *    Android app: `notify: false` plus an onFeed that syncs the native alarms
 *    and refreshes the background job's credentials.
 *  - A tap while the app runs arrives as a `navigate` event; the native side
 *    also parks that target for a page that was not listening, so the hook
 *    must take it off the shelf too. Found on the emulator: without that,
 *    signing out and back in replayed an old tap and opened Reminders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let available = true;
let pending: { target: string | null; item: number | null } = { target: null, item: null };
let navListener: ((n: { target: string | null; item: number | null }) => void) | null = null;
const consume = vi.fn(async () => { const t = pending; pending = { target: null, item: null }; return t; });
const syncNativeReminders = vi.fn(async () => ({ ok: true }));
const setNativeBackgroundRefresh = vi.fn(async () => undefined);
const startTaskReminders = vi.fn((_opts?: unknown) => () => {});

vi.mock('../notes/native/notesNative', () => ({
    notesNativeAvailable: () => available,
    consumeNativeLaunchNav: () => consume(),
    onNativeNavigate: (cb: (n: { target: string | null; item: number | null }) => void) => { navListener = cb; return () => { navListener = null; }; },
    syncNativeReminders: (...a: unknown[]) => syncNativeReminders(...(a as [])),
    setNativeBackgroundRefresh: (...a: unknown[]) => setNativeBackgroundRefresh(...(a as [])),
}));
vi.mock('../api/taskReminders', () => ({ startTaskReminders: (o?: unknown) => startTaskReminders(o) }));
vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => 7, getToken: () => 'tok' }));
vi.mock('../api/config', () => ({ API_BASE_URL: 'https://api.example.test' }));

const { useNotesReminderLoop } = await import('../notes/native/useNativeReminders');

const settle = async () => { await act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); }); };

let container: HTMLDivElement;
let root: Root;
const navigate = vi.fn();
const compose = vi.fn();
function Shell() {
    useNotesReminderLoop(navigate, compose);
    return null;
}

beforeEach(() => {
    available = true;
    pending = { target: null, item: null };
    navListener = null;
    for (const f of [consume, syncNativeReminders, setNativeBackgroundRefresh, startTaskReminders, navigate, compose]) f.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('useNotesReminderLoop', () => {
    it('browser / older APK: Púca\'s loop, unchanged', async () => {
        available = false;
        act(() => root.render(<Shell />));
        await settle();
        expect(startTaskReminders).toHaveBeenCalledWith(undefined);
        expect(consume).not.toHaveBeenCalled();
    });

    it('Android app: the loop posts nothing and feeds the native alarms', async () => {
        act(() => root.render(<Shell />));
        await settle();
        const opts = startTaskReminders.mock.calls[0][0] as { notify: boolean; onFeed: (e: unknown[]) => void };
        expect(opts.notify).toBe(false);
        opts.onFeed([{ id: 1, at: 5, mark: 'm' }]);
        expect(syncNativeReminders).toHaveBeenCalledWith('7', [{ id: 1, at: 5, mark: 'm' }]);
        expect(setNativeBackgroundRefresh).toHaveBeenCalledWith({ apiBase: 'https://api.example.test', token: 'tok', account: '7' });
    });

    it('a launch from a reminder notification lands on Reminders', async () => {
        pending = { target: 'reminders', item: null };
        act(() => root.render(<Shell />));
        await settle();
        expect(navigate).toHaveBeenCalledWith('/reminders');
    });

    it('one item due: the launch names it, so the shell can open that item', async () => {
        pending = { target: 'reminders', item: 42 };
        act(() => root.render(<Shell />));
        await settle();
        expect(navigate).toHaveBeenCalledWith('/reminders?item=42');
    });

    it('a launcher shortcut, the tile or the widget opens the composer and navigates nowhere', async () => {
        pending = { target: 'compose-draw', item: null };
        act(() => root.render(<Shell />));
        await settle();
        expect(compose).toHaveBeenCalledWith('draw');
        expect(navigate).not.toHaveBeenCalled();
    });

    it('an unknown target still does nothing at all (forward-compat control)', async () => {
        pending = { target: 'compose-whatever-comes-next', item: null };
        act(() => root.render(<Shell />));
        await settle();
        expect(compose).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('a tap while running navigates AND clears the parked target, so a later mount does not replay it', async () => {
        act(() => root.render(<Shell />));
        await settle();
        navigate.mockClear();
        pending = { target: 'reminders', item: null };   // what the native side parks alongside the event
        act(() => navListener?.({ target: 'reminders', item: null }));
        await settle();
        expect(navigate).toHaveBeenCalledWith('/reminders');
        expect(pending.target).toBeNull();
        // Sign out and back in: the shell mounts again.
        act(() => root.render(<></>));
        navigate.mockClear();
        act(() => root.render(<Shell />));
        await settle();
        expect(navigate).not.toHaveBeenCalled();
    });
});
