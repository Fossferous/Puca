/**
 * Sticky notes on the desktop (docs/STICKY_NOTES.md): one shell window per
 * note out on the desktop, each an `about:blank` document this page draws the
 * note into. Rendered by NotesShell inside the desktop app's Notes
 * (NotesDesktopView), so it works with Notes' own cards and actions — the
 * same cache, live updates, offline queue and conflict-checked saves as the
 * note on the grid.
 *
 * Which notes are out is stickyStore.ts. This draws them:
 *  - a window per entry, in a SLOT (stickyShell.ts); a slot is kept while
 *    its entry lives, so the window stays put through a note's key changing
 *    (a draft saved, an offline note synced);
 *  - opening: bind the slot to the note, then window.open — the shell
 *    refuses a slot nothing is bound to; a slot freed in the same change is
 *    opened once the shell has destroyed its old window;
 *  - the PERSON closing it (Alt+F4) is a close request the shell reports
 *    (sticky://closed): the note leaves the desktop. A window that just goes
 *    (pagehide with no request: the shell destroying it as the page reloads
 *    or Púca quits) leaves the screen but stays in the stored set, so it
 *    comes back at the next start;
 *  - the APP closing it (X, Ctrl+W, a deleted note, sign-out) unmounts it,
 *    and the shell destroys the window;
 *  - a note Notes does not have gets no window — not before Notes has read
 *    it (an empty page there would make a NEW note when typed into), and not
 *    once it has gone; it leaves the stored set only when fresh fetches by
 *    this page, a minute apart, have all gone without it (Notes' own prune
 *    rule, notesPrune.ts): one look at a half-loaded or cached view must not
 *    take a note off the desktop for good.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { LayerOnScreenContext, PortalTargetContext } from '../portalTarget';
import { assignSlots, sameSlots } from '../streamOsWindows';
import { loadSettings, saveSettings } from '../settingsStore';
import { currentUserIdFromToken } from '../../api/auth';
import { type NoteCard, type NoteRef, noteKey } from '../../notes/model/notesModel';
import type { NoteActions } from '../../notes/model/notesQueries';
import { type PruneGens, newPruneState, pruneStep } from '../../notes/model/notesPrune';
import { anythingQueued } from '../../notes/model/noteBusy';
import {
    MAX_STICKY_WINDOWS, STICKY_CLOSED_EVENT, closeStickyWindow, openStickyWindow, stickyPlace, stickyShell, stickySlotClosing,
} from './stickyShell';
import {
    type StickyEntry, attachAccount, attachLayer, closeSticky, detachAccount, forgetStickies, promoteMade, rekeySticky,
    requestNewSticky, stickyEntries, stickyNoteKeys, stickyWindowGone, subscribeStickies,
} from './stickyStore';
import { type StickyKeys, prepareStickyWindow } from './stickyDocument';
import { StickyNoteView } from './StickyNoteView';
import './StickyNotes.css';

export interface StickyNotesLayerProps {
    /** Every note Notes has (not the grid's filtered view). */
    cards: NoteCard[];
    /** Every kind of note has been read with no error (NotesShell). */
    ready: boolean;
    /** When each kind was last fetched (notesPrune.ts). */
    gens: PruneGens;
    actions: NoteActions;
    /** Show Púca Notes (the main window) — at a note, or with search ready. */
    openInNotes: (key: string | null, search: boolean) => void;
}

function useStickySettings(): { reopen: boolean; confirmDelete: boolean } {
    const read = () => {
        const s = loadSettings();
        return { reopen: s.stickyReopen !== false, confirmDelete: s.stickyConfirmDelete !== false };
    };
    const [value, setValue] = useState(read);
    useEffect(() => {
        const on = () => setValue(read());
        window.addEventListener('settingsChanged', on);
        return () => window.removeEventListener('settingsChanged', on);
    }, []);
    return value;
}

