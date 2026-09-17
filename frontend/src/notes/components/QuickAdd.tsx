/**
 * "Take a note…" — Notes' composer. Collapsed it is one line; open it is a
 * title plus a growing list of items (Enter = next item). Closing with
 * content SAVES (Notes' behaviour): a personal list is created, then its
 * items in typed order. A note needs a title in Púca, so an untitled note
 * borrows its first item (deriveQuickTitle).
 *
 * Rendered inline on desktop; on a phone the FAB opens the same component
 * as a full-screen sheet (`sheet`), because the inline card is hidden there.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckboxIcon, CloseIcon, PlusIcon, TrashIcon } from '../../components/Icons';
import { isEditableTarget } from '../../api/hotkeys';
import { MAX_TITLE_LENGTH, cleanQuickItems } from '../model/notesModel';

interface QuickAddProps {
    /** Called with the typed title and items; resolves true once the note
     *  exists. On false the composer stays open with the draft intact — a
     *  failed save must never throw the typed text away. */
    onCreate: (title: string, items: string[]) => Promise<boolean>;
    /** Open immediately as a full-screen sheet (phone FAB). */
    sheet?: boolean;
    /** Sheet only: dismissed (after a save, or empty). */
    onDismiss?: () => void;
    /** A parent can force the composer open (the `c` shortcut). */
    openSignal?: number;
}

export function QuickAdd({ onCreate, sheet = false, onDismiss, openSignal = 0 }: QuickAddProps) {
    const [open, setOpen] = useState(sheet);
    const [title, setTitle] = useState('');
    const [items, setItems] = useState<string[]>(['']);
    const [saving, setSaving] = useState(false);
    const itemRefs = useRef<(HTMLInputElement | null)[]>([]);
    const rootRef = useRef<HTMLDivElement>(null);
    const focusItem = (i: number) => requestAnimationFrame(() => itemRefs.current[i]?.focus());

    useEffect(() => {
        if (openSignal > 0) { setOpen(true); focusItem(0); }
    }, [openSignal]);

    const reset = () => { setTitle(''); setItems(['']); };

    const close = async () => {
        const cleaned = cleanQuickItems(items);
        if (title.trim() === '' && cleaned.length === 0) {
            reset();
            setOpen(!sheet && false);
            onDismiss?.();
            return;
        }
        if (saving) return;
        setSaving(true);
        let ok = false;
        try {
            ok = await onCreate(title, items);
        } finally {
            setSaving(false);
        }
        if (!ok) return;   // the owner has toasted why; the draft stays
        reset();
        setOpen(false);
        onDismiss?.();
    };

    const discard = () => { reset(); setOpen(false); onDismiss?.(); };

    // Click outside (desktop inline card) saves, like Notes.
    useEffect(() => {
        if (!open || sheet) return;
        const onDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) void close();
        };
        document.addEventListener('pointerdown', onDown);
        return () => document.removeEventListener('pointerdown', onDown);
        // close() reads live state through closures each render; re-binding per render is intended.
    });

    const onKeyItem = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            setItems(prev => {
                const next = [...prev];
                next.splice(i + 1, 0, '');
                return next;
            });
            focusItem(i + 1);
        } else if (e.key === 'Backspace' && items[i] === '' && items.length > 1) {
            e.preventDefault();
            setItems(prev => prev.filter((_, idx) => idx !== i));
            focusItem(Math.max(0, i - 1));
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            void close();
        }
    };

    if (!open) {
        return (
            <div className="notes-quickadd" ref={rootRef}>
                <button
                    type="button"
                    className="notes-quickadd-collapsed"
                    onClick={() => { setOpen(true); focusItem(0); }}
                    aria-label="Take a note"
                >
                    Take a note…
                    <CheckboxIcon />
                </button>
            </div>
        );
    }

    const body = (
        <div className={`notes-quickadd ${sheet ? 'sheet' : ''}`} ref={rootRef} role="dialog" aria-label="New note">
            <div className="notes-quickadd-open">
                <input
                    className="notes-quickadd-title"
                    placeholder="Title"
                    value={title}
                    maxLength={MAX_TITLE_LENGTH}
                    onChange={e => setTitle(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); focusItem(0); }
                        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void close(); }
                    }}
                    autoFocus={sheet}
                    aria-label="Title"
                />
                {items.map((it, i) => (
                    <div className="notes-quickadd-item" key={i}>
                        <CheckboxIcon />
                        <input
                            ref={el => { itemRefs.current[i] = el; }}
                            value={it}
                            placeholder={i === 0 ? 'List item' : ''}
                            maxLength={500}
                            onChange={e => setItems(prev => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
                            onKeyDown={e => onKeyItem(i, e)}
                            aria-label={`Item ${i + 1}`}
                        />
                        {items.length > 1 && (
                            <button
                                type="button"
                                className="notes-iconbtn small"
                                aria-label="Remove item"
                                title="Remove"
                                onClick={() => setItems(prev => prev.filter((_, idx) => idx !== i))}
                            >
                                <CloseIcon size={14} />
                            </button>
                        )}
                    </div>
                ))}
                <div className="notes-quickadd-foot">
                    <button type="button" className="notes-iconbtn small" aria-label="Add item" title="Add item"
                        onClick={() => { setItems(prev => [...prev, '']); focusItem(items.length); }}>
                        <PlusIcon />
                    </button>
                    <button type="button" className="notes-iconbtn small" aria-label="Discard note" title="Discard" onClick={discard}>
                        <TrashIcon />
                    </button>
                    <button type="button" className="notes-textbtn" onClick={() => void close()} disabled={saving}>
                        {saving ? 'Saving…' : 'Done'}
                    </button>
                </div>
            </div>
        </div>
    );

    if (!sheet) return body;
    return createPortal(
        <div
            className="notes-editor-backdrop"
            onClick={e => { if (e.target === e.currentTarget && !isEditableTarget(document.activeElement)) void close(); }}
        >
            <div className="notes-editor notes-quickadd-sheet">{body}</div>
        </div>,
        document.body,
    );
}
