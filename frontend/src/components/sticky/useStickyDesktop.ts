/**
 * Chat's part in sticky notes (docs/STICKY_NOTES.md), in the desktop app
 * while an account is signed in:
 *  - ask the shell once whether it has sticky windows;
 *  - register the global "new sticky note" shortcut from Settings, and keep
 *    it in step as Settings changes it; release it when Chat goes;
 *  - answer the shell's "new sticky note" (the shortcut, the tray);
 *  - say when Notes has to be MOUNTED for sticky notes — there are notes to
 *    bring back at start, or a new one was asked for — since the sticky
 *    windows are drawn from inside Notes (NotesDesktopView).
 */
import { useEffect, useState } from 'react';
import { currentUserIdFromToken } from '../../api/auth';
import { isMobile, isTauri } from '../../api/platform';
import { loadSettings } from '../settingsStore';
import { STICKY_NEW_NOTE_EVENT, primeStickySupport } from './stickyShell';
import { enableStickyHotkey, wantStickyHotkey } from './stickyHotkey';
import { readStoredStickies, requestNewSticky } from './stickyStore';

/** True once Notes should be mounted for sticky notes. */
export function useStickyDesktop(): boolean {
    const [mount, setMount] = useState(false);
    useEffect(() => {
        if (!isTauri() || isMobile()) return;
        let live = true;
        let unlisten: (() => void) | null = null;
        void primeStickySupport().then(async ok => {
            if (!live || !ok) return;
            const s = loadSettings();
            void wantStickyHotkey(s.stickyHotkey);
            void enableStickyHotkey(true);
            const uid = currentUserIdFromToken();
            if (uid && s.stickyReopen !== false && readStoredStickies(uid).length > 0) setMount(true);
            try {
                const { listen } = await import('@tauri-apps/api/event');
                const un = await listen(STICKY_NEW_NOTE_EVENT, () => {
                    requestNewSticky();
                    setMount(true);
                });
                if (live) unlisten = un;
                else un();
            } catch (err) {
                console.warn('[sticky] could not listen for new sticky notes:', err);
            }
        });
        const onSettings = () => { void wantStickyHotkey(loadSettings().stickyHotkey); };
        window.addEventListener('settingsChanged', onSettings);
        return () => {
            live = false;
            try { unlisten?.(); } catch { /* the shell is going with the page */ }
            window.removeEventListener('settingsChanged', onSettings);
            void enableStickyHotkey(false);
        };
    }, []);
    return mount;
}
