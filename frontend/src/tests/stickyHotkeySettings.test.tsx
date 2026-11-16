/**
 * The global "new sticky note" shortcut (components/sticky/stickyHotkey.ts,
 * StickyNotesSettings.tsx; docs/STICKY_NOTES.md):
 *  - registered with the shell only while Púca is signed in, released while
 *    Settings captures a new one, and in the order asked (each registration
 *    is a new shell thread);
 *  - Settings says what the SHELL did: a combination Windows or another app
 *    holds is shown as taken, not as set;
 *  - the capture takes Ctrl, Alt or the Windows key (metaKey) with a key and
 *    refuses Shift and a letter, which is typing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({
    calls: [] as { cmd: string; args?: Record<string, unknown> }[],
    taken: new Set<string>(),
}));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => true,
    isMobile: () => false,
}));
vi.mock('@tauri-apps/api/core', async importOriginal => ({
    ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
        h.calls.push({ cmd, args });
        if (cmd === 'sticky_supported') return true;
        if (cmd === 'sticky_hotkey') {
            const b = args?.binding as { keyCode: number; ctrl: boolean; alt: boolean; shift: boolean; win: boolean } | null;
            if (b && h.taken.has(JSON.stringify(b))) throw 'taken';
            return null;
        }
        throw new Error(`no shell command ${cmd}`);
    },
}));

const { primeStickySupport, __resetStickyShellForTests } = await import('../components/sticky/stickyShell');
const hk = await import('../components/sticky/stickyHotkey');
const { StickyNotesSettings } = await import('../components/sticky/StickyNotesSettings');
const { DEFAULT_STICKY_HOTKEY } = await import('../components/settingsStore');
import type { KeyBinding } from '../components/settingsStore';

const hotkeyCalls = () => h.calls.filter(c => c.cmd === 'sticky_hotkey').map(c => c.args?.binding ?? null);
const WIN_SHIFT_N = { keyCode: 0x4E, ctrl: false, alt: false, shift: true, win: true };

beforeEach(async () => {
    h.calls = [];
    h.taken.clear();
    hk.__resetStickyHotkeyForTests();
    __resetStickyShellForTests();
    await primeStickySupport();
});

describe('registering the shortcut', () => {
    it('only while signed in, in the order asked, and released when signed out', async () => {
        await hk.wantStickyHotkey(DEFAULT_STICKY_HOTKEY);
        expect(hotkeyCalls()).toEqual([null]);
        await hk.enableStickyHotkey(true);
        expect(hotkeyCalls()).toEqual([null, WIN_SHIFT_N]);
        expect(hk.stickyHotkeyStatus()).toMatchObject({ state: 'on' });
        await hk.enableStickyHotkey(false);
        expect(hotkeyCalls().at(-1)).toBeNull();
        expect(hk.stickyHotkeyStatus()).toEqual({ state: 'off' });
    });

    it('a combination something else holds is TAKEN, not on', async () => {
        h.taken.add(JSON.stringify(WIN_SHIFT_N));
        await hk.wantStickyHotkey(DEFAULT_STICKY_HOTKEY);
        await hk.enableStickyHotkey(true);
        expect(hk.stickyHotkeyStatus()).toMatchObject({ state: 'taken' });
    });

    it('a refused shortcut is tried again when asked for again; an unchanged ask restarts nothing', async () => {
        h.taken.add(JSON.stringify(WIN_SHIFT_N));
        await hk.wantStickyHotkey(DEFAULT_STICKY_HOTKEY);
        await hk.enableStickyHotkey(true);
        expect(hk.stickyHotkeyStatus()).toMatchObject({ state: 'taken' });
        h.taken.clear();   // the other app let go
        await hk.wantStickyHotkey(DEFAULT_STICKY_HOTKEY);
        expect(hk.stickyHotkeyStatus()).toMatchObject({ state: 'on' });
        const n = hotkeyCalls().length;
        await hk.wantStickyHotkey({ ...DEFAULT_STICKY_HOTKEY });
        await hk.enableStickyHotkey(true);
        expect(hotkeyCalls()).toHaveLength(n);
    });

    it('a capture lets go of the shortcut and takes it back after', async () => {
        await hk.wantStickyHotkey(DEFAULT_STICKY_HOTKEY);
        await hk.enableStickyHotkey(true);
        await hk.suspendStickyHotkey(true);
        await hk.suspendStickyHotkey(false);
        expect(hotkeyCalls().slice(-2)).toEqual([null, WIN_SHIFT_N]);
    });
});

describe('Settings › Sticky notes', () => {
    let root: Root;
    let container: HTMLDivElement;
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    function mount(hotkey: KeyBinding | null) {
        const onHotkey = vi.fn();
        act(() => root.render(
            <StickyNotesSettings hotkey={hotkey} reopen confirmDelete onHotkey={onHotkey} onReopen={() => {}} onConfirmDelete={() => {}} />,
        ));
        return onHotkey;
    }
    const button = () => container.querySelector('[data-testid="sticky-hotkey"]') as HTMLButtonElement;
    const keydown = (init: KeyboardEventInit) => act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });

    it('shows Win + Shift + N, and a press with the Windows key is captured with it', () => {
        const onHotkey = mount(DEFAULT_STICKY_HOTKEY);
        expect(button().textContent).toBe('Win + Shift + N');
        act(() => button().click());
        keydown({ key: 'J', keyCode: 0x4A, metaKey: true, altKey: true });
        expect(onHotkey).toHaveBeenCalledWith({ keyCode: 0x4A, ctrl: false, alt: true, shift: false, win: true, label: 'J' });
    });

    it('refuses Shift and a letter — that is typing — and stays capturing', () => {
        const onHotkey = mount(DEFAULT_STICKY_HOTKEY);
        act(() => button().click());
        keydown({ key: 'N', keyCode: 0x4E, shiftKey: true });
        expect(onHotkey).not.toHaveBeenCalled();
        expect(container.textContent).toContain('Hold Ctrl, Alt or the Windows key');
        keydown({ key: 'Escape', keyCode: 27 });
        expect(button().textContent).toBe('Win + Shift + N');
    });

    it('says when Windows or another app holds it', async () => {
        h.taken.add(JSON.stringify(WIN_SHIFT_N));
        mount(DEFAULT_STICKY_HOTKEY);
        await act(async () => { await hk.wantStickyHotkey(DEFAULT_STICKY_HOTKEY); await hk.enableStickyHotkey(true); });
        expect(container.textContent).toContain('Win + Shift + N is taken by Windows or another app');
    });

    it('Reset and Remove', () => {
        const onHotkey = mount({ keyCode: 0x4A, ctrl: true, alt: true, shift: false, label: 'J' });
        act(() => (container.querySelector('.keybind-reset') as HTMLButtonElement).click());
        expect(onHotkey).toHaveBeenLastCalledWith(DEFAULT_STICKY_HOTKEY);
        act(() => (container.querySelector('.keybind-clear') as HTMLButtonElement).click());
        expect(onHotkey).toHaveBeenLastCalledWith(null);
    });
});
