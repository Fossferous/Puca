/**
 * The phone-layout gate for the voice panel: ONE condition, shared by the
 * JS that decides to render the collapsed bar and its expand chevron, and by
 * the CSS in VoicePanel.css / mobile.css that implements the collapse and
 * reserves the bar's height.
 *
 * It used to be `isNativeMobile() || matchMedia(...)` on the JS side and the
 * media query alone on the CSS side. The native shell above 1024 CSS px (an
 * iPad in landscape) therefore rendered a "More voice controls" chevron that
 * toggled nothing, because none of the collapse rules applied. Two gates for
 * one layout will drift; this module is the one gate. A test pins that the
 * stylesheets carry this exact query.
 */
export const PHONE_PANEL_QUERY = '(pointer: coarse) and (max-width: 1024px)';

/** The live MediaQueryList, or null where there is no window or no
 *  matchMedia (SSR, the test runtime's default jsdom). */
export function phonePanelQuery(): MediaQueryList | null {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    return window.matchMedia(PHONE_PANEL_QUERY);
}
