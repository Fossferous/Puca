/**
 * Desktop notifications for messages that arrive while you are not looking.
 *
 * The `desktopNotifications` setting asked for browser permission and then
 * nothing ever called `new Notification()` — so the toggle, and the permission
 * the user granted, did nothing at all.
 *
 * DELIBERATELY CONTENT-FREE. Messages are end-to-end encrypted: the server
 * cannot read them, and `MessageNotification` carries only the author and the
 * channel. Even for a DM, where this process *can* decrypt, the body stays
 * generic — a notification is rendered by the OS, survives in a notification
 * centre, and is visible on a lock screen. "New message" leaks nothing there.
 */
import { loadSettings } from '../components/settingsStore';
import { appIsForeground, isMobile, isTauri } from './platform';
import { isBadgeWorthy, setUnreadBadge } from './unreadBadge';
import { mobileAppAvailable, postMobileNotification, requestMobileNotificationPermission } from './mobileApp';

export type NotifyDecision =
    | { fire: true }
    | { fire: false; reason: 'setting-off' | 'no-permission' | 'own-message' | 'muted' | 'focused' | 'mobile' };

export interface NotifyInput {
    /** The message is from this client's own user. */
    isOwn: boolean;
    /** Server or channel muted by the user. */
    isMuted: boolean;
    /** Does this app window currently have focus? */
    hasFocus: boolean;
    permission: NotificationPermission | 'unsupported';
    setting: boolean;
    mobile: boolean;
    /** A native notification path exists on this mobile platform — the
     *  Android SovereignApp plugin (APKs from 0.8.33). Without it, mobile
     *  stays blocked exactly as before the plugin existed. */
    mobileNative: boolean;
}

// --- Diagnostics --------------------------------------------------------
//
// Every suppression in this file is SILENT: `notifyNewMessage` returns a
// decision explaining exactly why nothing appeared and both call sites discard
// it, so "I get no notifications" has been undiagnosable without a debugger
// attached at the right moment. On Android that is the whole ballgame — there
// is no way to tell "the gate said no" apart from "the WebSocket frame never
// arrived", and those have completely different fixes.
//
// So: a ring buffer of recent decisions, readable live via
// `__pucaNotifyDiag()` in DevTools (chrome://inspect on Android), matching
// the `__pucaVoiceDiag()` idiom. Ids only, never message text or
// usernames — this is printed to a console and the rest of the file is
// content-free for good reasons.

interface NotifyLogEntry {
    at: string;
    kind: 'message' | 'task';
    /** 'chan:<serverId>' / 'dm:<conversationId>' / 'tasks-due' — ids only. */
    key: string;
    /** 'fired', or the reason it was suppressed. */
    outcome: string;
    inputs?: NotifyInput;
}

const NOTIFY_LOG_MAX = 40;
const notifyLog: NotifyLogEntry[] = [];

function recordNotify(entry: NotifyLogEntry): void {
    notifyLog.push(entry);
    if (notifyLog.length > NOTIFY_LOG_MAX) notifyLog.shift();
}

/**
 * Live notification diagnostics. Read it from DevTools WHILE the problem is
 * happening — the gate inputs are sampled at call time.
 *
 * Reading the result:
 *  - `recent` EMPTY after someone messages you  → nothing ever reached this
 *    module: the WebSocket frame did not arrive (backgrounded WebView, Doze,
 *    a dead keep-alive) or an earlier gate in Chat dropped it (blocked user,
 *    own message). The notification code is not the problem.
 *  - entries with `outcome: 'focused'` while the app is in the BACKGROUND →
 *    `document.hasFocus()` is lying in this WebView; the focus gate is
 *    suppressing everything.
 *  - `outcome: 'muted'` → that server/channel is muted, or set to "mentions
 *    only" (which also silences OS notifications, since the cross-channel
 *    frame carries no mention marker).
 *  - `outcome: 'fired'` but nothing in the shade → the failure is below this
 *    layer: the native plugin or the OS.
 */
export function notifyDiag() {
    return {
        now: new Date().toISOString(),
        live: {
            isMobile: isMobile(),
            mobileNative: isMobile() && mobileAppAvailable(),
            isTauri: isTauri(),
            // Both, deliberately: on mobile these DISAGREE, and seeing the
            // disagreement is what identifies the fault.
            foreground: appIsForeground(),
            rawHasFocus: typeof document !== 'undefined' && document.hasFocus(),
            visibility: typeof document !== 'undefined' ? document.visibilityState : 'n/a',
            permission: notificationPermission(),
            mobileNotifications: loadSettings().mobileNotifications,
            desktopNotifications: loadSettings().desktopNotifications,
            mobileBackgroundDelivery: loadSettings().mobileBackgroundDelivery,
        },
        recent: [...notifyLog],
    };
}

if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__pucaNotifyDiag = notifyDiag;
}

/**
 * Pure so every suppression rule is testable without a browser.
 *
 * The focus rule is evaluated FRESH at fire time by the caller rather than
 * tracked in a `focused` flag kept up to date by listeners: a sticky flag that
 * misses a blur (alt-tab into a game, a Tauri window event that never lands) is
 * how you end up either silently dropping every notification or firing them
 * while the user is looking at the message.
 */
