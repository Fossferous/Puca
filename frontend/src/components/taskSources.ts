/**
 * Every dated-item view in Púca reads the same rows: one query per personal
 * list and per checklist channel, decrypted on the device, kept live by the
 * socket's ChecklistUpdate.
 *
 * This hook is that read, shared by the pinned Calendar tab and the pinned
 * Reminders tab so the two use the SAME query keys — switching between them
 * costs no extra requests, and neither can drift from the other about which
 * items exist or who may change them.
 *
 * Content-free on the wire: the item text and `created_by` come from the
 * ordinary per-list/per-channel task reads, never from GET /task-reminders,
 * which is ids and times only (src/task_handlers.rs).
 */
import { useEffect, useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { type Task, type TaskList, canCompleteTasks, canEditTask, listListTasks, listTasks } from '../api/tasks';
import { type CalendarSource } from '../api/taskCalendar';
import { wsClient, type ServerMessage } from '../api/websocket';

export interface TasksScopeChannel {
    id: number;
    label: string;
    serverName?: string;
    myPerms?: number;
}

export type TaskScopeKind = 'list' | 'channel';

/** The cache key a scope's items live under, for every view that shows them. */
export const taskScopeKey = (kind: TaskScopeKind, id: number) => ['tasks-calendar', kind, id] as const;

export interface TaskSources {
    sources: CalendarSource[];
    /** The whole scope's items — what a completion cascade needs. */
    tasksIn: (kind: TaskScopeKind, id: number) => Task[] | undefined;
    /** Re-read one scope after a write. */
    refetch: (kind: TaskScopeKind, id: number) => Promise<void>;
}

export function useTaskSources(lists: TaskList[], channels: TasksScopeChannel[], currentUserId?: number): TaskSources {
    const qc = useQueryClient();
    const listQ = useQueries({ queries: lists.map(l => ({ queryKey: taskScopeKey('list', l.id), queryFn: () => listListTasks(l.id), staleTime: 30_000 })) });
    const chanQ = useQueries({ queries: channels.map(c => ({ queryKey: taskScopeKey('channel', c.id), queryFn: () => listTasks(c.id), staleTime: 30_000 })) });

    // Live: another member changed a checklist → refetch it.
    useEffect(() => {
        const handler = (msg: ServerMessage) => {
            const cid = (msg.payload as { channel_id?: number } | undefined)?.channel_id;
            if (typeof cid === 'number') void qc.invalidateQueries({ queryKey: taskScopeKey('channel', cid) });
        };
        wsClient.on('ChecklistUpdate', handler);
        return () => wsClient.off('ChecklistUpdate', handler);
    }, [qc]);

    const listData = listQ.map(q => q.data);
    const chanData = chanQ.map(q => q.data);
    const sources: CalendarSource[] = useMemo(() => [
        ...lists.flatMap((l, i) => ((listData[i] as Task[] | undefined) ?? []).map(t => ({ task: t, noteKey: `list:${l.id}`, noteTitle: l.title, canEdit: true }))),
        ...channels.flatMap((c, i) => ((chanData[i] as Task[] | undefined) ?? []).map(t => ({
            task: t, noteKey: `channel:${c.id}`, noteTitle: `#${c.label}`, serverName: c.serverName, canEdit: canEditTask(t, currentUserId, c.myPerms),
            canComplete: canCompleteTasks(c.myPerms),
        }))),
        // The query result arrays are new every render; their data is what matters.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    ], [lists, channels, currentUserId, ...listData, ...chanData]);

    const tasksIn = (kind: TaskScopeKind, id: number): Task[] | undefined => (
        kind === 'list'
            ? (listData[lists.findIndex(l => l.id === id)] as Task[] | undefined)
            : (chanData[channels.findIndex(c => c.id === id)] as Task[] | undefined)
    );
    const refetch = (kind: TaskScopeKind, id: number) => qc.invalidateQueries({ queryKey: taskScopeKey(kind, id) });

    return { sources, tasksIn, refetch };
}
