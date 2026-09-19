/**
 * The Trash: notes moved there from Notes or from Púca's Tasks view, with
 * Restore and Delete forever, and Empty trash. How long the server keeps
 * them is the server's setting (NOTES_TRASH_RETENTION_DAYS, read through
 * GET /task-lists/features), and the copy says exactly that.
 *
 * Delete forever removes the note's uploaded pictures and attachments first
 * (the server cannot find them on its own — api/listContent.ts), then the
 * note. A trashed note is read-only on the server; to change it, restore it.
 */
import { useSyncExternalStore } from 'react';
import { type TaskList } from '../../api/tasks';
import { trashPurgeAt } from '../../api/listContent';
import { galleryItems } from '../../api/noteMedia';
import { isUndecryptable } from '../../api/decryptMarkers';
import { parseServerTimestamp } from '../../utils/serverTime';
import { TrashIcon } from '../../components/Icons';
import { type ListContentActions, useTrashedLists } from '../model/useListContent';
import '../noteContent.css';

function subscribeMinute(cb: () => void): () => void {
    const id = window.setInterval(cb, 60_000);
    return () => window.clearInterval(id);
}
function minuteNow(): number {
    return Math.floor(Date.now() / 60_000) * 60_000;
}

/** "in 3 days" / "today" / "any time now" for a purge time. */
function purgeLabel(at: number, now: number): string {
    const days = Math.ceil((at - now) / 86_400_000);
    if (days <= 0) return 'any time now';
    if (days === 1) return 'within a day';
    return `in ${days} days`;
}

function retentionCopy(days: number): string {
    if (days <= 0) return 'Notes stay in the trash until you delete them forever or empty it.';
    return `Notes in the trash are deleted forever after ${days} day${days === 1 ? '' : 's'}. Restore one to see and change it again.`;
}

function TrashRow({ list, content, now }: { list: TaskList; content: ListContentActions; now: number }) {
    const title = list.title.trim() ? list.title : 'Untitled note';
    const body = list.body && !isUndecryptable(list.body) ? list.body : '';
    const pictures = galleryItems(list.attachments).filter(i => i.kind !== 'file').length;
    const purge = trashPurgeAt(list.trashed_at, content.features.trashRetentionDays);
    const trashed = list.trashed_at ? parseServerTimestamp(list.trashed_at) : NaN;
    const parts: string[] = [];
    if (list.total_tasks > 0) parts.push(`${list.total_tasks} item${list.total_tasks === 1 ? '' : 's'}`);
    if (pictures > 0) parts.push(`${pictures} picture${pictures === 1 ? '' : 's'}`);
    if (Number.isFinite(trashed)) parts.push(`trashed ${new Date(trashed).toLocaleDateString()}`);
    if (purge !== null) parts.push(`deleted forever ${purgeLabel(purge, now)}`);
    return (
        <li className="notes-trash-row" data-list-id={list.id}>
            <div className="notes-trash-main">
                <div className="notes-trash-title">{title}</div>
                {body && <div className="notes-trash-snippet">{body}</div>}
                <div className="notes-trash-meta">{parts.join(' · ')}</div>
            </div>
            <div className="notes-trash-actions">
                <button type="button" className="notes-textbtn primary" onClick={() => void content.restore(list.id)}>Restore</button>
                <button
                    type="button"
                    className="notes-textbtn danger"
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

export function TrashView({ content }: { content: ListContentActions }) {
    const trash = useTrashedLists();
    const now = useSyncExternalStore(subscribeMinute, minuteNow, minuteNow);
    const lists = trash.data ?? [];
    return (
        <section className="notes-trash" aria-label="Trash">
            <div className="notes-trash-head">
                <h1 className="notes-section-title">Trash</h1>
                <span className="spacer" />
                {lists.length > 0 && (
                    <button
                        type="button"
                        className="notes-textbtn danger"
                        onClick={() => {
                            if (!window.confirm(`Delete all ${lists.length} note${lists.length === 1 ? '' : 's'} in the trash forever? This can’t be undone.`)) return;
                            void content.emptyTrash();
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
                    {lists.map(l => <TrashRow key={l.id} list={l} content={content} now={now} />)}
                </ul>
            )}
        </section>
    );
}
