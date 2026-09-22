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
import { useTaskFeature } from '../../api/taskFeatures';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { useContextMenu } from '../../components/contextMenuUtils';
import { IdentityBanner } from '../../components/IdentityBanner';
import { MessageToasts } from '../../components/MessageToasts';
import { pushMessageToast } from '../../components/messageToastBus';
import { PlusIcon, WarningIcon } from '../../components/Icons';
import {
    type NoteCard, type NoteFilter, type NoteRef,
    allLabels, applyVisibleOrder, canDragReorder, canReorder, filterNotes, groupReminders, moveNoteInOrder,
    reminderBadgeCount, splitPinned,
} from '../model/notesModel';
import { type ComposeIntent, type ComposeMode, takeShare } from '../model/composeIntent';
import { useNativeShareIn, type SharedIntoNotes } from '../native/useNativeShareIn';
import { restoreLabels } from '../model/notesBulk';
import { setNotesSort, setNotesView, setReminderTimes, type NotesSortMode } from '../model/notesPrefs';
import { useNotesPrefs, useNoteActions, useNoteCards } from '../model/notesQueries';
import { copyBlockersOf, copyPlanOf, copyRefusal, noteToMarkdown } from '../model/noteText';
import { AccountMenu } from './AccountMenu';
import { ColorPicker } from '../../components/notes/ColorPicker';
import { ShortcutsHelp } from './NotesDialog';
import { NotesRail } from './NotesRail';
import { NotesTopBar } from './NotesTopBar';
import { NotesUpdateStripSlot } from './NotesUpdateGate';
import { LabelPicker } from '../../components/notes/LabelPicker';
import { LabelManager } from './LabelManager';
import { NoteEditor } from './NoteEditor';
import { NoteGrid, type GridSection } from './NoteGrid';
import { Popover } from '../../components/notes/Popover';
import { QuickAdd } from './QuickAdd';
import { RemindersView } from './RemindersView';
import { TrashView } from './TrashView';
import { type NoteExtras } from '../model/useListContent';
import { CalendarView } from './CalendarView';
import { UndoBar } from './UndoBar';
import { useNotesShortcuts } from './useNotesShortcuts';
import { onOpenReminders, useNotesReminderLoop } from '../native/useNativeReminders';
import { canShareNotes, exportNotes, shareNote, shareNotes } from '../native/notesExport';
import { usePlaceReminderItems } from '../native/useNotesPlaces';
import { NativeReminderBanners } from '../native/NativeReminderBanners';
import { flushNotesPrefs, prefsUnsynced, useNotesPrefsSync, useNotesUnsyncedFlag } from '../model/notesPrefsSync';
import { useTaskEvents } from '../model/taskEvents';
import { ExpiredOfflineBanner, OutboxBanner, PrefsSyncBanner } from './SyncBanners';
import { useNotesOutbox, useOutboxPending, useQueuedListDeletes } from '../model/notesOutbox';
import { useNotesCachePersistence } from '../model/notesCache';
import { isGridPath, useBulkPending, useNoteSelection } from './useNoteSelection';

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
    | { kind: 'trash'; key: string; ref: NoteRef; title: string; token: number }
    | { kind: 'archive'; key: string; ref: NoteRef; title: string; token: number }
    // A label rename/merge/delete rewrote every note at once, so its Undo is
    // the whole label map as it was, not one note's (notesBulk.restoreLabels).
    // `returnTo` is the label route the change forced us OFF, if any: putting
    // the map back has to put the view back with it.
    | { kind: 'labels'; message: string; snapshot: Record<string, string[]>; returnTo: string | null; token: number };

function sortCards(cards: NoteCard[], sort: NotesSortMode): NoteCard[] {
    if (sort === 'puca') return cards;
    const out = [...cards];
    if (sort === 'title') out.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'edited') out.sort((a, b) => (Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0) - (Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0));
    else out.sort((a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0));
    return out;
}

interface NotesShellProps {
    onSignOut: () => void;
    /** The token expired while offline: keep showing the cached notes. */
    expiredOffline?: boolean;
}

