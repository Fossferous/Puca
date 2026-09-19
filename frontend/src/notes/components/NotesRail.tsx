/**
 * The left rail: Notes, Reminders (badge = overdue + today), one entry per
 * label, Archive, and the way back to Púca. A drawer on narrow windows and
 * phones (notes.css); the owner passes `open` and the scrim closes it.
 */
import { ArchiveIcon, BellIcon, CalendarIcon, NoteIcon, PopOutIcon, TagIcon, TrashIcon } from '../../components/Icons';
import { isMobile } from '../../api/platform';
import { type NoteFilter } from '../model/notesModel';

/** Inside the Notes Android shell there is no Púca page to open — `/` IS
 *  this page — and the Púca app is a separate install. */
const NATIVE = isMobile();

interface NotesRailProps {
    filter: NoteFilter | { kind: 'reminders' } | { kind: 'trash' } | { kind: 'calendar' };
    /** The server has a trash (useListContent.ts): show its entry. */
    trashEnabled?: boolean;
    labels: string[];
    reminderBadge: number;
    counts: { notes: number; archived: number };
    open: boolean;
    onClose: () => void;
    onNavigate: (to: string) => void;
    version: string;
}

export function NotesRail({ filter, labels, reminderBadge, counts, open, onClose, onNavigate, version, trashEnabled = false }: NotesRailProps) {
    const go = (to: string) => { onNavigate(to); onClose(); };
    const is = (k: string) => filter.kind === k;
    return (
        <>
            {open && <div className="notes-rail-scrim" onClick={onClose} />}
            <nav className={`notes-rail ${open ? 'open' : ''}`} aria-label="Views">
                <button type="button" className={`notes-rail-item ${is('all') || is('search') ? 'active' : ''}`} onClick={() => go('/')}>
                    <NoteIcon /><span className="notes-rail-label">Notes</span>
                    <span className="notes-rail-count">{counts.notes}</span>
                </button>
                <button type="button" className={`notes-rail-item ${is('reminders') ? 'active' : ''}`} onClick={() => go('/reminders')}>
                    <BellIcon /><span className="notes-rail-label">Reminders</span>
                    {reminderBadge > 0 && <span className="notes-badge">{reminderBadge}</span>}
                </button>
                <button type="button" className={`notes-rail-item ${is('calendar') ? 'active' : ''}`} onClick={() => go('/calendar')}>
                    <CalendarIcon /><span className="notes-rail-label">Calendar</span>
                </button>
                {labels.length > 0 && <div className="notes-rail-section">Labels</div>}
                {labels.map(l => (
                    <button
                        key={l}
                        type="button"
                        className={`notes-rail-item ${filter.kind === 'label' && filter.label.toLocaleLowerCase() === l.toLocaleLowerCase() ? 'active' : ''}`}
                        onClick={() => go(`/label/${encodeURIComponent(l)}`)}
                    >
                        <TagIcon /><span className="notes-rail-label">{l}</span>
                    </button>
                ))}
                <div className="notes-rail-section">More</div>
                <button type="button" className={`notes-rail-item ${is('archive') ? 'active' : ''}`} onClick={() => go('/archive')}>
                    <ArchiveIcon /><span className="notes-rail-label">Archive</span>
                    <span className="notes-rail-count">{counts.archived}</span>
                </button>
                {trashEnabled && (
                    <button type="button" className={`notes-rail-item ${is('trash') ? 'active' : ''}`} onClick={() => go('/trash')}>
                        <TrashIcon /><span className="notes-rail-label">Trash</span>
                    </button>
                )}
                {!NATIVE && (
                    <a className="notes-rail-item" href="/" target="_blank" rel="noopener">
                        <PopOutIcon /><span className="notes-rail-label">Open Púca</span>
                    </a>
                )}
                <div className="notes-rail-spacer" />
                <div className="notes-rail-foot">Púca Notes {version}</div>
            </nav>
        </>
    );
}
