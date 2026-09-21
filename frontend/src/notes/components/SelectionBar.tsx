/**
 * Bulk selection: pick several notes, then pin, colour, label, archive,
 * delete, copy or duplicate them together.
 *
 * ENTRY. Desktop: the checkbox a card shows on hover, Shift-click (a range in
 * the visible order), Ctrl/Cmd-click, Ctrl/Cmd+A (every visible note). Phone:
 * a long press on a card (DESIGN_PHILOSOPHY §5 — the tap alternative to a
 * modifier key); after that, taps toggle. Esc, or the bar's close button,
 * ends it. While anything is selected this bar sits over the top bar.
 *
 * ONE WRITE PER ACTION. Pins are one save of Púca's tab prefs, built over the
 * FULL note order so hidden notes keep their slots (notesModel bulkPinOrder);
 * colour, labels and archive are one write of the synced note state
 * (notesBulk.ts) — one sealed push, not one per note. Delete waits out an
 * Undo window, then moves the personal notes to the trash where the server
 * has one (else deletes them — notesQueries.ts deleteNote, through the
 * offline outbox) with bounded concurrency, and says which failed. Shared
 * notes (channel checklists) and Notes to self (which the trash refuses) are
 * skipped by Delete, and the button says so.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
    ArchiveIcon, CheckboxCheckedIcon, CheckboxIcon, CloseIcon, CopyIcon, FileTextIcon, PaletteIcon, PinIcon, PlusIcon, TagIcon, TrashIcon,
} from '../../components/Icons';
import { pushMessageToast } from '../../components/messageToastBus';
import { normalizeLabel, type NoteCard, type NoteColor, MAX_LABEL_LENGTH } from '../model/notesModel';
import { labelCoverage, setArchivedOf, setColorOf, setLabelOn } from '../model/notesBulk';
import { type NoteActions, useNotesPrefs } from '../model/notesQueries';
import { type BulkPendingApi } from './useNoteSelection';
import { copyBlockersOf, copyPlanOf, copyRefusal, noteToMarkdown } from '../model/noteText';
import { useTaskFeature } from '../../api/taskFeatures';
import { ColorPicker } from './ColorPicker';
import { Popover } from './Popover';
import '../sync.css';

type Pop = { kind: 'color' | 'labels'; anchor: HTMLElement } | null;

interface SelectionBarProps {
    cards: NoteCard[];
    actions: NoteActions;
    labels: string[];
    bulk: BulkPendingApi;
    onClear: () => void;
    onSelectAll: () => void;
    allSelected: boolean;
}

export function SelectionBar({ cards, actions, labels, bulk, onClear, onSelectAll, allSelected }: SelectionBarProps) {
    const [pop, setPop] = useState<Pop>(null);
    const scheduleOnServer = useTaskFeature('schedule') === true;
    const keys = cards.map(c => c.key);
    const allPinned = cards.every(c => c.pinned);
    const allArchived = cards.every(c => c.archived);
    const deletable = cards.filter(c => c.ref.kind === 'list' && !actions.content.isSelfList(c.ref.id));
    const self = cards.filter(c => c.ref.kind === 'list').length - deletable.length;
    const shared = cards.length - deletable.length - self;
    const commonColor: NoteColor = cards.every(c => c.color === cards[0]?.color) ? (cards[0]?.color ?? 'default') : 'default';

    const pin = () => { actions.setPinnedMany(cards.map(c => c.ref), !allPinned); onClear(); };
    const archive = () => {
        const target = !allArchived;
        bulk.commit(bulk.pendingRef.current);
        const flags = Object.fromEntries(cards.map(c => [c.key, c.archived]));
        setArchivedOf(keys, target);
        bulk.setPending(target ? { kind: 'archive', flags, count: cards.length, token: bulk.nextToken() } : null);
        onClear();
    };
    const del = () => {
        if (deletable.length === 0) return;
        bulk.commit(bulk.pendingRef.current);
        bulk.setPending({ kind: 'delete', cards: deletable, token: bulk.nextToken() });
        if (shared > 0) pushMessageToast({ title: `${shared} shared note${shared === 1 ? ' was' : 's were'} left alone — shared notes are deleted from their server` });
        if (self > 0) pushMessageToast({ title: 'Notes to self was left alone — it can’t be moved to the trash' });
        onClear();
    };
    const copyText = async () => {
        try {
            await navigator.clipboard.writeText(cards.map(noteToMarkdown).join('\n\n'));
            pushMessageToast({ title: `Copied ${cards.length} notes as text` });
        } catch {
            pushMessageToast({ title: 'Couldn’t write to the clipboard' });
        }
    };
    const duplicate = async () => {
        onClear();
        let made = 0;
        let unreadable = 0;
        // Sequential: each copy now re-encrypts the note's pictures, and a
        // bulk copy must not fan out N x 12 uploads at once.
        for (const c of cards) {
            // A copy as the card menu makes one (NotesShell duplicate): the
            // whole note, and nothing at all when part of it cannot be read here.
            if (copyRefusal(copyBlockersOf(c))) { unreadable++; continue; }
            const ref = await actions.copyNote(copyPlanOf(c, { schedules: !!scheduleOnServer }));
            if (!ref) continue;
            made++;
            if (c.color !== 'default') actions.setColor(ref, c.color);
            if (c.labels.length > 0) actions.setLabels(ref, c.labels);
        }
        const title = made === cards.length
            ? `Made ${made} cop${made === 1 ? 'y' : 'ies'}`
            : unreadable > 0
                ? `Made ${made} of ${cards.length} copies — ${unreadable} couldn’t be read on this device`
                : `Made ${made} of ${cards.length} copies`;
        pushMessageToast({ title });
    };

    return createPortal(
        <>
            <div className="notes-selectbar" role="toolbar" aria-label={`${cards.length} notes selected`}>
                <button type="button" className="notes-iconbtn" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear}><CloseIcon /></button>
                <span className="notes-selectbar-count" aria-live="polite">{cards.length} selected</span>
                <button type="button" className="notes-iconbtn notes-selectbar-all" aria-label={allSelected ? 'All selected' : 'Select all'} title="Select all (Ctrl+A)" disabled={allSelected} onClick={onSelectAll}>
                    {allSelected ? <CheckboxCheckedIcon /> : <CheckboxIcon />}
                </button>
                <span className="spacer" />
                <button type="button" className={`notes-iconbtn ${allPinned ? 'active' : ''}`} aria-label={allPinned ? 'Unpin selected' : 'Pin selected'} title={allPinned ? 'Unpin' : 'Pin'} onClick={pin}><PinIcon /></button>
                <button type="button" className="notes-iconbtn" aria-label="Colour selected" title="Colour" onClick={e => setPop({ kind: 'color', anchor: e.currentTarget })}><PaletteIcon /></button>
                <button type="button" className="notes-iconbtn" aria-label="Label selected" title="Labels" onClick={e => setPop({ kind: 'labels', anchor: e.currentTarget })}><TagIcon /></button>
                <button type="button" className="notes-iconbtn" aria-label={allArchived ? 'Unarchive selected' : 'Archive selected'} title={allArchived ? 'Unarchive' : 'Archive'} onClick={archive}><ArchiveIcon /></button>
                <button
                    type="button"
                    className="notes-iconbtn"
                    aria-label="Delete selected"
                    title={deletable.length === 0
                        ? (self > 0 && shared === 0 ? 'Notes to self can’t be moved to the trash' : 'Shared notes can only be deleted from their server')
                        : shared + self > 0 ? `Delete ${deletable.length} (${shared > 0 ? 'shared notes' : 'Notes to self'}${shared > 0 && self > 0 ? ' and Notes to self' : ''} skipped)` : 'Delete'}
                    disabled={deletable.length === 0}
                    onClick={del}
                ><TrashIcon /></button>
                <button type="button" className="notes-iconbtn notes-selectbar-extra" aria-label="Make copies" title="Make copies" onClick={() => { void duplicate(); }}><FileTextIcon /></button>
                <button type="button" className="notes-iconbtn notes-selectbar-extra" aria-label="Copy as text" title="Copy as text" onClick={() => { void copyText(); }}><CopyIcon /></button>
            </div>
            {pop?.kind === 'color' && (
                <Popover anchor={pop.anchor} onClose={() => setPop(null)} label="Colour for the selected notes">
                    <h4>Colour · {cards.length} notes</h4>
                    <ColorPicker value={commonColor} onChange={c => setColorOf(keys, c)} />
                </Popover>
            )}
            {pop?.kind === 'labels' && (
                <Popover anchor={pop.anchor} onClose={() => setPop(null)} label="Labels for the selected notes">
                    <BulkLabelPicker keys={keys} labels={labels} />
                </Popover>
            )}
        </>,
        document.body,
    );
}

/** Tick = every selected note has it; a dash = some do. Ticking adds it to
 *  all, unticking removes it from all. */
