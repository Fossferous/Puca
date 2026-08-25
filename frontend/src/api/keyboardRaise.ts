/**
 * Bring the soft keyboard up over a field, from OUTSIDE a user gesture.
 *
 * Its own module (not DeviceStageMobileKeyboard.tsx) only because that file
 * exports a component and react-refresh wants components alone there; the
 * keyboard overlay is the sole caller, for its "Tap to type" button and for
 * the stage's raise-on-demand (deviceAutoKeyboard.ts).
 *
 * The order matters and each step covers a case the others cannot:
 *  1. focus() — no keyboard can appear over an unfocused field. Blink raises
 *     the IME for a programmatic focus while it judges the frame
 *     user-activated; when it does, this alone is enough.
 *  2. the native showKeyboard — Android's showSoftInput has no gesture
 *     condition and is what makes this reliable (APKs from 0.8.104).
 *  3. blur+focus — the fallback for an old APK / the web, and ONLY when the
 *     field was already focused: focus() on the focused element is a no-op
 *     in Blink, so a keyboard dismissed by the back gesture needs the focus
 *     to actually change hands to come back. Gated on `imeVisible` because
 *     the dance hides and re-shows an IME that IS up.
 */
import { showMobileKeyboard } from './mobileApp';

export async function raiseKeyboardOver(field: HTMLInputElement, imeVisible: boolean): Promise<void> {
    const wasFocused = document.activeElement === field;
    if (!wasFocused) field.focus();
    const native = await showMobileKeyboard();
    if (!native && wasFocused && !imeVisible) {
        field.blur();
        field.focus();
    }
}
