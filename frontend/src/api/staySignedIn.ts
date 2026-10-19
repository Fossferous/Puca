/**
 * "Stay signed in on this device" — the one stored answer both sign-in forms
 * read (Púca's Login.tsx and Púca Notes' NotesLogin.tsx).
 *
 * What it buys is the server's long session (src/auth.rs `ls`): a token that
 * lives 30 days instead of 24 hours and renews on use for up to a year from
 * the sign-in. Without it, a token renews only on use, so not opening the app
 * for a day means signing in again - someone who drops in once an evening, a
 * little later each day, was signed out almost every day.
 *
 * The answer is about the DEVICE, not an account, so it is stored the moment
 * it is chosen (not on a successful sign-in: untick, mistype the password,
 * and the box stays unticked) and is deliberately kept across a sign-out
 * (auth.ts STAY_SIGNED_IN_KEY has why). Absent, each form falls back to its
 * own default.
 */
import { STAY_SIGNED_IN_KEY } from './auth';

/** This device's answer: a stored 'true' or 'false', else `fallback`.
 *  Storage can throw (a locked-down profile), and a checkbox is not worth a
 *  blank screen - fall back. */
export function readStaySignedIn(fallback: boolean): boolean {
    try {
        const v = localStorage.getItem(STAY_SIGNED_IN_KEY);
        if (v === 'true') return true;
        if (v === 'false') return false;
    } catch { /* fall through to the default */ }
    return fallback;
}

/** Remember the answer on this device. A profile that refuses storage still
 *  gets the session it asked for this time. */
export function writeStaySignedIn(stay: boolean): void {
    try {
        localStorage.setItem(STAY_SIGNED_IN_KEY, stay ? 'true' : 'false');
    } catch { /* see above */ }
}
