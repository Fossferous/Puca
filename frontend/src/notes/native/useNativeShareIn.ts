/**
 * Share INTO Púca Notes: another app sent text or a picture, and the composer
 * opens with it already there.
 *
 * Mounted once in the signed-in shell, beside the reminder loop. It drains
 * whatever the launch carried, and subscribes for a share that arrives while
 * the app is already up (Android re-enters the same task, so the native side
 * pings rather than restarting the page).
 *
 * NOTHING IS SAVED HERE. The hook hands the shell a title, a body and files;
 * the note exists only once the user presses Done. That is what keeps a
 * malicious or mistaken share from writing into the account on its own, and
 * it is why the payload never touches the outbox or the cache on its way.
 *
 * In the browser and in an older Notes APK the bridge answers the empty
 * payload and this does nothing at all (notesNative's feature-detect).
 */
import { useEffect, useRef } from 'react';
import {
    consumeNativeLaunchShare, fetchSharedFiles, notesNativeAvailable, onNativeShare,
} from './notesNative';

/** What arrived, ready for the composer. */
export interface SharedIntoNotes {
    title: string;
    body: string;
    files: File[];
}

/** The composer's own title cap (notesModel MAX_TITLE_LENGTH), applied to a
 *  subject that came from another app. */
const MAX_TITLE = 100;

/**
 * Shape a shared payload the way the native side would: the sender's subject
 * becomes the title, else the first line of the text when it reads like one.
 *
 * The SAME rules as ShareIntake.java, on purpose — the native side applies
 * them so the page gets a title even from an intent it never sees, and this
 * one is what the browser-side tests and the walk exercise. Pure, exported
 * for its own test.
 */
export function shapeSharedText(text: string | null, subject: string | null): { title: string; body: string } {
    const s = (subject ?? '').trim();
    const t = text ?? '';
    if (s) return { title: s.slice(0, MAX_TITLE), body: t.trim() };
    const nl = t.indexOf('\n');
    const first = (nl < 0 ? t : t.slice(0, nl)).trim();
    if (!first || first.length > MAX_TITLE) return { title: '', body: t.trim() };
    return { title: first, body: nl < 0 ? '' : t.slice(nl + 1).replace(/^[\r\n]+/, '').trim() };
}

/**
 * @param onShare called once per share, with what the composer should show.
 *                It is read through a ref, so the shell may rebuild it.
 * @param onLaunch told once whether the LAUNCH carried a share, as soon as
 *                the native side has answered — before the pictures are
 *                read, and whatever they turn out to be. "Open Púca Notes
 *                to" stands down for one (native/useNotesOpenTo.ts).
 */
export function useNativeShareIn(onShare: (shared: SharedIntoNotes) => void, onLaunch?: (carried: boolean) => void): void {
    const cbRef = useRef(onShare);
    useEffect(() => { cbRef.current = onShare; }, [onShare]);
    const launchRef = useRef(onLaunch);
    useEffect(() => { launchRef.current = onLaunch; }, [onLaunch]);

    useEffect(() => {
        if (!notesNativeAvailable()) return;
        let live = true;
        const drain = async (launch: boolean) => {
            const payload = await consumeNativeLaunchShare();
            if (!live) return;
            if (launch) launchRef.current?.(!!payload.text || !!payload.subject || payload.files.length > 0);
            const files = await fetchSharedFiles(payload);
            if (!live) return;
            const { title, body } = shapeSharedText(payload.text, payload.subject);
            if (!title && !body && files.length === 0) return;
            cbRef.current({ title, body, files });
        };
        void drain(true);
        // A share while the app runs: a content-free ping, then we ask.
        const off = onNativeShare(() => { void drain(false); });
        return () => { live = false; off(); };
    }, []);
}
