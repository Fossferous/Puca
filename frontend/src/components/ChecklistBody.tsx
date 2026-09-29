/**
 * ChecklistBody — the reusable channel-checklist body (add form + Keep-style
 * TaskTree with optimistic mutations). Extracted so it renders in three places:
 * the side panel (ChecklistPanel), a checklist channel's main content, and each
 * channel section of the server-wide "All checklists" view.
 *
 * All items are E2EE under the channel group key (see api/tasks.ts).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
    type Task, type TaskAttachmentRef,
    listTasks, createTask, updateChannelTask, updateChannelTaskAttachments,
    listListTasks, listIsGone, createListTask, updateListTask, updateListTaskAttachments,
    updateTask, deleteTask, moveTask, reorderTask,
    applyMove, applyReorder, collectSubtreeIds,
    serializeTaskAttachments,
} from '../api/tasks';
import { wsClient, type ServerMessage } from '../api/websocket';
import { pokeTaskReminders } from '../api/taskReminders';
import { planToggle } from '../api/taskCompletion';
import { useTaskFeature } from '../api/taskFeatures';
import { useScheduleSetter, useSnoozeSetter } from './schedule/useScheduleSetter';
import { canEditTask } from '../api/tasks';
import { PERM, hasPerm } from '../api/permissionBits';
import { ApiError } from '../api/client';
import { pushMessageToast } from './messageToastBus';
import { heldOpKey } from '../api/opKey';
import { invalidateTaskScope } from './taskSources';
import { TaskTree } from './TaskTree';
import { usePasteItems } from './usePasteItems';
import { createdWhileReading } from './createdWhileReading';
import { SAVE_WAIT_MS, type WritesInFlight, writesInFlight } from './writesInFlight';
import { MAX_ITEM_LENGTH } from '../notes/model/notesModel';

/** Which checklist a body shows: a channel's, or a personal list's. */
interface Scope { isChannel: boolean; channelId?: number; listId?: number }
const sameScope = (a: Scope, b: Scope) => a.isChannel === b.isChannel && a.channelId === b.channelId && a.listId === b.listId;
const scopeKey = (s: Scope) => (s.isChannel ? `channel:${s.channelId}` : `list:${s.listId}`);

/** After a live re-read, how long updates that arrived meanwhile wait to be
 *  read together (the live-sync effect below). */
const LIVE_REREAD_GAP_MS = 400;

interface ChecklistBodyProps {
    /** Channel-scoped checklist (shared, E2EE under the channel group key). */
    channelId?: number;
    /** Personal-list-scoped checklist (owner-only, encrypt-to-self). Used by the
     *  self-DM "Notes to self". Exactly one of channelId / listId must be set. */
    listId?: number;
    /** Compact variant for the aggregated view (smaller add-form). */
    compact?: boolean;
    /** Join the channel's WS room so live updates arrive even when this isn't
     *  the "current" channel (used by the All-checklists board cards). The main
     *  channel view already joins the room via Chat.tsx, so it leaves this off.
     *  Ignored for personal lists (no other viewers). */
    subscribeRoom?: boolean;
    /** Resolved permission bits for this CHANNEL (Channel.my_permissions).
     *  Leave undefined for personal lists and old backends = all allowed. */
    myPerms?: number;
    /** Caller's user id, for creator-only task actions in TaskTree. */
    currentUserId?: number;
    /** Attribution: user id → display name (channel scope only). */
    resolveUserName?: (id: number) => string | undefined;
    /** Fires after every local task-state change (load, add, toggle, delete…)
     *  so an embedding view can keep progress counts in sync. */
    onTasksChanged?: (tasks: Task[]) => void;
    /** An embedder's Refresh (TasksView's All-tasks board, for its personal
     *  lists — they have no live updates). Called while mounted with the
     *  way to read this checklist again; the answer is whether it could be
     *  read. The read is quiet and waits for this body's own writes, like
     *  the embedder's (writesInFlight). Returns the unregister function. */
    registerRefresh?: (reread: () => Promise<boolean>) => () => void;
    /** The embedder's count of its writes, for this body's to join (the
     *  board's list cards). Through onTasksChanged a change here is also a
     *  change to the embedder's copy of the list — its counts — so the
     *  embedder's Refresh must see it, or its lists answer, read before the
     *  change landed, puts the old counts back. Without it the body counts
     *  its own. */
    writes?: WritesInFlight;
}

