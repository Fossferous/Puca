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
import { memo, useEffect, useRef, useState } from 'react';
import { type Task, isAttachmentsLocked, parseTaskAttachments, isTaskOverdue, formatDueShort, type TaskAttachmentRef } from '../../api/tasks';
import { parseEncAttachment, decryptToBlobUrl } from '../../api/attachments';
import { isUndecryptable } from '../../api/decryptMarkers';
import { PERM, hasPerm } from '../../api/permissionBits';
import {
    ArchiveIcon, CheckboxCheckedIcon, CheckboxIcon, ClockIcon, LockIcon, MembersIcon, MoreVerticalIcon, PaletteIcon, PinIcon, TagIcon, WarningIcon,
} from '../../components/Icons';
import { type NoteCard as NoteCardModel, previewRows, nearestDue } from '../model/notesModel';
import { type NoteActions } from '../model/notesQueries';
import { NoteBodyPreview, NoteHero } from './NoteCardContent';
import { heroItems } from '../../api/noteMedia';
import { ScheduleChip } from '../../components/schedule/ScheduleChip';
import { NoteDueChip } from '../../components/schedule/NoteReminderControl';
import { useNoteUnsynced } from '../model/notesOutbox';
import { useLongPress } from './useLongPress';

export const PREVIEW_ROWS = 8;
const MAX_THUMBS = 3;

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
    selected = false, selecting = false, onSelect,
}: NoteCardProps) {
    const elRef = useRef<HTMLElement | null>(null);
    const press = useLongPress(onSelect ? () => onSelect(card, { shiftKey: false }) : undefined);
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
            className={`notes-card ${card.pinned ? 'pinned' : ''} ${selected ? 'selected' : ''}`}
            data-selected={selected ? 'true' : undefined}
            data-color={card.color}
            data-note-key={card.key}
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
            {...press.handlers}
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
                <h3 className={`notes-card-title ${untitled ? 'untitled' : ''}`}>
                    {untitled ? 'Untitled note' : card.title}
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

            <NoteBodyPreview body={card.body} />
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
                            <span className="notes-card-item-text">{task.description}</span>
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

            {(thumbs.length > 0 || fileCount > 0) && (
                <div className="notes-card-thumbs">
                    {thumbs.map(r => <ImageThumb key={r.href} refItem={r} visible={onScreen} />)}
                    {fileCount > 0 && <span className="notes-chip">{fileCount} file{fileCount === 1 ? '' : 's'}</span>}
                </div>
            )}

            <div className="notes-card-foot">
                {card.serverName && (
                    <span className="notes-chip shared" title={`Shared checklist in ${card.serverName}`}><MembersIcon /> {card.serverName}</span>
                )}
                {/* The NOTE's own reminder first, then the soonest ITEM
                    due: two different things, so two chips. */}
                <NoteDueChip note={{ title: card.title, dueAt: card.dueAt, schedule: card.schedule }} now={now} />
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
                        <TagIcon /> {l}
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
