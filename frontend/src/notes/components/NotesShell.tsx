/**
 * The signed-in Notes: top bar, rail, the grid or reminders view, the open
 * note, and every popover, menu and snackbar. Owns the view state (the hash
 * route + `?q=` search + `?note=` open note) and hands the data layer's
 * actions down.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { decodeJwtPayload, getToken, logoutEverywhere } from '../../api/auth';
import { isNetworkError } from '../../api/client';
import { isMobile } from '../../api/platform';
import { notificationPermission } from '../../api/desktopNotify';
import { startTaskReminders } from '../../api/taskReminders';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { useContextMenu } from '../../components/contextMenuUtils';
import { IdentityBanner } from '../../components/IdentityBanner';
import { MessageToasts } from '../../components/MessageToasts';
import { pushMessageToast } from '../../components/messageToastBus';
import { PlusIcon, WarningIcon } from '../../components/Icons';
import {
    type NoteCard, type NoteFilter, type NoteRef,
    allLabels, filterNotes, groupReminders, moveNoteInOrder, reminderBadgeCount, splitPinned,
} from '../model/notesModel';
import { setNotesSort, setNotesView, type NotesSortMode } from '../model/notesPrefs';
import { useNotesPrefs, useNoteActions, useNoteCards } from '../model/notesQueries';
import { downloadTextFile, fileStamp, noteToMarkdown, notesToJson, notesToMarkdown, openItemsOf } from '../model/noteText';
import { AccountMenu } from './AccountMenu';
import { ColorPicker } from './ColorPicker';
import { ShortcutsHelp } from './NotesDialog';
import { NotesRail } from './NotesRail';
import { NotesTopBar } from './NotesTopBar';
import { NotesUpdateStripSlot } from './NotesUpdateGate';
import { LabelPicker } from './LabelPicker';
import { NoteEditor } from './NoteEditor';
import { NoteGrid } from './NoteGrid';
import { Popover } from './Popover';
import { QuickAdd } from './QuickAdd';
import { RemindersView } from './RemindersView';
import { UndoBar } from './UndoBar';
import { useNotesShortcuts } from './useNotesShortcuts';

// Shared 30-second clock for due styling (TaskTree's pattern): quantized so
// the snapshot is referentially stable between ticks.
function subscribeHalfMinute(onTick: () => void): () => void {
    const id = window.setInterval(onTick, 30_000);
    return () => window.clearInterval(id);
}
function halfMinuteNow(): number {
    return Math.floor(Date.now() / 30_000) * 30_000;
}

// The JS side of the coarse-pointer media query, mirroring the CSS exactly
// (docs/DESIGN_PHILOSOPHY.md §2).
const COARSE = '(pointer: coarse) and (max-width: 1024px)';
function subscribeCoarse(cb: () => void): () => void {
    const mq = window.matchMedia(COARSE);
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
}
function isCoarse(): boolean {
    return window.matchMedia(COARSE).matches;
}

type Popup =
    | { kind: 'color'; key: string; anchor: HTMLElement }
    | { kind: 'labels'; key: string; anchor: HTMLElement }
    | { kind: 'account'; anchor: HTMLElement };

type Pending =
    | { kind: 'delete'; key: string; ref: NoteRef; title: string; token: number }
    | { kind: 'archive'; key: string; ref: NoteRef; title: string; token: number };

function sortCards(cards: NoteCard[], sort: NotesSortMode): NoteCard[] {
    if (sort === 'puca') return cards;
    const out = [...cards];
    if (sort === 'title') out.sort((a, b) => a.title.localeCompare(b.title));
    else out.sort((a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0));
    return out;
}

interface NotesShellProps {
    onSignOut: () => void;
}

export function NotesShell({ onSignOut }: NotesShellProps) {
    const location = useLocation();
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    // The search text lives in state, NOT in the URL: it is typed against
    // decrypted note content, and the address bar and history are the one
    // store a sign-out cannot scrub. Only the open note's id rides the hash.
    const [query, setQueryState] = useState('');
    const openKey = params.get('note');

    const { cards: allCards, prefs, prefsReady, loading, error, tasksPending } = useNoteCards();
    const actions = useNoteActions(allCards, prefs, prefsReady);
    const local = useNotesPrefs();
    const now = useSyncExternalStore(subscribeHalfMinute, halfMinuteNow, halfMinuteNow);
    const coarse = useSyncExternalStore(subscribeCoarse, isCoarse, () => false);

    const [drawer, setDrawer] = useState(false);
    const [popup, setPopup] = useState<Popup | null>(null);
    const [help, setHelp] = useState(false);
    const [sheet, setSheet] = useState(false);
    const [quickSignal, setQuickSignal] = useState(0);
    const [pending, setPending] = useState<Pending | null>(null);
    const [notif, setNotif] = useState(notificationPermission);
    const { contextMenu, showContextMenu, hideContextMenu } = useContextMenu();
    const searchRef = useRef<HTMLInputElement>(null);
    const cardEls = useRef(new Map<string, HTMLElement>());
    const registerEl = useCallback((key: string, el: HTMLElement | null) => {
        if (el) cardEls.current.set(key, el);
        else cardEls.current.delete(key);
    }, []);

    // --- View --------------------------------------------------------------------
    const path = location.pathname;
    const remindersView = path === '/reminders';
    const filter: NoteFilter = useMemo(() => {
        if (query.trim() && !remindersView) return { kind: 'search', query };
        if (path === '/archive') return { kind: 'archive' };
        const labelMatch = /^\/label\/(.+)$/.exec(path);
        if (labelMatch) return { kind: 'label', label: decodeURIComponent(labelMatch[1]) };
        return { kind: 'all' };
    }, [path, query, remindersView]);

    // A delete waits in the undo window; until it commits the note is hidden.
    const cards = useMemo(
        () => (pending?.kind === 'delete' ? allCards.filter(c => c.key !== pending.key) : allCards),
        [allCards, pending],
    );
    const cardsByKey = useMemo(() => new Map(cards.map(c => [c.key, c])), [cards]);
    const visible = useMemo(() => sortCards(filterNotes(cards, filter), local.sort), [cards, filter, local.sort]);
    const { pinned, others } = useMemo(() => splitPinned(visible), [visible]);
    const labels = useMemo(() => allLabels(cards), [cards]);
    const reminders = useMemo(() => groupReminders(cards, now), [cards, now]);
    const counts = useMemo(() => ({
        notes: cards.filter(c => !c.archived).length,
        archived: cards.filter(c => c.archived).length,
    }), [cards]);

    const openCard = openKey ? cardsByKey.get(openKey) ?? null : null;
    useEffect(() => {
        // The open note vanished (deleted elsewhere, left the server): drop the param.
        if (openKey && !loading && !openCard && cards.length > 0) {
            setParams(p => { p.delete('note'); return p; }, { replace: true });
        }
    }, [openKey, openCard, loading, cards.length, setParams]);

    // --- Navigation helpers ---------------------------------------------------------
    const go = useCallback((to: string) => { navigate(to); }, [navigate]);
    const setQuery = useCallback((q: string) => {
        setQueryState(q);
        if (q && remindersView) navigate('/', { replace: true });
    }, [navigate, remindersView]);
    const openNote = useCallback((card: NoteCard) => {
        setParams(p => { p.set('note', card.key); return p; });
    }, [setParams]);
    const closeNote = useCallback(() => {
        setParams(p => { p.delete('note'); return p; });
    }, [setParams]);

    // --- Reminders loop + notifications -------------------------------------------------
    useEffect(() => startTaskReminders(), []);
    const enableNotifications = async () => {
        if (typeof Notification === 'undefined') return;
        await Notification.requestPermission();
        setNotif(notificationPermission());
    };

    // --- Undo-able actions ------------------------------------------------------------------
    const pendingRef = useRef<Pending | null>(null);
    useEffect(() => { pendingRef.current = pending; }, [pending]);
    const commitPending = useCallback((p: Pending | null) => {
        if (!p) return;
        if (p.kind === 'delete') void actions.deleteNote(p.ref);
        // An archive already took effect; expiry just drops the undo.
    }, [actions]);
    // Leaving the shell (sign-out) commits whatever was pending.
    useEffect(() => () => { commitPending(pendingRef.current); }, [commitPending]);

    const tokenSeq = useRef(0);
    const deleteWithUndo = (card: NoteCard) => {
        if (card.ref.kind !== 'list') return;
        commitPending(pendingRef.current);
        if (openKey === card.key) closeNote();
        setPending({ kind: 'delete', key: card.key, ref: card.ref, title: card.title, token: ++tokenSeq.current });
    };
    const archiveWithUndo = useCallback((card: NoteCard, archived: boolean) => {
        commitPending(pendingRef.current);
        actions.setArchived(card.ref, archived);
        if (archived) setPending({ kind: 'archive', key: card.key, ref: card.ref, title: card.title, token: ++tokenSeq.current });
        else setPending(null);
    }, [actions, commitPending]);
    const undoPending = () => {
        const p = pendingRef.current;
        if (!p) return;
        if (p.kind === 'archive') actions.setArchived(p.ref, false);
        setPending(null);
    };
    const expirePending = () => {
        commitPending(pendingRef.current);
        setPending(null);
    };

    // --- Card menu -----------------------------------------------------------------------------
    // In the Notes Android shell `/` is this very page, so there is nothing to
    // open; on the web it is Púca, one origin over.
    const pucaHref = isMobile() ? null : `${window.location.origin}/`;
    const copyAsText = async (card: NoteCard) => {
        try {
            await navigator.clipboard.writeText(noteToMarkdown(card));
            pushMessageToast({ title: 'Copied as text' });
        } catch {
            pushMessageToast({ title: 'Couldn’t write to the clipboard' });
        }
    };
    const duplicate = async (card: NoteCard) => {
        const ref = await actions.createNote(`${card.title} (copy)`, openItemsOf(card));
        if (ref) {
            pushMessageToast({ title: 'Copied — open items only, un-nested' });
            setParams(p => { p.set('note', `${ref.kind}:${ref.id}`); return p; });
        }
    };
    const menuFor = (card: NoteCard, anchor: HTMLElement): ContextMenuItem[] => {
        const el = cardEls.current.get(card.key) ?? anchor;
        // Moves step among the cards RENDERED beside this one — its own
        // section (pinned or others) — never the unsplit order, where a
        // one-slot move could swap with a card drawn in the other section:
        // nothing visible changes, yet Púca's tab bar is rewritten.
        const section = card.pinned ? pinned : others;
        const visibleKeys = section.map(c => c.key);
        const fullKeys = allCards.map(c => c.key);
        const canMove = local.sort === 'puca' && filter.kind !== 'search' && section.length > 1;
        const move = (target: 'top' | 'up' | 'down') => {
            const next = moveNoteInOrder(fullKeys, visibleKeys, card.key, target);
            if (next) actions.reorderNotes(next);
        };
        const items: ContextMenuItem[] = [
            { id: 'open', label: 'Open', icon: 'note', onClick: () => openNote(card) },
            { id: 'pin', label: card.pinned ? 'Unpin' : 'Pin', icon: 'pin', onClick: () => actions.togglePin(card.ref) },
            { id: 'color', label: 'Colour…', icon: 'palette', onClick: () => setPopup({ kind: 'color', key: card.key, anchor: el }) },
            { id: 'labels', label: 'Labels…', icon: 'tag', onClick: () => setPopup({ kind: 'labels', key: card.key, anchor: el }) },
            { id: 'archive', label: card.archived ? 'Unarchive' : 'Archive', icon: 'archive', onClick: () => archiveWithUndo(card, !card.archived) },
            { id: 'sep1', label: '', separator: true },
        ];
        if (canMove) {
            items.push(
                { id: 'move-top', label: 'Move to top', icon: 'arrow-up-circle', onClick: () => move('top') },
                { id: 'move-up', label: 'Move up', icon: 'chevron-up', onClick: () => move('up') },
                { id: 'move-down', label: 'Move down', icon: 'chevron-down', onClick: () => move('down') },
                { id: 'sep2', label: '', separator: true },
            );
        }
        items.push(
            { id: 'copy-text', label: 'Copy as text', icon: 'copy', onClick: () => { void copyAsText(card); } },
            { id: 'duplicate', label: 'Make a copy', icon: 'file-text', onClick: () => { void duplicate(card); } },
        );
        if (pucaHref) {
            items.push({ id: 'puca', label: 'Open in Púca', icon: 'pop-out', onClick: () => window.open(pucaHref, '_blank', 'noopener') });
        }
        if (card.ref.kind === 'list') {
            items.push(
                { id: 'sep3', label: '', separator: true },
                { id: 'rename', label: 'Rename', icon: 'pencil', onClick: () => openNote(card) },
                { id: 'delete', label: 'Delete note', icon: 'trash', danger: true, onClick: () => deleteWithUndo(card) },
            );
        }
        return items;
    };
    // Stable identities, so memo(NoteCard) can actually skip renders: the
    // menu builder closes over the current view and is read through a ref.
    const menuForRef = useRef(menuFor);
    useEffect(() => { menuForRef.current = menuFor; });
    const onMenu = useCallback((e: React.MouseEvent, card: NoteCard, anchor: HTMLElement) => {
        showContextMenu(e, menuForRef.current(card, anchor));
    }, [showContextMenu]);
    const onPickColor = useCallback((card: NoteCard, anchor: HTMLElement) => setPopup({ kind: 'color', key: card.key, anchor }), []);
    const onPickLabels = useCallback((card: NoteCard, anchor: HTMLElement) => setPopup({ kind: 'labels', key: card.key, anchor }), []);
    const onLabelClick = useCallback((l: string) => { setQuery(''); go(`/label/${encodeURIComponent(l)}`); }, [setQuery, go]);

    // --- Composer --------------------------------------------------------------------------------
    const createNote = async (title: string, items: string[]): Promise<boolean> => {
        const ref = await actions.createNote(title, items);
        if (!ref) {
            pushMessageToast({ title: 'Couldn’t save the note — check your connection. Your text is still here.' });
            return false;
        }
        return true;
    };

    // --- Shortcuts ---------------------------------------------------------------------------------
    useNotesShortcuts({
        onSearch: () => searchRef.current?.focus(),
        onNew: () => { if (isCoarse()) setSheet(true); else setQuickSignal(n => n + 1); },
        onHelp: () => setHelp(true),
        onRefresh: () => { void actions.refreshAll(); },
    }, !openCard && !popup && !help && !sheet && !contextMenu);

    // --- Account -------------------------------------------------------------------------------------
    const username = (() => {
        const t = getToken();
        const u = t ? decodeJwtPayload(t)?.username : null;
        return typeof u === 'string' && u ? u : 'you';
    })();
    const signOutEverywhere = async () => {
        if (!window.confirm('Sign out of every device? Every phone and computer signed in to this account will need to sign in again.')) return;
        try {
            await logoutEverywhere();
        } catch {
            pushMessageToast({ title: 'Couldn’t reach the server — signed out here only' });
        }
        onSignOut();
    };
    const exportMd = () => downloadTextFile(`puca-notes-${fileStamp(Date.now())}.md`, notesToMarkdown(cards), 'text/markdown;charset=utf-8');
    const exportJson = () => downloadTextFile(`puca-notes-${fileStamp(Date.now())}.json`, notesToJson(cards, new Date().toISOString()), 'application/json');

    const popupCard = popup && popup.kind !== 'account' ? cardsByKey.get(popup.key) ?? null : null;
    const offline = error !== null && error !== undefined && isNetworkError(error);

    return (
        <div className="notes-app">
            <IdentityBanner onSignOut={onSignOut} />
            <NotesTopBar
                ref={searchRef}
                query={query}
                onQueryChange={setQuery}
                onClearQuery={() => setQuery('')}
                view={local.view}
                onToggleView={() => setNotesView(local.view === 'grid' ? 'list' : 'grid')}
                refreshing={tasksPending && cards.length > 0}
                onRefresh={() => { void actions.refreshAll(); }}
                onMenu={() => setDrawer(d => !d)}
                onHome={() => { setQuery(''); go('/'); }}
                accountInitial={username.slice(0, 1)}
                onAccount={anchor => setPopup({ kind: 'account', anchor })}
            />
            {/* The Android app's "new app" strip: its own row, never over the top bar. */}
            <NotesUpdateStripSlot />
            <div className="notes-body">
                <NotesRail
                    filter={remindersView ? { kind: 'reminders' } : filter}
                    labels={labels}
                    reminderBadge={reminderBadgeCount(reminders)}
                    counts={counts}
                    open={drawer}
                    onClose={() => setDrawer(false)}
                    onNavigate={to => { setQuery(''); go(to); }}
                    version={__APP_VERSION__}
                />
                <main className="notes-main">
                    <div className="notes-main-inner">
                        {offline && (
                            <div className="notes-status offline" role="status">
                                <WarningIcon /> You appear to be offline — showing what was loaded last.
                                <button type="button" onClick={() => { void actions.refreshAll(); }}>Retry</button>
                            </div>
                        )}
                        {error != null && !offline && (
                            <div className="notes-status error" role="alert">
                                <WarningIcon /> Couldn’t load your notes: {error instanceof Error ? error.message : String(error)}
                                <button type="button" onClick={() => { void actions.refreshAll(); }}>Retry</button>
                            </div>
                        )}
                        {remindersView ? (
                            <RemindersView
                                groups={reminders}
                                actions={actions}
                                now={now}
                                onOpen={openNote}
                                notificationsState={notif}
                                onEnableNotifications={() => { void enableNotifications(); }}
                            />
                        ) : (
                            <>
                                {filter.kind === 'all' && <QuickAdd onCreate={createNote} openSignal={quickSignal} />}
                                {filter.kind === 'label' && <h1 className="notes-section-title">Label: {filter.label}</h1>}
                                {filter.kind === 'archive' && <h1 className="notes-section-title">Archive</h1>}
                                {filter.kind === 'search' && <h1 className="notes-section-title">Results for “{filter.query}”</h1>}
                                <NoteGrid
                                    pinned={pinned}
                                    others={others}
                                    filter={filter}
                                    view={local.view}
                                    loading={loading}
                                    actions={actions}
                                    now={now}
                                    compactTools={coarse}
                                    onOpen={openNote}
                                    onMenu={onMenu}
                                    onPickColor={onPickColor}
                                    onPickLabels={onPickLabels}
                                    onLabelClick={onLabelClick}
                                    onArchive={archiveWithUndo}
                                    registerEl={registerEl}
                                />
                            </>
                        )}
                    </div>
                </main>
            </div>

            {!remindersView && (
                <button type="button" className="notes-fab" aria-label="New note" title="New note" onClick={() => setSheet(true)}>
                    <PlusIcon />
                </button>
            )}
            {sheet && <QuickAdd sheet onCreate={createNote} onDismiss={() => setSheet(false)} />}

            {openCard && (
                <NoteEditor
                    key={openCard.key}
                    card={openCard}
                    actions={actions}
                    onClose={closeNote}
                    onMenu={onMenu}
                    onPickColor={onPickColor}
                    onPickLabels={onPickLabels}
                    onArchive={archiveWithUndo}
                    pucaHref={pucaHref}
                    escapeBlocked={!!popup || !!contextMenu || help}
                />
            )}

            {popup?.kind === 'color' && popupCard && (
                <Popover anchor={popup.anchor} onClose={() => setPopup(null)} label="Note colour">
                    <h4>Colour</h4>
                    <ColorPicker value={popupCard.color} onChange={c => actions.setColor(popupCard.ref, c)} />
                </Popover>
            )}
            {popup?.kind === 'labels' && popupCard && (
                <Popover anchor={popup.anchor} onClose={() => setPopup(null)} label="Note labels">
                    <LabelPicker all={labels} value={popupCard.labels} onChange={ls => actions.setLabels(popupCard.ref, ls)} />
                </Popover>
            )}
            {popup?.kind === 'account' && (
                <Popover anchor={popup.anchor} onClose={() => setPopup(null)} label="Account">
                    <AccountMenu
                        username={username}
                        sort={local.sort}
                        onSort={s => setNotesSort(s)}
                        onExportMarkdown={() => { setPopup(null); exportMd(); }}
                        onExportJson={() => { setPopup(null); exportJson(); }}
                        onHelp={() => { setPopup(null); setHelp(true); }}
                        onSignOut={() => { setPopup(null); onSignOut(); }}
                        onSignOutEverywhere={() => { setPopup(null); void signOutEverywhere(); }}
                    />
                </Popover>
            )}
            {help && <ShortcutsHelp onClose={() => setHelp(false)} />}

            {contextMenu && (
                <ContextMenu items={contextMenu.items} position={contextMenu.position} onClose={hideContextMenu} />
            )}

            {pending && (
                <UndoBar
                    token={pending.token}
                    message={pending.kind === 'delete' ? `Deleted “${pending.title}”` : `Archived “${pending.title}”`}
                    onUndo={undoPending}
                    onExpire={expirePending}
                />
            )}
            <MessageToasts />
        </div>
    );
}
