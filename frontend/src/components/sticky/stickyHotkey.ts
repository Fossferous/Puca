/**
 * The global "new sticky note" shortcut (docs/STICKY_NOTES.md), as the page
 * holds it: what Settings asks for, what the shell has actually registered,
 * and why not when it has not. The shell registers a real Windows hot key
 * (src-tauri/src/sticky.rs), so "set" is not "works" — Windows refuses a
 * combination another app holds, and Settings says so from `status`.
 *
 * Registered only while Púca is signed in (Chat enables it), and released
 * while Settings is capturing a new combination, so pressing the current one
 * to replace it does not also make a note.
 *
 * Calls to the shell go one at a time, in order: each registration is a new
 * shell thread, and two racing would leave the older one registered.
 */
import { useSyncExternalStore } from 'react';
import type { KeyBinding } from '../settingsStore';
import { setStickyHotkey, stickySupported } from './stickyShell';

export type StickyHotkeyStatus =
    | { state: 'off' }
    | { state: 'on'; binding: KeyBinding }
    | { state: 'taken'; binding: KeyBinding }
    | { state: 'refused'; binding: KeyBinding; why: string };

let wanted: KeyBinding | null = null;
let enabled = false;
let suspended = false;
let status: StickyHotkeyStatus = { state: 'off' };
/** What the shell was last told (undefined: nothing yet), so an ask that
 *  changes nothing — signing in with the shortcut already asked for — does
 *  not restart the shell's thread for the same key. */
let applied: KeyBinding | null | undefined;
let queue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function emit(): void {
    for (const l of listeners) l();
}

function sameBinding(a: KeyBinding | null, b: KeyBinding | null): boolean {
    if (!a || !b) return a === b;
    return a.keyCode === b.keyCode && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && (a.win === true) === (b.win === true);
}

function sync(): Promise<void> {
    queue = queue.then(async () => {
        const want = enabled && !suspended ? wanted : null;
        if (!stickySupported()) { status = { state: 'off' }; emit(); return; }
        if (applied !== undefined && sameBinding(applied, want)) return;
        applied = want;
        const err = await setStickyHotkey(want);
        // A newer ask already queued behind this one decides the status.
        if (!want) status = { state: 'off' };
        else if (err === null) status = { state: 'on', binding: want };
        else if (err === 'taken') status = { state: 'taken', binding: want };
        else status = { state: 'refused', binding: want, why: err };
        // Refused: the next ask tries again (the other app may have let go).
        if (err !== null) applied = undefined;
        emit();
    });
    return queue;
}

/** Signed in (Chat) or not: the shortcut exists only while an account does. */
export function enableStickyHotkey(on: boolean): Promise<void> {
    if (enabled === on) return queue;
    enabled = on;
    return sync();
}

/** What Settings asks for (null = no shortcut). */
export function wantStickyHotkey(binding: KeyBinding | null): Promise<void> {
    // The same one again is nothing to do — unless Windows refused it, when
    // asking again (Reset, a save) is the way to try it again.
    const refused = status.state === 'taken' || status.state === 'refused';
    if (sameBinding(wanted, binding) && !refused) return queue;
    wanted = binding;
    return sync();
}

/** Settings is capturing a combination: let go of the current one meanwhile. */
export function suspendStickyHotkey(on: boolean): Promise<void> {
    if (suspended === on) return queue;
    suspended = on;
    return sync();
}

export function stickyHotkeyStatus(): StickyHotkeyStatus {
    return status;
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

export function useStickyHotkeyStatus(): StickyHotkeyStatus {
    return useSyncExternalStore(subscribe, stickyHotkeyStatus, stickyHotkeyStatus);
}

export function __resetStickyHotkeyForTests(): void {
    wanted = null;
    enabled = false;
    suspended = false;
    status = { state: 'off' };
    applied = undefined;
    queue = Promise.resolve();
    listeners.clear();
}
