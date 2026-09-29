/**
 * Notes' single-key shortcuts. Every one is guarded by hotkeys.ts's
 * isEditableTarget so typing in a note never triggers them, and none uses a
 * modifier the browser owns. Importing hotkeys.ts is inert: its listeners
 * are installed only by registerHold/registerPress, which Notes never calls.
 *
 * Handlers are read through a ref, so the caller may pass fresh closures
 * every render without the listener re-binding.
 *
 * Inside the Púca desktop app the window is Púca's too, so the host can veto
 * a key (`accept`): one of its own dialogs is over Notes, focus is in its
 * chrome, or the key is a Púca hotkey — push-to-talk on a bare `c` must not
 * also start a note. Asked only for the four keys below.
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

const KEYS = new Set(['/', 'c', '?', 'r']);

export function useNotesShortcuts(h: NotesShortcutHandlers, enabled = true, accept?: (e: KeyboardEvent) => boolean): void {
    const ref = useRef(h);
    const acceptRef = useRef(accept);
    useEffect(() => { ref.current = h; acceptRef.current = accept; });
    useEffect(() => {
        if (!enabled) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
            if (isEditableTarget(e.target)) return;
            if (!KEYS.has(e.key)) return;
            if (acceptRef.current && !acceptRef.current(e)) return;
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
