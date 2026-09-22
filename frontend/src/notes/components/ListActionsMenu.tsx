/**
 * "Uncheck all" and "Delete checked" — what a weekly shopping list needs to
 * start again, in the open note's foot.
 *
 * There is no third action. Ticked items are ALWAYS at the bottom, in their
 * own Completed section (TaskTree.tsx), and the server orders them that way
 * too (`ORDER BY is_completed ASC`), so there is no "move checked to bottom"
 * to build — they cannot be anywhere else.
 *
 * Driven by the editor's LIVE items, not by the card's snapshot: `card.tasks`
 * is stale relative to the editor's own query, and acting on a stale list is
 * how you delete something a person just un-ticked on another device.
 *
 * Both actions are fan-outs of writes that already exist — a timing PATCH per
 * untick, one delete per checked branch — so there is no new route and the
 * server sees exactly the requests it already sees when someone ticks and
 * deletes by hand. What IS new is the burst, and docs/NOTES.md says so rather
 * than claiming nothing changed: a run of unticks inside a second is a
 * recognisable "this list was reset", and its size says how many items were
 * done. They run ONE AT A TIME with a pause between them (icsImport's
 * PACE_MS, well under the limiter's 50/s). Sequential rather than concurrent
 * on purpose: unticking must go parents-first, because un-completing a parent
 * reopens its ancestors, and a concurrency bound gives up exactly that
 * guarantee for a list rarely longer than a screen.
 *
 * Both are refused while offline or while anything waits in the outbox — the
 * same rule, and the same reason, as "Show checkboxes": a hundred ops that
 * replay later is not what "uncheck all" looked like when it was tapped.
 *
 * Personal notes only. A channel checklist broadcasts a refetch to every
 * member per write, which is why icsImport refuses bulk there too.
 */
import { useEffect, useRef, useState } from 'react';
import { type Task, collectSubtreeIds, isAttachmentsLocked, parseTaskAttachments } from '../../api/tasks';
import { CheckboxIcon, TrashIcon } from '../../components/Icons';
import { pushMessageToast } from '../../components/messageToastBus';
import { deleteFiles } from '../../api/listContent';
import { fileIdsOf } from '../../api/noteMedia';
import { PACE_MS } from '../../api/icsImport';
import { type NoteActions } from '../model/notesQueries';
import { type NoteRef } from '../model/notesModel';
import { pendingOutboxCount } from '../model/notesOutbox';
import { recreationOrder } from '../model/noteContent';
import { checkedCount, checkedRoots, deadSeriesAmong, describeUncheckWarning, uncheckOrder } from '../model/noteItemBulk';
import { Popover } from '../../components/notes/Popover';
import { UndoBar } from './UndoBar';

const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms); });

/** An item's attachment refs, when this device can read them. */
function attachmentsOf(t: Task) {
    return t.attachments && !isAttachmentsLocked(t.attachments) ? parseTaskAttachments(t.attachments) : [];
}

/** `commit` runs when the Undo can no longer happen. */
type Undo = { token: number; message: string; run: () => Promise<void>; commit?: () => void };
let undoSeq = 0;

interface Props {
    note: NoteRef;
    actions: NoteActions;
    /** The editor's LIVE items. */
    tasks: Task[];
}

