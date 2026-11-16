/**
 * What a sticky note window shows (docs/STICKY_NOTES.md): a coloured bar to
 * drag it by (with New, the on-top pin, a menu and Close), the note's text in
 * the same NoteBodyField Notes uses — the same save, the same conflict
 * question, the same Undo — its items, its pictures, and the formatting bar.
 *
 * It is rendered by the MAIN page into the sticky window's document
 * (StickyNotesLayer portals it), so everything here must ask that document,
 * not the global one: the focus, the clipboard, the outside-click of its own
 * menu. `doc` is that document.
 *
 * A NEW sticky note is a draft (`card` null): nothing is saved until words or
 * a picture go in, and the first save makes the note — exactly once, however
 * many saves the field asks for while that first one is out (`created`).
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type BodySaveOutcome, type NoteBodyHandle, NoteBodyField } from '../NoteBodyField';
import { NoteImages } from '../NoteImages';
import { NoteLinkText } from '../NoteLinkText';
import { ColorPicker } from '../notes/ColorPicker';
import {
    BoldIcon, BulletListIcon, CheckboxCheckedIcon, CheckboxIcon, CloseIcon, CopyIcon, DockIcon, ImageIcon, ItalicIcon,
    MoreVerticalIcon, NoteIcon, PinIcon, PlusIcon, StrikethroughIcon, TrashIcon, UnderlineIcon,
} from '../Icons';
import { type Task } from '../../api/tasks';
import { PERM, hasPerm } from '../../api/permissionBits';
import { headingLabel, isHeadingTask, asItemText } from '../../api/taskHeading';
import { isUndecryptable } from '../../api/decryptMarkers';
import { type NoteCard, type NoteColor, type NoteRef, MAX_ITEM_LENGTH } from '../../notes/model/notesModel';
import { type NoteActions, useNoteTasks } from '../../notes/model/notesQueries';
import { noteToMarkdown } from '../../notes/model/noteText';
import { filesFromTransfer, isTextPaste } from '../../notes/model/noteContent';
import { ONLY_PICTURES, PASTE_OFFLINE } from '../../notes/model/pasteDrop';
import type { FormatKind } from '../../notes/model/noteFormat';
import { NEW_STICKY_COLOR } from './stickyStore';

export interface StickyNoteViewProps {
    /** The note, or null for a new sticky note nobody has typed in yet. */
    card: NoteCard | null;
    actions: NoteActions;
    /** The document this view is drawn in (the sticky window's). */
    doc: Document;
    onTop: boolean;
    onTogglePin: () => void;
    docked: 'left' | 'right' | null;
    onDock: (side: 'left' | 'right' | null) => void;
    onDrag: () => void;
    onNew: () => void;
    onClose: () => void;
    /** Settings › Ask before deleting a sticky note. */
    confirmDelete: boolean;
    onDontAskAgain: () => void;
    /** The note is gone from the desktop for good (trashed, or a draft). */
    onDeleted: () => void;
    /** The draft's first save made this note. */
    onCreated: (ref: NoteRef) => void;
    onOpenInNotes: () => void;
}

/** A word the view says inside its own window: Púca's toasts are drawn in
 *  the main window, which may well be hidden in the tray. */
type Notice = { text: string; tone: 'info' | 'error' } | null;

function useNotice(): [Notice, (n: Notice) => void] {
    const [notice, setNotice] = useState<Notice>(null);
    useEffect(() => {
        if (!notice) return;
        const t = window.setTimeout(() => setNotice(null), 5000);
        return () => window.clearTimeout(t);
    }, [notice]);
    return [notice, setNotice];
}

