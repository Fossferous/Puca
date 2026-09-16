/**
 * The grid: PINNED first, then OTHERS, each a masonry of NoteCards (CSS
 * columns; single column in list view and on phones). No card drag —
 * CSS-columns layout is two-dimensional and useDragReorder is one-axis, so
 * ordering is done from the card menu (Move to top / up / down), which is
 * also the tap alternative the design rules require.
 */
import { NoteIcon, ArchiveIcon, SearchIcon, TagIcon } from '../../components/Icons';
import { type NoteCard as NoteCardModel, type NoteFilter } from '../model/keepModel';
import { type NoteActions } from '../model/notesQueries';
import { NoteCard } from './NoteCard';

interface NoteGridProps {
    pinned: NoteCardModel[];
    others: NoteCardModel[];
    filter: NoteFilter;
    view: 'grid' | 'list';
    loading: boolean;
    actions: NoteActions;
    now: number;
    compactTools: boolean;
    onOpen: (card: NoteCardModel) => void;
    onMenu: (e: React.MouseEvent, card: NoteCardModel, anchor: HTMLElement) => void;
    onPickColor: (card: NoteCardModel, anchor: HTMLElement) => void;
    onPickLabels: (card: NoteCardModel, anchor: HTMLElement) => void;
    onLabelClick: (label: string) => void;
    onArchive: (card: NoteCardModel, archived: boolean) => void;
    registerEl: (key: string, el: HTMLElement | null) => void;
}

function Empty({ filter }: { filter: NoteFilter }) {
    switch (filter.kind) {
        case 'archive':
            return <div className="keep-empty"><ArchiveIcon size={48} /><p>Nothing archived. Archived notes leave the main view but keep their items and reminders.</p></div>;
        case 'label':
            return <div className="keep-empty"><TagIcon size={48} /><p>No notes labelled <strong>{filter.label}</strong>.</p></div>;
        case 'search':
            return <div className="keep-empty"><SearchIcon size={48} /><p>No notes match <strong>{filter.query}</strong>.</p></div>;
        default:
            return (
                <div className="keep-empty">
                    <NoteIcon size={48} />
                    <p>Notes you add here are your <strong>personal lists</strong> in Púca's Tasks view, and every checklist channel from your servers shows up as a shared note.</p>
                    <p>Start with <strong>Take a note…</strong> above.</p>
                </div>
            );
    }
}

export function NoteGrid(props: NoteGridProps) {
    const { pinned, others, filter, view, loading } = props;
    if (loading && pinned.length === 0 && others.length === 0) {
        return <div className="keep-loading"><span className="keep-spinner" /> Loading your notes…</div>;
    }
    if (pinned.length === 0 && others.length === 0) return <Empty filter={filter} />;
    const cardProps = {
        actions: props.actions, now: props.now, compactTools: props.compactTools,
        onOpen: props.onOpen, onMenu: props.onMenu, onPickColor: props.onPickColor,
        onPickLabels: props.onPickLabels, onLabelClick: props.onLabelClick, onArchive: props.onArchive,
        registerEl: props.registerEl,
    };
    return (
        <>
            {pinned.length > 0 && (
                <section aria-label="Pinned notes">
                    <h2 className="keep-section-title">Pinned</h2>
                    <div className={`keep-grid ${view === 'list' ? 'list' : ''}`}>
                        {pinned.map(c => <NoteCard key={c.key} card={c} {...cardProps} />)}
                    </div>
                </section>
            )}
            {others.length > 0 && (
                <section aria-label={pinned.length > 0 ? 'Other notes' : 'Notes'}>
                    {pinned.length > 0 && <h2 className="keep-section-title">Others</h2>}
                    <div className={`keep-grid ${view === 'list' ? 'list' : ''}`}>
                        {others.map(c => <NoteCard key={c.key} card={c} {...cardProps} />)}
                    </div>
                </section>
            )}
        </>
    );
}
