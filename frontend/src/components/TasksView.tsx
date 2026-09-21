/**
 * TasksView — the Tasks dashboard.
 *
 * One Google-Tasks-style tab bar holds EVERY checklist the user can see:
 * their personal lists (Google-Keep style, encrypt-to-self) and every checklist
 * channel across their servers (E2EE under each channel's group key). Tabs
 * drag to reorder (mouse: drag; touch: long-press then drag) and any tab can
 * be favourited from its context menu — favouriting pulls it to the front.
 * Order + favourites persist server-side per user (task_tab_prefs), so they
 * follow the account across devices.
 *
 * The pinned first tab is "All tasks": a board of every list and channel
 * checklist as live interactive cards — the default view when Tasks opens.
 *
 * COLOUR, LABELS AND ARCHIVE are Púca Notes' organisation, and this view is
 * the second front door onto it: one account-wide sealed-to-self document
 * (notes/model/notesPrefsSync.ts — the server holds ciphertext and a revision,
 * never a colour or a label), read here through the same synchronous snapshot
 * Notes reads and written through the same mutators, so there is one merge
 * rule and not two. A device with no identity yet (locked seed, not enrolled)
 * gets 'locked' and simply shows no colours: never a banner for someone who
 * has never opened Notes.
 *
 * The filter and the archive HIDE tabs, and a tab-order save is a full
 * replace — so everything hidden goes into `hiddenKeys` beside the trashed
 * lists, or favouriting one tab would drop every hidden note's slot.
 */

import { ApiError } from '../api/client';
import { pushMessageToast } from './messageToastBus';
import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
    type Task,
    type TaskAttachmentRef,
    type TaskList,
    type TaskTabKind,
    type TaskTabPref,
    listTaskLists,
    createTaskList,
    renameTaskList,
    deleteTaskList,
    listListTasks,
    createListTask,
    updateListTask,
    updateListTaskAttachments,
    deleteTask,
    moveTask,
    reorderTask,
    getTaskTabPrefs,
    putTaskTabPrefs,
    applyMove,
    applyReorder,
    collectSubtreeIds,
    serializeTaskAttachments,
    orderTaskTabs,
    isFavoriteTab,
    buildPrefsForOrder,
    taskTabKey,
} from '../api/tasks';
import { useServers, keys } from '../hooks/queries';
import { pokeTaskReminders } from '../api/taskReminders';
import { planToggle } from '../api/taskCompletion';
import { useTaskFeature } from '../api/taskFeatures';
import { useScheduleSetter } from './schedule/useScheduleSetter';
import { listChannels, listMembersWithRoles, type Channel, type MemberWithRoles, type Server } from '../api/servers';
import { getToken } from '../api/auth';
import { isMobile, isTauri } from '../api/platform';
import { TaskTree } from './TaskTree';
import { ChecklistBody } from './ChecklistBody';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { useContextMenu } from './contextMenuUtils';
import { ArchiveIcon, CalendarIcon, ChecklistIcon, FileTextIcon, NoteIcon, PlusIcon, StarIcon, TagIcon, TasksIcon, TrashIcon } from './Icons';
// Púca Notes' organisation, shared rather than forked — see the header.
import { type NoteColor } from '../notes/model/notesModel';
import {
    forgetNoteKeys,
    getNotesPrefs,
    setNoteArchived,
    setNoteColor,
    setNoteLabels,
    subscribeNotesPrefs,
} from '../notes/model/notesPrefs';
import { useNotesPrefsSync } from '../notes/model/notesPrefsSync';
import { ColorPicker } from './notes/ColorPicker';
import { LabelPicker } from './notes/LabelPicker';
import { Popover } from './notes/Popover';
import { PrefsSyncBanner } from './notes/PrefsSyncBanner';
import { TasksCalendar } from './calendar/TasksCalendar';
import { useSwipe } from '../hooks/useSwipe';
import { useDragReorder } from '../hooks/useDragReorder';
import { ListContentBlock, TasksTrash } from './ListContentBlock';
import { listBodySnippet, listContentQueryKeys, useListContentSupport } from './useListContentSupport';
import { fetchListFeatures, flushBodySave, keepHiddenSlots, toggleFavoriteKeepingHidden, trashTaskList } from '../api/listContent';
import { useQueryClient } from '@tanstack/react-query';
import './TasksView.css';
import './AllChecklistsView.css';
import './ServerTasksBoard.css';

/**
 * Where Púca Notes lives, or null where the link would be wrong. WEB ONLY:
 * Notes is a second page on the web app's origin, and it is signed in there
 * because the two pages share the origin's storage. The link names the FILE
 * (`/notes/index.html`), not the folder: a vhost whose `try_files` still reads
 * `{path} /index.html` answers both `/notes` and `/notes/` with THIS app
 * (measured on production the day Notes shipped — the folder only works once
 * the operator adds `{path}/`, deploy/webapp/README.md), while a real file is
 * served by every configuration. Notes' own routes are hash routes, so the
 * file name stays in the address bar and nothing else changes. The desktop shell runs at tauri://localhost and the phone at
 * https://localhost, where nothing is shared: a link from either would open
 * a signed-out, default-themed page in the system browser, so they get none.
 */
