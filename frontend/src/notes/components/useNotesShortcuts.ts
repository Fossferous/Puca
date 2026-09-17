/**
 * Notes' single-key shortcuts. Every one is guarded by hotkeys.ts's
 * isEditableTarget so typing in a note never triggers them, and none uses a
 * modifier the browser owns. Importing hotkeys.ts is inert: its listeners
 * are installed only by registerHold/registerPress, which Notes never calls.
 *
 * Handlers are read through a ref, so the caller may pass fresh closures
 * every render without the listener re-binding.
 */
import { useEffect, useRef } from 'react';
import { isEditableTarget } from '../../api/hotkeys';

export interface NotesShortcutHandlers {
    /** `/` — focus the search box. */
    onSearch: () => void;
    /** `c` — start a new note. */
    onNew: () => void;
    /** `?` — the shortcuts help. */
    onHelp: () => void;
    /** `r` — refresh from the server. */
    onRefresh: () => void;
}

export function useNotesShortcuts(h: NotesShortcutHandlers, enabled = true): void {
    const ref = useRef(h);
    useEffect(() => { ref.current = h; });
    useEffect(() => {
        if (!enabled) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
            if (isEditableTarget(e.target)) return;
            switch (e.key) {
                case '/': e.preventDefault(); ref.current.onSearch(); break;
                case 'c': e.preventDefault(); ref.current.onNew(); break;
                case '?': e.preventDefault(); ref.current.onHelp(); break;
                case 'r': e.preventDefault(); ref.current.onRefresh(); break;
                default: break;
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [enabled]);
}
