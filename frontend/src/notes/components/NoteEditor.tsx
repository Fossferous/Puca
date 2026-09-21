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
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Task } from '../../api/tasks';
import { currentUserIdFromToken } from '../../api/auth';
import { isEditableTarget } from '../../api/hotkeys';
import { isUndecryptable } from '../../api/decryptMarkers';
import { TaskTree } from '../../components/TaskTree';
import {
    ArchiveIcon, ChevronDownIcon, ChevronUpIcon, CloseIcon, LockIcon, MembersIcon, MoreVerticalIcon, PaletteIcon, PinIcon, PlusIcon, PopOutIcon,
    RefreshIcon, SearchIcon, TagIcon, WarningIcon,
} from '../../components/Icons';
import { PERM, hasPerm } from '../../api/permissionBits';
import { MAX_TITLE_LENGTH, type NoteCard } from '../model/notesModel';
import { findRanges, searchTerms } from '../model/noteSearch';
import { Highlight } from './Highlight';
import { type NoteActions, useNoteTasks } from '../model/notesQueries';
import { NoteContentSection } from './NoteContentSection';
import { useTaskFeature } from '../../api/taskFeatures';
import { EditedStamp } from './EditedStamp';

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
    /** The search that led here, so the note can say where it matched and
     *  step through its matches. Display only — never stored or sent. */
    query?: string;
}

