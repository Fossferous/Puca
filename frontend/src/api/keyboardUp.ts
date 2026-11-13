/**
 * `<html data-keyboard-up>` while a phone's soft keyboard is up for a text
 * field: the bottom tab bar steps aside then (mobile.css), as in most chat
 * apps. Before 2026-11-12 it stayed on top of the keyboard, 60 px of the
 * ~470 px a phone has left while typing (seen on the real APK).
 *
 * Two signals, both only while a text field has the focus (the app's own,
 * when it has measured the keyboard, decides; else the visual viewport):
 *  - the Android app's own keyboard event (APKs from 0.8.88). The WebView is
 *    resized there, so nothing in the page can see the keyboard; and a Back
 *    that closes the keyboard leaves the field focused, which this sees as
 *    "down", so the bar comes back without a tap elsewhere.
 *  - the visual viewport shrinking by a keyboard's height (an iPhone, a phone
 *    browser): the layout keeps its height and the keyboard covers its foot.
 *
 * A focus alone is not enough: a hardware keyboard, or Back having closed the
 * soft one, leaves a field focused with nothing covering the bar.
 */
import { mobileKeyboardState, onMobileKeyboard } from './mobileApp';

/** A shrink smaller than this is a URL bar, not a keyboard (keyboardInset.ts
 *  draws the same line). */
const MIN_KEYBOARD_PX = 80;

const NOT_TYPED_INTO = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit', 'hidden']);

/** Is this element something the soft keyboard types into? */
export function isTextEntry(el: Element | null): boolean {
    if (!el) return false;
    if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
    if (el instanceof HTMLInputElement) return !NOT_TYPED_INTO.has(el.type) && !el.readOnly && !el.disabled;
    return el instanceof HTMLElement && el.isContentEditable === true;
}

export interface KeyboardReading {
    /** A text field has the focus. */
    typing: boolean;
    /** The Android app's own answer; null where nothing native has spoken. */
    nativeVisible: boolean | null;
    /** The layout viewport's height, CSS px. */
    layoutHeight: number;
    /** The visual viewport's height times its scale (a pinch zoom is not a
     *  keyboard); null without a visual viewport. */
    visualHeight: number | null;
}

export function keyboardIsUp(r: KeyboardReading): boolean {
    if (!r.typing) return false;
    if (r.nativeVisible !== null) return r.nativeVisible;
    return r.visualHeight !== null && r.layoutHeight - r.visualHeight > MIN_KEYBOARD_PX;
}

/** Keeps `data-keyboard-up` on <html> in step; main.tsx installs it once. */
export function installKeyboardUp(): () => void {
    const root = document.documentElement;
    let nativeVisible: boolean | null = null;
    const update = () => {
        const vv = window.visualViewport;
        const up = keyboardIsUp({
            typing: isTextEntry(document.activeElement),
            nativeVisible,
            layoutHeight: root.clientHeight || window.innerHeight,
            visualHeight: vv ? vv.height * vv.scale : null,
        });
        if (up) root.dataset.keyboardUp = '';
        else delete root.dataset.keyboardUp;
    };
    // focusout fires before the next element takes the focus: read after it.
    const onFocusOut = () => { window.setTimeout(update, 0); };
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', onFocusOut);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', update);
    let live = true;
    const fromNative = (d: { visible: boolean; topPx?: number }) => {
        if (!live) return;
        // topPx -1 is the plugin's "nothing measured yet" (permanently, on Android
        // 7 to 10, where its inset listener is never installed): not an answer,
        // so the visual viewport still gets its say.
        if (typeof d.topPx === 'number' && d.topPx < 0) return;
        nativeVisible = d.visible;
        update();
    };
    void mobileKeyboardState().then(s => { if (s) fromNative(s); }).catch(() => undefined);
    const handle = onMobileKeyboard(fromNative);
    update();
    return () => {
        live = false;
        document.removeEventListener('focusin', update);
        document.removeEventListener('focusout', onFocusOut);
        vv?.removeEventListener('resize', update);
        void handle.then(h => h?.remove()).catch(() => undefined);
        delete root.dataset.keyboardUp;
    };
}