export function StickyNotesLayer({ cards, ready, gens, actions, openInNotes }: StickyNotesLayerProps) {
    const entries = useSyncExternalStore(subscribeStickies, stickyEntries, stickyEntries);
    const settings = useStickySettings();
    const userId = currentUserIdFromToken() ?? null;

    // This account's notes come back (or not, per the setting) when the
    // layer first draws; a request made before it existed is made now.
    const reopenRef = useRef(settings.reopen);
    useEffect(() => {
        if (userId === null) return;
        attachAccount(userId, reopenRef.current);
        const detachLayer = attachLayer();
        return () => { detachLayer(); detachAccount(); };
    }, [userId]);

    // A note this window made is an ordinary one as soon as Notes has it; a
    // note Notes has gone without, across fresh complete fetches a minute
    // apart, leaves the stored set (its window went the moment it was not
    // there). Never while edits are queued: the server's set is behind then.
    const prune = useRef(newPruneState());
    const { list, channel, channelOldest } = gens;
    useEffect(() => {
        const present = new Set(cards.map(c => c.key));
        promoteMade(key => present.has(key));
        if (!ready || anythingQueued()) return;
        const gone = pruneStep(prune.current, { list, channel, channelOldest }, Date.now(), present, stickyNoteKeys());
        if (gone.length > 0) forgetStickies(gone);
    }, [cards, ready, list, channel, channelOldest]);

    const [slots, setSlots] = useState<Map<number, number>>(() => new Map());
    const wids = entries.map(e => e.wid);
    const next = assignSlots(slots, wids, MAX_STICKY_WINDOWS);
    if (!sameSlots(next, slots)) setSlots(next);
    // Past the cap: not out on the desktop after all.
    const unplaced = wids.filter(w => !next.has(w)).join(',');
    useEffect(() => {
        if (!unplaced) return;
        for (const w of unplaced.split(',')) closeSticky(Number(w));
    }, [unplaced]);

    // The person closed a window (Alt+F4): that note leaves the desktop.
    const slotsRef = useRef(next);
    useEffect(() => { slotsRef.current = next; });
    useEffect(() => {
        let live = true;
        let off: (() => void) | null = null;
        void import('@tauri-apps/api/event').then(async ({ listen }) => {
            const un = await listen<number>(STICKY_CLOSED_EVENT, e => {
                for (const [wid, slot] of slotsRef.current) if (slot === e.payload) closeSticky(wid);
            });
            if (live) off = un;
            else un();
        }).catch(err => console.warn('[sticky] could not listen for closed windows:', err));
        return () => {
            live = false;
            try { off?.(); } catch { /* the shell is going with the page */ }
        };
    }, []);

    const cardsByKey = new Map(cards.map(c => [c.key, c]));
    // A note's window opens once Notes has the note: drawn before that, it
    // would be an empty page that typing into would make a NEW note.
    const order = entries.filter(e => next.has(e.wid) && (e.state !== 'note' || cardsByKey.has(e.key)));
    const cycle = useCallback((wid: number, dir: 1 | -1) => {
        const list = stickyEntries();
        const at = list.findIndex(e => e.wid === wid);
        if (at < 0 || list.length < 2) return;
        const to = list[(at + dir + list.length) % list.length];
        const slot = next.get(to.wid);
        if (slot !== undefined) void stickyShell.raise(slot).catch(() => { /* gone meanwhile */ });
    }, [next]);

    if (userId === null) return null;
    return (
        <>
            {order.map(e => (
                <StickyWindow
                    key={e.wid}
                    entry={e}
                    slot={next.get(e.wid)!}
                    userId={userId}
                    card={cardsByKey.get(e.key) ?? null}
                    actions={actions}
                    confirmDelete={settings.confirmDelete}
                    openInNotes={openInNotes}
                    onCycle={cycle}
                />
            ))}
        </>
    );
}

interface StickyWindowProps {
    entry: StickyEntry;
    slot: number;
    userId: number;
    card: NoteCard | null;
    actions: NoteActions;
    confirmDelete: boolean;
    openInNotes: StickyNotesLayerProps['openInNotes'];
    onCycle: (wid: number, dir: 1 | -1) => void;
}