function BulkLabelPicker({ keys, labels }: { keys: string[]; labels: string[] }) {
    const [draft, setDraft] = useState('');
    const state = useNotesPrefs();
    const coverage = labelCoverage(state, keys, labels);
    const add = () => {
        const l = normalizeLabel(draft);
        if (!l) return;
        setLabelOn(keys, l, true);
        setDraft('');
    };
    return (
        <div>
            <h4>Labels · {keys.length} notes</h4>
            {labels.length === 0 ? (
                <div className="notes-labels-hint">No labels yet — add one below.</div>
            ) : (
                <div className="notes-labels-list">
                    {labels.map(l => {
                        const c = coverage.get(l) ?? 'none';
                        return (
                            <label key={l}>
                                <input
                                    type="checkbox"
                                    checked={c === 'all'}
                                    ref={el => { if (el) el.indeterminate = c === 'some'; }}
                                    aria-checked={c === 'some' ? 'mixed' : c === 'all'}
                                    onChange={() => setLabelOn(keys, l, c !== 'all')}
                                />
                                <span>{l}</span>
                            </label>
                        );
                    })}
                </div>
            )}
            <form className="notes-labels-new" onSubmit={e => { e.preventDefault(); add(); }}>
                <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="New label" maxLength={MAX_LABEL_LENGTH} aria-label="New label" />
                <button type="submit" className="notes-iconbtn small" aria-label="Add label to the selected notes" title="Add label" disabled={!normalizeLabel(draft)}>
                    <PlusIcon />
                </button>
            </form>
        </div>
    );
}