export function shouldNotify(i: NotifyInput): NotifyDecision {
    // Mobile WITHOUT a native path (iOS, web-mobile, an old Android APK) is
    // blocked outright, exactly as before the Android plugin existed. WITH
    // one, mobile runs the same gates as everywhere else.
    if (i.mobile && !i.mobileNative) return { fire: false, reason: 'mobile' };
    if (!i.setting) return { fire: false, reason: 'setting-off' };
    if (i.permission !== 'granted') return { fire: false, reason: 'no-permission' };
    if (i.isOwn) return { fire: false, reason: 'own-message' };
    if (i.isMuted) return { fire: false, reason: 'muted' };
    // You are already looking at the app: the in-app sound and unread state are
    // enough, and an OS toast over the window you are using is just noise.
    if (i.hasFocus) return { fire: false, reason: 'focused' };
    return { fire: true };
}

/** Current permission, or 'unsupported' where the API does not exist. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
}

/**
 * Raise the app window. On desktop this is the existing native command — the
 * webview's own `window.focus()` cannot raise a minimised Tauri window, and the
 * window ACL does not grant `setFocus`.
 */
async function focusApp(): Promise<void> {
    if (isTauri()) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('attention_main_window');
            return;
        } catch {
            // fall through to the web behaviour
        }
    }
    try { window.focus(); } catch { /* nothing else to try */ }
}

/**
 * Show a notification for a new message, if every rule allows it.
 * Returns the decision so callers (and tests) can see WHY nothing appeared.
 */
export function notifyNewMessage(opts: {
    title: string;
    isOwn: boolean;
    isMuted: boolean;
    /** Stable key for replacement on Android — 'dm:<conversationId>',
     *  'chan:<serverId>' — so a burst from one conversation updates a single
     *  notification instead of stacking. Falls back to the title. */
    notifyKey?: string;
    /** Where a tap lands on Android: 'friends', 'dm:<conversationId>',
     *  'server:<serverId>', … (see mobileApp.ts). */
    nav?: string;
    /** Called when the user clicks the notification, after focusing the app. */
    onActivate?: () => void;
}): NotifyDecision {
    const mobileNative = isMobile() && mobileAppAvailable();
    const settings = loadSettings();
    const inputs: NotifyInput = {
        isOwn: opts.isOwn,
        isMuted: opts.isMuted,
        // Read at fire time — never from a cached flag. Platform-aware: on
        // mobile this is visibilityState, because document.hasFocus() stays
        // TRUE in a backgrounded Android WebView and silently suppressed every
        // message notification. See appIsForeground.
        hasFocus: appIsForeground(),
        // On desktop the WEBVIEW's permission is irrelevant — the notification
        // goes through the OS via Tauri, which asks for its own permission.
        // Leaving the webview check in place would gate the native path behind
        // a 'default'/'denied' that means nothing there, and silently suppress
        // every notification on the platform this feature exists for.
        // Android's native path likewise manages POST_NOTIFICATIONS itself
        // (unposted notifications are dropped by the OS, not errored).
        permission: isTauri() || mobileNative ? 'granted' : notificationPermission(),
        setting: isMobile() ? settings.mobileNotifications : settings.desktopNotifications,
        mobile: isMobile(),
        mobileNative,
    };
    const decision = shouldNotify(inputs);
    recordNotify({
        at: new Date().toISOString(),
        kind: 'message',
        key: opts.notifyKey ?? '(no key)',
        outcome: decision.fire ? 'fired' : decision.reason,
        inputs,
    });
    // Taskbar/tray unread badge: judged from the RAW inputs (never the
    // decision's short-circuited reason), wider than the toast — a message
    // that only failed the toast gates (setting off / no OS permission) is
    // still unseen. Cleared by Chat's window-focus listener.
    if (isBadgeWorthy(inputs)) setUnreadBadge(true);
    if (!decision.fire) return decision;

    // ANDROID: through the SovereignApp plugin — `new Notification()` in a
    // Capacitor WebView reaches nothing, same disease as WebView2 below. The
    // body stays content-free for the same lock-screen reason as everywhere
    // else; the tap target rides the notification as a nav intent instead of
    // an onActivate closure (the process may be long past this closure's
    // lifetime when the tap happens).
    if (inputs.mobile && inputs.mobileNative) {
        void postMobileNotification(
            opts.notifyKey ?? opts.title, opts.title, 'New message', opts.nav,
        );
        return decision;
    }

    // DESKTOP: go through the OS via Tauri, not the webview.
    //
    // `new Notification()` inside WebView2 does NOT reach the Windows
    // notification centre — WebView2 only surfaces it if the host app handles
    // CoreWebView2.NotificationReceived, and Tauri does not. So on the platform
    // most people run this on, the branch below was very likely doing nothing
    // at all while reporting success. The plugin calls the OS API from Rust and
    // sidesteps the webview entirely.
    if (isTauri()) {
        void (async () => {
            try {
                const { isPermissionGranted, requestPermission, sendNotification } =
                    await import('@tauri-apps/plugin-notification');
                let granted = await isPermissionGranted();
                if (!granted) granted = (await requestPermission()) === 'granted';
                if (!granted) return;
                sendNotification({ title: opts.title, body: 'New message' });
            } catch (err) {
                console.warn('[notify] native notification failed:', err);
            }
        })();
        return decision;
    }

    try {
        const n = new Notification(opts.title, {
            body: 'New message',
            // Collapses repeats from the same conversation instead of stacking
            // one toast per message during a burst.
            tag: opts.title,
            silent: true, // the app plays its own sound; two is jarring
        });
        n.onclick = () => {
            void focusApp();
            opts.onActivate?.();
            n.close();
        };
    } catch {
        // A platform can refuse construction even with permission granted
        // (notifications disabled at OS level). Never let that break message
        // handling.
    }
    return decision;
}

