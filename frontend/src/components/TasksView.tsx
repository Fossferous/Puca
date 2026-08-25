/**
 * TasksView — the Tasks dashboard.
 *
 * One Google-Tasks-style tab bar holds EVERY checklist the user can see:
 * their personal lists (Keep style, encrypt-to-self) and every checklist
 * channel across their servers (E2EE under each channel's group key). Tabs
 * drag to reorder (mouse: drag; touch: long-press then drag) and any tab can
 * be favourited from its context menu — favouriting pulls it to the front.
 * Order + favourites persist server-side per user (task_tab_prefs), so they
 * follow the account across devices.
 *
 * The pinned first tab is "All tasks": a board of every list and channel
 * checklist as live interactive cards — the default view when Tasks opens.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
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
    applyToggle,
    applyMove,
    applyReorder,
    collectSubtreeIds,
    serializeTaskAttachments,
    orderTaskTabs,
    isFavoriteTab,
    buildPrefsForOrder,
    toggleFavoritePrefs,
    taskTabKey,
} from '../api/tasks';
import { useServers, keys } from '../hooks/queries';
import { pokeTaskReminders } from '../api/taskReminders';
import { listChannels, listMembersWithRoles, type Channel, type MemberWithRoles, type Server } from '../api/servers';
import { getToken } from '../api/auth';
import { TaskTree } from './TaskTree';
import { ChecklistBody } from './ChecklistBody';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { useContextMenu } from './contextMenuUtils';
import { ChecklistIcon, FileTextIcon, PlusIcon, StarIcon, TasksIcon, TrashIcon } from './Icons';
import { useSwipe } from '../hooks/useSwipe';
import { useDragReorder } from '../hooks/useDragReorder';
import './TasksView.css';
import './AllChecklistsView.css';
import './ServerTasksBoard.css';

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

type Selected = { kind: TaskTabKind; id: number } | null;

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
    const orderedTabs = orderTaskTabs([...listTabs, ...channelTabs], prefs);

    const selectedList = selected?.kind === 'list' ? (lists.find(l => l.id === selected.id) ?? null) : null;
    const selectedChannel = selected?.kind === 'channel'
        ? (orderedTabs.find(t => t.kind === 'channel' && t.id === selected.id) ?? null)
        : null;

    /** Optimistically apply a new pref set and persist it; roll back on error
     *  (an old backend without the endpoint reverts to the fetched order).
     *  Sequenced: two quick edits fire overlapping PUTs, and the FIRST one
     *  failing after the second succeeded must not revert to a snapshot from
     *  before either edit — only the latest save may roll back. */
    const saveSeq = useRef(0);
    const savePrefs = (next: TaskTabPref[]) => {
        const prev = prefs;
        const seq = ++saveSeq.current;
        setPrefs(next);
        putTaskTabPrefs(next).catch(err => {
            console.error('Failed to save tab prefs:', err);
            if (saveSeq.current === seq) setPrefs(prev);
        });
    };

    const toggleFavorite = (tab: BarTab) => {
        savePrefs(toggleFavoritePrefs(orderedTabs, prefs, tab));
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
            savePrefs(buildPrefsForOrder(newOrder, prefs));
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
            setNewListTitle('');
            setAddingList(false);
        } catch (err) {
            console.error('Failed to create list:', err);
        }
    };

    const handleDeleteList = async (list: TaskList) => {
        if (!confirm(`Delete list "${list.title}" and all its tasks?`)) return;
        const original = lists;
        setLists(prev => prev.filter(l => l.id !== list.id));
        if (selected?.kind === 'list' && selected.id === list.id) setSelected(null);
        try {
            await deleteTaskList(list.id);
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
        const next = applyToggle(tasks, task, completed);
        setTasks(next);
        syncListCounts(selectedList.id, next);
        try {
            await updateListTask(task.id, { is_completed: completed });
        } catch (err) {
            console.error('Failed to update task:', err);
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

    /** Context-menu items for a tab/card: favourite always; personal lists
     *  additionally rename + delete. */
    const menuItemsFor = (tab: BarTab): ContextMenuItem[] => {
        const fav = isFavoriteTab(prefs, tab);
        const items: ContextMenuItem[] = [{
            id: 'favorite-tab',
            label: fav ? 'Unfavourite' : 'Favourite',
            icon: 'star',
            onClick: () => toggleFavorite(tab),
        }];
        if (tab.kind === 'list') {
            const list = lists.find(l => l.id === tab.id);
            if (list) {
                items.push(
                    {
                        id: 'rename-list',
                        label: 'Rename List',
                        icon: 'pencil',
                        onClick: () => {
                            setSelected({ kind: 'list', id: list.id });
                            setTitleDraft(list.title);
                            setEditingTitle(true);
                        },
                    },
                    {
                        id: 'delete-list',
                        label: 'Delete List',
                        icon: 'trash',
                        danger: true,
                        onClick: () => handleDeleteList(list),
                    },
                );
            }
        }
        return items;
    };

    const renderTab = (tab: BarTab) => {
        const isActive = selected !== null && selected.kind === tab.kind && selected.id === tab.id;
        const fav = isFavoriteTab(prefs, tab);
        const list = tab.kind === 'list' ? lists.find(l => l.id === tab.id) : undefined;
        return (
            <button
                key={taskTabKey(tab)}
                className={`tasks-tab ${isActive ? 'active' : ''} ${tab.kind === 'channel' ? 'tasks-tab-channel' : ''}`}
                data-drag-key={taskTabKey(tab)}
                data-drag-group="bar"
                onClick={() => { setSelected({ kind: tab.kind, id: tab.id }); }}
                onContextMenu={(e) => showContextMenu(e, menuItemsFor(tab))}
                title={tab.kind === 'channel' ? `#${tab.label} in ${tab.serverName}` : tab.label}
            >
                {fav && <StarIcon className="tasks-tab-star" />}
                {tab.kind === 'channel' && <ChecklistIcon className="tasks-tab-kind" />}
                <span className="tasks-tab-title">{tab.label}</span>
                {list && list.total_tasks > 0 && (
                    <span className="tasks-tab-count">{list.completed_tasks}/{list.total_tasks}</span>
                )}
            </button>
        );
    };

    /** One interactive board card (used by the All-tasks view). */
    const renderCard = (tab: BarTab) => {
        const fav = isFavoriteTab(prefs, tab);
        const list = tab.kind === 'list' ? lists.find(l => l.id === tab.id) : undefined;
        return (
            <section className="checklist-card" key={taskTabKey(tab)}>
                <header
                    className="checklist-card-header"
                    role="button"
                    title="Open"
                    onClick={() => { setSelected({ kind: tab.kind, id: tab.id }); scrollActiveTabIntoView(); }}
                    onContextMenu={(e) => showContextMenu(e, menuItemsFor(tab))}
                >
                    {tab.kind === 'list' ? <FileTextIcon /> : <ChecklistIcon />} {tab.label}
                    {fav && <StarIcon className="tasks-tab-star" />}
                    <span className="tasks-card-sub">
                        {tab.kind === 'channel'
                            ? tab.serverName
                            : list && list.total_tasks > 0 ? `${list.completed_tasks}/${list.total_tasks}` : ''}
                    </span>
                </header>
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

    return (
        <div className="tasks-view-outer">
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
                        onClick={() => { setAddingList(true); }}
                    >
                        <PlusIcon />
                    </button>
                </div>
            </div>

            {selected === null ? (
                // The All-tasks board: every list + channel checklist as a
                // live card, in bar order (favourites lead after favouriting).
                loading ? (
                    <div className="tasks-muted">Loading…</div>
                ) : orderedTabs.length === 0 ? (
                    <div className="tasks-editor-empty" {...contentSwipe}>
                        <div className="tasks-empty-icon"><FileTextIcon size={40} /></div>
                        <p>Create a list with New list, above — or make any text channel a checklist and it will show up here.</p>
                    </div>
                ) : (
                    <div className="server-tasks-scroll tasks-all-scroll" {...contentSwipe}>
                        <div className="all-checklists-grid server-tasks-grid">
                            {orderedTabs.map(renderCard)}
                        </div>
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
                        <button
                            className="tasks-editor-delete"
                            title="Delete this list"
                            onClick={() => handleDeleteList(selectedList)}
                        >
                            <TrashIcon />
                        </button>
                    </div>

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
        </div>
    );
}
