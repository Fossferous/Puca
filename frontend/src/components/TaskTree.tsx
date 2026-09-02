/**
 * TaskTree — shared checklist renderer (Google Keep style).
 *
 * Renders tasks as an arbitrarily-nested tree (server caps the depth at
 * MAX_TASK_DEPTH), with a per-item "add subtask" affordance, inline text
 * editing, and a collapsible Completed section. Used by both the channel
 * ChecklistPanel and the personal TasksView; all mutations are delegated to
 * the owner via callbacks so each panel keeps its own optimistic state.
 */

import { isUndecryptable } from '../api/decryptMarkers';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
    type Task, type TaskNode, type TaskAttachmentRef,
    buildTaskTree, parseTaskAttachments, isAttachmentsLocked, canEditTask, collectSubtreeIds,
    dueToLocalInput, localInputToIso, isTaskOverdue, formatDueShort, planDropTarget,
    MAX_TASK_DEPTH, MAX_TASK_ATTACHMENTS,
} from '../api/tasks';

/** Horizontal travel per indent step while dragging a row — matches the
 *  tree's own 24px per-level padding (TaskTree.css .tt-children), so the
 *  gesture distance IS the visual indent it produces. */
const INDENT_PX = 24;
import { PERM, hasPerm } from '../api/permissionBits';
import { encryptAndUploadRef } from '../api/attachments';
import { ApiError } from '../api/client';
import { TaskAttachments } from './TaskAttachments';
import { useDragReorder } from '../hooks/useDragReorder';
import {
    ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, ClockIcon, GripIcon, LockIcon,
    MapPinIcon, PaperclipIcon, PendingIcon, PlusIcon, TrashIcon, WarningIcon,
} from './Icons';
import './TaskTree.css';
import { parseServerTimestamp } from '../utils/serverTime';
import { isAndroidApp } from '../api/platform';
import { loadSettings } from './settingsStore';
import {
    type TaskPlace, DEFAULT_PLACE_RADIUS_M,
    assignTaskPlace, createPlace, getTaskPlace, listPlaces, placesVersion,
    subscribePlaces, unassignTasks,
} from '../api/taskPlaces';
import { currentPosition, mobileLocationAvailable } from '../api/mobileLocation';

// Shared 30-second clock for overdue styling. The snapshot is quantized so it
// is referentially stable between ticks (useSyncExternalStore re-renders only
// when the snapshot value changes).
function subscribeHalfMinute(onTick: () => void): () => void {
    const id = window.setInterval(onTick, 30_000);
    return () => window.clearInterval(id);
}
function halfMinuteNow(): number {
    return Math.floor(Date.now() / 30_000) * 30_000;
}

const NEW_PLACE = '__new__';

/**
 * Inline place picker for a row (Android only — the geofence engine lives in
 * the APK). Places are DEVICE-LOCAL (taskPlaces.ts): assigning one is this
 * phone's own reminder state, not an edit to the task, which is why the
 * picker appears without edit permission and writes the store directly
 * instead of going through the owner's mutation callbacks.
 *
 * A new place is captured where the user is standing — one GPS fix, no map
 * picker. A map would need a tile server, and every tile request tells that
 * server where you are looking; standing there tells no one anything.
 */