export function NoteEditor({ card, actions, onClose, onMenu, onPickColor, onPickLabels, onArchive, pucaHref, escapeBlocked = false, query }: NoteEditorProps) {
    const ref = card.ref;
    // Its own query subscription with `live` so a shared note polls while open.
    const tasksQuery = useNoteTasks(ref, { live: true });
    // Memoised, not a fresh `?? []` per render: the match count below is a
    // useMemo over it, and a new empty array each render would recompute it
    // (and every child memo) forever.
    const tasks: Task[] = useMemo(() => tasksQuery.data ?? card.tasks ?? [], [tasksQuery.data, card.tasks]);
    const [newItem, setNewItem] = useState('');
    const [titleDraft, setTitleDraft] = useState(card.title);
    // A rename that landed from elsewhere (another device, a refetch) replaces
    // the draft — the "adjust state while rendering" pattern, not an effect.
    const [seenTitle, setSeenTitle] = useState(card.title);
    if (seenTitle !== card.title) {
        setSeenTitle(card.title);
        setTitleDraft(card.title);
    }
    const addRef = useRef<HTMLInputElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    // Search marks inside the open note. The COUNT comes from the model, not
    // from counting DOM nodes, so it is right on the first render; stepping
    // walks the rendered marks, which are the same ones.
    const terms = useMemo(() => (query ? searchTerms(query) : []), [query]);
    const matchCount = useMemo(
        () => (terms.length === 0 ? 0 : tasks.reduce((n, t) => n + (isUndecryptable(t.description) ? 0 : findRanges(t.description, terms).length), 0)),
        [tasks, terms],
    );
    const [matchAt, setMatchAt] = useState(0);
    const renderDescription = useCallback(
        (text: string) => <Highlight text={text} ranges={terms.length > 0 && !isUndecryptable(text) ? findRanges(text, terms) : undefined} />,
        [terms],
    );
    /** Scroll the nth mark into view and flag it, imperatively — the marks
     *  are already in the DOM, so no state has to travel down to find them. */
    const goToMatch = useCallback((index: number) => {
        const marks = bodyRef.current?.querySelectorAll<HTMLElement>('mark.notes-hl');
        if (!marks || marks.length === 0) return;
        const at = ((index % marks.length) + marks.length) % marks.length;
        marks.forEach(m => m.classList.remove('current'));
        marks[at].classList.add('current');
        marks[at].scrollIntoView({ block: 'center', behavior: 'smooth' });
        setMatchAt(at);
    }, []);
    const currentUserId = currentUserIdFromToken() ?? undefined;
    const isChannel = ref.kind === 'channel';
    const canCreate = !isChannel || hasPerm(card.myPerms, PERM.CREATE_TASKS);
    const titleUnreadable = isUndecryptable(card.title);
    // Date & repeat only against a server that stores it (an older one would
    // drop the field silently); unknown = hidden.
    const onSetSchedule = useTaskFeature('schedule')
        ? (t: Task, schedule: string | null, due: string | null) => void actions.setSchedule(ref, t, schedule, due)
        : undefined;

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
        if (isChannel || titleUnreadable || !t || t === card.title) { setTitleDraft(card.title); return; }
        void actions.renameNote(ref, t);
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
                        onChange={e => setTitleDraft(e.target.value)}
                        onBlur={commitTitle}
                        onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setTitleDraft(card.title); (e.target as HTMLInputElement).blur(); }
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
                    {card.labels.map(l => <span key={l} className="notes-chip"><TagIcon /> {l}</span>)}
                    {card.createdAt && <span>Created {new Date(card.createdAt).toLocaleDateString()}</span>}
                    <EditedStamp createdAt={card.createdAt} updatedAt={card.updatedAt} />
                    {tasksQuery.isFetching && <span className="notes-spinner" aria-label="Refreshing" />}
                </div>

                {matchCount > 0 && (
                    <div className="notes-editor-matches" role="status">
                        <SearchIcon />
                        <span>{Math.min(matchAt, matchCount - 1) + 1} of {matchCount}</span>
                        <button type="button" className="notes-iconbtn small" aria-label="Previous match" title="Previous match" onClick={() => goToMatch(matchAt - 1)}><ChevronUpIcon /></button>
                        <button type="button" className="notes-iconbtn small" aria-label="Next match" title="Next match" onClick={() => goToMatch(matchAt + 1)}><ChevronDownIcon /></button>
                    </div>
                )}
                {titleUnreadable && (
                    <div className="notes-editor-locked"><LockIcon /> This note's title can't be read yet: {card.title}</div>
                )}

                <div className="notes-editor-body" ref={bodyRef}>
                    <NoteContentSection card={card} actions={actions} tasks={tasks} tasksLoaded={!tasksQuery.isPending} />
                    {canCreate && (
                        <form className="notes-editor-add" onSubmit={addItem}>
                            <input
                                ref={addRef}
                                value={newItem}
                                onChange={e => setNewItem(e.target.value)}
                                placeholder="Add an item…"
                                maxLength={500}
                                aria-label="New item"
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
                            onSetAttachments={(t, refs) => void actions.setAttachments(ref, t, refs)}
                            myPerms={card.myPerms}
                            currentUserId={currentUserId}
                            resolveUserName={card.resolveUserName}
                            channelId={ref.id}
                            renderDescription={renderDescription}
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
                            onSetAttachments={(t, refs) => void actions.setAttachments(ref, t, refs)}
                            renderDescription={renderDescription}
                        />
                    )}
                </div>

                <div className="notes-editor-foot">
                    <button type="button" className="notes-iconbtn" aria-label="Colour" title="Colour" onClick={e => onPickColor(card, e.currentTarget)}><PaletteIcon /></button>
                    <button type="button" className="notes-iconbtn" aria-label="Labels" title="Labels" onClick={e => onPickLabels(card, e.currentTarget)}><TagIcon /></button>
                    <button type="button" className="notes-iconbtn" aria-label={card.archived ? 'Unarchive' : 'Archive'} title={card.archived ? 'Unarchive' : 'Archive'} onClick={() => onArchive(card, !card.archived)}><ArchiveIcon /></button>
                    <button type="button" className="notes-iconbtn" aria-label="Refresh this note" title="Refresh" onClick={() => void actions.refreshNote(ref)}><RefreshIcon /></button>
                    {pucaHref && (
                        <a className="notes-iconbtn" href={pucaHref} target="_blank" rel="noopener" aria-label="Open in Púca" title="Open in Púca"><PopOutIcon /></a>
                    )}
                    <span className="spacer" />
                    <button type="button" className="notes-iconbtn" aria-label="More actions" title="More" onClick={e => onMenu(e, card, e.currentTarget)}><MoreVerticalIcon /></button>
                    <button type="button" className="notes-textbtn" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
