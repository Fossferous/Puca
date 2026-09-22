/**
 * The open note: Púca's TaskTree, with every callback wired, inside a Notes
 * frame (title, chips, add-item row ON TOP like Púca's Tasks editor — a
 * bottom-docked input sits under the Android keyboard — and the Notes tools
 * in a footer). This is the "shares task layouts" requirement made literal:
 * the rows, the nesting, the drag/nest gesture, due editor, attachments and
 * completed section are the same component Púca renders.
 *
 * Portaled to document.body: a modal on desktop, full-screen on a phone
 * (notes.css), and never inside the drawer's transform.
 *
 * Escape closes the editor — but only when it was not aimed at an input:
 * TaskTree's inline item editor cancels on Escape WITHOUT stopping
 * propagation (its other three editors do), so a window-level close would
 * swallow that cancel. isEditableTarget is the guard.
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { type Task } from '../../api/tasks';
import { currentUserIdFromToken } from '../../api/auth';
import { isEditableTarget } from '../../api/hotkeys';
import { isUndecryptable } from '../../api/decryptMarkers';
import { TaskTree } from '../../components/TaskTree';
import {
    ArchiveIcon, CloseIcon, LockIcon, MembersIcon, MoreVerticalIcon, PaletteIcon, PinIcon, PlusIcon, PopOutIcon,
    RefreshIcon, TagIcon, WarningIcon,
} from '../../components/Icons';
import { PERM, hasPerm } from '../../api/permissionBits';
import { MAX_ITEM_LENGTH, MAX_TITLE_LENGTH, type NoteCard } from '../model/notesModel';
import { type NoteActions, useNoteTasks } from '../model/notesQueries';
import { NoteContentSection } from './NoteContentSection';
import { ListActionsMenu } from './ListActionsMenu';
import { PastedLinesDialog } from './PastedLinesDialog';
import { linesFromPaste, pasteAsOneLine } from '../model/noteContent';
import { PACE_MS } from '../../api/icsImport';
import { pushMessageToast } from '../../components/messageToastBus';
import { useTaskFeature } from '../../api/taskFeatures';
import { NoteDueChip, NoteReminderControl } from '../../components/schedule/NoteReminderControl';
import { halfMinuteNow, subscribeHalfMinute } from '../../components/schedule/halfMinuteClock';
import { EditedStamp } from './EditedStamp';

const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms); });

interface NoteEditorProps {
    card: NoteCard;
    actions: NoteActions;
    onClose: () => void;
    onMenu: (e: React.MouseEvent, card: NoteCard, anchor: HTMLElement) => void;
    onPickColor: (card: NoteCard, anchor: HTMLElement) => void;
    onPickLabels: (card: NoteCard, anchor: HTMLElement) => void;
    /** Archive/unarchive through the owner (Undo snackbar). */
    onArchive: (card: NoteCard, archived: boolean) => void;
    /** Where this note lives in Púca (web only; null hides the link). */
    pucaHref: string | null;
    /** A layer above the editor is open (context menu, popover, dialog):
     *  Escape belongs to it, not to us. The context menu closes on Escape
     *  from a bubble-phase listener of its own without stopping propagation,
     *  so without this both would close on one keypress. */
    escapeBlocked?: boolean;
    /** The one item a due notification came for: TaskTree flashes that row. */
    flashTaskId?: number | null;
}