function PlacePicker({ task, onDone }: { task: Task; onDone: () => void }) {
    const assigned = getTaskPlace(task.id);
    // Snapshot at open — the picker is short-lived and owns its own edits.
    const [places] = useState<TaskPlace[]>(listPlaces);
    const [choice, setChoice] = useState<string>(assigned?.id ?? places[0]?.id ?? NEW_PLACE);
    const [label, setLabel] = useState('');
    const [radius, setRadius] = useState(DEFAULT_PLACE_RADIUS_M);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const commit = async () => {
        if (choice !== NEW_PLACE) {
            assignTaskPlace(task.id, choice);
            onDone();
            return;
        }
        setBusy(true);
        setError(null);
        const fix = await currentPosition();
        if (!fix) {
            setBusy(false);
            setError('No location fix — check location is on and Púca is allowed to use it.');
            return;
        }
        // An approximate-only grant (Android 12+) fixes at ~2 km: a place
        // saved from that can never trigger (the engine distrusts fixes this
        // loose), so refuse loudly now instead of failing silently forever.
        if (fix.accuracy > 200) {
            setBusy(false);
            setError(`Location fix too imprecise (±${Math.round(fix.accuracy)} m) — `
                + 'allow PRECISE location for Púca and try again.');
            return;
        }
        const place = createPlace(label, fix.lat, fix.lon, radius);
        assignTaskPlace(task.id, place.id);
        setBusy(false);
        onDone();
    };

    return (
        <div
            className="tt-place-edit"
            onKeyDown={e => {
                if (e.key === 'Escape') {
                    // Same as the due editor: the app-level Escape handlers
                    // must not fire before the editor closes.
                    e.preventDefault();
                    e.stopPropagation();
                    onDone();
                }
            }}
        >
            <select value={choice} onChange={e => setChoice(e.target.value)} autoFocus>
                {places.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                <option value={NEW_PLACE}>New place (right here)…</option>
            </select>
            {choice === NEW_PLACE && (
                <>
                    <input
                        className="tt-place-label"
                        placeholder="Name this place…"
                        value={label}
                        maxLength={60}
                        onChange={e => setLabel(e.target.value)}
                    />
                    <select value={radius} onChange={e => setRadius(Number(e.target.value))}>
                        <option value={100}>100 m</option>
                        <option value={150}>150 m</option>
                        <option value={300}>300 m</option>
                        <option value={1000}>1 km</option>
                    </select>
                </>
            )}
            <button className="tt-btn tt-due-set" disabled={busy} onClick={() => void commit()}>
                {busy ? 'Locating…' : 'Set'}
            </button>
            {assigned && (
                <button
                    className="tt-btn tt-delete"
                    onClick={() => { assignTaskPlace(task.id, null); onDone(); }}
                >
                    Clear
                </button>
            )}
            {error && <span className="tt-place-error">{error}</span>}
        </div>
    );
}

interface TaskTreeProps {
    tasks: Task[];
    onToggle: (task: Task, completed: boolean) => void;
    onDelete: (taskId: number) => void;
    onEdit: (task: Task, description: string) => void;
    onAddSubtask: (parentId: number, description: string) => void;
    onMove: (task: Task, direction: 'up' | 'down') => void;
    /** Drag-drop reorder among visible siblings: land immediately after
     *  `afterId` (null = first). When provided, rows grow a grip handle; the
     *  one-slot arrow buttons stay as the coarse-pointer fallback.
     *  `reparent` (W4 drag-to-nest, needs an S1 server): the drop also moves
     *  the task under a different parent — the planDropTarget verdict from
     *  the drag's horizontal indent. */
    onReorder?: (task: Task, afterId: number | null, reparent?: { parentId: number | null }) => void;
    /** Set or clear a task's due time (ISO string; null clears). When
     *  provided, editable rows grow a clock action + due chip. */
    onSetDue?: (task: Task, dueAt: string | null) => void;
    /** Replace a task's full attachment list (add and remove both land here). */
    onSetAttachments: (task: Task, refs: TaskAttachmentRef[]) => void;
    /** Resolved channel permission bits (Channel.my_permissions). undefined =
     *  everything allowed — personal lists and servers that don't return bits
     *  yet (hasPerm's backward-compat fallback). */
    myPerms?: number;
    /** Caller's user id; creator-only actions (edit/move/delete/attach without
     *  MANAGE_TASKS) compare against task.created_by. */
    currentUserId?: number;
    /** Attribution: user id → display name. Provided for channel checklists;
     *  omitted for personal lists (every task is the owner's own). */
    resolveUserName?: (id: number) => string | undefined;
    /** Channel checklists name their channel on attachment uploads so the
     *  server can honour ATTACH_FILES at the upload door. Personal lists omit it. */
    channelId?: number;
}

export function TaskTree({
    tasks, onToggle, onDelete, onEdit, onAddSubtask, onMove, onReorder, onSetDue, onSetAttachments,
    myPerms, currentUserId, resolveUserName, channelId,
}: TaskTreeProps) {
    const [showCompleted, setShowCompleted] = useState(true);
    const [subtaskFor, setSubtaskFor] = useState<number | null>(null);
    const [subtaskText, setSubtaskText] = useState('');
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editText, setEditText] = useState('');
    // Row with its due-time editor open, and the datetime-local draft value.
    const [dueFor, setDueFor] = useState<number | null>(null);
    const [dueDraft, setDueDraft] = useState('');
    // Row with its place picker open (Android location reminders).
    const [placeFor, setPlaceFor] = useState<number | null>(null);
    // Place chips read the device-local store directly; this subscription is
    // what re-renders them after the picker (or a prune) writes it.
    useSyncExternalStore(subscribePlaces, placesVersion, placesVersion);
    // The pin affordance appears only once the user opted in via Settings
    // (which owns the permission flow); chips for already-assigned places
    // stay visible regardless so existing state is never invisible.
    const placesOn = isAndroidApp() && mobileLocationAvailable() && loadSettings().locationReminders;
    // Attach flow: one hidden file input serves every row; the attach click
    // stores its task here before opening the picker. uploadingIds is a SET (not a
    // single slot) so a second row's upload finishing can't re-enable a row
    // whose upload is still in flight.
    const [uploadingIds, setUploadingIds] = useState<Set<number>>(new Set());
    const fileInputRef = useRef<HTMLInputElement>(null);
    const attachTarget = useRef<Task | null>(null);
    // Latest tasks, read at upload-completion time so the sidecar is merged
    // against current state (which may hold a concurrent edit refetched over WS)
    // rather than the stale click-time snapshot.
    const tasksRef = useRef<Task[]>(tasks);
    // Keep the ref current via an effect rather than writing it during render
    // (refs must not be mutated in render). The ref is only read later, at
    // upload-completion time, so an effect-lag frame doesn't matter.
    useEffect(() => { tasksRef.current = tasks; }, [tasks]);

    // Completed tasks shed their device-local place assignment: a fence for a
    // finished errand must stop firing even when it was completed on ANOTHER
    // device (this effect observes it on the next load here). Deletion is
    // handled at the delete button; remote deletions this view never renders
    // again are the accepted leak — the Settings "delete all" wipe bounds it.
    useEffect(() => {
        if (!isAndroidApp()) return;
        const done = tasks.filter(t => t.is_completed).map(t => t.id);
        if (done.length > 0) unassignTasks(done);
    }, [tasks]);

    const tree = buildTaskTree(tasks);
    const active = tree.filter(n => !n.task.is_completed);
    const completed = tree.filter(n => n.task.is_completed);

    // Drag-drop reorder among same-group siblings (same parent, same
    // completion state — the same constraint the server enforces), plus the
    // W4 horizontal indent: one INDENT_PX step right while dropping nests the
    // task under the row above; one step left un-nests to the grandparent.
    // planDropTarget turns the gesture into a plan (degrading every
    // impossible indent to the plain drop), so this stays a thin wire. Drags
    // start from the grip handle only, so click-to-edit and scrolling stay
    // intact. Destructured on purpose — see the setContainer note in
    // useDragReorder.
    const { state: dragState, setContainer: setDragContainer, onPointerDown: onDragPointerDown } = useDragReorder({
        axis: 'y',
        handleSelector: '.tt-grip',
        touchHoldMs: 0, // the grip has touch-action: none — no scroll to fight
        crossStepPx: INDENT_PX,
        enabled: !!onReorder,
        onDrop: ({ key, order, insertAt, crossDelta, sameSlot }) => {
            const task = tasksRef.current.find(t => t.id === Number(key));
            if (!task || !onReorder) return;
            const indent = Math.max(-1, Math.min(1, Math.trunc(crossDelta / INDENT_PX)));
            const plan = planDropTarget(
                tasksRef.current, task, order.map(Number), insertAt, indent, sameSlot,
            );
            // null = a same-slot drop whose indent degraded: nothing to do,
            // and the plain plan would renumber + broadcast a non-change.
            if (plan) onReorder(task, plan.afterId, plan.reparent);
        },
    });

    // Permission gates. Missing bits HIDE affordances (except the checkbox,
    // which stays visible but disabled so the list still reads as a checklist).
    const canCreate = hasPerm(myPerms, PERM.CREATE_TASKS);
    // MANAGE_TASKS implies completion rights, matching the backend rule.
    const canComplete = hasPerm(myPerms, PERM.COMPLETE_TASKS) || hasPerm(myPerms, PERM.MANAGE_TASKS);
    const canEdit = (task: Task) => canEditTask(task, currentUserId, myPerms);

    /** Attribution name for a row, or null when no resolver was threaded
     *  (personal lists). Departed members degrade to "user #<id>". */
    const bylineFor = (task: Task): string | null =>
        resolveUserName ? (resolveUserName(task.created_by) ?? `user #${task.created_by}`) : null;

    const startEdit = (task: Task) => {
        // A failure marker is not text to edit: the editor would prefill with it
        // and a save would replace the real (still encrypted) item. The seal
        // layer refuses too; this just keeps the editor from opening on it.
        if (isUndecryptable(task.description)) return;
        setEditingId(task.id);
        setEditText(task.description);
    };

    const commitEdit = (task: Task) => {
        const text = editText.trim();
        setEditingId(null);
        if (text && text !== task.description) {
            onEdit(task, text);
        }
    };

    const commitSubtask = (parentId: number) => {
        const text = subtaskText.trim();
        if (text) {
            onAddSubtask(parentId, text);
            setSubtaskText('');
            // Keep the input open so several subtasks can be added in a row.
        }
    };

    // Overdue styling compares against a 30s-quantized clock via
    // useSyncExternalStore — the sanctioned way to read time in render
    // (Date.now() bare is an impure render call), and it keeps chips flipping
    // red live while the list is open. The reminder LOOP, not this component,
    // is what fires notifications.
    const now = useSyncExternalStore(subscribeHalfMinute, halfMinuteNow, halfMinuteNow);

    const commitDue = (task: Task) => {
        setDueFor(null);
        const iso = localInputToIso(dueDraft);
        if (iso === null && dueDraft.trim() !== '') return; // unparseable — keep as-is
        if (dueToLocalInput(task.due_at) === dueDraft) return; // unchanged
        onSetDue?.(task, iso);
    };

    const pickAttachments = (task: Task) => {
        attachTarget.current = task;
        fileInputRef.current?.click();
    };

    // Refuse to attach when the current sidecar can't be read: overwriting it
    // would orphan the encrypted refs the viewer merely lacks the key for.
    const LOCKED_MSG = "This task's attachments can't be read yet (encryption key unavailable). "
        + 'Adding files now would delete the existing ones — try again once you can see them '
        + '(reload if you just regained access).';

    const handleFilesChosen = async (files: File[]) => {
        const task = attachTarget.current;
        attachTarget.current = null;
        if (!task || files.length === 0) return;
        // Already uploading to this task — don't start an overlapping replace.
        if (uploadingIds.has(task.id)) return;
        if (isAttachmentsLocked(task.attachments)) { alert(LOCKED_MSG); return; }

        const startExisting = parseTaskAttachments(task.attachments);
        if (startExisting.length + files.length > MAX_TASK_ATTACHMENTS) {
            alert(`A task can hold at most ${MAX_TASK_ATTACHMENTS} attachments.`);
            return;
        }

        setUploadingIds(prev => new Set(prev).add(task.id));
        const added: TaskAttachmentRef[] = [];
        const failures: string[] = [];
        // A 403 is the ATTACH_FILES role gate: the server's own sentence says
        // why, and "under 10 MB" would be a lie.
        let refusal: string | null = null;
        // Sequential: each file is encrypted + uploaded on its own, and failures
        // (over the 10 MB cap, network) are surfaced per file at the end.
        for (const file of files) {
            try {
                const { href, name } = await encryptAndUploadRef(file, { channelId });
                added.push({ href, name });
            } catch (err) {
                console.error('Failed to attach file:', file.name, err);
                failures.push(file.name);
                if (err instanceof ApiError && err.status === 403) refusal = err.message;
            }
        }
        setUploadingIds(prev => { const n = new Set(prev); n.delete(task.id); return n; });

        if (added.length > 0) {
            // Merge against the task's CURRENT sidecar (uploads can take tens of
            // seconds; another member's edit may have arrived over WS), not the
            // click-time snapshot — re-check the lock and dedupe by href so a
            // concurrent change isn't clobbered.
            const current = tasksRef.current.find(t => t.id === task.id) ?? task;
            if (isAttachmentsLocked(current.attachments)) { alert(LOCKED_MSG); return; }
            const existing = parseTaskAttachments(current.attachments);
            const byHref = new Map<string, TaskAttachmentRef>();
            for (const r of [...existing, ...added]) if (!byHref.has(r.href)) byHref.set(r.href, r);
            onSetAttachments(task, Array.from(byHref.values()).slice(0, MAX_TASK_ATTACHMENTS));
        }
        if (failures.length > 0) {
            alert(`Failed to attach: ${failures.join(', ')}. ${refusal ?? 'Files must be under 10 MB.'}`);
        }
    };

    const renderRow = (task: Task, depth: number) => {
        const uploading = uploadingIds.has(task.id);
        const locked = isAttachmentsLocked(task.attachments);
        const editable = canEdit(task);
        const byline = bylineFor(task);
        // Device-local; empty everywhere except an Android phone that saved one.
        const place = isAndroidApp() ? getTaskPlace(task.id) : null;
        return (
        <li
            key={task.id}
            className={`tt-item ${task.is_completed ? 'completed' : ''} ${depth > 0 ? 'subtask' : ''}`}
            title={byline ? `Added by ${byline} · ${new Date(parseServerTimestamp(task.created_at)).toLocaleDateString()}` : undefined}
        >
            {/* Ghost keeps the checkbox column aligned on rows that can't
                drag (completed, not yours) when the tree is reorderable. */}
            {onReorder && (
                !task.is_completed && editable
                    ? <span className="tt-grip" title="Drag to reorder"><GripIcon /></span>
                    : <span className="tt-grip tt-grip-ghost" aria-hidden="true" />
            )}
            <input
                type="checkbox"
                checked={task.is_completed}
                disabled={!canComplete}
                title={canComplete ? undefined : 'No permission to complete tasks'}
                onChange={() => onToggle(task, !task.is_completed)}
            />
            {editingId === task.id ? (
                <input
                    className="tt-edit-input"
                    value={editText}
                    autoFocus
                    onChange={e => setEditText(e.target.value)}
                    onBlur={() => commitEdit(task)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') commitEdit(task);
                        if (e.key === 'Escape') setEditingId(null);
                    }}
                />
            ) : editable ? (
                <span className="tt-description" onClick={() => startEdit(task)} title="Click to edit">
                    {task.description}
                </span>
            ) : (
                <span className="tt-description">{task.description}</span>
            )}
            {/* Flag a checklist item the server stored as plaintext (never
                encrypted) — audit H-1. Everything else here is E2EE, so an
                injected cleartext item would otherwise be indistinguishable. */}
            {task.descEncState === 'legacy' && editingId !== task.id && (
                <span className="tt-not-encrypted" title="Not encrypted — this item was stored as plaintext, not end-to-end encrypted.">
                    <WarningIcon /> Not encrypted
                </span>
            )}
            {/* Due chip: red once the deadline passes on an open task. */}
            {task.due_at && editingId !== task.id && (
                <span
                    className={`tt-due ${isTaskOverdue(task, now) ? 'overdue' : ''}`}
                    title={`Due ${new Date(parseServerTimestamp(task.due_at)).toLocaleString()}`}
                >
                    {/* Label span so the text can ellipsize — text-overflow
                        doesn't apply to a flex container's anonymous items. */}
                    <ClockIcon /><span className="tt-due-label">{formatDueShort(task.due_at, now)}</span>
                </span>
            )}
            {/* Place chip: this phone reminds when it arrives there. The label
                is the user's own device-local text — in-app UI only, never in
                the notification. */}
            {place && !task.is_completed && editingId !== task.id && (
                <span className="tt-place" title={`Reminds on this phone near "${place.label}"`}>
                    <MapPinIcon /><span className="tt-due-label">{place.label}</span>
                </span>
            )}
            {/* Coarse pointer only (CSS): hover titles don't exist on touch,
                so attribution gets a tiny inline byline instead. */}
            {byline && editingId !== task.id && (
                <span className="tt-byline">· {byline}</span>
            )}
            <div className="tt-actions">
                {/* One-slot arrows: kept as the coarse-pointer fallback; CSS
                    hides them on fine pointers whenever the row has a grip
                    (drag is the desktop way to reorder). */}
                {!task.is_completed && editable && (
                    <>
                        <button className="tt-btn tt-move" title="Move up" onClick={() => onMove(task, 'up')}>
                            <ChevronUpIcon />
                        </button>
                        <button className="tt-btn tt-move" title="Move down" onClick={() => onMove(task, 'down')}>
                            <ChevronDownIcon />
                        </button>
                    </>
                )}
                {/* Any task can hold subtasks until the depth cap. */}
                {!task.is_completed && canCreate && depth < MAX_TASK_DEPTH - 1 && (
                    <button
                        className="tt-btn"
                        title="Add subtask"
                        onClick={() => {
                            setSubtaskFor(subtaskFor === task.id ? null : task.id);
                            setSubtaskText('');
                        }}
                    >
                        <PlusIcon />
                    </button>
                )}
                {!task.is_completed && editable && onSetDue && (
                    <button
                        className="tt-btn"
                        title={task.due_at ? 'Edit due time' : 'Add due time'}
                        onClick={() => {
                            if (dueFor === task.id) { setDueFor(null); return; }
                            setDueFor(task.id);
                            setDueDraft(dueToLocalInput(task.due_at));
                        }}
                    >
                        <ClockIcon />
                    </button>
                )}
                {/* NOT gated on `editable`: the place is this phone's own
                    reminder state, so a member who can't edit a shared task
                    can still be reminded at their own saved place. */}
                {!task.is_completed && placesOn && (
                    <button
                        className="tt-btn"
                        title={place ? 'Edit place reminder' : 'Remind at a place'}
                        onClick={() => setPlaceFor(placeFor === task.id ? null : task.id)}
                    >
                        <MapPinIcon />
                    </button>
                )}
                {!task.is_completed && editable && (
                    <button
                        className="tt-btn"
                        title={locked ? "Attachments locked — key unavailable" : "Attach picture/video"}
                        disabled={uploading || locked}
                        onClick={() => pickAttachments(task)}
                    >
                        {uploading ? <PendingIcon /> : <PaperclipIcon />}
                    </button>
                )}
                {/* Trash, not a cross: this deletes the task, and Delete is TrashIcon
                    everywhere else (message menu, checklist, invite). This row used a
                    bare cross glyph before the icon migration, which is why it differed. */}
                {editable && (
                    <button
                        className="tt-btn tt-delete"
                        title="Delete"
                        onClick={() => {
                            // Device-local place assignments die with the
                            // subtree (children cascade server-side too).
                            if (isAndroidApp()) unassignTasks(collectSubtreeIds(tasksRef.current, task.id));
                            onDelete(task.id);
                        }}
                    >
                        <TrashIcon />
                    </button>
                )}
            </div>
        </li>
        );
    };

    const renderNode = (node: TaskNode, depth: number): ReactNode => {
        const locked = isAttachmentsLocked(node.task.attachments);
        const attachRefs = parseTaskAttachments(node.task.attachments);
        // A whole group (row + subtasks + attachments) drags as one unit.
        // Completed and non-editable rows carry no attrs, so the drag can
        // neither start from them nor land between them.
        const draggable = !!onReorder && !node.task.is_completed && canEdit(node.task);
        return (
        <div
            key={node.task.id}
            className="tt-group"
            data-drag-key={draggable ? String(node.task.id) : undefined}
            data-drag-group={draggable ? String(node.task.parent_id ?? 'root') : undefined}
        >
            {renderRow(node.task, depth)}
            {dueFor === node.task.id && (
                <div className="tt-due-edit">
                    <input
                        type="datetime-local"
                        value={dueDraft}
                        autoFocus
                        onChange={e => setDueDraft(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') commitDue(node.task);
                            if (e.key === 'Escape') {
                                // Keep app-level Escape handlers from firing
                                // before the editor closes (same as subtasks).
                                e.preventDefault();
                                e.stopPropagation();
                                setDueFor(null);
                            }
                        }}
                    />
                    <button className="tt-btn tt-due-set" onClick={() => commitDue(node.task)}>Set</button>
                    {node.task.due_at && (
                        <button
                            className="tt-btn tt-delete"
                            onClick={() => { setDueFor(null); onSetDue?.(node.task, null); }}
                        >
                            Clear
                        </button>
                    )}
                </div>
            )}
            {placeFor === node.task.id && (
                <PlacePicker task={node.task} onDone={() => setPlaceFor(null)} />
            )}
            {locked ? (
                <div className="tt-attach-row">
                    <span className="tt-attach-locked" title="You don't have the key to decrypt this task's attachments yet">
                        <LockIcon /> Attachments locked — key unavailable
                    </span>
                </div>
            ) : attachRefs.length > 0 && (
                <div className="tt-attach-row">
                    <TaskAttachments
                        refs={attachRefs}
                        canEdit={canEdit(node.task)}
                        onRemove={i => onSetAttachments(node.task, attachRefs.filter((_, idx) => idx !== i))}
                    />
                </div>
            )}
            {(node.children.length > 0 || subtaskFor === node.task.id) && (
                <div className="tt-nest">
                    {node.children.map(child => renderNode(child, depth + 1))}
                    {subtaskFor === node.task.id && (
                        <div className="tt-subtask-add">
                            <input
                                value={subtaskText}
                                autoFocus
                                placeholder="Add a subtask…"
                                onChange={e => setSubtaskText(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') commitSubtask(node.task.id);
                                    if (e.key === 'Escape') {
                                        // Stop the app-level Escape handlers (modal
                                        // close, etc.) from swallowing the event
                                        // before the input closes.
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setSubtaskFor(null);
                                    }
                                }}
                                onBlur={() => {
                                    commitSubtask(node.task.id);
                                    setSubtaskFor(null);
                                }}
                            />
                        </div>
                    )}
                </div>
            )}
        </div>
        );
    };

    return (
        <div
            className={`task-tree ${onReorder ? 'tt-can-drag' : ''} ${dragState.dragging ? 'tt-drag-live' : ''}`}
            ref={setDragContainer}
            onPointerDown={onDragPointerDown}
        >
            {dragState.indicator && (() => {
                // The indent gesture telegraphs on the drop line itself: a
                // nest shifts (and shortens) the line one level with a cap
                // mark; an un-nest dashes it. Derived from the SAME
                // planDropTarget the drop will run — the raw crossSteps
                // promised indents the plan then refused (top slot, depth,
                // cycle), and a line asserting an indent that will not take
                // is worse than no cue (review W4-F2).
                const indent = Math.max(-1, Math.min(1, dragState.crossSteps));
                // The PROP, not tasksRef: refs may not be read in render,
                // and during a live drag the prop is equally current.
                const draggedTask = indent !== 0 && dragState.dragging
                    ? tasks.find(t => t.id === Number(dragState.dragging!.key))
                    : undefined;
                const plan = draggedTask
                    ? planDropTarget(
                        tasks, draggedTask,
                        dragState.order.map(Number), dragState.insertAt, indent, false,
                    )
                    : null;
                const effective = plan?.reparent ? indent : 0;
                const shift = effective > 0 ? INDENT_PX : 0;
                return (
                    <div
                        className={`tt-drop-indicator ${effective > 0 ? 'tt-drop-nest' : effective < 0 ? 'tt-drop-unnest' : ''}`}
                        style={{
                            left: dragState.indicator.x + shift,
                            top: dragState.indicator.y,
                            width: Math.max(dragState.indicator.width - shift, 8),
                            height: dragState.indicator.height,
                        }}
                    />
                );
            })()}
            <ul className="tt-list">{active.map(n => renderNode(n, 0))}</ul>

            {completed.length > 0 && (
                <div className="tt-completed-section">
                    <button className="tt-toggle-completed" onClick={() => setShowCompleted(!showCompleted)}>
                        {showCompleted ? <ChevronDownIcon /> : <ChevronRightIcon />} Completed ({completed.length})
                    </button>
                    {showCompleted && <ul className="tt-list completed">{completed.map(n => renderNode(n, 0))}</ul>}
                </div>
            )}

            {tasks.length === 0 && (
                <div className="tt-empty">{canCreate ? 'No tasks yet. Add one above!' : 'No tasks yet.'}</div>
            )}

            {/* Shared picker for the per-row attach buttons (target in attachTarget). */}
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                style={{ display: 'none' }}
                onChange={e => {
                    // Snapshot before the reset — the FileList is live.
                    const files = e.target.files ? Array.from(e.target.files) : [];
                    e.target.value = ''; // re-picking the same file must re-fire
                    handleFilesChosen(files);
                }}
            />
        </div>
    );
}
