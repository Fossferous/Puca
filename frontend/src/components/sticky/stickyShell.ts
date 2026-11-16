/**
 * The desktop shell's half of sticky notes (src-tauri/src/sticky.rs;
 * docs/STICKY_NOTES.md): the URL a sticky window is opened at, the note key
 * the shell files its place under, and the commands. None of them carries a
 * word of a note — a slot, a key, a pin, a side.
 *
 * The windows are the stream pop-outs' kind (components/streamOsWindows.ts
 * has the mechanism): `window.open("about:blank#puca-sticky-<slot>")` from the
 * main page, answered by the shell with a real window this realm scripts.
 */
import { invoke } from '@tauri-apps/api/core';
import { isMobile, isTauri } from '../../api/platform';
import type { KeyBinding } from '../settingsStore';

/** Must equal `MAX_STICKIES` in src-tauri/src/sticky.rs. */
export const MAX_STICKY_WINDOWS = 24;

export function stickyWindowUrl(slot: number): string {
    return `about:blank#puca-sticky-${slot}`;
}

export function stickyWindowName(slot: number): string {
    return `puca-sticky-${slot}`;
}

/**
 * The place the shell files a note's window under: the account, then the
 * note. A note made offline has a negative id until it is saved (the
 * outbox's temporary id) and goes as `temp:`; a new sticky note nothing has
 * been typed in yet as `new:`. Null for anything else.
 */
export function stickyPlace(userId: number | null, key: string): string | null {
    if (!userId || !Number.isSafeInteger(userId) || userId <= 0) return null;
    const m = /^(list|channel|new):(-?\d+)$/.exec(key);
    if (!m) return null;
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n === 0) return null;
    if (m[1] === 'list' && n < 0) return `${userId}/temp:${-n}`;
    if (n < 0) return null;
    return `${userId}/${m[1]}:${n}`;
}

// --- Is this engine here? ---------------------------------------------------

let support: 'unknown' | 'yes' | 'no' = 'unknown';
let probe: Promise<boolean> | null = null;

/** Ask the shell once whether it has sticky windows. An older shell has no
 *  such command and answers an error: no sticky notes there. */
export function primeStickySupport(): Promise<boolean> {
    if (probe) return probe;
    if (!isTauri() || isMobile()) {
        support = 'no';
        probe = Promise.resolve(false);
        return probe;
    }
    probe = invoke<boolean>('sticky_supported').then(
        ok => { support = ok === true ? 'yes' : 'no'; return support === 'yes'; },
        () => { support = 'no'; return false; },
    );
    return probe;
}

export function stickySupported(): boolean {
    return support === 'yes';
}

export function __resetStickyShellForTests(): void {
    support = 'unknown';
    probe = null;
    closing.clear();
}

// --- Windows ----------------------------------------------------------------

export function openStickyWindow(slot: number): Window | null {
    try {
        return window.open(stickyWindowUrl(slot), stickyWindowName(slot));
    } catch {
        return null;
    }
}

const closing = new Map<number, Promise<void>>();

/** Close a sticky window through the shell (never `window.close()`: wry
 *  destroys only the webview's container then — popout.rs). Resolves once the
 *  slot is free; until then a window.open for it is refused. */
export function closeStickyWindow(slot: number, fallback: Window | null): Promise<void> {
    return invoke('sticky_close', { slot }).then(() => undefined, () => {
        try { fallback?.close(); } catch { /* already gone */ }
    });
}

/** Record that `slot` is being freed until `done` settles — synchronously,
 *  in the closing window's cleanup, so a window mounting for the same slot
 *  in the same commit waits for it (streamOsWindows.ts noteSlotClosing). */
export function noteStickySlotClosing(slot: number, done: Promise<void>): void {
    const p = done.then(() => undefined, () => undefined);
    closing.set(slot, p);
    void p.then(() => { if (closing.get(slot) === p) closing.delete(slot); });
}

/** The pending close of `slot`, if one is still in flight. */
export function stickySlotClosing(slot: number): Promise<void> | undefined {
    return closing.get(slot);
}

export const stickyShell = {
    bind: (slot: number, place: string, focus: boolean) => invoke('sticky_bind', { slot, place, focus }),
    rekey: (slot: number, place: string) => invoke('sticky_rekey', { slot, place }),
    /** Read (`onTop` omitted) or set whether the note stays on top. */
    pin: async (slot: number, onTop?: boolean): Promise<boolean> => {
        const args: Record<string, unknown> = { slot };
        if (typeof onTop === 'boolean') args.onTop = onTop;
        return (await invoke<boolean>('sticky_pin', args)) === true;
    },
    drag: (slot: number) => invoke('sticky_drag', { slot }),
    raise: (slot: number) => invoke('sticky_raise', { slot }),
    dock: async (slot: number, side: 'left' | 'right' | null): Promise<'left' | 'right' | null> => {
        const r = await invoke<string | null>('sticky_dock', { slot, side });
        return r === 'left' || r === 'right' ? r : null;
    },
    dockState: async (slot: number): Promise<'left' | 'right' | null> => {
        const r = await invoke<string | null>('sticky_dock_state', { slot });
        return r === 'left' || r === 'right' ? r : null;
    },
    setVisible: (visible: boolean) => invoke('sticky_set_visible', { visible }),
    forget: (place: string) => invoke('sticky_forget', { place }),
};

/**
 * Register the global "new sticky note" shortcut (null releases it). Answers
 * null when it is registered, or why it is not: 'taken' when Windows or
 * another app already holds the combination.
 */
export async function setStickyHotkey(binding: KeyBinding | null): Promise<string | null> {
    if (!stickySupported()) return null;
    try {
        await invoke('sticky_hotkey', {
            binding: binding ? {
                keyCode: binding.keyCode, ctrl: binding.ctrl, alt: binding.alt, shift: binding.shift, win: binding.win === true,
            } : null,
        });
        return null;
    } catch (e) {
        return typeof e === 'string' ? e : e instanceof Error ? e.message : 'refused';
    }
}

/** Bring Púca's own window up (from a sticky note's Open in Notes). */
export function showMainWindow(): void {
    if (!stickySupported()) return;
    void invoke('sticky_show_main').catch(() => { /* an older shell: the view still opens */ });
}

/** The event the shell sends when the shortcut or the tray asks for a new
 *  sticky note (sticky.rs EVENT_NEW_NOTE). */
export const STICKY_NEW_NOTE_EVENT = 'sticky://new-note';

/** A sticky window's close was requested — the person closed it (Alt+F4) —
 *  with its slot (sticky.rs EVENT_CLOSED). A window the shell destroys
 *  itself (a reload, quitting) sends none. */
export const STICKY_CLOSED_EVENT = 'sticky://closed';

/** A binding as Settings shows it, the Windows key included. */
export function stickyHotkeyLabel(k: KeyBinding | null | undefined): string {
    if (!k) return 'None';
    return [k.ctrl && 'Ctrl', k.alt && 'Alt', k.win && 'Win', k.shift && 'Shift', k.label].filter(Boolean).join(' + ');
}