export function ListActionsMenu({ note, actions, tasks }: Props) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const [busy, setBusy] = useState(false);
    const [undo, setUndoState] = useState<Undo | null>(null);
    const undoRef = useRef<Undo | null>(null);
    // The items as they are NOW: read after a run, and by a commit that fires
    // long after the click. Written in an effect — refs are not for render.
    const tasksRef = useRef(tasks);
    useEffect(() => { tasksRef.current = tasks; });
    const setUndo = (next: Undo | null, committed = true) => {
        const prev = undoRef.current;
        undoRef.current = next;
        setUndoState(next);
        if (prev && prev !== next && committed) prev.commit?.();
    };
    // Closing the note ends the Undo too.
    useEffect(() => () => { undoRef.current?.commit?.(); undoRef.current = null; }, []);

    /** Wait for the effect-written `tasksRef` to stop changing, so a count
     *  taken from it reflects the writes just made. Bounded: a ref that never
     *  settles must leave the button working, not hang it. A fixed delay
     *  would be a guess that goes wrong exactly when the machine is busy. */
    const settled = async () => {
        for (let i = 0; i < 25; i++) {
            const before = tasksRef.current;
            await sleep(20);
            if (tasksRef.current === before) return;
        }
    };

    const done = checkedCount(tasks);
    if (note.kind !== 'list') return null;

    const close = () => setAnchor(null);

    /** Neither action may half-apply into the offline queue. */
    const refusedOffline = (): boolean => {
        if (navigator.onLine && pendingOutboxCount() === 0) return false;
        pushMessageToast({ title: 'Can’t change the whole list while offline or while changes are waiting to sync — try again once they have' });
        return true;
    };

    const uncheckAll = async () => {
        close();
        if (refusedOffline()) return;
        const order = uncheckOrder(tasks);
        if (order.length === 0) return;
        const warning = describeUncheckWarning(deadSeriesAmong(order));
        if (warning && !window.confirm(warning)) return;
        // Only the top of each completed branch is re-ticked by the Undo:
        // completing a parent completes its subtree.
        const roots = checkedRoots(tasks);
        setBusy(true);
        try {
            for (let i = 0; i < order.length; i++) {
                if (i > 0) await sleep(PACE_MS);
                await actions.toggleTask(note, order[i], false);
            }
            // toggleTask reports a refusal by rolling the item BACK, not by
            // throwing, so the honest count is what is still ticked once the
            // last rollback has landed — not a guess made per call.
            await settled();
        } finally {
            setBusy(false);
        }
        const stuck = checkedCount(tasksRef.current);
        if (stuck > 0) pushMessageToast({ title: `Couldn’t untick ${stuck} of ${order.length} items` });
        if (stuck >= order.length) return;
        setUndo({
            token: ++undoSeq,
            message: order.length === 1 ? 'Unticked 1 item' : `Unticked ${order.length} items`,
            run: async () => {
                for (let i = 0; i < roots.length; i++) {
                    if (i > 0) await sleep(PACE_MS);
                    const live = tasksRef.current.find(t => t.id === roots[i].id);
                    if (live && !live.is_completed) await actions.toggleTask(note, live, true);
                }
            },
        });
    };

    const deleteChecked = async () => {
        close();
        if (refusedOffline()) return;
        const roots = checkedRoots(tasks);
        if (roots.length === 0) return;
        // Deleting a branch takes its subtree on the server, so only the tops
        // are named — but everything under them goes, and the Undo owes all
        // of it back.
        const swept = new Set<number>();
        for (const r of roots) for (const id of collectSubtreeIds(tasks, r.id)) swept.add(id);
        if (!window.confirm(swept.size === 1
            ? 'Delete the ticked item? Undo brings it back.'
            : `Delete ${swept.size} ticked items? Undo brings them back with their dates, repeats and pictures.`)) return;
        setBusy(true);
        const gone = new Set<number>();
        // Counted directly, per REQUEST: `gone` holds swept subtree ids and
        // `roots` holds branch tops, so subtracting one from the other is not
        // a count of anything — and goes negative the moment a branch with
        // children succeeds beside a lone item that fails.
        let failed = 0;
        try {
            for (let i = 0; i < roots.length; i++) {
                if (i > 0) await sleep(PACE_MS);
                if (await actions.deleteTaskFrom(note, roots[i].id)) {
                    for (const id of collectSubtreeIds(tasks, roots[i].id)) gone.add(id);
                } else {
                    failed++;
                }
            }
        } finally {
            setBusy(false);
        }
        // Parents before children, so the Undo re-creates them in an order
        // that can carry the nesting.
        const left = recreationOrder(tasks).filter(t => gone.has(t.id));
        if (failed > 0) {
            pushMessageToast({ title: `Couldn’t delete ${failed} of ${roots.length} items` });
        }
        if (left.length === 0) return;
        // Their uploads: kept while Undo is offered, deleted after it — and
        // never one a live item names by then.
        const orphaned = fileIdsOf(left.flatMap(attachmentsOf));
        setUndo({
            token: ++undoSeq,
            message: left.length === 1 ? 'Deleted 1 ticked item' : `Deleted ${left.length} ticked items`,
            run: async () => {
                const idMap = new Map<number, number>();
                for (const t of left) {
                    // Where it goes back: under its re-created parent when
                    // the parent went too, otherwise under the SAME parent it
                    // had, which is still there. A completed item under an
                    // OPEN parent is a checked root of its own
                    // (noteItemBulk.checkedRoots), so that parent is never
                    // deleted and never enters this map — the map alone would
                    // put the item back at the top level and lose the nesting.
                    const stillThere = t.parent_id !== null && tasksRef.current.some(x => x.id === t.parent_id);
                    const parent = t.parent_id === null
                        ? undefined
                        : (idMap.get(t.parent_id) ?? (stillThere ? t.parent_id : undefined));
                    const made = await actions.addTask(note, t.description, parent);
                    if (!made) continue;
                    idMap.set(t.id, made.id);
                    if (t.schedule) await actions.setSchedule(note, made, t.schedule, t.due_at);
                    else if (t.due_at) await actions.setDue(note, made, t.due_at);
                    if (t.attachments && !isAttachmentsLocked(t.attachments)) {
                        await actions.setAttachments(note, made, parseTaskAttachments(t.attachments));
                    }
                    // Completing a parent completes its subtree, so only the
                    // top of each completed branch is toggled.
                    const parentDone = t.parent_id !== null && left.find(p => p.id === t.parent_id)?.is_completed;
                    if (t.is_completed && !parentDone) await actions.toggleTask(note, made, true);
                }
            },
            commit: orphaned.length > 0 ? () => {
                const named = new Set(fileIdsOf(tasksRef.current.flatMap(attachmentsOf)));
                const unused = orphaned.filter(id => !named.has(id));
                if (unused.length > 0) void deleteFiles(unused);
            } : undefined,
        });
    };

    return (
        <>
            {done > 0 && (
                <button
                    type="button"
                    className="notes-iconbtn"
                    aria-label="List actions"
                    title="List actions"
                    disabled={busy}
                    onClick={e => setAnchor(e.currentTarget)}
                >
                    <CheckboxIcon />
                </button>
            )}
            {anchor && (
                <Popover anchor={anchor} onClose={close} label="List actions">
                    <div className="notes-list-actions">
                        <button type="button" onClick={() => void uncheckAll()}>
                            <CheckboxIcon /> Uncheck all ({done})
                        </button>
                        <button type="button" className="danger" onClick={() => void deleteChecked()}>
                            <TrashIcon /> Delete checked ({done})
                        </button>
                    </div>
                </Popover>
            )}
            {undo && (
                <UndoBar
                    token={undo.token}
                    message={undo.message}
                    onUndo={() => { const u = undo; setUndo(null, false); void u.run(); }}
                    onExpire={() => setUndo(null)}
                />
            )}
        </>
    );
}
