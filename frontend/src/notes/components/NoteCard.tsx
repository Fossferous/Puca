/**
 * One note in the grid: title, a compact preview of its open items (each
 * checkbox live), lazily decrypted image thumbnails, chips, and the card
 * tools. A READ-MOSTLY projection of the query cache — it never mounts
 * TaskTree or ChecklistBody (those carry a drag hook, a clock, a file input
 * and a places subscription each; forty cards must not). Editing beyond a
 * checkbox happens in the editor.
 *
 * Attachments: the sidecar is parsed only after isAttachmentsLocked() says it
 * is readable — a locked sidecar renders a lock chip, never "nothing", and no
 * card control ever WRITES attachments (TaskTree owns that, with the locked
 * check and the channel plumbing). Thumbnails decrypt only once the card is
 * on screen, image types only, at most three per card.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { type Task, isAttachmentsLocked, parseTaskAttachments, isTaskOverdue, formatDueShort, type TaskAttachmentRef } from '../../api/tasks';
import { parseEncAttachment, decryptToBlobUrl } from '../../api/attachments';
import { isUndecryptable } from '../../api/decryptMarkers';
import { PERM, hasPerm } from '../../api/permissionBits';
import {
    ArchiveIcon, CheckboxCheckedIcon, CheckboxIcon, ClockIcon, GripIcon, LockIcon, MembersIcon, MoreVerticalIcon, PaletteIcon, PinIcon, SearchIcon, TagIcon, WarningIcon,
} from '../../components/Icons';
import { type NoteCard as NoteCardModel, previewRows, nearestDue } from '../model/notesModel';
import { findRanges, searchTerms, snippetAround, type Range } from '../model/noteSearch';
import { scheduleSearchText } from '../model/notesTiming';
import { Highlight } from './Highlight';
import { type NoteActions } from '../model/notesQueries';
import { NoteBodyPreview, NoteHero } from './NoteCardContent';
import { heroItems } from '../../api/noteMedia';
import { ScheduleChip } from '../../components/schedule/ScheduleChip';
import { useNoteUnsynced } from '../model/notesOutbox';
import { useLongPress } from './useLongPress';

export const PREVIEW_ROWS = 8;
const MAX_THUMBS = 3;
/** Characters of context around a match in an "also matched" row, which is one
 *  ellipsised line — much tighter than the body preview's window. */
const FOUND_RADIUS = 40;

interface NoteCardProps {
    card: NoteCardModel;
    actions: NoteActions;
    now: number;
    onOpen: (card: NoteCardModel) => void;
    onMenu: (e: React.MouseEvent, card: NoteCardModel, anchor: HTMLElement) => void;
    onPickColor: (card: NoteCardModel, anchor: HTMLElement) => void;
    onPickLabels: (card: NoteCardModel, anchor: HTMLElement) => void;
    onLabelClick: (label: string) => void;
    /** Archive/unarchive through the owner, so it gets the Undo snackbar. */
    onArchive: (card: NoteCardModel, archived: boolean) => void;
    /** Coarse pointer: pin + more only; the rest lives in the menu. */
    compactTools: boolean;
    /** The card registers its element so menus opened elsewhere can anchor to it. */
    registerEl: (key: string, el: HTMLElement | null) => void;
    /** The live search text, when a search is what put this card here.
     *  Only for marking up what matched: the query is never stored or sent.
     */
    query?: string;
    /** Drag to reorder is on for this section (NoteGrid decides): show the
     *  grip and mark the article for useDragReorder. */
    draggable?: boolean;
    /** The key currently being dragged, so this card can dim itself. */
    draggingKey?: string | null;
    /** Bulk selection (useNoteSelection.tsx): absent = no selection UI. */
    selected?: boolean;
    selecting?: boolean;
    onSelect?: (card: NoteCardModel, e: { shiftKey: boolean }) => void;
}

