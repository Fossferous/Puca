/**
 * The state behind bulk selection (SelectionBar.tsx has the what and why):
 * which notes are selected, the keyboard and pointer entry points, and the
 * Undo window a bulk delete or archive waits in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isEditableTarget } from '../../api/hotkeys';
import { pushMessageToast } from '../../components/messageToastBus';
import { keepVisible, rangeSelection, toggleInSelection, type NoteCard } from '../model/notesModel';
import { restoreArchived } from '../model/notesBulk';
import { type NoteActions } from '../model/notesQueries';
import { SelectionBar } from './SelectionBar';
import { UndoBar } from './UndoBar';

/** Deletes run this many at a time: quick for twenty notes, gentle on the server. */
export const BULK_DELETE_CONCURRENCY = 3;

/** Run `fn` over `items`, at most `limit` at once; the ones that failed. */
export async function runBounded<T>(items: readonly T[], limit: number, fn: (t: T) => Promise<boolean>): Promise<T[]> {
    const failed: T[] = [];
    let i = 0;
    const worker = async () => {
        while (i < items.length) {
            const item = items[i++];
            let ok = false;
            try { ok = await fn(item); } catch { ok = false; }
            if (!ok) failed.push(item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return failed;
}

export type BulkPending =
    | { kind: 'delete'; cards: NoteCard[]; token: number }
    | { kind: 'archive'; flags: Record<string, boolean>; count: number; token: number };

/**
 * The notes a bulk delete is holding in its Undo window (hidden from the
 * grid until it commits). Called BEFORE the grid's cards are computed.
 */
export function useBulkPending(actions: NoteActions) {
    const [pending, setPending] = useState<BulkPending | null>(null);
    // Notes whose deletes are running: still hidden, so a card does not flash
    // back while it waits its turn behind the concurrency bound.
    const [committing, setCommitting] = useState<ReadonlySet<string>>(() => new Set());
    const ref = useRef<BulkPending | null>(null);
    useEffect(() => { ref.current = pending; }, [pending]);
    const tokens = useRef(0);
    const nextToken = useCallback(() => ++tokens.current, []);
    const commit = useCallback((p: BulkPending | null) => {
        if (!p || p.kind !== 'delete') return;
        const keys = p.cards.map(c => c.key);
        setCommitting(prev => new Set([...prev, ...keys]));
        void runBounded(p.cards, BULK_DELETE_CONCURRENCY, c => actions.deleteNote(c.ref)).then(failed => {
            setCommitting(prev => new Set([...prev].filter(k => !keys.includes(k))));
            if (failed.length > 0) {
                const verb = actions.content.trashEnabled ? 'move' : 'delete';
                pushMessageToast({ title: `Couldn’t ${verb} ${failed.length} of ${p.cards.length} notes${verb === 'move' ? ' to the trash' : ''} — they are back in the grid` });
            }
        });
    }, [actions]);
    // Leaving the shell (sign-out) commits a waiting delete, as a single one does.
    useEffect(() => () => { commit(ref.current); }, [commit]);
    const hiddenKeys = useMemo(
        () => new Set([...(pending?.kind === 'delete' ? pending.cards.map(c => c.key) : []), ...committing]),
        [pending, committing],
    );
    return { pending, setPending, commit, pendingRef: ref, hiddenKeys, nextToken };
}

export type BulkPendingApi = ReturnType<typeof useBulkPending>;

/** Whether a route shows the note grid. Reminders, Trash and Calendar do
 *  not, and bulk selection exists only on the grid: those views fall back to
 *  the "all notes" filter underneath, so a selection there would be of notes
 *  that are not on screen — and its Delete would trash every one of them. */
export function isGridPath(path: string): boolean {
    return path !== '/reminders' && path !== '/trash' && path !== '/calendar';
}

interface SelectionOptions {
    visible: NoteCard[];
    actions: NoteActions;
    labels: string[];
    bulk: BulkPendingApi;
    /** The grid is the view on screen (isGridPath). Off it nothing is
     *  selected, no bar or Undo renders, a selection made on the grid is
     *  dropped, and a bulk delete still waiting out its Undo commits — as
     *  leaving the shell does. */
    grid: boolean;
    /** Keyboard selection (Ctrl/Cmd+A, Esc): on the grid with no note open. */
    enabled: boolean;
}

const NOTHING: ReadonlySet<string> = new Set();

export function useNoteSelection({ visible, actions, labels, bulk, grid, enabled }: SelectionOptions) {
    const [raw, setRaw] = useState<Set<string>>(() => new Set());
    const anchor = useRef<string | null>(null);
    // Leaving the grid drops the selection, so coming back does not revive it.
    const [wasGrid, setWasGrid] = useState(grid);
    if (wasGrid !== grid) {
        setWasGrid(grid);
        if (!grid) setRaw(new Set());
    }
    useEffect(() => { if (!grid) anchor.current = null; }, [grid]);
    // A bulk delete waiting out its Undo is the grid's: leaving commits it (the
    // Undo would otherwise hang, its notes hidden, on a view without it).
    const { commit, setPending, pendingRef } = bulk;
    useEffect(() => {
        if (grid || !pendingRef.current) return;
        const p = pendingRef.current;
        pendingRef.current = null;
        commit(p);
        setPending(null);
    }, [grid, commit, setPending, pendingRef]);
    const visibleKeys = useMemo(() => visible.map(c => c.key), [visible]);
    // Only what is on screen can be selected: a filter change, a search or a
    // note deleted elsewhere quietly drops the rest.
    const selected = useMemo(() => (grid ? keepVisible(raw, visibleKeys) : NOTHING), [grid, raw, visibleKeys]);
    const active = selected.size > 0;
    const keys = grid && enabled;

    const clear = useCallback(() => { setRaw(new Set()); anchor.current = null; }, []);
    const onSelect = useCallback((card: NoteCard, e?: { shiftKey?: boolean }) => {
        setRaw(prev => {
            const cur = keepVisible(prev, visibleKeys);
            return e?.shiftKey ? rangeSelection(cur, visibleKeys, anchor.current, card.key) : toggleInSelection(cur, card.key);
        });
        anchor.current = card.key;
    }, [visibleKeys]);

    useEffect(() => {
        if (!keys) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || isEditableTarget(e.target)) return;
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                setRaw(new Set(visibleKeys));
            } else if (e.key === 'Escape' && active) {
                e.preventDefault();
                clear();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [keys, visibleKeys, active, clear]);

    const cards = useMemo(() => visible.filter(c => selected.has(c.key)), [visible, selected]);
    const bar = active ? (
        <SelectionBar cards={cards} actions={actions} labels={labels} bulk={bulk} onClear={clear} onSelectAll={() => setRaw(new Set(visibleKeys))} allSelected={selected.size === visibleKeys.length} />
    ) : null;
    const undo = grid && bulk.pending ? (
        <UndoBar
            token={bulk.pending.token}
            message={bulk.pending.kind === 'delete'
                ? `${actions.content.trashEnabled ? 'Moving' : 'Deleting'} ${bulk.pending.cards.length} notes${actions.content.trashEnabled ? ' to the trash' : ''}`
                : `Archived ${bulk.pending.count} notes`}
            onUndo={() => {
                const p = bulk.pendingRef.current;
                if (p?.kind === 'archive') restoreArchived(p.flags);
                bulk.setPending(null);
            }}
            onExpire={() => { bulk.commit(bulk.pendingRef.current); bulk.setPending(null); }}
        />
    ) : null;
    return { selected, active, onSelect, clear, bar, undo };
}