export function ChecklistBody({
    channelId, listId, compact = false, subscribeRoom = false,
    myPerms, currentUserId, resolveUserName, onTasksChanged, registerRefresh,
    writes: sharedWrites,
}: ChecklistBodyProps) {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [newTask, setNewTask] = useState('');
    const addRef = useRef<HTMLInputElement>(null);
    // A step-by-step list pasted into "Add an item…" asks first, then lands
    // item by item, in order (components/usePasteItems).
    const pasteItems = usePasteItems();
    const [isLoading, setIsLoading] = useState(false);
    const isChannel = channelId !== undefined;
    // This body is the THIRD writer of a task's timing and completion on the
    // Púca page (the side panel, a checklist channel, the All-checklists
    // board and the personal Notes-to-self list all render it), and it keeps
    // its items in component state. The pinned Calendar and Reminders tabs
    // read the same rows through useTaskSources, a cache with a 30 s
    // staleTime that nothing here writes — and the socket cannot cover it:
    // broadcast_checklist EXCLUDES the actor, and a personal list has no
    // channel to broadcast on at all. So every write below says so itself
    // (taskSources.invalidateTaskScope).
    const qc = useQueryClient();

    // Surface every post-load task change to the embedder (progress counts).
    // Ref-read so a new callback identity doesn't re-run the effect; gated on
    // the first successful load so the initial [] can't wipe known counts.
    const onChangedRef = useRef(onTasksChanged);
    useEffect(() => { onChangedRef.current = onTasksChanged; });
    const loadedOnce = useRef(false);
    // One create key per intent, held across the user's own retries.
    const itemKey = useRef(heldOpKey());
    useEffect(() => {
        if (loadedOnce.current) onChangedRef.current?.(tasks);
    }, [tasks]);

    // The latest scope, read when a read answers: a reply for a list or
    // channel this body no longer shows must not land in it. Set before the
    // load below runs, for the same render.
    const scopeRef = useRef<Scope>({ isChannel, channelId, listId });
    useEffect(() => { scopeRef.current = { isChannel, channelId, listId }; });
    // Items created here while this checklist is being read: the read's
    // answer is older than they are and must not take them off the screen
    // (a pasted checklist is still landing when the side panel comes back
    // to it, or another member's edit makes it read again).
    const whileReading = useRef(createdWhileReading());
    // This body's writes still out, for the embedder's Refresh: its read
    // waits for them, and an answer that raced one is dropped — the
    // embedder's count when it hands one over (`writes`).
    const [ownWrites] = useState(writesInFlight);
    const writes = sharedWrites ?? ownWrites;

    const loadTasks = useCallback(async () => {
        const asked: Scope = { isChannel, channelId, listId };
        setIsLoading(true);
        const read = whileReading.current.reading(scopeKey(asked));
        try {
            const fetched = isChannel ? await listTasks(channelId!) : await listListTasks(listId!);
            // The side panel follows the channel: a late answer for the one
            // it showed before is not this one's, and this one's own load
            // owns "Loading…".
            if (!sameScope(scopeRef.current, asked)) return;
            loadedOnce.current = true;
            setTasks(read.merge(fetched));
        } catch (err) {
            console.error('Failed to load tasks:', err);
        } finally {
            read.done();
            if (sameScope(scopeRef.current, asked)) setIsLoading(false);
        }
    }, [isChannel, channelId, listId]);

    useEffect(() => { loadTasks(); }, [loadTasks]);

    /** Re-read from truth WITHOUT loadTasks' "Loading…" swap (which resets
     *  collapse and edit state — review W4-F5). `current`, asked when the
     *  answer is in, says whether it may still land. False when it could
     *  not be read (and that was logged); never rejects. A personal list
     *  deleted for good on another device reads as gone (listIsGone): that
     *  is an answer, and the embedder's own lists read takes this card
     *  away, so it is not a failure to report. */
    const rereadQuietly = async (current: () => boolean = () => true): Promise<boolean> => {
        const asked: Scope = { isChannel, channelId, listId };
        const read = whileReading.current.reading(scopeKey(asked));
        try {
            const fresh = isChannel ? await listTasks(channelId!) : await listListTasks(listId!);
            if (!sameScope(scopeRef.current, asked) || !current()) return true;
            loadedOnce.current = true;
            setTasks(read.merge(fresh));
            return true;
        } catch (err) {
            if (!isChannel && listIsGone(err)) return true;
            console.error('Failed to reload tasks:', err);
            return false;
        } finally {
            read.done();
        }
    };
    // The live re-read below outlives the render that started it.
    const rereadRef = useRef(rereadQuietly);
    useEffect(() => { rereadRef.current = rereadQuietly; });

    // The embedder's Refresh: what this body has out lands first, and an
    // answer that raced a write started meanwhile is dropped — the screen is
    // newer than it (writesInFlight). A save still out after the wait is
    // left to report itself, and this list is not read: that answer would
    // be dropped anyway.
    useEffect(() => {
        if (!registerRefresh) return;
        return registerRefresh(async () => {
            if (!await writes.settled(SAVE_WAIT_MS)) return true;
            const mark = writes.mark();
            return rereadRef.current(() => !writes.since(mark));
        });
    }, [registerRefresh, writes]);

    // Live sync: another viewer changed this CHANNEL's checklist → re-read.
    // Personal lists are owner-only, so they get no broadcast (nothing to sync).
    //
    // QUIETLY: loadTasks' "Loading…" swaps the tree out, and with it the row
    // this viewer was editing and every group they had folded. And TOGETHER:
    // another member's pasted checklist is up to MAX_TAKEN_ITEMS creates,
    // each broadcast on its own (broadcast_checklist), and one read per
    // create was a flicker per item for everyone watching. So an update is
    // read at once; every update that arrives while that read is out, or in
    // the LIVE_REREAD_GAP_MS after it, is read by ONE more read at the end
    // of that pause; and two reads are never out at once, so an older answer
    // cannot land last.
    useEffect(() => {
        if (!isChannel) return;
        let busy = false;           // a read is out, or the pause after it runs
        let again = false;          // an update arrived meanwhile
        let gone = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const read = async () => {
            busy = true;
            again = false;          // this read covers every update before it
            await rereadRef.current();   // never rejects: it logs its own failure
            if (gone) return;
            timer = setTimeout(() => {
                timer = null;
                busy = false;
                if (again) void read();
            }, LIVE_REREAD_GAP_MS);
        };
        const handler = (msg: ServerMessage) => {
            const p = msg.payload as { channel_id?: number } | undefined;
            if (p?.channel_id !== channelId) return;
            if (busy) { again = true; return; }
            void read();
        };
        wsClient.on('ChecklistUpdate', handler);
        if (subscribeRoom) wsClient.joinRoom(`channel_${channelId}`);
        return () => {
            gone = true;
            if (timer !== null) clearTimeout(timer);
            wsClient.off('ChecklistUpdate', handler);
            if (subscribeRoom) wsClient.leaveRoom(`channel_${channelId}`);
        };
    }, [isChannel, channelId, subscribeRoom]);

    /**
     * Create one item in `scope` — the add row, a subtask and every line of
     * a pasted checklist come through here. The scope is the caller's, not
     * the current props: a paste names the channel or list its field
     * belonged to when it was pasted, and this body can be handed another
     * one while that paste is still landing. The created item, or null when
     * it was refused (and the person is told why).
     *
     * One key per intent, held across the user's own retries (api/opKey.ts):
     * this form has no automatic one, so a failed create is re-sent by hand
     * and must not be able to make a second item.
     */
    const addItem = (scope: Scope, description: string, parentId?: number) => writes.run(async (): Promise<Task | null> => {
        try {
            const key = itemKey.current.keyFor(`${scope.isChannel ? 'c' : 'l'}${scope.isChannel ? scope.channelId : scope.listId}\u0000${parentId ?? ''}\u0000${description}`);
            const created = scope.isChannel
                ? await createTask(scope.channelId!, description, parentId, undefined, key)
                : await createListTask(scope.listId!, description, parentId, undefined, key);
            itemKey.current.landed();
            whileReading.current.created(scopeKey(scope), created);
            if (sameScope(scopeRef.current, scope)) setTasks(prev => [...prev, created]);
            return created;
        } catch (err) {
            console.error('Failed to create task:', err);
            // The server's own reason when it gave one (400, 403, 409 — a missing
            // CREATE_TASKS bit, an envelope refusal), else ours.
            pushMessageToast({ title: err instanceof ApiError && (err.status === 400 || err.status === 403 || err.status === 409) ? err.message : 'Couldn’t add the item — check your connection' });
            return null;
        }
    });

    const handleAddTask = async (e: React.FormEvent) => {
        e.preventDefault();
        // Enter under the paste question adds nothing behind it.
        if (!newTask.trim() || pasteItems.asking) return;
        // A failed create leaves the words in the box for the retry.
        if (await addItem({ isChannel, channelId, listId }, newTask.trim())) setNewTask('');
    };

    const handleAddSubtask = async (parentId: number, text: string) => {
        await addItem({ isChannel, channelId, listId }, text, parentId);
    };

    /** A paste into "Add an item…". More than one line asks first; the items
     *  go to the checklist this field belonged to WHEN it was pasted. */
    const onPasteItem = (e: React.ClipboardEvent<HTMLInputElement>) => {
        const scope = { isChannel, channelId, listId };
        pasteItems.onPaste(e, {
            separate: read => { void pasteItems.addInOrder(read.items, async text => (await addItem(scope, text)) !== null); },
            // Into the box, not created: Enter adds it, as for typed text.
            one: line => setNewTask(v => `${v}${line}`.slice(0, MAX_ITEM_LENGTH)),
            after: () => addRef.current?.focus(),
        });
    };

    const handleToggle = (task: Task, completed: boolean) => writes.run(async () => {
        const original = tasks;
        // One completion path (taskCompletion.ts): a repeating task advances.
        const plan = planToggle(tasks, task, completed, { canEdit: canEditTask(task, currentUserId, myPerms) });
        setTasks(plan.next);
        try {
            await plan.send();
            // A ticked item leaves Reminders, and a repeating one reappears
            // at its next time: the dated tabs read a cache this body does
            // not write.
            invalidateTaskScope(qc, task);
        } catch (err) {
            console.error('Failed to update task:', err);
            setTasks(original);
            if (err instanceof ApiError && err.status === 409) {
                pushMessageToast({ title: err.message });
                // Refused because the server holds something newer: show
                // it, or every retry is judged on the same stale copy (a
                // personal list gets no live refresh at all).
                void rereadQuietly();
            }
        }
    });

    const handleEdit = (task: Task, description: string) => writes.run(async () => {
        const original = tasks;
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, description } : t));
        try {
            if (isChannel) await updateChannelTask(channelId!, task.id, { description }, task.created_by);
            else await updateListTask(task.id, { description });
        } catch (err) {
            console.error('Failed to edit task:', err);
            // The server's 409 explains itself (envelope-version refusal): surface it.
            if (err instanceof ApiError && err.status === 409) pushMessageToast({ title: err.message });
            setTasks(original);
        }
    });

    const handleMove = (task: Task, direction: 'up' | 'down') => writes.run(async () => {
        const original = tasks;
        const next = applyMove(tasks, task, direction);
        if (next === tasks) return;
        setTasks(next);
        try {
            await moveTask(task.id, direction);
        } catch (err) {
            console.error('Failed to move task:', err);
            setTasks(original);
        }
    });

    const handleReorder = (
        task: Task, afterId: number | null, reparent?: { parentId: number | null },
    ) => writes.run(async () => {
        const original = tasks;
        const next = applyReorder(tasks, task, afterId, reparent);
        if (next === tasks) return;
        setTasks(next);
        try {
            await reorderTask(task.id, afterId, reparent);
            // A reparent re-fetches from truth on success — QUIETLY, not via
            // loadTasks: its isLoading flag swaps the tree for "Loading…",
            // flashing the list and resetting collapse/edit state on every
            // nest (review W4-F5). The one old-server frame that 200s (a
            // completed-parent un-nest, moved to the front of its unchanged
            // group) is also healed by this read; the rest 400 into the
            // catch below and revert.
            if (reparent) {
                const fresh = isChannel
                    ? await listTasks(channelId!)
                    : await listListTasks(listId!);
                setTasks(fresh);
            }
        } catch (err) {
            console.error('Failed to reorder task:', err);
            setTasks(original);
        }
    });

    const handleSetDue = (task: Task, dueAt: string | null) => writes.run(async () => {
        const original = tasks;
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, due_at: dueAt } : t));
        try {
            // due_at is plaintext metadata on both scopes ('' clears).
            await updateTask(task.id, { due_at: dueAt ?? '' });
            pokeTaskReminders(); // arm a near deadline now, not at the next poll
            // ...and tell the Calendar and Reminders tabs, which read a cache
            // this body does not write to (taskSources).
            invalidateTaskScope(qc, task);
        } catch (err) {
            console.error('Failed to set due time:', err);
            setTasks(original);
        }
    });

    // Date & repeat: only against a server that stores it (taskFeatures).
    const scheduleOn = useTaskFeature('schedule') === true;
    const handleSetSchedule = useScheduleSetter(tasks, setTasks);
    // Snooze: same gate, its own feature. Whether the plaintext due_at moves
    // with it depends on this member's right to edit the item's time — the
    // question the row already asked before offering the control.
    const snoozeOn = useTaskFeature('snooze') === true;
    const canEditTime = useCallback((task: Task) => canEditTask(task, currentUserId, myPerms), [currentUserId, myPerms]);
    const handleSnooze = useSnoozeSetter(tasks, setTasks, canEditTime);
    // The two above, counted as writes for a Refresh (writesInFlight).
    const setScheduleCounted = (task: Task, schedule: string | null, dueAt: string | null) => writes.run(() => handleSetSchedule(task, schedule, dueAt));
    const snoozeCounted = (task: Task, until: number | null) => writes.run(() => handleSnooze(task, until));

    const handleSetAttachments = (task: Task, refs: TaskAttachmentRef[]) => writes.run(async () => {
        const original = tasks;
        try {
            // Local state holds the OPENED sidecar (plaintext JSON); the update
            // fns seal it for the wire. Serialize can throw (cap) → rollback.
            const plain = refs.length === 0 ? null : serializeTaskAttachments(refs);
            setTasks(prev => prev.map(t => t.id === task.id ? { ...t, attachments: plain } : t));
            if (isChannel) await updateChannelTaskAttachments(channelId!, task.id, refs, task.created_by);
            else await updateListTaskAttachments(task.id, refs);
        } catch (err) {
            console.error('Failed to update attachments:', err);
            setTasks(original);
        }
    });

    const handleDelete = (taskId: number) => writes.run(async () => {
        const original = tasks;
        // An item that has only just landed must not come back with a read
        // that is still out (createdWhileReading).
        whileReading.current.forget(collectSubtreeIds(tasks, taskId));
        // The whole subtree goes server-side (FK cascade); mirror at any depth.
        setTasks(prev => {
            const doomed = collectSubtreeIds(prev, taskId);
            return prev.filter(t => !doomed.has(t.id));
        });
        try {
            await deleteTask(taskId);
        } catch (err) {
            console.error('Failed to delete task:', err);
            setTasks(original);
        }
    });

    // CREATE_TASKS gate: the add form (and TaskTree's add-subtask affordance)
    // is hidden entirely without the bit. undefined bits = allowed (hasPerm's
    // backward-compat fallback covers personal lists and old backends).
    const canCreate = hasPerm(myPerms, PERM.CREATE_TASKS);

    return (
        <div className={`checklist-body ${compact ? 'compact' : ''}`}>
            {canCreate && (
                <form className="checklist-add" onSubmit={handleAddTask}>
                    <input
                        ref={addRef}
                        type="text"
                        value={newTask}
                        onChange={e => setNewTask(e.target.value)}
                        onPaste={onPasteItem}
                        placeholder="Add an item…"
                        maxLength={MAX_ITEM_LENGTH}
                    />
                    <button type="submit" disabled={!newTask.trim()}>+</button>
                </form>
            )}
            {pasteItems.dialog}

            {isLoading ? (
                <div className="checklist-loading">Loading…</div>
            ) : (
                <TaskTree
                    tasks={tasks}
                    onToggle={handleToggle}
                    onDelete={handleDelete}
                    onEdit={handleEdit}
                    onAddSubtask={handleAddSubtask}
                    onMove={handleMove}
                    onReorder={handleReorder}
                    onSetDue={handleSetDue}
                    onSetSchedule={scheduleOn ? setScheduleCounted : undefined}
                    onSnooze={snoozeOn ? snoozeCounted : undefined}
                    onSetAttachments={handleSetAttachments}
                    myPerms={myPerms}
                    currentUserId={currentUserId}
                    resolveUserName={resolveUserName}
                    channelId={channelId}
                />
            )}
        </div>
    );
}