export function NotesShell({ onSignOut, expiredOffline = false }: NotesShellProps) {
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
    const prefsSync = useNotesPrefsSync();
    // What a sign-out would lose, published for PÚCA's sign-out to ask about
    // too (api/notesCacheScrub.ts): a sign-out in either tab deletes it.
    useNotesUnsyncedFlag(useOutboxPending());
    const queuedDeletes = useQueuedListDeletes();
    useTaskEvents();
    useNotesCachePersistence();
    const now = useSyncExternalStore(subscribeHalfMinute, halfMinuteNow, halfMinuteNow);
    const coarse = useSyncExternalStore(subscribeCoarse, isCoarse, () => false);
    const canSnooze = useTaskFeature('snooze') === true;
    /** A Reminders row has the Date & repeat dialog open. */
    const [reminderModal, setReminderModal] = useState(false);
    const scheduleOnServer = useTaskFeature('schedule') === true;
    // What the composer can offer against THIS server. Read by the share
    // intake below as well as by the composer itself, so it is computed here
    // rather than beside the render.
    const composerContent = useMemo(
        () => ({ text: actions.content.features.body, pictures: actions.content.features.attachments, camera: coarse }),
        [actions.content.features.body, actions.content.features.attachments, coarse],
    );
    const contentRef = useRef(composerContent);
    useEffect(() => { contentRef.current = composerContent; }, [composerContent]);

    const [drawer, setDrawer] = useState(false);
    const [popup, setPopup] = useState<Popup | null>(null);
    const [help, setHelp] = useState(false);
    const [labelMgr, setLabelMgr] = useState(false);
    const [sheet, setSheet] = useState(false);
    const [quickSignal, setQuickSignal] = useState(0);
    // What a shortcut, the quick tile, the widget or a share asked the
    // composer to open as. Nothing is saved until the user presses Done.
    const [composeIntent, setComposeIntent] = useState<ComposeIntent | null>(null);
    const composeSeq = useRef(0);
    // The ONE item a due notification came for (notes/native/): its note
    // opens and the row is flashed. Held in state, not the URL, so a reload
    // cannot replay a tap from hours ago.
    //
    // A TAP, not an id: `seq` counts them, so the same item coming due twice
    // in one page session — a repeat, or a snooze that fired again — is two
    // taps, and the second one opens the note as the first did.
    const [flashTap, setFlashTap] = useState<{ id: number; seq: number } | null>(null);
    const flashItem = flashTap?.id ?? null;
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
    const trashView = path === '/trash';
    const calendarView = path === '/calendar';
    const filter: NoteFilter = useMemo(() => {
        if (query.trim() && !remindersView) return { kind: 'search', query };
        if (path === '/archive') return { kind: 'archive' };
        const labelMatch = /^\/label\/(.+)$/.exec(path);
        if (labelMatch) return { kind: 'label', label: decodeURIComponent(labelMatch[1]) };
        return { kind: 'all' };
    }, [path, query, remindersView]);

    // A delete waits in the undo window; until it commits the note is hidden.
    const bulk = useBulkPending(actions);
    const bulkHidden = bulk.hiddenKeys;
    const cards = useMemo(
        () => (pending?.kind === 'delete' ? allCards.filter(c => c.key !== pending.key) : allCards)
            .filter(c => !bulkHidden.has(c.key)),
        [allCards, pending, bulkHidden],
    );
    const cardsByKey = useMemo(() => new Map(cards.map(c => [c.key, c])), [cards]);
    const visible = useMemo(() => sortCards(filterNotes(cards, filter), local.sort), [cards, filter, local.sort]);
    const { pinned, others } = useMemo(() => splitPinned(visible), [visible]);
    const labels = useMemo(() => allLabels(cards), [cards]);
    // How many notes carry each label, ARCHIVED INCLUDED — the label manager
    // exists because a filtered view can never reach those (filterNotes).
    const labelCounts = useMemo(() => {
        const m = new Map<string, number>();
        for (const c of cards) for (const l of c.labels) {
            const k = l.toLocaleLowerCase();
            m.set(k, (m.get(k) ?? 0) + 1);
        }
        return m;
    }, [cards]);
    // Bulk selection over what the grid shows, in the order it shows it.
    const gridOrder = useMemo(() => [...pinned, ...others], [pinned, others]);
    const selection = useNoteSelection({ visible: gridOrder, actions, labels, bulk, grid: isGridPath(path), enabled: !openKey });
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
        if (q && (remindersView || calendarView)) navigate('/', { replace: true });
    }, [navigate, remindersView, calendarView]);
    const openNote = useCallback((card: NoteCard) => {
        setParams(p => { p.set('note', card.key); return p; });
    }, [setParams]);
    const closeNote = useCallback(() => {
        setParams(p => { p.delete('note'); return p; });
    }, [setParams]);
    // A note created offline replayed: keep it open under its real id.
    const noteMoved = useCallback((from: string, to: string) => {
        setParams(p => { if (p.get('note') === from) p.set('note', to); return p; }, { replace: true });
    }, [setParams]);
    useNotesOutbox(noteMoved);

    // --- Opening the composer from outside the page -------------------------------------
    // A launcher shortcut, the quick-settings tile, the home-screen widget or
    // a share from another app. All four land here, in one place.
    const openCompose = useCallback((intent: Omit<ComposeIntent, 'seq'>) => {
        composeSeq.current += 1;
        setComposeIntent({ ...intent, seq: composeSeq.current });
        // The inline composer only exists on the grid; the phone's sheet is a
        // portal and works from anywhere.
        if (isCoarse()) setSheet(true);
        else {
            if (!isGridPath(path)) { setQueryState(''); navigate('/'); }
            setQuickSignal(n => n + 1);
        }
    }, [navigate, path]);
    const onNativeCompose = useCallback((mode: ComposeMode) => { openCompose({ mode }); }, [openCompose]);
    const composeTaken = useCallback(() => setComposeIntent(null), []);

    // Share INTO Notes (Android): the composer opens with what arrived. A
    // picture this server cannot keep is refused out loud rather than
    // vanishing, which would look like the share never came.
    //
    // The decision WAITS for /notes/features. A share is normally a cold
    // start, and the native handoff beats that request every time: judged
    // against what the page knows at that instant, the picture would be
    // dropped and the user told this server cannot keep pictures when it can
    // (model/composeIntent's takeShare).
    const onShared = (shared: SharedIntoNotes) => {
        void takeShare(shared, {
            ensureContent: async () => {
                const f = await actions.content.ensureFeatures();
                return f ? { text: f.body, pictures: f.attachments } : null;
            },
            fallback: () => contentRef.current,
            open: openCompose,
            refusePicture: () => pushMessageToast({ title: 'This server can’t keep pictures in a note, so the shared picture wasn’t added.' }),
        });
    };
    useNativeShareIn(onShared);

    // --- Reminders loop + notifications -------------------------------------------------
    // Android app: native alarms own firing, open or closed (notes/native/).
    useNotesReminderLoop(go, onNativeCompose);

    // A due notification that named ONE item: take the id off the URL at
    // once (a one-shot — a reload must not replay it), then, once the notes
    // are loaded, open that item's note. An id that is stale by the time of
    // the tap — completed, deleted, in a note this account lost — falls back
    // to Reminders and never opens a blank editor.
    const itemParam = params.get('item');
    useEffect(() => {
        const raw = Number(itemParam);
        if (!raw || raw <= 0) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setFlashTap(prev => ({ id: raw, seq: (prev?.seq ?? 0) + 1 }));
        setParams(p => { p.delete('item'); return p; }, { replace: true });
    }, [itemParam, setParams]);
    // ONCE PER TAP. `cards` changes identity on every refetch, and without
    // this the effect re-set `note` after the user had closed the note — the
    // flashed note re-opened itself for as long as the flash lasted. Found by
    // the walk. Keyed on the tap's `seq` and not on the item's id, because a
    // repeat or a snooze brings the SAME id round again and that tap must
    // open the note just as the first one did.
    const flashResolved = useRef(-1);
    const flashSeq = flashTap?.seq ?? -1;
    useEffect(() => {
        if (!flashItem || loading || cards.length === 0) return;
        if (flashResolved.current === flashSeq) return;
        const card = cards.find(c => (c.tasks ?? []).some(t => t.id === flashItem));
        if (card) {
            flashResolved.current = flashSeq;
            setParams(p => { p.set('note', card.key); return p; }, { replace: true });
        } else if (!tasksPending) {
            // Every note's items are in: the id is stale (completed, deleted,
            // a note this account lost). Stay on Reminders.
            flashResolved.current = flashSeq;
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setFlashTap(null);
        }
    }, [flashItem, flashSeq, loading, tasksPending, cards, setParams]);
    useEffect(() => {
        if (!flashTap) return;
        // Long enough to see, short enough that a later render (or going
        // back) does not show it a second time. Per TAP: the next one gets
        // its own four seconds.
        const t = setTimeout(() => setFlashTap(null), 4000);
        return () => clearTimeout(t);
    }, [flashTap]);
    // The browser/desktop half of the same tap: notifyTasksDue carries the
    // due ids on its event (api/desktopNotify.ts, and the merge note beside
    // onOpenReminders).
    useEffect(() => onOpenReminders(navigate), [navigate]);
    const placeItems = usePlaceReminderItems(cards);
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
        // Where the server has a trash the move happens NOW and Undo restores;
        // otherwise the delete waits out the undo window, as before.
        if (actions.content.trashEnabled) {
            // A failure is reported by the data layer, once (notesQueries.ts
            // deleteNote); offline the move is queued and Undo queues behind it.
            void actions.deleteNote(card.ref).then(ok => {
                if (ok) setPending({ kind: 'trash', key: card.key, ref: card.ref, title: card.title, token: ++tokenSeq.current });
            });
            return;
        }
        setPending({ kind: 'delete', key: card.key, ref: card.ref, title: card.title, token: ++tokenSeq.current });
    };
    const archiveWithUndo = useCallback((card: NoteCard, archived: boolean) => {
        commitPending(pendingRef.current);
        actions.setArchived(card.ref, archived);
        if (archived) setPending({ kind: 'archive', key: card.key, ref: card.ref, title: card.title, token: ++tokenSeq.current });
        else setPending(null);
    }, [actions, commitPending]);
    // The label manager rewrote the whole label map in one write. Undo puts
    // the snapshot back; and if the view we are looking at WAS that label, the
    // route has to follow, or the grid silently empties under a stale heading.
    const onLabelChanged = useCallback((from: string, to: string | null, before: Record<string, string[]>) => {
        commitPending(pendingRef.current);
        // Undo restores the map, so the label we were looking at exists again
        // — and the route we were moved off is the only one that shows it.
        // Without this, Undo leaves you on /label/<new name> after the new
        // name has ceased to exist: an empty grid under a heading naming a
        // label that is no longer in the rail.
        const leaving = filter.kind === 'label' && filter.label.toLocaleLowerCase() === from.toLocaleLowerCase();
        setPending({
            kind: 'labels',
            message: to === null ? `Removed “${from}” from every note` : `Renamed “${from}” to “${to}”`,
            snapshot: before,
            returnTo: leaving ? path : null,
            token: ++tokenSeq.current,
        });
        if (leaving) go(to === null ? '/' : `/label/${encodeURIComponent(to)}`);
    }, [commitPending, filter, go, path]);

    const undoPending = () => {
        const p = pendingRef.current;
        if (!p) return;
        if (p.kind === 'archive') actions.setArchived(p.ref, false);
        if (p.kind === 'trash') void actions.restoreNote(p.ref);
        if (p.kind === 'labels') {
            restoreLabels(p.snapshot);
            if (p.returnTo) go(p.returnTo);
        }
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
        // A note holding something this device cannot read is not copied at
        // all, rather than copied with the unreadable part missing (the same
        // choice "Hide checkboxes" makes).
        const refusal = copyRefusal(copyBlockersOf(card));
        if (refusal) { pushMessageToast({ title: refusal }); return; }
        const plan = copyPlanOf(card, { schedules: !!scheduleOnServer });
        const ref = await actions.copyNote(plan);
        if (ref) {
            // The copy takes the note's colour and labels, but is never
            // pinned and never lands in the archive: a copy is made to be
            // looked at now.
            if (card.color !== 'default') actions.setColor(ref, card.color);
            if (card.labels.length > 0) actions.setLabels(ref, card.labels);
            pushMessageToast({ title: plan.files > 0 ? 'Copied — pictures and all' : 'Copied' });
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
        const canMove = canReorder(local.sort, filter.kind) && section.length > 1;
        const move = (target: 'top' | 'up' | 'down' | 'bottom') => {
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
                { id: 'move-bottom', label: 'Move to bottom', icon: 'arrow-down-circle', onClick: () => move('bottom') },
                { id: 'sep2', label: '', separator: true },
            );
        }
        items.push(
            { id: 'copy-text', label: 'Copy as text', icon: 'copy', onClick: () => { void copyAsText(card); } },
            { id: 'duplicate', label: 'Make a copy', icon: 'file-text', onClick: () => { void duplicate(card); } },
        );
        if (canShareNotes()) items.push({ id: 'share', label: 'Share…', icon: 'upload', onClick: () => { void shareNote(card); } });
        if (pucaHref) {
            items.push({ id: 'puca', label: 'Open in Púca', icon: 'pop-out', onClick: () => window.open(pucaHref, '_blank', 'noopener') });
        }
        if (card.ref.kind === 'list') {
            items.push(
                { id: 'sep3', label: '', separator: true },
                { id: 'rename', label: 'Rename', icon: 'pencil', onClick: () => openNote(card) },
            );
            // The note's own reminder lives in its footer (a date needs a
            // picker, which a context menu has nowhere to put), so this is a
            // signpost to it — the same shape as Rename above.
            if (actions.content.features.noteReminders) {
                items.push({
                    id: 'remind',
                    label: card.dueAt || card.schedule ? 'Reminder…' : 'Remind me…',
                    icon: 'clock',
                    onClick: () => openNote(card),
                });
            }
            // Notes to self cannot go to the trash (the server refuses it), so
            // it is not offered rather than offered and failing.
            if (!(actions.content.trashEnabled && actions.content.isSelfList(card.ref.id))) {
                items.push({ id: 'delete', label: actions.content.trashEnabled ? 'Move to trash' : 'Delete note', icon: 'trash', danger: true, onClick: () => deleteWithUndo(card) });
            }
        }
        return items;
    };
    // Drag to reorder, same three conditions as the menu's Move items plus
    // "this section is one column": list view, or any view on a coarse
    // pointer (notes.css forces column-count: 1 there). The drop goes through
    // actions.reorderNotes like the menu does, so it inherits the two refusals
    // in savePrefs (prefs not read, trash not settled) and keepHiddenSlots.
    const canDrag = canDragReorder(local.sort, filter.kind, local.view, coarse);
    const onDropReorder = useCallback((section: GridSection, nextVisible: string[]) => {
        const visible = (section === 'pinned' ? pinned : others).map(c => c.key);
        const next = applyVisibleOrder(allCards.map(c => c.key), visible, nextVisible);
        if (next) actions.reorderNotes(next);
    }, [allCards, pinned, others, actions]);

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
    const createNote = async (title: string, items: string[], extra?: NoteExtras): Promise<boolean> => {
        const ref = await actions.createNote(title, items, extra);
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
        // A dialog opened from a Reminders row is none of the shell's own
        // popups, and hotkeys.isEditableTarget says false for a <select> —
        // without this, `c` and `r` fire behind the open schedule editor.
    }, !openCard && !popup && !help && !sheet && !contextMenu && !labelMgr && !reminderModal);

    // --- Account -------------------------------------------------------------------------------------
    const username = (() => {
        const t = getToken();
        const u = t ? decodeJwtPayload(t)?.username : null;
        return typeof u === 'string' && u ? u : 'you';
    })();
    const signOutEverywhere = async () => {
        if (!window.confirm('Sign out of every device? Every phone and computer signed in to this account will need to sign in again.')) return;
        // Last chance for colours and labels while this session still works.
        if (prefsUnsynced()) await flushNotesPrefs();
        try {
            await logoutEverywhere();
        } catch {
            pushMessageToast({ title: 'Couldn’t reach the server — signed out here only' });
        }
        onSignOut();
    };
    const exportMd = () => { void exportNotes(cards, 'md'); };
    const exportJson = () => { void exportNotes(cards, 'json'); };

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
                    filter={remindersView ? { kind: 'reminders' } : trashView ? { kind: 'trash' } : calendarView ? { kind: 'calendar' } : filter}
                    trashEnabled={actions.content.trashEnabled}
                    labels={labels}
                    reminderBadge={reminderBadgeCount(reminders)}
                    counts={counts}
                    open={drawer}
                    onClose={() => setDrawer(false)}
                    onNavigate={to => { setQuery(''); go(to); }}
                    onEditLabels={() => setLabelMgr(true)}
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
                        <PrefsSyncBanner status={prefsSync} />
                        {expiredOffline && <ExpiredOfflineBanner />}
                        <OutboxBanner />
                        {error != null && !offline && (
                            <div className="notes-status error" role="alert">
                                <WarningIcon /> Couldn’t load your notes: {error instanceof Error ? error.message : String(error)}
                                <button type="button" onClick={() => { void actions.refreshAll(); }}>Retry</button>
                            </div>
                        )}
                        {trashView ? (
                            <TrashView content={actions.content} restoreNote={actions.restoreNote} queuedDeletes={queuedDeletes} />
                        ) : remindersView ? (
                            <RemindersView
                                groups={reminders}
                                actions={actions}
                                now={now}
                                onOpen={openNote}
                                notificationsState={notif}
                                onEnableNotifications={() => { void enableNotifications(); }}
                                nativeBanner={<NativeReminderBanners />}
                                placeItems={placeItems}
                                canSnooze={canSnooze}
                                flashTaskId={flashItem}
                                canSchedule={scheduleOnServer}
                                onModal={setReminderModal}
                            />
                        ) : calendarView ? (
                            <CalendarView
                                cards={cards}
                                actions={actions}
                                now={now}
                                onOpenNote={key => setParams(p => { p.set('note', key); return p; })}
                                shortcutsEnabled={!openCard && !popup && !help && !sheet && !contextMenu && !labelMgr}
                            />
                        ) : (
                            <>
                                {/* The sheet takes the payload when it is open; the inline
                                    card is still mounted behind it on a phone. */}
                                {filter.kind === 'all' && <QuickAdd onCreate={createNote} openSignal={quickSignal} content={composerContent} initial={sheet ? null : composeIntent} onInitialUsed={composeTaken} />}
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
                                    canDrag={canDrag}
                                    onDropReorder={onDropReorder}
                                    selected={selection.selected}
                                    onSelect={selection.onSelect}
                                />
                            </>
                        )}
                    </div>
                </main>
            </div>

            {!remindersView && !trashView && !calendarView && (
                <button type="button" className="notes-fab" aria-label="New note" title="New note" onClick={() => setSheet(true)}>
                    <PlusIcon />
                </button>
            )}
            {sheet && <QuickAdd sheet onCreate={createNote} onDismiss={() => setSheet(false)} content={composerContent} initial={composeIntent} onInitialUsed={composeTaken} />}

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
                    escapeBlocked={!!popup || !!contextMenu || help || labelMgr}
                    flashTaskId={flashItem}
                    query={filter.kind === 'search' ? filter.query : undefined}
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
                        times={local.times}
                        onTimes={patch => setReminderTimes(patch)}
                        onExportMarkdown={() => { setPopup(null); exportMd(); }}
                        onExportJson={() => { setPopup(null); exportJson(); }}
                        onShare={canShareNotes() ? () => { setPopup(null); void shareNotes(cards); } : undefined}
                        onHelp={() => { setPopup(null); setHelp(true); }}
                        onSignOut={() => { setPopup(null); onSignOut(); }}
                        onSignOutEverywhere={() => { setPopup(null); void signOutEverywhere(); }}
                    />
                </Popover>
            )}
            {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
            {labelMgr && (
                <LabelManager
                    labels={labels}
                    counts={labelCounts}
                    onClose={() => setLabelMgr(false)}
                    onChanged={onLabelChanged}
                />
            )}

            {contextMenu && (
                <ContextMenu items={contextMenu.items} position={contextMenu.position} onClose={hideContextMenu} />
            )}

            {pending && (
                <UndoBar
                    token={pending.token}
                    message={pending.kind === 'labels' ? pending.message
                        : pending.kind === 'delete' ? `Deleted “${pending.title}”`
                            : pending.kind === 'trash' ? `Moved “${pending.title}” to the trash`
                                : `Archived “${pending.title}”`}
                    onUndo={undoPending}
                    onExpire={expirePending}
                />
            )}
            {selection.bar}
            {selection.undo}
            <MessageToasts />
        </div>
    );
}