function notesUrl(): string | null {
    if (typeof window === 'undefined' || isTauri() || isMobile()) return null;
    return `${window.location.origin}/notes/index.html`;
}

// Decode the JWT for the caller's user id (same lightweight client-side decode
// as Chat.tsx) — creator-only task actions compare against it.
function tokenUserId(): number | undefined {
    const token = getToken();
    if (!token) return undefined;
    try {
        const sub = JSON.parse(atob(token.split('.')[1])).sub;
        return typeof sub === 'number' ? sub : undefined;
    } catch {
        return undefined;
    }
}

/** One bar tab: a personal list or a channel checklist. */
interface BarTab {
    kind: TaskTabKind;
    id: number;
    label: string;
    /** Channel tabs: the server they live in + resolved bits/attribution. */
    serverName?: string;
    myPerms?: number;
    resolveUserName?: (id: number) => string | undefined;
}

/** 'calendar' = the pinned Calendar tab (TasksCalendar), beside All tasks. */
type Selected = { kind: TaskTabKind | 'calendar'; id: number } | null;

/** What the tab bar and the board are showing: everything unarchived, one
 *  label, or the archive. A view choice, not a stored setting — it starts at
 *  'all' every time Tasks opens, as Notes' rail does. */
type NoteFilter = { kind: 'all' } | { kind: 'label'; label: string } | { kind: 'archive' };

