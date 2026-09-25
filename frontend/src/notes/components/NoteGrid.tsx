/**
 * The grid: PINNED first, then OTHERS, each a masonry of NoteCards (CSS
 * columns, two on a phone; single column in list view).
 *
 * DRAG is offered only where the section really is ONE COLUMN — list view.
 * useDragReorder is one-axis and sorts items by their y-start, which across
 * CSS columns is meaningless, so masonry on a fine pointer keeps the card menu
 * alone (Move to top / up / down / to bottom), which is also the tap and
 * keyboard alternative the design rules require everywhere.
 *
 * Each section mounts its OWN hook instance and its cards carry that section's
 * `data-drag-group`, so a card can never be dragged from Others into Pinned:
 * splitPinned re-splits on every render, so nothing visible would change while
 * Púca's tab bar was silently rewritten (NotesShell's menuFor has that story).
 */
import { useDragReorder } from '../../hooks/useDragReorder';
import { NoteIcon, ArchiveIcon, SearchIcon, TagIcon } from '../../components/Icons';
import { type NoteCard as NoteCardModel, type NoteFilter } from '../model/notesModel';
import { type NoteActions } from '../model/notesQueries';
import { NoteCard } from './NoteCard';

export type GridSection = 'pinned' | 'others';

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
    /** Drag to reorder is allowed at all (saved order, no search, one column). */
    canDrag?: boolean;
    /** A drop: the section's keys in their new visible order. */
    onDropReorder?: (section: GridSection, nextVisible: string[]) => void;
    /** Bulk selection (optional). */
    selected?: ReadonlySet<string>;
    onSelect?: (card: NoteCardModel, e: { shiftKey: boolean }) => void;
}

function Empty({ filter }: { filter: NoteFilter }) {
    switch (filter.kind) {
        case 'archive':
            return <div className="notes-empty"><ArchiveIcon size={48} /><p>Nothing archived. Archived notes leave the main view but keep their items and reminders.</p></div>;
        case 'label':
            return <div className="notes-empty"><TagIcon size={48} /><p>No notes labelled <strong>{filter.label}</strong>.</p></div>;
        case 'search':
            return <div className="notes-empty"><SearchIcon size={48} /><p>No notes match <strong>{filter.query}</strong>.</p></div>;
        default:
            return (
                <div className="notes-empty">
                    <NoteIcon size={48} />
                    <p>Notes you add here are your <strong>personal lists</strong> in Púca's Tasks view, and every checklist channel from your servers shows up as a shared note.</p>
                    <p>Start with <strong>Take a note…</strong> above.</p>
                </div>
            );
    }
}

function DropLine({ indicator }: { indicator: { x: number; y: number; width: number; height: number } | null }) {
    if (!indicator) return null;
    return (
        <div
            className="notes-grid-drop-indicator"
            style={{ left: indicator.x, top: indicator.y, width: indicator.width, height: indicator.height }}
        />
    );
}

export function NoteGrid(props: NoteGridProps) {
    const { pinned, others, filter, view, loading, canDrag = false, onDropReorder } = props;

    // Both hooks are called unconditionally, ABOVE the early returns below —
    // rules-of-hooks is a required gate here and a hook under a return shipped
    // as far as a signed installer once. Destructured on purpose: passing
    // `hook.setContainer` straight to a JSX ref makes the refs lint treat the
    // whole returned object as a ref (see useDragReorder's own note).
    const dragFor = (section: GridSection, count: number) => ({
        axis: 'y' as const,
        handleSelector: '.notes-card-grip',
        touchHoldMs: 0,            // the grip has touch-action: none — no scroll to fight
        enabled: canDrag && !!onDropReorder && count > 1,
        onDrop: ({ key, order, insertAt }: { key: string; order: string[]; insertAt: number }) => {
            const next = [...order];
            next.splice(insertAt, 0, key);
            onDropReorder?.(section, next);
        },
    });
    const { setContainer: setPinnedContainer, state: pinnedDrag, onPointerDown: onPinnedPointerDown } =
        useDragReorder(dragFor('pinned', pinned.length));
    const { setContainer: setOthersContainer, state: othersDrag, onPointerDown: onOthersPointerDown } =
        useDragReorder(dragFor('others', others.length));

    if (loading && pinned.length === 0 && others.length === 0) {
        return <div className="notes-loading"><span className="notes-spinner" /> Loading your notes…</div>;
    }
    if (pinned.length === 0 && others.length === 0) return <Empty filter={filter} />;
    const cardProps = {
        actions: props.actions, now: props.now, compactTools: props.compactTools,
        onOpen: props.onOpen, onMenu: props.onMenu, onPickColor: props.onPickColor,
        onPickLabels: props.onPickLabels, onLabelClick: props.onLabelClick, onArchive: props.onArchive,
        registerEl: props.registerEl,
        // A search is what put these cards here: hand the card the text so it
        // can say WHERE it matched. Never persisted, never sent.
        query: filter.kind === 'search' ? filter.query : undefined,
        onSelect: props.onSelect,
        selecting: (props.selected?.size ?? 0) > 0,
    };
    const pinnedDraggable = canDrag && !!onDropReorder && pinned.length > 1;
    const othersDraggable = canDrag && !!onDropReorder && others.length > 1;
    return (
        <>
            {pinned.length > 0 && (
                <section aria-label="Pinned notes">
                    <h2 className="notes-section-title">Pinned</h2>
                    <div className={`notes-grid ${view === 'list' ? 'list' : ''}`} ref={setPinnedContainer} onPointerDown={onPinnedPointerDown}>
                        <DropLine indicator={pinnedDrag.indicator} />
                        {pinned.map(c => (
                            <NoteCard
                                key={c.key}
                                card={c}
                                {...cardProps}
                                draggable={pinnedDraggable}
                                draggingKey={pinnedDrag.dragging?.key ?? null}
                                selected={props.selected?.has(c.key) ?? false}
                            />
                        ))}
                    </div>
                </section>
            )}
            {others.length > 0 && (
                <section aria-label={pinned.length > 0 ? 'Other notes' : 'Notes'}>
                    {pinned.length > 0 && <h2 className="notes-section-title">Others</h2>}
                    <div className={`notes-grid ${view === 'list' ? 'list' : ''}`} ref={setOthersContainer} onPointerDown={onOthersPointerDown}>
                        <DropLine indicator={othersDrag.indicator} />
                        {others.map(c => (
                            <NoteCard
                                key={c.key}
                                card={c}
                                {...cardProps}
                                draggable={othersDraggable}
                                draggingKey={othersDrag.dragging?.key ?? null}
                                selected={props.selected?.has(c.key) ?? false}
                            />
                        ))}
                    </div>
                </section>
            )}
        </>
    );
}
