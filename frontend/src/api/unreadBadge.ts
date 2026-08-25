// Unread indicator on the OS surfaces: a red-dot overlay on the Windows
// taskbar button + a badged tray icon (Rust command `set_unread_badge`).
//
// It is a LATCH, not a counter: set when a notification-worthy message
// arrives while the window is unfocused, cleared when the window gains
// focus. The app has no global unread aggregate (per-channel counts cover
// only the open server, DMs none at all), but desktopNotify's decision
// already answers exactly "did a message arrive that the user isn't
// looking at?" — so the badge rides that.

import { isTauri } from './platform';

/**
 * Whether a message should light the badge, judged from the RAW inputs, not
 * the toast decision. Deliberately WIDER than "a toast fired": notifications
 * off (or OS permission denied) still deserves the badge — those gates are
 * about toasts, not about whether the message is unseen. Judging the toast
 * decision's short-circuited `reason` instead leaked here: shouldNotify
 * checks the setting FIRST, so with notifications off every message —
 * including your own, muted ones, and ones you were looking at — reported
 * 'setting-off' and would have badged.
 */
export function isBadgeWorthy(i: {
    mobile: boolean; isOwn: boolean; isMuted: boolean; hasFocus: boolean;
}): boolean {
    return !i.mobile && !i.isOwn && !i.isMuted && !i.hasFocus;
}

// Last value actually sent — the latch dedupes so only 0<->N transitions
// cross the IPC boundary. Reset on error so a retry can happen.
let lastSent: boolean | null = null;

export function setUnreadBadge(unread: boolean): void {
    if (!isTauri()) return; // web + mobile: no taskbar/tray to badge
    if (lastSent === unread) return;
    lastSent = unread;
    void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('set_unread_badge', { unread }))
        .catch((err) => {
            lastSent = null;
            console.warn('[unreadBadge] set failed:', err);
        });
}
