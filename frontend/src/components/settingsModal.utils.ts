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