/** The union of every label in use, in the order the rail shows them. */
function labelsInUse(keys: string[], byKey: Record<string, string[]>): string[] {
    const seen = new Map<string, string>();
    for (const k of keys) {
        for (const l of byKey[k] ?? []) {
            const lower = l.toLocaleLowerCase();
            if (!seen.has(lower)) seen.set(lower, l);
        }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export function TasksView() {
    // null = the pinned "All tasks" board (the default view).
    const [selected, setSelected] = useState<Selected>(null);
    const [lists, setLists] = useState<TaskList[]>([]);
    const [prefs, setPrefs] = useState<TaskTabPref[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(true);
    const [newListTitle, setNewListTitle] = useState('');
    const [addingList, setAddingList] = useState(false);
    const [newTaskText, setNewTaskText] = useState('');
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');
    // Right-click / long-press menu on the tabs and board cards.
    const { contextMenu, showContextMenu, hideContextMenu } = useContextMenu();
    const currentUserId = tokenUserId();
    const notesHref = notesUrl();
    // Púca Notes' text/photo notes and the trash, where the server has them.
    const support = useListContentSupport();
    // Colour, labels and archive: the account's sealed document, kept in step
    // while this view is up, and the synchronous snapshot every render reads.
    const prefsSyncStatus = useNotesPrefsSync();
    const notePrefs = useSyncExternalStore(subscribeNotesPrefs, getNotesPrefs, getNotesPrefs);
    const [noteFilter, setNoteFilter] = useState<NoteFilter>({ kind: 'all' });
    const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
    // The colour / label pickers, anchored to the tab or card they were opened
    // from (the context menu has no submenus, and would not want one on touch).
    const [picker, setPicker] = useState<{ kind: 'color' | 'labels'; tab: BarTab; anchor: HTMLElement | null } | null>(null);
    const qc = useQueryClient();
    const patchList = (id: number, patch: Partial<TaskList>) => setLists(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
    // Read at async completion time (the reparent refetch guard) — the load
    // effect uses a per-run `cancelled` flag for the same stale-reply hole.
    const selectedRef = useRef<Selected>(null);
    useEffect(() => { selectedRef.current = selected; }, [selected]);

    // --- Server checklist channels (same cache keys the main app populates) ---
    const { data: servers = [] } = useServers();
    const channelQueries = useQueries({
        queries: servers.map((s: Server) => ({
            queryKey: keys.channels(s.id),
            queryFn: () => listChannels(s.id),
            staleTime: 30_000,
        })),
    });
    const memberQueries = useQueries({
        queries: servers.map((s: Server) => ({
            queryKey: keys.members(s.id),
            queryFn: () => listMembersWithRoles(s.id),
            staleTime: 30_000,
        })),
    });

    const channelTabs: BarTab[] = servers.flatMap((server: Server, i: number) => {
        // Same name-fallback chain as Chat's memberNames map.
        const memberNames = new Map(
            ((memberQueries[i]?.data as MemberWithRoles[] | undefined) ?? [])
                .map(m => [m.id, m.display_name || m.server_nickname || m.username])
        );
        return (((channelQueries[i]?.data as Channel[] | undefined) ?? []))
            .filter(c => c.has_checklist)
            .map(c => ({
                kind: 'channel' as const,
                id: c.id,
                label: c.name,
                serverName: server.name,
                myPerms: c.my_permissions,
                resolveUserName: (id: number) => memberNames.get(id),
            }));
    });

    const listTabs: BarTab[] = lists.map(l => ({ kind: 'list' as const, id: l.id, label: l.title }));
    // Saved order first, then anything the prefs haven't seen (new lists /
    // newly joined servers) in natural order. Cheap enough to run per render.
    const allTabs = orderTaskTabs([...listTabs, ...channelTabs], prefs);

    const isArchived = (key: string) => notePrefs.archived[key] === true;
    const matchesFilter = (key: string) => {
        if (noteFilter.kind === 'archive') return isArchived(key);
        if (isArchived(key)) return false;
        if (noteFilter.kind === 'label') {
            const want = noteFilter.label.toLocaleLowerCase();
            return (notePrefs.labels[key] ?? []).some(l => l.toLocaleLowerCase() === want);
        }
        return true;
    };
    /** What the bar and the board show right now. */
    const orderedTabs = allTabs.filter(t => matchesFilter(taskTabKey(t)));
    /** Tabs that exist but are not on screen: the trash, the archive, and
     *  whatever a label filter is leaving out. A tab-pref save is a full
     *  replace (PUT /task-tab-prefs), so each of these has to be put back at
     *  the index it holds — the bug already fixed for the trash alone
     *  (api/listContent.ts keepHiddenSlots, tasksViewTrashSlots.test.tsx). */
    const hiddenKeys: ReadonlySet<string> = new Set<string>([
        ...support.trashedKeys,
        ...allTabs.filter(t => !matchesFilter(taskTabKey(t))).map(taskTabKey),
    ]);
    const noteLabels = labelsInUse(allTabs.map(taskTabKey), notePrefs.labels);
    const archivedCount = allTabs.filter(t => isArchived(taskTabKey(t))).length;

    // Resolved from ALL tabs, not the visible ones: archiving the open note
    // takes it off the bar, and "that checklist is gone" would be a lie.
    const selectedList = selected?.kind === 'list' ? (lists.find(l => l.id === selected.id) ?? null) : null;
    const selectedChannel = selected?.kind === 'channel'
        ? (allTabs.find(t => t.kind === 'channel' && t.id === selected.id) ?? null)
        : null;

    /** Optimistically apply a new pref set and persist it; roll back on error
     *  (an old backend without the endpoint reverts to the fetched order).
     *  Sequenced: two quick edits fire overlapping PUTs, and the FIRST one
     *  failing after the second succeeded must not revert to a snapshot from
     *  before either edit — only the latest save may roll back. */
    const saveSeq = useRef(0);
    const savePrefs = (next: TaskTabPref[]) => {
        // Built before the trash was read, `next` has no slot for a trashed
        // list (keepHiddenSlots needs its key), and the PUT is a full replace.
        if (!support.trashSettled) {
            pushMessageToast({ title: 'Still loading the trash — try again in a moment' });
            return;
        }
        const prev = prefs;
        const seq = ++saveSeq.current;
        setPrefs(next);
        putTaskTabPrefs(next).catch(err => {
            console.error('Failed to save tab prefs:', err);
            if (saveSeq.current === seq) setPrefs(prev);
        });
    };

    const toggleFavorite = (tab: BarTab) => {
        // Every tab the trash, the archive or a filter is hiding keeps its slot
        // in the saved order (api/listContent.ts).
        savePrefs(toggleFavoriteKeepingHidden(orderedTabs, prefs, tab, hiddenKeys));
    };

    // Tab drag: mouse drags after a small threshold; touch long-presses to
    // lift (a plain horizontal touch keeps scrolling the bar; holding still
    // through the browser's long-press still opens the context menu).
    // Destructured on purpose — see the setContainer note in useDragReorder.
    const { state: tabDragState, setContainer: setTabDragContainer, onPointerDown: onTabDragPointerDown } = useDragReorder({
        axis: 'x',
        touchHoldMs: 350,
        enabled: orderedTabs.length > 1,
        onDrop: ({ key, order, insertAt }) => {
            const byKey = new Map(orderedTabs.map(t => [taskTabKey(t), t]));
            if (!byKey.has(key)) return;
            const newKeys = [...order];
            newKeys.splice(insertAt, 0, key);
            const newOrder = newKeys.map(k => byKey.get(k)).filter((t): t is BarTab => !!t);
            savePrefs(buildPrefsForOrder(keepHiddenSlots(newOrder, prefs, hiddenKeys), prefs));
        },
    });

    const scrollActiveTabIntoView = () => {
        requestAnimationFrame(() => {
            document.querySelector('.tasks-tabbar .tasks-tab.active')
                ?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        });
    };

    /** Move to the previous/next tab, cycling through [All, ...tabs] (wired to
     *  swipe on the content area). */
    const stepTab = (delta: 1 | -1) => {
        const seq: (BarTab | null)[] = [null, ...orderedTabs];
        if (seq.length < 2) return;
        const idx = seq.findIndex(t => (t === null
            ? selected === null
            : selected !== null && t.kind === selected.kind && t.id === selected.id));
        const next = seq[((idx < 0 ? 0 : idx) + delta + seq.length) % seq.length];
        setSelected(next === null ? null : { kind: next.kind, id: next.id });
        scrollActiveTabIntoView();
    };

    // Swipe left → next tab, right → previous. Guarded by useSwipe (ignores
    // the horizontally-scrolling tab bar, inputs, and vertical scrolls).
    const contentSwipe = useSwipe({
        enabled: orderedTabs.length > 0,
        onSwipeLeft: () => stepTab(1),
        onSwipeRight: () => stepTab(-1),
    });

    const refreshLists = useCallback(async (withPrefs = false) => {
        try {
            const fetched = await listTaskLists();
            setLists(fetched);
        } catch (err) {
            console.error('Failed to load task lists:', err);
        }
        if (withPrefs) {
            try {
                setPrefs(await getTaskTabPrefs());
            } catch {
                // Old backend / offline: natural order, favourites unsaved.
            }
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load on mount
        refreshLists(true);
    }, [refreshLists]);

    useEffect(() => {
        if (selected?.kind !== 'list') {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale tasks when no list selected
            setTasks([]);
            return;
        }
        let cancelled = false;
        listListTasks(selected.id)
            .then(fetched => { if (!cancelled) setTasks(fetched); })
            .catch(err => console.error('Failed to load tasks:', err));
        return () => { cancelled = true; };
    }, [selected?.kind, selected?.id]);

    /** Update the sidebar counts for one personal list from local task state
     *  (the selected editor and the All-board cards both report through here). */
    const syncListCounts = (listId: number, nextTasks: Task[]) => {
        setLists(prev => prev.map(l => l.id === listId
            ? {
                ...l,
                total_tasks: nextTasks.length,
                completed_tasks: nextTasks.filter(t => t.is_completed).length,
            }
            : l));
    };

    const handleCreateList = async (e: React.FormEvent) => {
        e.preventDefault();
        const title = newListTitle.trim();
        if (!title) return;
        try {
            const created = await createTaskList(title);
            setLists(prev => [...prev, created]);
            setSelected({ kind: 'list', id: created.id });
            // A brand-new list has no labels and is not archived, so ANY
            // filter hides it: the editor would open on a note with no tab and
            // no card, and the "Show all notes" way back only appears when the
            // board is empty — which it is not. Creating one means showing it.
            setNoteFilter({ kind: 'all' });
            setNewListTitle('');
            setAddingList(false);
        } catch (err) {
            console.error('Failed to create list:', err);
        }
    };

    /** The "Notes to self" list cannot go to the trash (the server refuses
     *  it), so where there is a trash it is not offered for that list. */
    const canDeleteList = (list: TaskList) => !(support.trashEnabled && list.is_self === true);

    const handleDeleteList = async (list: TaskList) => {
        // Only a server KNOWN to have no trash gets the permanent delete.
        let features = support.features;
        if (!support.featuresKnown) {
            try {
                features = await qc.fetchQuery({ queryKey: listContentQueryKeys.features, queryFn: fetchListFeatures });
            } catch {
                pushMessageToast({ title: 'Couldn’t reach the server — nothing was deleted' });
                return;
            }
        }
        if (features.trash) {
            const days = features.trashRetentionDays;
            if (list.is_self) {
                pushMessageToast({ title: 'Notes to self can’t be moved to the trash' });
                return;
            }
            if (!confirm(`Move "${list.title}" to the trash? ${days > 0 ? `You can restore it for ${days} days` : 'You can restore it'} from the Trash below the All tasks board, or in Púca Notes.`)) return;
            // Text typed just before this is still saving: let it land first.
            await flushBodySave(list.id);
            const original = lists;
            setLists(prev => prev.filter(l => l.id !== list.id));
            if (selected?.kind === 'list' && selected.id === list.id) setSelected(null);
            try {
                await trashTaskList(list.id);
                qc.setQueryData<TaskList[]>(listContentQueryKeys.trash, prev => [{ ...list, trashed_at: new Date().toISOString() }, ...(prev ?? []).filter(l => l.id !== list.id)]);
                void qc.invalidateQueries({ queryKey: listContentQueryKeys.trash });
                pokeTaskReminders();
            } catch (err) {
                console.error('Failed to move list to the trash:', err);
                // The server's own reason when it gave one (400, 409), else ours.
                pushMessageToast({ title: err instanceof ApiError && (err.status === 400 || err.status === 409) ? err.message : 'Couldn’t move the list to the trash — check your connection' });
                setLists(original);
            }
            return;
        }
        if (!confirm(`Delete list "${list.title}" and all its tasks?`)) return;
        const original = lists;
        setLists(prev => prev.filter(l => l.id !== list.id));
        if (selected?.kind === 'list' && selected.id === list.id) setSelected(null);
        try {
            await deleteTaskList(list.id);
            // Gone for good, so its colour and labels are too. A note moved to
            // the TRASH keeps them for a restore — that branch returned above.
            forgetNoteKeys([`list:${list.id}`]);
        } catch (err) {
            console.error('Failed to delete list:', err);
            setLists(original);
        }
    };

    const commitTitle = async () => {
        setEditingTitle(false);
        const title = titleDraft.trim();
        if (!selectedList || !title || title === selectedList.title) return;
        const original = lists;
        setLists(prev => prev.map(l => l.id === selectedList.id ? { ...l, title } : l));
        try {
            await renameTaskList(selectedList.id, title);
        } catch (err) {
            console.error('Failed to rename list:', err);
            if (err instanceof ApiError && err.status === 409) pushMessageToast({ title: err.message });
            setLists(original);
        }
    };

    const handleAddTask = async (e: React.FormEvent) => {
        e.preventDefault();
        const text = newTaskText.trim();
        if (!text || selectedList === null) return;
        try {
            const created = await createListTask(selectedList.id, text);
            const next = [...tasks, created];
            setTasks(next);
            syncListCounts(selectedList.id, next);
            setNewTaskText('');
        } catch (err) {
            console.error('Failed to create task:', err);
        }
    };

    const handleAddSubtask = async (parentId: number, text: string) => {
        if (selectedList === null) return;
        try {
            const created = await createListTask(selectedList.id, text, parentId);
            const next = [...tasks, created];
            setTasks(next);
            syncListCounts(selectedList.id, next);
        } catch (err) {
            console.error('Failed to create subtask:', err);
        }
    };

    const handleToggle = async (task: Task, completed: boolean) => {
        if (selectedList === null) return;
        const original = tasks;
        // One completion path (taskCompletion.ts): a repeating task advances.
        const plan = planToggle(tasks, task, completed, { canEdit: true });
        const next = plan.next;
        setTasks(next);
        syncListCounts(selectedList.id, next);
        try {
            await plan.send();
        } catch (err) {
            console.error('Failed to update task:', err);
            if (err instanceof ApiError && err.status === 409) pushMessageToast({ title: err.message });
            setTasks(original);
            syncListCounts(selectedList.id, original);
        }
    };

    const handleEdit = async (task: Task, description: string) => {
        const original = tasks;
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, description } : t));
        try {
            await updateListTask(task.id, { description });
        } catch (err) {
            console.error('Failed to edit task:', err);
            if (err instanceof ApiError && err.status === 409) pushMessageToast({ title: err.message });
            setTasks(original);
        }
    };

    const handleMove = async (task: Task, direction: 'up' | 'down') => {
        const original = tasks;
        const next = applyMove(tasks, task, direction);
        if (next === tasks) return; // already at the edge
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
            // A reparent re-fetches from truth on success (the load effect's
            // job, done inline; see ChecklistBody for the old-server story).
            // GUARDED like that effect: switch lists mid-round-trip and the
            // stale reply must not land in the new list's editor.
            if (reparent && selected?.kind === 'list') {
                const forList = selected.id;
                const fetched = await listListTasks(forList);
                setTasks(prev =>
                    selectedRef.current?.kind === 'list' && selectedRef.current.id === forList
                        ? fetched
                        : prev);
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
            // due_at is plaintext metadata ('' clears server-side).
            await updateListTask(task.id, { due_at: dueAt ?? '' });
            pokeTaskReminders(); // arm a near deadline now, not at the next poll
        } catch (err) {
            console.error('Failed to set due time:', err);
            setTasks(original);
        }
    };

    // Date & repeat: only against a server that stores it (taskFeatures).
    const scheduleOn = useTaskFeature('schedule') === true;
    const handleSetSchedule = useScheduleSetter(tasks, setTasks);

    const handleSetAttachments = async (task: Task, refs: TaskAttachmentRef[]) => {
        const original = tasks;
        try {
            // Local state holds the OPENED sidecar (plaintext JSON); the update
            // fn seals it for the wire. Serialize can throw (cap) → rollback.
            const plain = refs.length === 0 ? null : serializeTaskAttachments(refs);
            setTasks(prev => prev.map(t => t.id === task.id ? { ...t, attachments: plain } : t));
            await updateListTaskAttachments(task.id, refs);
        } catch (err) {
            console.error('Failed to update attachments:', err);
            setTasks(original);
        }
    };

    const handleDelete = async (taskId: number) => {
        if (selectedList === null) return;
        const original = tasks;
        // The whole subtree cascades server-side; mirror locally at any depth.
        const doomed = collectSubtreeIds(tasks, taskId);
        const next = tasks.filter(t => !doomed.has(t.id));
        setTasks(next);
        syncListCounts(selectedList.id, next);
        try {
            await deleteTask(taskId);
        } catch (err) {
            console.error('Failed to delete task:', err);
            setTasks(original);
            syncListCounts(selectedList.id, original);
        }
    };

    /** Archive or unarchive a note. Either way it leaves the surface the user
     *  is looking at, so an open editor for it would be stranded. */
    const setArchived = (tab: BarTab, archived: boolean) => {
        setNoteArchived(taskTabKey(tab), archived);
        if (selected?.kind === tab.kind && selected.id === tab.id) setSelected(null);
    };

    /** Context-menu items for a tab/card: favourite, colour, labels and
     *  archive on every note; personal lists additionally rename + delete. */
    const menuItemsFor = (tab: BarTab, anchor: HTMLElement | null): ContextMenuItem[] => {
        const fav = isFavoriteTab(prefs, tab);
        const items: ContextMenuItem[] = [{
            id: 'favorite-tab',
            label: fav ? 'Unfavourite' : 'Favourite',
            icon: 'star',
            onClick: () => toggleFavorite(tab),
        }, {
            id: 'note-color',
            label: 'Colour…',
            icon: 'palette',
            onClick: () => setPicker({ kind: 'color', tab, anchor }),
        }, {
            id: 'note-labels',
            label: 'Labels…',
            icon: 'tag',
            onClick: () => setPicker({ kind: 'labels', tab, anchor }),
        }, {
            id: 'note-archive',
            label: isArchived(taskTabKey(tab)) ? 'Unarchive' : 'Archive',
            icon: 'archive',
            onClick: () => setArchived(tab, !isArchived(taskTabKey(tab))),
        }];
        if (tab.kind === 'list') {
            const list = lists.find(l => l.id === tab.id);
            if (list) {
                items.push({
                    id: 'rename-list',
                    label: 'Rename List',
                    icon: 'pencil',
                    onClick: () => {
                        setSelected({ kind: 'list', id: list.id });
                        setTitleDraft(list.title);
                        setEditingTitle(true);
                    },
                });
                if (canDeleteList(list)) {
                    items.push({
                        id: 'delete-list',
                        label: support.trashEnabled ? 'Move to trash' : 'Delete List',
                        icon: 'trash',
                        danger: true,
                        onClick: () => handleDeleteList(list),
                    });
                }
            }
        }
        return items;
    };

    const renderTab = (tab: BarTab) => {
        const key = taskTabKey(tab);
        const isActive = selected !== null && selected.kind === tab.kind && selected.id === tab.id;
        const fav = isFavoriteTab(prefs, tab);
        const list = tab.kind === 'list' ? lists.find(l => l.id === tab.id) : undefined;
        const labels = notePrefs.labels[key] ?? [];
        return (
            <button
                key={key}
                className={`tasks-tab ${isActive ? 'active' : ''} ${tab.kind === 'channel' ? 'tasks-tab-channel' : ''}`}
                data-drag-key={key}
                data-drag-group="bar"
                data-color={notePrefs.colors[key] ?? 'default'}
                onClick={() => { setSelected({ kind: tab.kind, id: tab.id }); }}
                onContextMenu={(e) => { const anchor = e.currentTarget; showContextMenu(e, menuItemsFor(tab, anchor)); }}
                title={tab.kind === 'channel' ? `#${tab.label} in ${tab.serverName}` : tab.label}
            >
                {fav && <StarIcon className="tasks-tab-star" />}
                {tab.kind === 'channel' && <ChecklistIcon className="tasks-tab-kind" />}
                <span className="tasks-tab-title">{tab.label}</span>
                {labels.length > 0 && (
                    <span className="tasks-tab-labels">
                        {labels.map(l => <span key={l} className="tasks-tab-label">{l}</span>)}
                    </span>
                )}
                {list && list.total_tasks > 0 && (
                    <span className="tasks-tab-count">{list.completed_tasks}/{list.total_tasks}</span>
                )}
            </button>
        );
    };

    /** One interactive board card (used by the All-tasks view). */
    const renderCard = (tab: BarTab) => {
        const key = taskTabKey(tab);
        const fav = isFavoriteTab(prefs, tab);
        const list = tab.kind === 'list' ? lists.find(l => l.id === tab.id) : undefined;
        const labels = notePrefs.labels[key] ?? [];
        return (
            <section className="checklist-card" key={key} data-color={notePrefs.colors[key] ?? 'default'}>
                <header
                    className="checklist-card-header"
                    role="button"
                    title="Open"
                    onClick={() => { setSelected({ kind: tab.kind, id: tab.id }); scrollActiveTabIntoView(); }}
                    onContextMenu={(e) => { const anchor = e.currentTarget; showContextMenu(e, menuItemsFor(tab, anchor)); }}
                >
                    {tab.kind === 'list' ? <FileTextIcon /> : <ChecklistIcon />} {tab.label}
                    {fav && <StarIcon className="tasks-tab-star" />}
                    <span className="tasks-card-sub">
                        {tab.kind === 'channel'
                            ? tab.serverName
                            : list && list.total_tasks > 0 ? `${list.completed_tasks}/${list.total_tasks}` : ''}
                    </span>
                </header>
                {labels.length > 0 && (
                    <div className="tasks-card-labels">
                        {labels.map(l => (
                            <button
                                key={l}
                                type="button"
                                className="tasks-card-label"
                                title={`Show only notes labelled ${l}`}
                                onClick={() => setNoteFilter({ kind: 'label', label: l })}
                            >
                                <TagIcon /> {l}
                            </button>
                        ))}
                    </div>
                )}
                {tab.kind === 'list' && listBodySnippet(list) && <p className="tasks-card-body">{listBodySnippet(list)}</p>}
                {tab.kind === 'list' ? (
                    <ChecklistBody
                        listId={tab.id}
                        compact
                        onTasksChanged={ts => syncListCounts(tab.id, ts)}
                    />
                ) : (
                    <ChecklistBody
                        channelId={tab.id}
                        compact
                        subscribeRoom
                        myPerms={tab.myPerms}
                        currentUserId={currentUserId}
                        resolveUserName={tab.resolveUserName}
                    />
                )}
            </section>
        );
    };

    // The trash rides at the end of the All-tasks board (inside its scroll,
    // so on a phone it never sits under the bottom nav).
    const trashSection = (
        <TasksTrash
            features={support.features}
            trashed={support.trashed}
            onRestored={l => setLists(prev => (prev.some(x => x.id === l.id) ? prev : [...prev, l]))}
        />
    );

    const filterName = noteFilter.kind === 'archive' ? 'Archive'
        : noteFilter.kind === 'label' ? noteFilter.label
        : 'All notes';
    const pickerKey = picker ? taskTabKey(picker.tab) : '';

    return (
        <div className="tasks-view-outer">
            {/* Colour/label/archive syncing that did NOT happen — the same
                three states, and the same two ways out, Notes shows. */}
            <PrefsSyncBanner status={prefsSyncStatus} />
            {/* Tab bar: pinned All-tasks board, then every list + server
                checklist as draggable tabs, with New-list pinned right. */}
            <div className="tasks-tabbar">
                <div
                    className="tasks-tab-scroll"
                    ref={setTabDragContainer}
                    onPointerDown={onTabDragPointerDown}
                >
                    {tabDragState.indicator && (
                        <div
                            className="tasks-tab-drop-indicator"
                            style={{
                                left: tabDragState.indicator.x,
                                top: tabDragState.indicator.y,
                                width: tabDragState.indicator.width,
                                height: tabDragState.indicator.height,
                            }}
                        />
                    )}
                    <button
                        className={`tasks-tab tasks-tab-all ${selected === null ? 'active' : ''}`}
                        onClick={() => setSelected(null)}
                        title="All tasks"
                    >
                        <TasksIcon className="tasks-tab-kind" />
                        <span className="tasks-tab-title">All tasks</span>
                    </button>
                    <button
                        className={`tasks-tab tasks-tab-calendar ${selected?.kind === 'calendar' ? 'active' : ''}`}
                        onClick={() => setSelected({ kind: 'calendar', id: 0 })}
                        title="Calendar — every dated item"
                        aria-label="Calendar"
                    >
                        <CalendarIcon className="tasks-tab-kind" />
                        <span className="tasks-tab-title">Calendar</span>
                    </button>
                    {orderedTabs.map(renderTab)}
                    {addingList && (
                        <form className="tasks-tab-newform" onSubmit={handleCreateList}>
                            <input
                                type="text"
                                autoFocus
                                placeholder="List name…"
                                value={newListTitle}
                                onChange={e => setNewListTitle(e.target.value)}
                                onBlur={() => { if (!newListTitle.trim()) setAddingList(false); }}
                                onKeyDown={e => { if (e.key === 'Escape') { setNewListTitle(''); setAddingList(false); } }}
                                maxLength={100}
                            />
                        </form>
                    )}
                </div>
                <div className="tasks-tabbar-actions">
                    <button
                        className="tasks-tab tasks-tab-icon"
                        title="New list"
                        aria-label="New list"
                        onClick={() => { setAddingList(true); }}
                    >
                        <PlusIcon />
                    </button>
                    {/* In the FIXED actions block, never in the scroller: the
                        bar scrolls away under a coarse pointer and a filter
                        you cannot find is a filter you cannot turn off. */}
                    {allTabs.length > 0 && (
                        <button
                            className={`tasks-tab tasks-tab-icon tasks-tab-filter ${noteFilter.kind === 'all' ? '' : 'on'}`}
                            title={`Showing: ${filterName}`}
                            aria-label={`Filter notes — showing ${filterName}`}
                            onClick={(e) => setFilterAnchor(e.currentTarget)}
                        >
                            {noteFilter.kind === 'archive' ? <ArchiveIcon /> : <TagIcon />}
                        </button>
                    )}
                    {notesHref && (
                        <a
                            className="tasks-tab tasks-tab-icon tasks-tab-notes"
                            href={notesHref}
                            target="_blank"
                            rel="noopener"
                            title="Open in Púca Notes — these lists as notes"
                            aria-label="Open in Púca Notes"
                        >
                            <NoteIcon />
                        </a>
                    )}
                </div>
            </div>

            {selected?.kind === 'calendar' ? (
                <div className="server-tasks-scroll tasks-calendar-scroll">
                    <TasksCalendar
                        lists={lists}
                        channels={channelTabs.map(c => ({ id: c.id, label: c.label, serverName: c.serverName, myPerms: c.myPerms }))}
                        currentUserId={currentUserId}
                        onOpen={(kind, id) => setSelected({ kind, id })}
                    />
                </div>
            ) : selected === null ? (
                // The All-tasks board: every list + channel checklist as a
                // live card, in bar order (favourites lead after favouriting).
                loading ? (
                    <div className="tasks-muted">Loading…</div>
                ) : orderedTabs.length === 0 ? (
                    <div className="tasks-editor-empty" {...contentSwipe}>
                        <div className="tasks-empty-icon"><FileTextIcon size={40} /></div>
                        {allTabs.length > 0 ? (
                            // Not "you have nothing" — a filter is on, and saying
                            // so is the only way back from it.
                            <p>
                                Nothing {noteFilter.kind === 'archive' ? 'in the archive' : <>labelled “{filterName}”</>}.{' '}
                                <button type="button" className="tasks-empty-link" onClick={() => setNoteFilter({ kind: 'all' })}>Show all notes</button>
                            </p>
                        ) : (
                            <p>Create a list with New list, above — or make any text channel a checklist and it will show up here.</p>
                        )}
                        {trashSection}
                    </div>
                ) : (
                    <div className="server-tasks-scroll tasks-all-scroll" {...contentSwipe}>
                        <div className="all-checklists-grid server-tasks-grid">
                            {orderedTabs.map(renderCard)}
                        </div>
                        {trashSection}
                    </div>
                )
            ) : selectedChannel ? (
                // A server checklist channel, full height.
                <div className="tasks-editor" {...contentSwipe}>
                    <div className="tasks-editor-header">
                        <h2 className="tasks-editor-title tasks-editor-channel-title">
                            <ChecklistIcon /> {selectedChannel.label}
                            <span className="tasks-editor-server">{selectedChannel.serverName}</span>
                        </h2>
                    </div>
                    <ChecklistBody
                        channelId={selectedChannel.id}
                        subscribeRoom
                        myPerms={selectedChannel.myPerms}
                        currentUserId={currentUserId}
                        resolveUserName={selectedChannel.resolveUserName}
                    />
                </div>
            ) : selectedList ? (
                <div className="tasks-editor" {...contentSwipe}>
                    <div className="tasks-editor-header">
                        {editingTitle ? (
                            <input
                                className="tasks-title-input"
                                value={titleDraft}
                                autoFocus
                                onChange={e => setTitleDraft(e.target.value)}
                                onBlur={commitTitle}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') commitTitle();
                                    if (e.key === 'Escape') setEditingTitle(false);
                                }}
                            />
                        ) : (
                            <h2
                                className="tasks-editor-title"
                                title="Click to rename"
                                onClick={() => {
                                    setTitleDraft(selectedList.title);
                                    setEditingTitle(true);
                                }}
                            >
                                {selectedList.title}
                            </h2>
                        )}
                        {canDeleteList(selectedList) && (
                            <button
                                className="tasks-editor-delete"
                                title={support.trashEnabled ? 'Move this list to the trash' : 'Delete this list'}
                                onClick={() => handleDeleteList(selectedList)}
                            >
                                <TrashIcon />
                            </button>
                        )}
                    </div>

                    <ListContentBlock
                        list={selectedList}
                        features={support.features}
                        onPatch={patchList}
                        coarse={isMobile() || window.matchMedia('(pointer: coarse) and (max-width: 1024px)').matches}
                    />

                    <form className="tasks-add" onSubmit={handleAddTask}>
                        <input
                            type="text"
                            placeholder="Add a task…"
                            value={newTaskText}
                            onChange={e => setNewTaskText(e.target.value)}
                            maxLength={500}
                        />
                        <button type="submit" aria-label="Add task" disabled={!newTaskText.trim()}><PlusIcon /></button>
                    </form>

                    <TaskTree
                        tasks={tasks}
                        onToggle={handleToggle}
                        onDelete={handleDelete}
                        onEdit={handleEdit}
                        onAddSubtask={handleAddSubtask}
                        onMove={handleMove}
                        onReorder={handleReorder}
                        onSetDue={handleSetDue}
                        onSetSchedule={scheduleOn ? handleSetSchedule : undefined}
                        onSetAttachments={handleSetAttachments}
                    />
                </div>
            ) : loading ? (
                <div className="tasks-muted">Loading…</div>
            ) : (
                // Selection points at something that no longer exists
                // (deleted list, left server) — fall back to the board.
                <div className="tasks-editor-empty">
                    <div className="tasks-empty-icon"><FileTextIcon size={40} /></div>
                    <p>That checklist is gone. Pick another above.</p>
                </div>
            )}

            {contextMenu && (
                <ContextMenu
                    items={contextMenu.items}
                    position={contextMenu.position}
                    onClose={hideContextMenu}
                />
            )}

            {filterAnchor && (
                <Popover anchor={filterAnchor} onClose={() => setFilterAnchor(null)} label="Filter notes">
                    <h4>Show</h4>
                    <div className="tasks-filter-menu">
                        <button
                            type="button"
                            className={`tasks-filter-item ${noteFilter.kind === 'all' ? 'active' : ''}`}
                            onClick={() => { setNoteFilter({ kind: 'all' }); setFilterAnchor(null); }}
                        >
                            <NoteIcon /><span className="tasks-filter-label">All notes</span>
                            <span className="tasks-filter-count">{allTabs.length - archivedCount}</span>
                        </button>
                        {noteLabels.map(l => (
                            <button
                                key={l}
                                type="button"
                                className={`tasks-filter-item ${noteFilter.kind === 'label' && noteFilter.label.toLocaleLowerCase() === l.toLocaleLowerCase() ? 'active' : ''}`}
                                onClick={() => { setNoteFilter({ kind: 'label', label: l }); setFilterAnchor(null); }}
                            >
                                <TagIcon /><span className="tasks-filter-label">{l}</span>
                            </button>
                        ))}
                        <button
                            type="button"
                            className={`tasks-filter-item ${noteFilter.kind === 'archive' ? 'active' : ''}`}
                            onClick={() => { setNoteFilter({ kind: 'archive' }); setFilterAnchor(null); }}
                        >
                            <ArchiveIcon /><span className="tasks-filter-label">Archive</span>
                            <span className="tasks-filter-count">{archivedCount}</span>
                        </button>
                    </div>
                </Popover>
            )}
            {picker?.kind === 'color' && (
                <Popover anchor={picker.anchor} onClose={() => setPicker(null)} label="Note colour">
                    <h4>Colour</h4>
                    <ColorPicker
                        value={notePrefs.colors[pickerKey] ?? 'default'}
                        onChange={(c: NoteColor) => setNoteColor(pickerKey, c)}
                    />
                </Popover>
            )}
            {picker?.kind === 'labels' && (
                <Popover anchor={picker.anchor} onClose={() => setPicker(null)} label="Note labels">
                    <LabelPicker
                        all={noteLabels}
                        value={notePrefs.labels[pickerKey] ?? []}
                        onChange={ls => setNoteLabels(pickerKey, ls)}
                    />
                </Popover>
            )}
        </div>
    );
}
