/**
 * The settings nav's tab list, and which tabs a platform gets.
 *
 * Lives outside SettingsModal.tsx because `react-refresh/only-export-components`
 * forbids exporting a plain function from a component file, and the decision
 * must be importable by a test without mounting the modal.
 */
import type { IconName } from './Icons';
import { isMobile as isNativeMobile } from '../api/platform';

export interface SettingsSection { id: string; label: string; icon: IconName }

/**
 * A touch device, whatever its current width or orientation — the same
 * predicate DeviceStage uses for its touch UI (its COARSE_POINTER_QUERY).
 *
 * This is the "not on phones" of the Keybinds tab, the Screen-control group
 * and the Toggle Mute / Toggle Deafen presses, and it is deliberately wider
 * than the Capacitor app: a phone that opened the web app in a browser (where
 * an invite link lands) has exactly the same hardware. The query is the bare
 * `(pointer: coarse)`, not Chat.tsx's phone-LAYOUT gate with its max-width,
 * because what is being decided here is whether there is a keyboard to bind,
 * not which chrome to draw — an iPad in landscape is wider than 1024 CSS px
 * and still has no key to press. A desktop with a touchscreen reports `fine`
 * for its primary pointer and correctly keeps everything.
 */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

export function isTouchDevice(): boolean {
    // The Capacitor app is authoritative about itself; the media query covers
    // a browser. No window / no matchMedia (SSR, bare jsdom) is not a phone.
    if (isNativeMobile()) return true;
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/** The user agents the voice panel offers no Share Screen to: phones and
 *  tablets, whose browsers cannot capture a screen. */
const NO_SCREEN_SHARE_UA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;

/**
 * Does this device offer Share Screen? The voice panel decides by user agent,
 * and every setting that only matters to someone sharing follows the SAME
 * answer — not isTouchDevice(), which a Windows 2-in-1 in tablet mode
 * answers yes while it can still share.
 */
export function screenShareOffered(userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
    return !NO_SCREEN_SHARE_UA.test(userAgent);
}

/** Every tab, in nav order. Filtered per platform by settingsSections(). */
const ALL_SETTINGS_SECTIONS: readonly SettingsSection[] = [
    { id: 'account', label: 'My Account', icon: 'user' },
    { id: 'privacy', label: 'Privacy & Safety', icon: 'lock' },
    { id: 'appearance', label: 'Appearance', icon: 'palette' },
    { id: 'accessibility', label: 'Accessibility', icon: 'accessibility' },
    { id: 'notifications', label: 'Notifications', icon: 'bell' },
    { id: 'voice', label: 'Voice & Video', icon: 'mic' },
    { id: 'keybinds', label: 'Keybinds', icon: 'keyboard' },
    { id: 'language', label: 'Language', icon: 'globe' },
    { id: 'advanced', label: 'Advanced', icon: 'settings' },
];

/**
 * The tabs the settings nav shows on this platform. A pure function so the
 * decision is testable without mounting the modal.
 *
 * Phones get no Keybinds tab: every row on it is a key combination — captured
 * by pressing keys, with a "works from other apps too" scope that only the
 * desktop hotkey hook provides — so on a touch device it was a page of
 * controls over hardware the user does not have. The one setting on it that
 * a phone user could still want (Push to talk) keeps its own row under
 * Voice & Video, which stays.
 *
 * `mobile` is isTouchDevice()'s answer, passed in rather than read here so
 * the decision stays pure. The presses the hidden tab used to expose (Toggle
 * Mute / Toggle Deafen, VoicePanel) are gated on the same predicate: a
 * binding nobody can see or clear must not stay live.
 */
export function settingsSections(opts: { mobile: boolean }): SettingsSection[] {
    return ALL_SETTINGS_SECTIONS.filter(s => !(opts.mobile && s.id === 'keybinds'));
}

/** What a press inside a settings row can mean already, without this helper. */
const ROW_CONTROLS = 'input, select, textarea, button, a[href], [role="button"], [role="switch"], [contenteditable="true"]';

/**
 * A press on a setting's name or hint toggles its checkbox.
 *
 * Nearly every on/off setting is a `.settings-option` row: a `<label>` with
 * the name, a hint under it, and a bare checkbox. The label names no control
 * (66 of them in SettingsModal), so only the 20px box answered a press, and on
 * a phone the row stacks into a column with the box alone under the hint:
 * a 20px target, under §5's 44. This makes the whole row the target. It acts
 * only where the meaning is unambiguous: a row holding exactly one control,
 * and that control an enabled checkbox; a press on any control, or on a label
 * the browser already ties to one, is left to the browser (it would toggle
 * twice otherwise), and so is a press that ended selecting the row's words.
 * Returns whether it toggled.
 */
export function toggleSettingFromRow(target: EventTarget | null, opts: { pressInSelection?: boolean } = {}): boolean {
    if (!(target instanceof Element)) return false;
    if (target.closest(ROW_CONTROLS)) return false;
    const label = target.closest('label');
    if (label instanceof HTMLLabelElement && label.control) return false;
    const row = target.closest('.settings-option');
    if (!row) return false;
    // A press that ends a drag across the words is someone selecting them to
    // copy, not choosing: a native <label> ignores that click too (Chromium's
    // and Gecko's label activation both skip a click that made a selection).
    // Without this, copying a phrase of a hint flipped and saved its setting.
    // But not a single press that went down INSIDE words already selected
    // (`pressInSelection`, from pointInSelection at mousedown): Chromium's
    // label takes that one, and the selection goes with it. Skipping it too
    // made a second press necessary.
    const selection = target.ownerDocument.getSelection?.();
    if (!opts.pressInSelection && selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(row)) return false;
    const controls = row.querySelectorAll(ROW_CONTROLS);
    if (controls.length !== 1) return false;
    const box = controls[0];
    if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox' || box.disabled) return false;
    box.click();
    return true;
}

/** Whether (x, y) is on words that are selected now: read at mousedown, before
 *  the press changes the selection, for toggleSettingFromRow. */
export function pointInSelection(doc: Document, x: number, y: number): boolean {
    const selection = doc.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    if (typeof range.getClientRects !== 'function') return false;
    return [...range.getClientRects()].some(b => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
}
