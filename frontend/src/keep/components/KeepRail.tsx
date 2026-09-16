/**
 * The left rail: Notes, Reminders (badge = overdue + today), one entry per
 * label, Archive, and the way back to Púca. A drawer on narrow windows and
 * phones (keep.css); the owner passes `open` and the scrim closes it.
 */
import { ArchiveIcon, BellIcon, NoteIcon, PopOutIcon, TagIcon } from '../../components/Icons';
import { isMobile } from '../../api/platform';
import { type NoteFilter } from '../model/keepModel';

/** Inside the Keep Android shell there is no Púca page to open — `/` IS
 *  this page — and the Púca app is a separate install. */
const NATIVE = isMobile();

interface KeepRailProps {
    filter: NoteFilter | { kind: 'reminders' };
    labels: string[];
    reminderBadge: number;
    counts: { notes: number; archived: number };
    open: boolean;
    onClose: () => void;
    onNavigate: (to: string) => void;
    version: string;
}

export function KeepRail({ filter, labels, reminderBadge, counts, open, onClose, onNavigate, version }: KeepRailProps) {
    const go = (to: string) => { onNavigate(to); onClose(); };
    const is = (k: string) => filter.kind === k;
    return (
        <>
            {open && <div className="keep-rail-scrim" onClick={onClose} />}
            <nav className={`keep-rail ${open ? 'open' : ''}`} aria-label="Views">
                <button type="button" className={`keep-rail-item ${is('all') || is('search') ? 'active' : ''}`} onClick={() => go('/')}>
                    <NoteIcon /><span className="keep-rail-label">Notes</span>
                    <span className="keep-rail-count">{counts.notes}</span>
                </button>
                <button type="button" className={`keep-rail-item ${is('reminders') ? 'active' : ''}`} onClick={() => go('/reminders')}>
                    <BellIcon /><span className="keep-rail-label">Reminders</span>
                    {reminderBadge > 0 && <span className="keep-badge">{reminderBadge}</span>}
                </button>
                {labels.length > 0 && <div className="keep-rail-section">Labels</div>}
                {labels.map(l => (
                    <button
                        key={l}
                        type="button"
                        className={`keep-rail-item ${filter.kind === 'label' && filter.label.toLocaleLowerCase() === l.toLocaleLowerCase() ? 'active' : ''}`}
                        onClick={() => go(`/label/${encodeURIComponent(l)}`)}
                    >
                        <TagIcon /><span className="keep-rail-label">{l}</span>
                    </button>
                ))}
                <div className="keep-rail-section">More</div>
                <button type="button" className={`keep-rail-item ${is('archive') ? 'active' : ''}`} onClick={() => go('/archive')}>
                    <ArchiveIcon /><span className="keep-rail-label">Archive</span>
                    <span className="keep-rail-count">{counts.archived}</span>
                </button>
                {!NATIVE && (
                    <a className="keep-rail-item" href="/" target="_blank" rel="noopener">
                        <PopOutIcon /><span className="keep-rail-label">Open Púca</span>
                    </a>
                )}
                <div className="keep-rail-spacer" />
                <div className="keep-rail-foot">Púca Keep {version}</div>
            </nav>
        </>
    );
}
