/**
 * The flag Púca's sign-out reads (api/notesCacheScrub.ts) must follow the
 * truth both ways: set the moment a colour changes, and CLEARED once the
 * change lands — including when the status was 'synced' before and after,
 * which a status-driven effect never noticed (Púca's sign-out then asked
 * about changes that had long since synced).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 7 }));
const server = vi.hoisted(() => ({ rev: 0, blob: null as string | null }));
vi.mock('../api/sealedBlobs', () => ({
    getSealedBlob: async () => ({ kind: 'ok', doc: { rev: server.rev, blob: server.blob } }),
    putSealedBlob: async (_name: string, expected: number, blob: string) => {
        if (expected !== server.rev) return { kind: 'conflict', current: { rev: server.rev, blob: server.blob } };
        server.rev += 1;
        server.blob = blob;
        return { kind: 'written', rev: server.rev };
    },
}));
vi.mock('../api/e2ee', async (orig) => {
    const real = await orig<typeof import('../api/e2ee')>();
    const id = real.makeIdentity(new Uint8Array(32).fill(4));
    return { ...real, getActiveIdentity: () => id };
});

import { NOTES_UNSYNCED_PREFIX, notesSignOutWarning, readNotesUnsynced, writeNotesUnsynced } from '../api/notesCacheScrub';
import { flushNotesPrefs, useNotesPrefsUnsyncedFlag, useNotesUnsyncedFlag } from '../notes/model/notesPrefsSync';
import { invalidateNotesPrefs, setNoteColor } from '../notes/model/notesPrefs';

const store: Record<string, string> = {};
const FLAG = `${NOTES_UNSYNCED_PREFIX}7`;

function Probe() {
    useNotesUnsyncedFlag(0);
    return null;
}

/** Púca's half: it writes colours and labels too, but has no outbox. */
function PucaProbe() {
    useNotesPrefsUnsyncedFlag();
    return null;
}

let root: Root | null = null;
beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
    server.rev = 0;
    server.blob = null;
    invalidateNotesPrefs();
});
afterEach(() => { act(() => root?.unmount()); root = null; });

describe('the unsynced flag for Púca’s sign-out', () => {
    it('is set by a colour change and cleared when it lands, even when the status stays "synced"', async () => {
        const host = document.createElement('div');
        root = createRoot(host);
        act(() => { root!.render(<Probe />); });
        expect(store[FLAG]).toBeUndefined();                   // nothing to lose yet

        act(() => { setNoteColor('list:1', 'mint'); });
        expect(JSON.parse(store[FLAG])).toEqual({ ops: 0, prefs: true });
        await act(async () => { expect(await flushNotesPrefs()).toBe(false); });   // first sync: idle -> synced
        expect(store[FLAG]).toBeUndefined();

        act(() => { setNoteColor('list:1', 'dusk'); });
        expect(JSON.parse(store[FLAG]).prefs).toBe(true);
        await act(async () => { expect(await flushNotesPrefs()).toBe(false); });   // synced -> synced
        expect(store[FLAG]).toBeUndefined();
        expect(server.rev).toBe(2);                             // positive control: it really went up
    });

    it('is published by PÚCA too — without erasing the queued edits Notes recorded', async () => {
        // Notes, in the other tab, has two edits made offline. Púca has no
        // outbox of its own and must leave that count exactly where it is.
        writeNotesUnsynced(7, { ops: 2, prefs: false });
        const host = document.createElement('div');
        root = createRoot(host);
        act(() => { root!.render(<PucaProbe />); });
        expect(JSON.parse(store[FLAG])).toEqual({ ops: 2, prefs: false });

        act(() => { setNoteColor('list:1', 'mint'); });
        expect(JSON.parse(store[FLAG]), 'Púca’s own unsent colour is published').toEqual({ ops: 2, prefs: true });
        expect(notesSignOutWarning(readNotesUnsynced(7)), 'and Púca’s sign-out asks about both')
            .toMatch(/2 changes made offline and colours, labels or archive changes/);

        await act(async () => { expect(await flushNotesPrefs()).toBe(false); });
        expect(JSON.parse(store[FLAG]), 'the colour landed; the queued edits are untouched').toEqual({ ops: 2, prefs: false });
        expect(server.rev, 'positive control: it really went up').toBe(1);
    });
});