function ImageThumb({ refItem, visible }: { refItem: TaskAttachmentRef; visible: boolean }) {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const parsed = parseEncAttachment(refItem.href);
    useEffect(() => {
        if (!visible || !parsed || url) return;
        let cancelled = false;
        decryptToBlobUrl(parsed.id, parsed.key, parsed.mime, parsed.cap)
            .then(u => { if (!cancelled) setUrl(u); })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
        // parseEncAttachment is pure over href.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, refItem.href]);
    if (!parsed || failed) return <span className="notes-thumb file" title={refItem.name}><WarningIcon /></span>;
    if (!url) return <span className="notes-thumb pending" title={refItem.name} />;
    return <img className="notes-thumb" src={url} alt={refItem.name} title={refItem.name} loading="lazy" />;
}

function NoteCardImpl({
    card, actions, now, onOpen, onMenu, onPickColor, onPickLabels, onLabelClick, onArchive, compactTools, registerEl,
    query, draggable = false, draggingKey = null, selected = false, selecting = false, onSelect,
}: NoteCardProps) {
    const elRef = useRef<HTMLElement | null>(null);
    const press = useLongPress(onSelect ? () => onSelect(card, { shiftKey: false }) : undefined);
    // A press that STARTS on the grip is a drag (useDragReorder), never the
    // long press that opens bulk selection. Cancelling immediately rather than
    // skipping the handler keeps press.wasTouch() honest, which is what turns
    // Android's long-press `contextmenu` into a selection instead of the menu.
    const pressHandlers = {
        ...press.handlers,
        onPointerDown: (e: React.PointerEvent) => {
            press.handlers.onPointerDown(e);
            if ((e.target as Element | null)?.closest?.('.notes-card-grip')) press.handlers.onPointerCancel();
        },
    };
    // Where the search matched. Derived at render and never attached to the
    // card: notesCache.ts seals and stores whatever a NoteCard carries, and a
    // plaintext snippet has no business in that store. A decrypt-failure
    // marker is blanked first, exactly as noteMatches blanks it, so searching
    // "encrypted" never marks up a note you cannot read.
    const terms = useMemo(() => (query ? searchTerms(query) : []), [query]);
    const readable = (t: string) => (isUndecryptable(t) ? '' : t);
    const titleRanges = useMemo(() => findRanges(readable(card.title), terms), [card.title, terms]);
    const tasksForHits = card.tasks;
    // Matches the card structurally cannot show: a ticked item (previewRows
    // folds those away), an item past the eighth, or a place on a date, which
    // ScheduleChip draws as a bare pin with no text. Without this the card
    // looks as though it matched nothing at all.
    const foundElsewhere = useMemo<{ what: string; text: string; ranges: Range[] }[]>(() => {
        if (terms.length === 0 || !tasksForHits) return [];
        const shown = new Set(previewRows(tasksForHits, PREVIEW_ROWS).rows.map(r => r.task.id));
        const out: { what: string; text: string; ranges: Range[] }[] = [];
        // One line each, clipped with an ellipsis by CSS — so the row is
        // windowed AROUND its match first. A long item whose match sits past
        // the card's width otherwise rendered its opening words and hid the
        // <mark>, which is the only thing the row exists to show.
        const row = (what: string, text: string, ranges: Range[]) => {
            const s = snippetAround(text, ranges, FOUND_RADIUS);
            out.push({ what, text: s.text, ranges: s.ranges });
        };
        for (const t of tasksForHits) {
            if (!shown.has(t.id)) {
                const desc = isUndecryptable(t.description) ? '' : t.description;
                const r = findRanges(desc, terms);
                if (r.length > 0) row(t.is_completed ? 'ticked' : 'further down', desc, r);
            }
            const place = scheduleSearchText(t);
            const pr = place ? findRanges(place, terms) : [];
            if (pr.length > 0) row('a place', place, pr);
        }
        return out.slice(0, 3);
    }, [terms, tasksForHits]);

    const unsynced = useNoteUnsynced(card.key);
    // No observer (an old WebView, jsdom) → decrypt right away rather than never.
    const [onScreen, setOnScreen] = useState(() => typeof IntersectionObserver === 'undefined');

    useEffect(() => {
        const el = elRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') return;
        const io = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) { setOnScreen(true); io.disconnect(); }
        }, { rootMargin: '200px' });
        io.observe(el);
        return () => io.disconnect();
    }, []);

    const tasks = card.tasks;
    const preview = tasks ? previewRows(tasks, PREVIEW_ROWS) : null;
    const due = tasks ? nearestDue(tasks) : null;
    const canComplete = card.ref.kind === 'list'
        || hasPerm(card.myPerms, PERM.COMPLETE_TASKS) || hasPerm(card.myPerms, PERM.MANAGE_TASKS);
    const hero = heroItems(card.noteAttachments);
    const hasBody = !!card.body;
    const untitled = !card.title.trim();
    const titleUnreadable = isUndecryptable(card.title);

    // Image thumbnails: first three image refs across the note's rows, and a
    // lock chip if ANY row's sidecar could not be opened.
    const thumbs: TaskAttachmentRef[] = [];
    let anyLocked = isAttachmentsLocked(card.noteAttachments ?? null);
    let fileCount = 0;
    for (const t of tasks ?? []) {
        if (!t.attachments) continue;
        if (isAttachmentsLocked(t.attachments)) { anyLocked = true; continue; }
        for (const r of parseTaskAttachments(t.attachments)) {
            const p = parseEncAttachment(r.href);
            if (p && p.mime.startsWith('image/') && thumbs.length < MAX_THUMBS) thumbs.push(r);
            else fileCount++;
        }
    }

    const toggle = (task: Task, e: React.ChangeEvent<HTMLInputElement>) => {
        e.stopPropagation();
        void actions.toggleTask(card.ref, task, e.target.checked);
    };

    const colorName = card.color === 'default' ? '' : ` · ${card.color}`;
    return (
        <article
            ref={el => { elRef.current = el; registerEl(card.key, el); }}
            className={`notes-card ${card.pinned ? 'pinned' : ''} ${selected ? 'selected' : ''} ${draggingKey === card.key ? 'dragging' : ''}`}
            data-selected={selected ? 'true' : undefined}
            data-color={card.color}
            data-note-key={card.key}
            data-drag-key={draggable ? card.key : undefined}
            data-drag-group={draggable ? (card.pinned ? 'pinned' : 'others') : undefined}
            tabIndex={0}
            role="button"
            aria-label={`${untitled ? 'Untitled note' : card.title}${card.pinned ? ', pinned' : ''}${card.archived ? ', archived' : ''}${colorName}`}
            title={card.color === 'default' ? undefined : `Colour: ${card.color}`}
            onClick={e => {
                if (press.swallowClick()) return;
                // While selecting (or with a modifier), a click selects instead of opening.
                if (onSelect && (selecting || e.shiftKey || e.ctrlKey || e.metaKey)) { onSelect(card, { shiftKey: e.shiftKey }); return; }
                onOpen(card);
            }}
            {...pressHandlers}
            // The card itself only: Enter/Space on a control INSIDE it (pin,
            // a checkbox, a chip, the tools) bubbles here too, and must keep
            // its native activation rather than open the note.
            onKeyDown={e => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(card); }
            }}
            onContextMenu={e => {
                // A long press on a touch screen is a selection, not the menu
                // (the More button still opens that).
                if (press.wasTouch()) { e.preventDefault(); press.fire(); return; }
                onMenu(e, card, e.currentTarget);
            }}
        >
            {onSelect && (
                <button
                    type="button"
                    className={`notes-card-select ${selected ? 'on' : ''} ${selecting ? 'shown' : ''}`}
                    aria-pressed={selected}
                    aria-label={selected ? 'Deselect note' : 'Select note'}
                    title={selected ? 'Deselect' : 'Select'}
                    onClick={e => { e.stopPropagation(); onSelect(card, { shiftKey: e.shiftKey }); }}
                >
                    {selected ? <CheckboxCheckedIcon /> : <CheckboxIcon />}
                </button>
            )}
            <NoteHero items={hero} visible={onScreen} />
            <div className="notes-card-head">
                {/* aria-hidden: the keyboard and screen-reader route to reordering is the
                    card menu's Move items, as the design rules require. The title is a
                    mouse tooltip only — inert for assistive tech on this node, by design. */}
                {draggable && <span className="notes-card-grip" title="Drag to reorder" aria-hidden="true"><GripIcon /></span>}
                <h3 className={`notes-card-title ${untitled ? 'untitled' : ''}`}>
                    {untitled ? 'Untitled note' : <Highlight text={card.title} ranges={titleRanges} />}
                    {card.titleEncState === 'legacy' && !titleUnreadable && (
                        <span className="tt-not-encrypted" title="Not encrypted — this title is stored as plaintext, not end-to-end encrypted."> <WarningIcon /> Not encrypted</span>
                    )}
                </h3>
                <button
                    type="button"
                    className={`notes-iconbtn small notes-card-pin ${card.pinned ? 'pinned' : ''}`}
                    aria-label={card.pinned ? 'Unpin note' : 'Pin note'}
                    aria-pressed={card.pinned}
                    title={card.pinned ? 'Unpin' : 'Pin'}
                    onClick={e => { e.stopPropagation(); actions.togglePin(card.ref); }}
                >
                    <PinIcon />
                </button>
            </div>

            <NoteBodyPreview body={card.body} terms={terms} />
            {preview === null ? (
                <div className="notes-card-empty">Loading…</div>
            ) : preview.rows.length === 0 && preview.completedCount === 0 ? (
                hasBody || hero.length > 0 ? null : <div className="notes-card-empty">Empty note</div>
            ) : (
                <ul className="notes-card-items">
                    {preview.rows.map(({ task, depth }) => (
                        <li key={task.id} className="notes-card-item" style={{ '--depth': depth } as React.CSSProperties}>
                            <input
                                type="checkbox"
                                checked={task.is_completed}
                                disabled={!canComplete}
                                aria-label={`Complete: ${task.description}`}
                                onClick={e => e.stopPropagation()}
                                onChange={e => toggle(task, e)}
                            />
                            <span className="notes-card-item-text">
                                <Highlight text={task.description} ranges={findRanges(readable(task.description), terms)} />
                            </span>
                            {task.descEncState === 'legacy' && (
                                <span className="tt-not-encrypted" title="Not encrypted — this item was stored as plaintext, not end-to-end encrypted."><WarningIcon /> Not encrypted</span>
                            )}
                            {task.schedule != null && <ScheduleChip task={task} now={now} />}
                            {task.due_at && task.schedule == null && (
                                <span className={`tt-due ${isTaskOverdue(task, now) ? 'overdue' : ''}`} title={`Due ${new Date(task.due_at).toLocaleString()}`}>
                                    <ClockIcon /><span className="tt-due-label">{formatDueShort(task.due_at, now)}</span>
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {preview && (preview.moreOpen > 0 || preview.completedCount > 0) && (
                <div className="notes-card-more">
                    {preview.moreOpen > 0 && `+${preview.moreOpen} more`}
                    {preview.moreOpen > 0 && preview.completedCount > 0 && ' · '}
                    {preview.completedCount > 0 && `${preview.completedCount} completed`}
                </div>
            )}
            {foundElsewhere.length > 0 && (
                <div className="notes-card-found">
                    {foundElsewhere.map((f, i) => (
                        <span key={i} className="notes-card-found-row">
                            <SearchIcon />
                            <span className="notes-card-found-what">{f.what}</span>
                            <span className="notes-card-found-text"><Highlight text={f.text} ranges={f.ranges} /></span>
                        </span>
                    ))}
                </div>
            )}

            {(thumbs.length > 0 || fileCount > 0) && (
                <div className="notes-card-thumbs">
                    {thumbs.map(r => <ImageThumb key={r.href} refItem={r} visible={onScreen} />)}
                    {fileCount > 0 && <span className="notes-chip">{fileCount} file{fileCount === 1 ? '' : 's'}</span>}
                </div>
            )}

            <div className="notes-card-foot">
                {card.serverName && (
                    <span className="notes-chip shared" title={`Shared checklist in ${card.serverName}`}><MembersIcon /> <Highlight text={card.serverName} ranges={findRanges(card.serverName, terms)} /></span>
                )}
                {due && (
                    <span className={`notes-chip ${isTaskOverdue(due, now) ? 'overdue' : ''}`} title={`Next due: ${new Date(due.due_at!).toLocaleString()}`}>
                        <ClockIcon /> {formatDueShort(due.due_at!, now)}
                    </span>
                )}
                {anyLocked && <span className="notes-chip" title="Some attachments can't be read yet (key unavailable)"><LockIcon /> locked</span>}
                {card.archived && <span className="notes-chip archived"><ArchiveIcon /> archived</span>}
                {unsynced && <span className="notes-chip unsynced" title="Changed while offline — sends when the connection is back">Not synced</span>}
                {card.total > 0 && <span className="notes-chip progress" title="Completed / total">{card.completed}/{card.total}</span>}
                {card.labels.map(l => (
                    <span
                        key={l}
                        className="notes-chip clickable"
                        role="button"
                        tabIndex={0}
                        title={`Show notes labelled ${l}`}
                        onClick={e => { e.stopPropagation(); onLabelClick(l); }}
                        onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onLabelClick(l); } }}
                    >
                        <TagIcon /> <Highlight text={l} ranges={findRanges(l, terms)} />
                    </span>
                ))}
            </div>

            <div className="notes-card-tools" onClick={e => e.stopPropagation()}>
                {!compactTools && (
                    <>
                        <button type="button" className="notes-iconbtn" aria-label="Colour" title="Colour" onClick={e => onPickColor(card, e.currentTarget)}><PaletteIcon /></button>
                        <button type="button" className="notes-iconbtn" aria-label="Labels" title="Labels" onClick={e => onPickLabels(card, e.currentTarget)}><TagIcon /></button>
                        <button type="button" className="notes-iconbtn" aria-label={card.archived ? 'Unarchive' : 'Archive'} title={card.archived ? 'Unarchive' : 'Archive'} onClick={() => onArchive(card, !card.archived)}><ArchiveIcon /></button>
                    </>
                )}
                <span className="spacer" />
                <button type="button" className="notes-iconbtn" aria-label="More actions" title="More" onClick={e => onMenu(e, card, e.currentTarget)}><MoreVerticalIcon /></button>
            </div>
        </article>
    );
}

export const NoteCard = memo(NoteCardImpl);