export function StickyNoteView(props: StickyNoteViewProps) {
    const { card, actions, doc, onTop, docked } = props;
    const bodyRef = useRef<NoteBodyHandle>(null);
    const pickRef = useRef<HTMLInputElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const [menu, setMenu] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [dontAsk, setDontAsk] = useState(false);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useNotice();
    // The draft's one create, shared by every save the field asks for while
    // it is out — the field saves on a pause, on blur and on unmount, and
    // two of those can land before the first answer.
    const created = useRef<Promise<NoteRef | null> | null>(null);
    // What the draft saved, so the field keeps showing it until the note's
    // card arrives from the cache.
    const [savedDraft, setSavedDraft] = useState('');
    const ref = card?.ref ?? null;
    const isList = ref === null || ref.kind === 'list';
    const features = actions.content.features;
    const color: NoteColor = card ? card.color : NEW_STICKY_COLOR;
    const title = card ? (isUndecryptable(card.title) ? 'Sticky note' : card.title) : 'New sticky note';
    const canDelete = ref === null || (ref.kind === 'list' && !(actions.content.trashEnabled && actions.content.isSelfList(ref.id)));

    // The window's title is NOT the note's: a title is the one part of a
    // window any other program on the PC can read (the window list, task
    // switchers, accessibility and automation tools), and it would put a
    // decrypted title there. The same reason Notes' launcher shortcuts carry
    // no note titles (docs/NOTES.md, Not built).
    useEffect(() => { doc.title = 'Sticky note'; }, [doc]);

    // The menu closes on a press outside it, in THIS window.
    useEffect(() => {
        if (!menu) return;
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node | null;
            if (t && rootRef.current?.querySelector('.sticky-menu')?.contains(t)) return;
            if (t && (t as Element).closest?.('[data-sticky-menu-button]')) return;
            setMenu(false);
        };
        doc.addEventListener('mousedown', onDown, true);
        return () => doc.removeEventListener('mousedown', onDown, true);
    }, [menu, doc]);

    const createWith = useCallback((make: () => Promise<NoteRef | null>): Promise<NoteRef | null> => {
        if (!created.current) {
            const p = make().then(r => {
                if (r) {
                    actions.setColor(r, NEW_STICKY_COLOR);
                    props.onCreated(r);
                } else {
                    created.current = null;
                }
                return r;
            }, err => {
                created.current = null;
                setNotice({ text: err instanceof Error && err.message ? err.message : 'This note couldn’t be saved', tone: 'error' });
                return null;
            });
            created.current = p;
        }
        return created.current;
    }, [actions, props, setNotice]);

    const saveText = async (text: string, baseRev?: number): Promise<BodySaveOutcome> => {
        if (ref && ref.kind === 'list') return actions.content.setBody(ref.id, text, baseRev);
        if (ref) return false;
        // A draft. Its first words make the note — named after its first
        // line, as the composer names a note with no title.
        if (!created.current) {
            const made = await createWith(() => actions.createNote('', [], { body: text }));
            if (!made) return 'failed';
            setSavedDraft(text);
            return 'saved';
        }
        const made = await created.current;
        if (!made) return 'failed';
        return actions.content.setBody(made.id, text, baseRev);
    };

    const addPictures = async (files: File[]) => {
        if (files.length === 0) return;
        if (!navigator.onLine) { setNotice({ text: PASTE_OFFLINE, tone: 'error' }); return; }
        setBusy(true);
        try {
            if (ref && ref.kind === 'list') {
                if (!await actions.content.addNoteMedia(ref.id, files, [])) setNotice({ text: 'The picture couldn’t be added', tone: 'error' });
            } else if (!ref) {
                // A draft: the pictures make the note, or go into the note
                // its first words are already making.
                if (created.current) {
                    const made = await created.current;
                    if (made) await actions.content.addNoteMedia(made.id, files, []);
                } else {
                    await createWith(() => actions.createNote('', [], { photos: files }));
                }
            }
        } finally {
            setBusy(false);
        }
    };

    const takePictures = (dt: DataTransfer | null): boolean => {
        const { images, others } = filesFromTransfer(dt);
        if (images.length === 0 && others.length === 0) return false;
        if (!isList || !features.attachments) return true;
        if (images.length === 0) { setNotice({ text: ONLY_PICTURES, tone: 'error' }); return true; }
        if (others.length > 0) setNotice({ text: ONLY_PICTURES, tone: 'info' });
        void addPictures(images);
        return true;
    };

    const doDelete = async () => {
        setConfirming(false);
        if (dontAsk) props.onDontAskAgain();
        if (!ref) { props.onDeleted(); return; }
        if (await actions.deleteNote(ref)) props.onDeleted();
        else setNotice({ text: 'This note couldn’t be deleted', tone: 'error' });
    };
    const askDelete = () => {
        setMenu(false);
        if (!canDelete) return;
        if (props.confirmDelete && ref) setConfirming(true);
        else void doDelete();
    };

    const copyText = async () => {
        setMenu(false);
        if (!card) return;
        try {
            // The sticky window's own clipboard: the main page's document
            // has no focus while someone works in this one, and Chromium
            // refuses a write from an unfocused document.
            await (doc.defaultView?.navigator ?? navigator).clipboard.writeText(noteToMarkdown(card));
            setNotice({ text: 'Copied as text', tone: 'info' });
        } catch {
            setNotice({ text: 'Couldn’t write to the clipboard', tone: 'error' });
        }
    };

    // Ctrl+D asks the view (the layer owns the window-level keys), and
    // Escape closes the menu or answers the question with Cancel — a sticky
    // window is on Windows, which has no Back.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;
            if (e.key === 'Escape' && (menu || confirming)) {
                e.preventDefault();
                setMenu(false);
                setConfirming(false);
                return;
            }
            if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
            if (e.key.toLowerCase() === 'd') { e.preventDefault(); askDelete(); }
        };
        doc.addEventListener('keydown', onKey);
        return () => doc.removeEventListener('keydown', onKey);
    });

    const format = (kind: FormatKind | 'bullets') => bodyRef.current?.format(kind);
    const keepFocus = (e: React.MouseEvent) => e.preventDefault();
    const tool = (label: string, key: string, kind: FormatKind | 'bullets', icon: ReactNode) => (
        <button type="button" className="sticky-tool" aria-label={label} title={`${label} (${key})`} onMouseDown={keepFocus} onClick={() => format(kind)}>
            {icon}
        </button>
    );

    const textValue = card ? card.body : savedDraft;
    const showText = isList && features.body;

    return (
        <div
            ref={rootRef}
            className="sticky-note notes-card"
            data-color={color}
            data-testid="sticky-note"
            onPaste={e => { if (!isTextPaste(e.clipboardData) && takePictures(e.clipboardData)) e.preventDefault(); }}
            onDragOver={e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); }}
            onDrop={e => { if (takePictures(e.dataTransfer)) e.preventDefault(); }}
        >
            <div
                className="sticky-bar"
                data-testid="sticky-bar"
                onMouseDown={e => {
                    if (e.button !== 0 || (e.target as Element).closest('button')) return;
                    props.onDrag();
                }}
            >
                <button type="button" className="sticky-barbtn" aria-label="New sticky note" title="New note (Ctrl+N)" onClick={props.onNew}><PlusIcon /></button>
                <span className="sticky-title" title={title}>{card ? title : ''}</span>
                <button
                    type="button"
                    className={`sticky-barbtn${onTop ? ' is-on' : ''}`}
                    aria-label="Keep on top"
                    aria-pressed={onTop}
                    title={onTop ? 'Kept on top — click to let other windows cover it' : 'Keep on top of other windows'}
                    onClick={props.onTogglePin}
                >
                    <PinIcon />
                </button>
                <button
                    type="button"
                    className="sticky-barbtn"
                    aria-label="Menu"
                    aria-haspopup="menu"
                    aria-expanded={menu}
                    title="Menu"
                    data-sticky-menu-button=""
                    onClick={() => setMenu(m => !m)}
                >
                    <MoreVerticalIcon />
                </button>
                <button type="button" className="sticky-barbtn" aria-label="Close sticky note" title="Close (Ctrl+W) — the note stays in Notes" onClick={props.onClose}><CloseIcon /></button>
            </div>

            {menu && (
                <div className="sticky-menu" role="menu" aria-label="Sticky note">
                    {card && (
                        <div className="sticky-menu-colors">
                            <ColorPicker value={card.color} onChange={c => { actions.setColor(card.ref, c); }} />
                        </div>
                    )}
                    {card && (
                        <button type="button" role="menuitem" className="sticky-menuitem" onClick={() => { setMenu(false); props.onOpenInNotes(); }}>
                            <NoteIcon /> Open in Notes
                        </button>
                    )}
                    {card && (
                        <button type="button" role="menuitem" className="sticky-menuitem" onClick={() => void copyText()}>
                            <CopyIcon /> Copy as text
                        </button>
                    )}
                    {docked !== 'left' && (
                        <button type="button" role="menuitem" className="sticky-menuitem" onClick={() => { setMenu(false); props.onDock('left'); }}>
                            <DockIcon /> Dock left
                        </button>
                    )}
                    {docked !== 'right' && (
                        <button type="button" role="menuitem" className="sticky-menuitem" onClick={() => { setMenu(false); props.onDock('right'); }}>
                            <DockIcon /> Dock right
                        </button>
                    )}
                    {docked && (
                        <button type="button" role="menuitem" className="sticky-menuitem" onClick={() => { setMenu(false); props.onDock(null); }}>
                            <DockIcon /> Undock
                        </button>
                    )}
                    {canDelete && (
                        <button type="button" role="menuitem" className="sticky-menuitem danger" onClick={askDelete}>
                            <TrashIcon /> Delete note
                        </button>
                    )}
                </div>
            )}

            {confirming && (
                <div className="sticky-confirm" role="alertdialog" aria-label="Delete this note?">
                    <p>Delete this note? It goes to the trash in Púca Notes{actions.content.trashEnabled ? ', where it can be restored' : ''}.</p>
                    <label className="sticky-confirm-ask">
                        <input type="checkbox" checked={dontAsk} onChange={e => setDontAsk(e.target.checked)} /> Don’t ask again
                    </label>
                    <div className="sticky-confirm-actions">
                        <button type="button" className="sticky-textbtn danger" onClick={() => void doDelete()} autoFocus>Delete</button>
                        <button type="button" className="sticky-textbtn" onClick={() => setConfirming(false)}>Cancel</button>
                    </div>
                </div>
            )}

            <div className="sticky-content">
                {showText && (
                    <NoteBodyField
                        ref={bodyRef}
                        value={textValue}
                        contentRev={card?.contentRev}
                        onSave={saveText}
                        listId={ref?.kind === 'list' ? ref.id : undefined}
                        placeholder="Take a note…"
                        autoFocus={card === null}
                    />
                )}
                {card && <StickyItems card={card} actions={actions} />}
                {card && isList && features.attachments && card.noteAttachments && (
                    <div className="sticky-pictures">
                        <NoteImages opened={card.noteAttachments} editable={false} hideActions />
                    </div>
                )}
            </div>

            {notice && <div className={`sticky-notice ${notice.tone}`} role="status">{notice.text}</div>}

            {showText && (
                <div className="sticky-tools" role="toolbar" aria-label="Formatting">
                    {tool('Bold', 'Ctrl+B', 'bold', <BoldIcon />)}
                    {tool('Italic', 'Ctrl+I', 'italic', <ItalicIcon />)}
                    {tool('Underline', 'Ctrl+U', 'underline', <UnderlineIcon />)}
                    {tool('Strikethrough', 'Ctrl+T', 'strike', <StrikethroughIcon />)}
                    {tool('Bullets', 'Ctrl+Shift+L', 'bullets', <BulletListIcon />)}
                    {features.attachments && (
                        <>
                            <span className="sticky-tools-gap" />
                            <button
                                type="button"
                                className="sticky-tool"
                                aria-label="Add picture"
                                title="Add picture"
                                disabled={busy}
                                onClick={() => pickRef.current?.click()}
                            >
                                <ImageIcon />
                            </button>
                            <input
                                ref={pickRef}
                                type="file"
                                accept="image/*"
                                multiple
                                hidden
                                onChange={e => {
                                    const files = Array.from(e.target.files ?? []);
                                    e.target.value = '';
                                    void addPictures(files);
                                }}
                            />
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

/** The note's items: tick them, add one. Moving, dates and editing an item
 *  are the open note's, in Notes. */
function StickyItems({ card, actions }: { card: NoteCard; actions: NoteActions }) {
    const ref = card.ref;
    const tasksQuery = useNoteTasks(ref, { live: true });
    const tasks: Task[] = useMemo(() => tasksQuery.data ?? card.tasks ?? [], [tasksQuery.data, card.tasks]);
    const [newItem, setNewItem] = useState('');
    const [showDone, setShowDone] = useState(false);
    const isChannel = ref.kind === 'channel';
    const canCreate = !isChannel || hasPerm(card.myPerms, PERM.CREATE_TASKS);
    const canComplete = !isChannel || hasPerm(card.myPerms, PERM.COMPLETE_TASKS) || hasPerm(card.myPerms, PERM.MANAGE_TASKS);
    // In the order Notes shows them: a parent, then its children.
    const ordered = useMemo(() => {
        const byParent = new Map<number | null, Task[]>();
        for (const t of tasks) {
            const p = t.parent_id ?? null;
            const list = byParent.get(p) ?? [];
            list.push(t);
            byParent.set(p, list);
        }
        for (const list of byParent.values()) list.sort((a, b) => a.position - b.position);
        const out: Array<{ task: Task; depth: number }> = [];
        const walk = (parent: number | null, depth: number) => {
            for (const t of byParent.get(parent) ?? []) {
                out.push({ task: t, depth });
                if (depth < 4) walk(t.id, depth + 1);
            }
        };
        walk(null, 0);
        return out;
    }, [tasks]);
    if (tasks.length === 0 && !isChannel) return null;
    const open = ordered.filter(o => isHeadingTask(o.task) || !o.task.is_completed);
    const done = ordered.filter(o => !isHeadingTask(o.task) && o.task.is_completed);
    const row = ({ task, depth }: { task: Task; depth: number }) => {
        if (isHeadingTask(task)) {
            return <li key={task.id} className="sticky-heading" role="heading" aria-level={3}>{headingLabel(task.description)}</li>;
        }
        const unreadable = isUndecryptable(task.description);
        return (
            <li key={task.id} className={`sticky-item${task.is_completed ? ' done' : ''}`} style={depth ? { paddingInlineStart: depth * 16 } : undefined}>
                <button
                    type="button"
                    className="sticky-check"
                    role="checkbox"
                    aria-checked={task.is_completed}
                    aria-label={unreadable ? 'Item' : task.description}
                    disabled={!canComplete}
                    onClick={() => void actions.toggleTask(ref, task, !task.is_completed)}
                >
                    {task.is_completed ? <CheckboxCheckedIcon /> : <CheckboxIcon />}
                </button>
                <span className="sticky-item-text"><NoteLinkText text={task.description} /></span>
            </li>
        );
    };
    return (
        <div className="sticky-items">
            <ul>{open.map(row)}</ul>
            {done.length > 0 && (
                <>
                    <button type="button" className="sticky-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(v => !v)}>
                        {done.length} done
                    </button>
                    {showDone && <ul>{done.map(row)}</ul>}
                </>
            )}
            {canCreate && (
                <form
                    className="sticky-add"
                    onSubmit={async e => {
                        e.preventDefault();
                        const typed = newItem.trim();
                        if (!typed) return;
                        setNewItem('');
                        if (!await actions.addTask(ref, asItemText(typed))) setNewItem(typed);
                    }}
                >
                    <input value={newItem} onChange={e => setNewItem(e.target.value)} placeholder="Add an item" aria-label="New item" maxLength={MAX_ITEM_LENGTH} />
                    <button type="submit" aria-label="Add item" disabled={!newItem.trim()}><PlusIcon /></button>
                </form>
            )}
        </div>
    );
}