export function NoteEditor({ card, actions, onClose, onMenu, onPickColor, onPickLabels, onArchive, pucaHref, escapeBlocked = false, flashTaskId = null }: NoteEditorProps) {
    const ref = card.ref;
    // Its own query subscription with `live` so a shared note polls while open.
    const tasksQuery = useNoteTasks(ref, { live: true });
    const tasks: Task[] = tasksQuery.data ?? card.tasks ?? [];
    const [newItem, setNewItem] = useState('');
    const [titleDraft, setTitleDraft] = useState(card.title);
    // A rename that landed from elsewhere (another device, a refetch) replaces
    // the draft — the "adjust state while rendering" pattern, not an effect —
    // UNLESS this title is being typed right now. Without that guard a rename
    // arriving mid-keystroke wiped what the user was writing, with no way to
    // get it back; the note's text has never behaved that way
    // (components/NoteBodyField.tsx) and the title should not either.
    const [titleDirty, setTitleDirty] = useState(false);
    const [seenTitle, setSeenTitle] = useState(card.title);
    if (seenTitle !== card.title) {
        setSeenTitle(card.title);
        if (!titleDirty) setTitleDraft(card.title);
    }
    // THE BASE IS TAKEN WHEN TYPING STARTS, exactly as the note's text takes
    // it (components/NoteBodyField.tsx). Keeping the draft is only half the
    // protection: the rename that follows must also name the revision it was
    // written on top of. Reading the card's revision at COMMIT time would
    // read the one the refetch above just moved to the OTHER device's — and
    // the commit would then be accepted and destroy their rename with no
    // refusal, no banner and no toast.
    const titleBase = useRef<number | undefined>(card.contentRev);
    const markTitleDirty = () => {
        if (!titleDirty) titleBase.current = card.contentRev;   // the committed render's value
        setTitleDirty(true);
    };
    const addRef = useRef<HTMLInputElement>(null);
    // Not Date.now() in render: the chip must flip to "overdue" while the
    // note is open, and an impure render call fails the lint gate.
    const now = useSyncExternalStore(subscribeHalfMinute, halfMinuteNow, halfMinuteNow);
    const currentUserId = currentUserIdFromToken() ?? undefined;
    const isChannel = ref.kind === 'channel';
    const canCreate = !isChannel || hasPerm(card.myPerms, PERM.CREATE_TASKS);
    const titleUnreadable = isUndecryptable(card.title);
    // Date & repeat only against a server that stores it (an older one would
    // drop the field silently); unknown = hidden.
    const canSchedule = useTaskFeature('schedule') === true;
    const onSetSchedule = canSchedule
        ? (t: Task, schedule: string | null, due: string | null) => void actions.setSchedule(ref, t, schedule, due)
        : undefined;
    // Snooze on the item itself, the same control the Reminders list and the
    // calendar offer (NoteActions.snoozeTask already resolves who may move
    // the plaintext due_at).
    const onSnooze = useTaskFeature('snooze')
        ? (t: Task, until: number | null) => void actions.snoozeTask(ref, t, until)
        : undefined;
    // The NOTE's own reminder, on a server that stores one. Personal notes
    // only: a channel checklist has no list row to hang a time on.
    const noteReminders = !isChannel && actions.content.features.noteReminders;

    // useLayoutEffect, not useEffect: the listener must exist the moment the
    // dialog is in the DOM. A keyboard user who opened the note with Enter can
    // press Escape within the same frame, and a listener registered after
    // paint missed it — the editor stayed open, which the walk caught under
    // load. Registering at commit closes the window; nothing else changes.
    useLayoutEffect(() => {
        if (escapeBlocked) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            if (isEditableTarget(e.target)) return;   // TaskTree's editors own their Escape
            onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, escapeBlocked]);

    const commitTitle = () => {
        const t = titleDraft.trim();
        const base = titleBase.current;
        setTitleDirty(false);
        if (isChannel || titleUnreadable || !t || t === card.title) { setTitleDraft(card.title); return; }
        void actions.renameNote(ref, t, base);
    };

    const addItem = async (e: React.FormEvent) => {
        e.preventDefault();
        const text = newItem.trim();
        if (!text) return;
        setNewItem('');
        const created = await actions.addTask(ref, text);
        if (!created) setNewItem(text);   // failed: give the text back
        addRef.current?.focus();
    };

    // A multi-line paste into "Add an item…" asks before it creates: an item
    // is removed one at a time with no Undo (onDelete below goes straight to
    // deleteTaskFrom), so forty silent items would be unrecoverable.
    const [paste, setPaste] = useState<{ lines: string[]; text: string } | null>(null);
    const onPasteNewItem = (e: React.ClipboardEvent<HTMLInputElement>) => {
        const lines = linesFromPaste(e.clipboardData?.getData('text') ?? '');
        if (lines.length < 2) return;   // one line pastes as normal
        e.preventDefault();
        setPaste({ lines, text: e.clipboardData?.getData('text') ?? '' });
    };
    const addPastedLines = async (lines: string[]) => {
        setPaste(null);
        // One create per line, in order, through the SAME addTask a typed
        // item uses — so each is sealed here and queues offline like any
        // other. Paced like every other fan-out of creates in this app
        // (icsImport's PACE_MS, well under the server's 50/s per IP): a
        // hundred-line paste in one burst is exactly what trips the limiter.
        // Truncated to what the field itself accepts, and a run that stops
        // part-way SAYS where it stopped — addTask's own toast explains the
        // refusal, not how much of the list arrived.
        let made = 0;
        for (const line of lines) {
            if (made > 0) await sleep(PACE_MS);
            if (!await actions.addTask(ref, line.slice(0, MAX_ITEM_LENGTH))) break;
            made++;
        }
        if (made < lines.length) pushMessageToast({ title: `Added ${made} of ${lines.length} items` });
        addRef.current?.focus();
    };

    return createPortal(
        <div className="notes-editor-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="notes-editor" data-color={card.color} role="dialog" aria-modal="true" aria-label={card.title || 'Untitled note'}>
                <div className="notes-editor-head">
                    <input
                        className="notes-editor-title"
                        value={titleDraft}
                        placeholder="Title"
                        maxLength={MAX_TITLE_LENGTH}
                        readOnly={isChannel || titleUnreadable}
                        title={isChannel ? 'Channel checklists are renamed from the channel settings in Púca' : 'Click to rename'}
                        aria-label="Note title"
                        onChange={e => { markTitleDirty(); setTitleDraft(e.target.value); }}
                        onBlur={commitTitle}
                        onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setTitleDirty(false); setTitleDraft(card.title); (e.target as HTMLInputElement).blur(); }
                        }}
                    />
                    <button
                        type="button"
                        className={`notes-iconbtn ${card.pinned ? 'active' : ''}`}
                        aria-label={card.pinned ? 'Unpin note' : 'Pin note'}
                        aria-pressed={card.pinned}
                        title={card.pinned ? 'Unpin' : 'Pin'}
                        onClick={() => actions.togglePin(ref)}
                    >
                        <PinIcon />
                    </button>
                    <button type="button" className="notes-iconbtn" aria-label="Close note" title="Close (Esc)" onClick={onClose}>
                        <CloseIcon size={20} />
                    </button>
                </div>
                <div className="notes-editor-sub">
                    {card.serverName && <span className="notes-chip shared"><MembersIcon /> {card.serverName}</span>}
                    {card.titleEncState === 'legacy' && !titleUnreadable && (
                        <span className="tt-not-encrypted" title="Not encrypted — this title is stored as plaintext."><WarningIcon /> Title not encrypted</span>
                    )}
                    {card.archived && <span className="notes-chip archived"><ArchiveIcon /> archived</span>}
                    {noteReminders && <NoteDueChip note={{ title: card.title, dueAt: card.dueAt, schedule: card.schedule }} now={now} />}
                    {card.labels.map(l => <span key={l} className="notes-chip"><TagIcon /> {l}</span>)}
                    {card.createdAt && <span>Created {new Date(card.createdAt).toLocaleDateString()}</span>}
                    <EditedStamp createdAt={card.createdAt} updatedAt={card.updatedAt} />
                    {tasksQuery.isFetching && <span className="notes-spinner" aria-label="Refreshing" />}
                </div>

                {titleUnreadable && (
                    <div className="notes-editor-locked"><LockIcon /> This note's title can't be read yet: {card.title}</div>
                )}

                <div className="notes-editor-body">
                    <NoteContentSection card={card} actions={actions} tasks={tasks} tasksLoaded={!tasksQuery.isPending} />
                    {canCreate && (
                        <form className="notes-editor-add" onSubmit={addItem}>
                            <input
                                ref={addRef}
                                value={newItem}
                                onChange={e => setNewItem(e.target.value)}
                                placeholder="Add an item…"
                                maxLength={MAX_ITEM_LENGTH}
                                aria-label="New item"
                                onPaste={onPasteNewItem}
                                autoFocus={tasks.length === 0}
                            />
                            <button type="submit" aria-label="Add item" disabled={!newItem.trim()}><PlusIcon /></button>
                        </form>
                    )}
                    {tasksQuery.isPending && tasks.length === 0 ? (
                        <div className="notes-loading"><span className="notes-spinner" /> Loading…</div>
                    ) : isChannel ? (
                        <TaskTree
                            tasks={tasks}
                            onToggle={(t, done) => void actions.toggleTask(ref, t, done)}
                            onDelete={id => void actions.deleteTaskFrom(ref, id)}
                            onEdit={(t, text) => void actions.editTask(ref, t, text)}
                            onAddSubtask={(parentId, text) => void actions.addTask(ref, text, parentId)}
                            onMove={(t, dir) => void actions.moveTaskIn(ref, t, dir)}
                            onReorder={(t, afterId, reparent) => void actions.reorderTaskIn(ref, t, afterId, reparent)}
                            onSetDue={(t, due) => void actions.setDue(ref, t, due)}
                            onSetSchedule={onSetSchedule}
                            onSnooze={onSnooze}
                            onSetAttachments={(t, refs) => void actions.setAttachments(ref, t, refs)}
                            myPerms={card.myPerms}
                            currentUserId={currentUserId}
                            resolveUserName={card.resolveUserName}
                            channelId={ref.id}
                            flashTaskId={flashTaskId}
                        />
                    ) : (
                        <TaskTree
                            tasks={tasks}
                            onToggle={(t, done) => void actions.toggleTask(ref, t, done)}
                            onDelete={id => void actions.deleteTaskFrom(ref, id)}
                            onEdit={(t, text) => void actions.editTask(ref, t, text)}
                            onAddSubtask={(parentId, text) => void actions.addTask(ref, text, parentId)}
                            onMove={(t, dir) => void actions.moveTaskIn(ref, t, dir)}
                            onReorder={(t, afterId, reparent) => void actions.reorderTaskIn(ref, t, afterId, reparent)}
                            onSetDue={(t, due) => void actions.setDue(ref, t, due)}
                            onSetSchedule={onSetSchedule}
                            onSnooze={onSnooze}
                            onSetAttachments={(t, refs) => void actions.setAttachments(ref, t, refs)}
                            flashTaskId={flashTaskId}
                        />
                    )}
                </div>

                <div className="notes-editor-foot">
                    <button type="button" className="notes-iconbtn" aria-label="Colour" title="Colour" onClick={e => onPickColor(card, e.currentTarget)}><PaletteIcon /></button>
                    <button type="button" className="notes-iconbtn" aria-label="Labels" title="Labels" onClick={e => onPickLabels(card, e.currentTarget)}><TagIcon /></button>
                    <button type="button" className="notes-iconbtn" aria-label={card.archived ? 'Unarchive' : 'Archive'} title={card.archived ? 'Unarchive' : 'Archive'} onClick={() => onArchive(card, !card.archived)}><ArchiveIcon /></button>
                    {noteReminders && (
                        <NoteReminderControl
                            note={{ title: card.title, dueAt: card.dueAt, schedule: card.schedule }}
                            canSchedule={canSchedule}
                            onSave={patch => void actions.setNoteTiming(ref, patch)}
                        />
                    )}
                    <button type="button" className="notes-iconbtn" aria-label="Refresh this note" title="Refresh" onClick={() => void actions.refreshNote(ref)}><RefreshIcon /></button>
                    {/* Uncheck all / Delete checked, on the editor's LIVE
                        items. Shown only when something is ticked, and only
                        on a personal note. */}
                    <ListActionsMenu note={ref} actions={actions} tasks={tasks} />
                    {pucaHref && (
                        <a className="notes-iconbtn" href={pucaHref} target="_blank" rel="noopener" aria-label="Open in Púca" title="Open in Púca"><PopOutIcon /></a>
                    )}
                    <span className="spacer" />
                    <button type="button" className="notes-iconbtn" aria-label="More actions" title="More" onClick={e => onMenu(e, card, e.currentTarget)}><MoreVerticalIcon /></button>
                    <button type="button" className="notes-textbtn" onClick={onClose}>Close</button>
                </div>
                {paste && (
                    <PastedLinesDialog
                        lines={paste.lines}
                        onAddSeparate={() => void addPastedLines(paste.lines)}
                        onAddOne={() => { setPaste(null); setNewItem(v => `${v}${pasteAsOneLine(paste.text)}`.slice(0, MAX_ITEM_LENGTH)); addRef.current?.focus(); }}
                        onCancel={() => { setPaste(null); addRef.current?.focus(); }}
                    />
                )}
            </div>
        </div>,
        document.body,
    );
}
