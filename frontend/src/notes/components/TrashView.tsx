/**
 * The Trash: notes moved there from Notes or from Púca's Tasks view, with
 * Restore and Delete forever, and Empty trash. How long the server keeps
 * them is the server's setting (NOTES_TRASH_RETENTION_DAYS, read through
 * GET /task-lists/features), and the copy says exactly that.
 *
 * Delete forever removes the note's uploaded pictures and attachments first
 * (the server cannot find them on its own — api/listContent.ts), then the
 * note. A trashed note is read-only on the server; to change it, restore it.
 *
 * Restore is notesQueries.ts restoreNote, through the offline outbox — the
 * same path as the Undo of a delete — so it queues behind anything already
 * waiting instead of overtaking it. A note is listed here the moment it is
 * moved (deleteNote), even while that move is still QUEUED; until it reaches
 * the server its Restore and Delete forever are off, and Empty trash leaves
 * it alone: a direct call would run first, and the queued move would then
 * undo it without a word.
 */
import { useSyncExternalStore } from 'react';
import { type TaskList } from '../../api/tasks';
import { purgeCountdown, serverNowFrom, trashPurgeAt } from '../../api/listContent';
import { galleryItems } from '../../api/noteMedia';
import { isUndecryptable } from '../../api/decryptMarkers';
import { parseServerTimestamp } from '../../utils/serverTime';
import { TrashIcon } from '../../components/Icons';
import { type ListContentActions, useTrashedLists } from '../model/useListContent';
import { type NoteRef } from '../model/notesModel';
import '../noteContent.css';

function subscribeMinute(cb: () => void): () => void {
    const id = window.setInterval(cb, 60_000);
    return () => window.clearInterval(id);
}
function minuteNow(): number {
    return Math.floor(Date.now() / 60_000) * 60_000;
}

function retentionCopy(days: number): string {
    if (days <= 0) return 'Notes stay in the trash until you delete them forever or empty it.';
    return `Notes in the trash are deleted forever after ${days} day${days === 1 ? '' : 's'}. Restore one to see and change it again.`;
}

const QUEUED_TITLE = 'Still being moved to the trash — this waits for the connection';

interface RowProps {
    list: TaskList;
    content: ListContentActions;
    now: number;
    restoreNote: (note: NoteRef) => Promise<boolean>;
    /** Its move to the trash has not reached the server yet. */
    queued: boolean;
}

function TrashRow({ list, content, now, restoreNote, queued }: RowProps) {
    const title = list.title.trim() ? list.title : 'Untitled note';
    const body = list.body && !isUndecryptable(list.body) ? list.body : '';
    const pictures = galleryItems(list.attachments).filter(i => i.kind !== 'file').length;
    const purge = trashPurgeAt(list.trashed_at, content.features.trashRetentionDays);
    const trashed = list.trashed_at ? parseServerTimestamp(list.trashed_at) : NaN;
    const parts: string[] = [];
    if (list.total_tasks > 0) parts.push(`${list.total_tasks} item${list.total_tasks === 1 ? '' : 's'}`);
    if (pictures > 0) parts.push(`${pictures} picture${pictures === 1 ? '' : 's'}`);
    if (Number.isFinite(trashed)) parts.push(`trashed ${new Date(trashed).toLocaleDateString()}`);
    // Counted on the server's clock when it gave one: it is the server that deletes.
    if (purge !== null) parts.push(`deleted forever ${purgeCountdown(purge, serverNowFrom(content.features, now) ?? now, 60_000)}`);
    return (
        <li className="notes-trash-row" data-list-id={list.id} data-queued={queued ? 'true' : undefined}>
            <div className="notes-trash-main">
                <div className="notes-trash-title">{title}</div>
                {body && <div className="notes-trash-snippet">{body}</div>}
                <div className="notes-trash-meta">{parts.join(' · ')}</div>
            </div>
            <div className="notes-trash-actions">
                <button
                    type="button"
                    className="notes-textbtn primary"
                    disabled={queued}
                    title={queued ? QUEUED_TITLE : undefined}
                    onClick={() => void restoreNote({ kind: 'list', id: list.id })}
                >
                    Restore
                </button>
                <button
                    type="button"
                    className="notes-textbtn danger"
                    disabled={queued}
                    title={queued ? QUEUED_TITLE : undefined}
                    onClick={() => {
                        if (!window.confirm(`Delete “${title}” forever? Its pictures and attachments go with it. This can’t be undone.`)) return;
                        void content.deleteForever(list);
                    }}
                >
                    Delete forever
                </button>
            </div>
        </li>
    );
}

interface TrashViewProps {
    content: ListContentActions;
    /** The outbox's restore (NoteActions.restoreNote). */
    restoreNote: (note: NoteRef) => Promise<boolean>;
    /** Notes whose move to the trash is still queued (useQueuedListDeletes). */
    queuedDeletes: ReadonlySet<number>;
}

export function TrashView({ content, restoreNote, queuedDeletes }: TrashViewProps) {
    const trash = useTrashedLists();
    const now = useSyncExternalStore(subscribeMinute, minuteNow, minuteNow);
    const lists = trash.data ?? [];
    const deletable = lists.filter(l => !queuedDeletes.has(l.id)).length;
    return (
        <section className="notes-trash" aria-label="Trash">
            <div className="notes-trash-head">
                <h1 className="notes-section-title">Trash</h1>
                <span className="spacer" />
                {lists.length > 0 && (
                    <button
                        type="button"
                        className="notes-textbtn danger"
                        disabled={deletable === 0}
                        title={deletable === 0 ? QUEUED_TITLE : undefined}
                        onClick={() => {
                            const all = deletable === lists.length;
                            if (!window.confirm(`Delete ${all ? 'all ' : ''}${deletable} note${deletable === 1 ? '' : 's'} in the trash forever?${all ? '' : ' Notes still being moved there are left alone.'} This can’t be undone.`)) return;
                            void content.emptyTrash(queuedDeletes);
                        }}
                    >
                        Empty trash
                    </button>
                )}
            </div>
            <p className="notes-trash-copy">{retentionCopy(content.features.trashRetentionDays)}</p>
            {trash.isPending && trash.enabled ? (
                <div className="notes-loading"><span className="notes-spinner" /> Loading…</div>
            ) : trash.isError ? (
                <div className="notes-status error" role="alert">
                    Couldn’t load the trash.{' '}
                    <button type="button" onClick={() => void trash.refetch()}>Retry</button>
                </div>
            ) : lists.length === 0 ? (
                <div className="notes-empty">
                    <TrashIcon />
                    <p>No notes in the trash.</p>
                </div>
            ) : (
                <ul className="notes-trash-list">
                    {lists.map(l => <TrashRow key={l.id} list={l} content={content} now={now} restoreNote={restoreNote} queued={queuedDeletes.has(l.id)} />)}
                </ul>
            )}
        </section>
    );
}