function StickyWindow({ entry, slot, userId, card, actions, confirmDelete, openInNotes, onCycle }: StickyWindowProps) {
    const [win, setWin] = useState<Window | null>(null);
    const [onTop, setOnTop] = useState(false);
    const [docked, setDocked] = useState<'left' | 'right' | null>(null);
    const place = stickyPlace(userId, entry.key);
    const live = useRef({ entry, place, card, openInNotes, onCycle });
    useEffect(() => { live.current = { entry, place, card, openInNotes, onCycle }; });
    // Opened once per mounted window; StrictMode's second effect reuses it.
    const openedRef = useRef<{ w: Window | null } | null>(null);
    const aliveRef = useRef(true);
    // The place the shell last heard for this slot, to tell it of a change.
    const boundPlace = useRef<string | null>(null);

    const keys = useCallback((): StickyKeys => ({
        newNote: () => requestNewSticky(),
        close: () => closeSticky(live.current.entry.wid),
        openNotes: search => {
            const c = live.current.card;
            live.current.openInNotes(search || !c ? null : c.key, search);
        },
        cycle: dir => live.current.onCycle(live.current.entry.wid, dir),
    }), []);

    useEffect(() => {
        let cancelled = false;
        let detach: (() => void) | null = null;
        const attach = (w: Window) => {
            let gone = false;
            // The window went. Whether the PERSON closed it is the shell's
            // close request (sticky://closed, above); this only takes it off
            // the screen here.
            const windowWent = () => {
                if (gone) return;
                gone = true;
                stickyWindowGone(live.current.entry.wid);
            };
            w.addEventListener('pagehide', windowWent);
            const poll = window.setInterval(() => { if (w.closed) windowWent(); }, 1000);
            const undress = prepareStickyWindow(w, keys);
            setWin(w);
            detach = () => {
                w.removeEventListener('pagehide', windowWent);
                window.clearInterval(poll);
                undress();
            };
        };
        if (openedRef.current) {
            if (openedRef.current.w) attach(openedRef.current.w);
            return () => { cancelled = true; detach?.(); };
        }
        void (async () => {
            await stickySlotClosing(slot);
            const p = live.current.place;
            if (cancelled || openedRef.current) return;
            if (!p) { closeSticky(live.current.entry.wid); return; }
            try {
                await stickyShell.bind(slot, p, live.current.entry.focus);
            } catch {
                if (!cancelled) closeSticky(live.current.entry.wid);
                return;
            }
            if (cancelled || openedRef.current) return;
            boundPlace.current = p;
            const w = openStickyWindow(slot);
            openedRef.current = { w };
            if (!w) { closeSticky(live.current.entry.wid); return; }
            attach(w);
            stickyShell.pin(slot).then(v => { if (!cancelled) setOnTop(v); }, () => { /* keep off */ });
            stickyShell.dockState(slot).then(v => { if (!cancelled) setDocked(v); }, () => { /* not docked */ });
        })();
        return () => { cancelled = true; detach?.(); };
    }, [slot, keys]);

    // The window goes with the component (X, Ctrl+W, a deleted note, sign
    // out), through the shell, and the slot is free once it is destroyed.
    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
            queueMicrotask(() => {
                if (aliveRef.current) return; // StrictMode's pretend unmount
                const w = openedRef.current?.w ?? null;
                if (w) void closeStickyWindow(slot, w);
            });
        };
    }, [slot]);

    // A draft saved, an offline note synced: the same window, the new key.
    useEffect(() => {
        if (!win || !place || boundPlace.current === null || boundPlace.current === place) return;
        boundPlace.current = place;
        void stickyShell.rekey(slot, place).catch(() => { /* geometry only */ });
    }, [win, place, slot]);

    if (!win) return null;
    const onCreated = (ref: NoteRef) => rekeySticky(entry.wid, noteKey(ref));
    return createPortal(
        <PortalTargetContext.Provider value={win.document.body}>
            <LayerOnScreenContext.Provider value>
                <StickyNoteView
                    card={card}
                    actions={actions}
                    doc={win.document}
                    onTop={onTop}
                    onTogglePin={() => {
                        const want = !onTop;
                        setOnTop(want);
                        stickyShell.pin(slot, want).then(setOnTop, () => setOnTop(!want));
                    }}
                    docked={docked}
                    onDock={side => { stickyShell.dock(slot, side).then(setDocked, () => { /* stays as it was */ }); }}
                    onDrag={() => { void stickyShell.drag(slot).catch(() => { /* the press ended first */ }); }}
                    onNew={() => requestNewSticky()}
                    onClose={() => closeSticky(entry.wid)}
                    confirmDelete={confirmDelete}
                    onDontAskAgain={() => saveSettings({ ...loadSettings(), stickyConfirmDelete: false })}
                    onDeleted={() => {
                        if (place) void stickyShell.forget(place).catch(() => { /* geometry only */ });
                        closeSticky(entry.wid);
                    }}
                    onCreated={onCreated}
                    onOpenInNotes={() => { if (card) openInNotes(card.key, false); }}
                />
            </LayerOnScreenContext.Provider>
        </PortalTargetContext.Provider>,
        win.document.body,
    );
}
