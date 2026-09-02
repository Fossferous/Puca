/**
 * ChecklistBody — the reusable channel-checklist body (add form + Keep-style
 * TaskTree with optimistic mutations). Extracted so it renders in three places:
 * the side panel (ChecklistPanel), a checklist channel's main content, and each
 * channel section of the server-wide "All checklists" view.
 *
 * All items are E2EE under the channel group key (see api/tasks.ts).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
    type Task, type TaskAttachmentRef,
    listTasks, createTask, updateChannelTask, updateChannelTaskAttachments,
    listListTasks, createListTask, updateListTask, updateListTaskAttachments,
    updateTask, deleteTask, moveTask, reorderTask,
    applyToggle, applyMove, applyReorder, collectSubtreeIds,
    serializeTaskAttachments,
} from '../api/tasks';
import { wsClient, type ServerMessage } from '../api/websocket';
import { pokeTaskReminders } from '../api/taskReminders';
import { PERM, hasPerm } from '../api/permissionBits';
import { ApiError } from '../api/client';
import { pushMessageToast } from './messageToastBus';
import { TaskTree } from './TaskTree';

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
}

export function ChecklistBody({
    channelId, listId, compact = false, subscribeRoom = false,
    myPerms, currentUserId, resolveUserName, onTasksChanged,
}: ChecklistBodyProps) {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [newTask, setNewTask] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const isChannel = channelId !== undefined;

    // Surface every post-load task change to the embedder (progress counts).
    // Ref-read so a new callback identity doesn't re-run the effect; gated on
    // the first successful load so the initial [] can't wipe known counts.
    const onChangedRef = useRef(onTasksChanged);
    useEffect(() => { onChangedRef.current = onTasksChanged; });
    const loadedOnce = useRef(false);
    useEffect(() => {
        if (loadedOnce.current) onChangedRef.current?.(tasks);
    }, [tasks]);

    const loadTasks = useCallback(async () => {
        setIsLoading(true);
        try {
            const fetched = isChannel ? await listTasks(channelId!) : await listListTasks(listId!);
            loadedOnce.current = true;
            setTasks(fetched);
        } catch (err) {
            console.error('Failed to load tasks:', err);
        } finally {
            setIsLoading(false);
        }
    }, [isChannel, channelId, listId]);

    useEffect(() => { loadTasks(); }, [loadTasks]);

    // Live sync: another viewer changed this CHANNEL's checklist → refetch.
    // Personal lists are owner-only, so they get no broadcast (nothing to sync).
    useEffect(() => {
        if (!isChannel) return;
        const handler = (msg: ServerMessage) => {
            const p = msg.payload as { channel_id?: number } | undefined;
            if (p?.channel_id === channelId) loadTasks();
        };
        wsClient.on('ChecklistUpdate', handler);
        if (subscribeRoom) wsClient.joinRoom(`channel_${channelId}`);
        return () => {
            wsClient.off('ChecklistUpdate', handler);
            if (subscribeRoom) wsClient.leaveRoom(`channel_${channelId}`);
        };
    }, [isChannel, channelId, subscribeRoom, loadTasks]);

    const addItem = (description: string, parentId?: number) =>
        isChannel ? createTask(channelId!, description, parentId) : createListTask(listId!, description, parentId);

    const handleAddTask = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTask.trim()) return;
        try {
            const created = await addItem(newTask.trim());
            setTasks(prev => [...prev, created]);
            setNewTask('');
        } catch (err) {
            console.error('Failed to create task:', err);
        }
    };

    const handleAddSubtask = async (parentId: number, text: string) => {
        try {
            const created = await addItem(text, parentId);
            setTasks(prev => [...prev, created]);
        } catch (err) {
            console.error('Failed to create subtask:', err);
        }
    };

    const handleToggle = async (task: Task, completed: boolean) => {
        const original = tasks;
        setTasks(prev => applyToggle(prev, task, completed));
        try {
            await updateTask(task.id, { is_completed: completed });
        } catch (err) {
            console.error('Failed to update task:', err);
            setTasks(original);
        }
    };

    const handleEdit = async (task: Task, description: string) => {
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
    };

    const handleMove = async (task: Task, direction: 'up' | 'down') => {
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
    };

    const handleReorder = async (
        task: Task, afterId: number | null, reparent?: { parentId: number | null },
    ) => {
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
    };

    const handleSetDue = async (task: Task, dueAt: string | null) => {
        const original = tasks;
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, due_at: dueAt } : t));
        try {
            // due_at is plaintext metadata on both scopes ('' clears).
            await updateTask(task.id, { due_at: dueAt ?? '' });
            pokeTaskReminders(); // arm a near deadline now, not at the next poll
        } catch (err) {
            console.error('Failed to set due time:', err);
            setTasks(original);
        }
    };

    const handleSetAttachments = async (task: Task, refs: TaskAttachmentRef[]) => {
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
    };

    const handleDelete = async (taskId: number) => {
        const original = tasks;
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
    };

    // CREATE_TASKS gate: the add form (and TaskTree's add-subtask affordance)
    // is hidden entirely without the bit. undefined bits = allowed (hasPerm's
    // backward-compat fallback covers personal lists and old backends).
    const canCreate = hasPerm(myPerms, PERM.CREATE_TASKS);

    return (
        <div className={`checklist-body ${compact ? 'compact' : ''}`}>
            {canCreate && (
                <form className="checklist-add" onSubmit={handleAddTask}>
                    <input
                        type="text"
                        value={newTask}
                        onChange={e => setNewTask(e.target.value)}
                        placeholder="Add an item…"
                        maxLength={500}
                    />
                    <button type="submit" disabled={!newTask.trim()}>+</button>
                </form>
            )}

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