/**
 * Due-task reminder toast. Content-free like everything else here (task text
 * is E2EE and a toast survives on lock screens): only a count. Rides the same
 * setting as message notifications — a new setting would need its own UI.
 *
 * Deliberately does NOT suppress on focus, unlike a message: a message left
 * unread has badges and the channel list; a deadline that passes silently has
 * no other surface, and it is the one notification whose timing is the point.
 * Clicking it (web path) raises the app and opens the Tasks view via the
 * `sovereign:open-tasks` event Chat listens for.
 */
export function notifyTasksDue(count: number): void {
    if (count <= 0) return;
    const mobileNative = isMobile() && mobileAppAvailable();
    const settings = loadSettings();
    const setting = isMobile() ? settings.mobileNotifications : settings.desktopNotifications;
    // Logged on the same buffer as messages, and that comparison is the point:
    // a task entry beside NO message entries proves the two paths diverge
    // before this module, not inside it.
    recordNotify({
        at: new Date().toISOString(),
        kind: 'task',
        key: 'tasks-due',
        outcome: isMobile() && !mobileNative ? 'mobile' : !setting ? 'setting-off' : 'fired',
    });
    if (isMobile() && !mobileNative) return;
    if (!setting) return;

    const body = count === 1 ? 'A task is due' : `${count} tasks are due`;

    if (isMobile() && mobileNative) {
        void postMobileNotification('tasks-due', 'Púca Tasks', body, 'tasks');
        return;
    }

    if (isTauri()) {
        void (async () => {
            try {
                const { isPermissionGranted, requestPermission, sendNotification } =
                    await import('@tauri-apps/plugin-notification');
                let granted = await isPermissionGranted();
                if (!granted) granted = (await requestPermission()) === 'granted';
                if (!granted) return;
                sendNotification({ title: 'Púca Tasks', body });
            } catch (err) {
                console.warn('[notify] task reminder failed:', err);
            }
        })();
        return;
    }

    if (notificationPermission() !== 'granted') return;
    try {
        // No `silent`: there is no in-app sound for reminders, so the OS
        // default chime is the only audible cue.
        const n = new Notification('Púca Tasks', { body, tag: 'tasks-due' });
        n.onclick = () => {
            void focusApp();
            try { window.dispatchEvent(new CustomEvent('sovereign:open-tasks')); } catch { /* non-DOM env */ }
            n.close();
        };
    } catch {
        // Construction can fail with permission granted (OS-level disable).
    }
}

/**
 * Fire one notification right now, for the Settings "Send test" button.
 *
 * Deliberately goes through the SAME native path a real message uses, so it
 * exercises permission, the plugin, the capability ACL and the OS toast — the
 * whole chain except the WebSocket delivery. Without this you need a second
 * person online to find out whether notifications work at all, which is what
 * made this feature impossible to verify.
 *
 * Returns what happened so the caller can say something useful instead of
 * failing silently — the failure mode this whole area suffered from.
 */
export async function sendTestNotification(): Promise<{ ok: boolean; reason?: string }> {
    if (isMobile()) {
        if (!mobileAppAvailable()) {
            return { ok: false, reason: 'this APK is too old for notifications — install the current one' };
        }
        const granted = await requestMobileNotificationPermission();
        if (!granted) return { ok: false, reason: 'permission denied by Android' };
        await postMobileNotification(
            'test', 'Púca',
            'Test notification — this is what a new message looks like.',
        );
        return { ok: true };
    }
    if (!isTauri()) {
        if (notificationPermission() !== 'granted') {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') return { ok: false, reason: 'permission denied' };
        }
        try {
            new Notification('Púca', { body: 'Test notification — this is what a new message looks like.' });
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: String(err) };
        }
    }
    try {
        const { isPermissionGranted, requestPermission, sendNotification } =
            await import('@tauri-apps/plugin-notification');
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === 'granted';
        if (!granted) return { ok: false, reason: 'permission denied by the OS' };
        sendNotification({
            title: 'Púca',
            body: 'Test notification — this is what a new message looks like.',
        });
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: String(err) };
    }
}
