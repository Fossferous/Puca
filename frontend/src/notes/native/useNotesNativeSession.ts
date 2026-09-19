/**
 * Session hygiene for Púca Notes' native side, driven by the session gate's
 * one `signedIn` flag — so sign-out, a soft expiry (401 or a token seen to be
 * dead), a sign-out in another tab and an account switch all take the SAME
 * path out:
 *
 *  - signed out: every native alarm, fired marker, stored token, refresh job,
 *    location fence and session notice is cleared (NotesNative.clearAll), and
 *    the place store stops pushing fences;
 *  - signed in: the place store may push this account's fences again.
 *
 * An account switch reloads the page; the next sign-in's first reminder sync
 * rebinds the native store to the new account, which wipes the old one's.
 *
 * Also mirrors Púca's main.tsx: any settings save re-syncs the fence set
 * (deduped inside), which is what turns location reminders off natively when
 * the toggle goes off. Inert in the browser: every call there is a no-op.
 */
import { useEffect } from 'react';
import { setPlacesAuthed, syncTaskPlacesToNative } from '../../api/taskPlaces';
import { clearNativeSession } from './notesNative';

export function useNotesNativeSession(signedIn: boolean): void {
    useEffect(() => {
        setPlacesAuthed(signedIn);
        if (!signedIn) void clearNativeSession();
    }, [signedIn]);

    useEffect(() => {
        const onSettings = () => { void syncTaskPlacesToNative(); };
        window.addEventListener('settingsChanged', onSettings);
        return () => window.removeEventListener('settingsChanged', onSettings);
    }, []);
}
