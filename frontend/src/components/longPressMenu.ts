/**
 * On Android a long press on a message, a member or a channel opens Púca's
 * own menu: Chromium fires `contextmenu` for it. The same press ALSO selected
 * the word under the finger, so the menu came up with selection handles and
 * Android's own Copy bar under it (seen on the real APK, 2026-11-12). Those
 * rows take no text selection there (`[data-long-press-menu]` in Chat.css);
 * the menu's Copy Text copies a message.
 *
 * Not on an iPhone or iPad: iOS Safari fires no `contextmenu` on a long
 * press, so there is no menu to clash with, and native selection is how a
 * message is copied there. Not on a desktop either.
 */
export function longPressOpensMenu(userAgent: string): boolean {
    return /\bAndroid\b/i.test(userAgent);
}

/** Marks the page once at startup (main.tsx). */
export function markLongPressMenu(root: HTMLElement, userAgent: string): void {
    if (longPressOpensMenu(userAgent)) root.dataset.longPressMenu = '';
}
