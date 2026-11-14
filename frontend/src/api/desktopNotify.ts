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
 *
 * ONE PER CONVERSATION (api/notifyGroups.ts). A message that names its
 * conversation (`group`) does not raise a notification of its own: it updates
 * that conversation's one notification, which pops up for the first message of
 * a burst and otherwise changes where it is, quietly. In the desktop app that
 * is a Windows toast with a Tag and a Group (src-tauri/src/toasts.rs: the
 * plugin's toasts carried neither, so Windows stacked one per message); in the
 * web app a Notification tagged by the conversation. Reading the conversation
 * in the app takes its notification away (`seeConversation`). The
 * "Group notifications by conversation" setting off brings back the old
 * behaviour exactly.
 */
import { loadSettings, saveSettings } from '../components/settingsStore';
import { appIsForeground, isMobile, isTauri } from './platform';
import { isBadgeWorthy, setUnreadBadge } from './unreadBadge';
import {
    type DueReminder, mobileAppAvailable, notesOwnsDueReminders, postMobileNotification, requestMobileNotificationPermission,
    requestNavigation,
} from './mobileApp';
import { currentUserIdFromToken } from './auth';
import { API_BASE_URL } from './config';
import { hostSaysForeground, hostShowsNotifications, notifyHost } from './embedHost';
import { NotifyGroups, TASKS_DUE_KEY, navForGroupKey, type GroupMessage, type GroupStep } from './notifyGroups';

export type NotifyDecision =
    /** `quiet`: it only updated its conversation's notification where it
     *  is: no pop-up, so the caller plays no sound for it either. */
    | { fire: true; quiet?: true }
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
    /** 'chan:<serverId>:<channelId>' (grouped) or 'chan:<serverId>',
     *  'dm:<conversationId>', 'join:<serverId>', 'tasks-due' — ids only. */
    key: string;
    /** 'fired' (shown, popping up), 'updated' (its conversation's
     *  notification changed where it is, no pop-up), 'duplicate' (a message
     *  counted already), or the reason it was suppressed. */
    outcome: string;
    inputs?: NotifyInput;
}

const NOTIFY_LOG_MAX = 40;
const notifyLog: NotifyLogEntry[] = [];

function recordNotify(entry: NotifyLogEntry): void {
    notifyLog.push(entry);
    if (notifyLog.length > NOTIFY_LOG_MAX) notifyLog.shift();
}

// --- One notification per conversation ----------------------------------

/** Every conversation's count and names, until it is seen. */
const groups = new NotifyGroups();
/** What a click on a conversation's notification does: the newest caller's. */
const activations = new Map<string, () => void>();
/** The web app's notification per conversation, while it exists. */
const webLive = new Map<string, Notification>();
/** What the desktop app's own toasts (src-tauri/src/toasts.rs) last answered:
 *  'yes' Windows showed or updated it; 'off' Windows shows none of Púca's
 *  notifications (turned off in Settings, or a policy); 'failed' Windows
 *  refused that one; 'no' the shell has none (a build for anything but
 *  Windows: the page ships inside the installer with its shell, so a Windows
 *  app always has them). None of these is for good: every pop-up asks again,
 *  so turning Púca's notifications back on, or a one-off refusal, mends
 *  itself by the next burst. */
type NativeToasts = 'unknown' | 'yes' | 'off' | 'failed' | 'no';
let nativeToasts: NativeToasts = 'unknown';
/** Is the last toast still on screen to be updated, as far as we know? A
 *  quiet update is quiet to the caller (no sound) only then. */
const nativeToastsShowing = () => nativeToasts === 'yes' || nativeToasts === 'unknown';
/** toast_show's answer, as the state above. An older shell answered nothing:
 *  it showed it. */
function toastAnswer(answer: unknown): NativeToasts {
    if (answer === 'off') return 'off';
    if (answer === 'failed') return 'failed';
    return 'yes';
}
let activationListener: Promise<void> | null = null;
/** Every toast command goes through here, ONE at a time: Tauri does not
 *  promise to deliver two separate invokes in the order they were made
 *  (ordered_worker.rs), and a quiet update overtaking the pop-up it updates
 *  would pop the older words. A clear returns once the shell has queued it,
 *  a show once Windows has answered (milliseconds; at most toasts.rs's
 *  ANSWER_WAIT). */
let nativeQueue: Promise<unknown> = Promise.resolve();
function nativeCall(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    const call = nativeQueue.then(async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        return invoke(cmd, args);
    });
    nativeQueue = call.catch(() => undefined);
    return call;
}

/** "Group notifications by conversation" (Settings → Notifications). On by
 *  default; off is the behaviour before it, exactly. */
function groupingOn(): boolean {
    return loadSettings().groupNotifications !== false;
}

/**
 * A click on a conversation's notification: it is about to be seen, so its
 * count goes, and the conversation opens. The caller's own action when this
 * page still has it; otherwise (a toast left from before a reload) the place
 * its key names. The task reminder's toast (TASKS_DUE_KEY) comes through
 * here too, and opens the Reminders view.
 */
export function activateConversation(key: string): void {
    const act = activations.get(key);
    seeConversation(key);
    if (act) { act(); return; }
    const nav = navForGroupKey(key);
    if (nav) requestNavigation(nav);
}

/** The desktop app tells the page which toast was clicked (toasts.rs raises
 *  the window itself). Listened for from the start, so a toast left in the
 *  notification centre from before a reload still opens its conversation. */
function listenForToastClicks(): void {
    if (activationListener || !isTauri()) return;
    activationListener = (async () => {
        try {
            const { listen } = await import('@tauri-apps/api/event');
            await listen<string>('toast-activated', e => activateConversation(String(e.payload)));
        } catch {
            activationListener = null;
        }
    })();
}
listenForToastClicks();

/**
 * The conversation is on screen with the window focused: whatever its
 * notification said is in front of the user now. Its count starts again, and
 * its notification leaves the notification centre. Cheap when there is none,
 * and asked of the desktop app even then: a toast can outlive the page that
 * counted it (a reload, a restart), and only the shell can find it by key.
 */
export function seeConversation(key: string): void {
    groups.seen(key);
    activations.delete(key);
    const n = webLive.get(key);
    if (n) {
        webLive.delete(key);
        try { n.close(); } catch { /* already gone */ }
    }
    if (isTauri() && nativeToasts !== 'no') {
        nativeCall('toast_clear', { key }).catch(() => { nativeToasts = 'no'; });
    }
}

/** You came back to the window: whatever conversation goes on, its next
 *  message after you leave again pops (api/notifyGroups.ts, endBursts). */
export function endConversationBursts(): void {
    groups.endBursts();
}

/** Sign-out: every conversation's notification goes, and every count. */
export function clearAllConversationNotifications(): void {
    groups.clear();
    activations.clear();
    for (const n of webLive.values()) {
        try { n.close(); } catch { /* already gone */ }
    }
    webLive.clear();
    if (isTauri() && nativeToasts !== 'no') {
        nativeCall('toast_clear_all').catch(() => { nativeToasts = 'no'; });
    }
}

/** The notification plugin's toast, where the shell has none of its own:
 *  permission asked first, as everywhere the plugin is used. (On a desktop
 *  the plugin always answers granted today; asking is what keeps a refusal,
 *  should a platform ever give one, from being shown nothing in silence.) It
 *  carries no tag, no click and no sound. Says whether it was handed over. */
async function pluginNotify(title: string, body: string): Promise<boolean> {
    try {
        const { isPermissionGranted, requestPermission, sendNotification } =
            await import('@tauri-apps/plugin-notification');
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === 'granted';
        if (!granted) return false;
        sendNotification({ title, body });
        return true;
    } catch (err) {
        console.warn('[notify] native notification failed:', err);
        return false;
    }
}

/** Ask the desktop app's own toasts (toasts.rs) for one, and keep what it
 *  answered. False when this shell has none ('no'). */
async function askNativeToast(args: { key: string; title: string; body: string; popup: boolean; sound: boolean }): Promise<boolean> {
    try {
        nativeToasts = toastAnswer(await nativeCall('toast_show', args));
        listenForToastClicks();
        return true;
    } catch (err) {
        if (nativeToasts !== 'no') console.warn('[notify] toasts that replace each other are unavailable here:', err);
        nativeToasts = 'no';
        return false;
    }
}

/** The desktop app's toast for one conversation. Where the shell refuses
 *  `toast_show` (see nativeToasts) the plugin raises one when the rule says
 *  pop, and nothing when it says update: it can neither replace nor update.
 *  A quiet update after a refusal is not asked for (it has nothing to
 *  change); the next pop asks again. 'off' and 'failed' fall back to nothing:
 *  the plugin's toasts go through the same Windows switch. */
async function showNativeToast(key: string, step: Pick<GroupStep, 'pop' | 'title' | 'body'>): Promise<void> {
    if (!step.pop && nativeToasts === 'no') return;
    const asked = await askNativeToast({ key, title: step.title, body: step.body, popup: step.pop, sound: false });
    if (!asked && step.pop) await pluginNotify(step.title, step.body);
}

/**
 * Does this browser pop a replaced notification up again only when asked
 * (`renotify`)? Chromium does, and replaces quietly otherwise. Firefox has no
 * `renotify` at all and shows every replacement as a fresh pop-up (on Windows
 * it closes the old toast and shows a new one: widget/windows/
 * ToastNotification.cpp, ShowAlertWithCallbacks; on macOS the same, Mozilla
 * bug 1789736). Safari has none either, and shows a same-tag notification at
 * once, on iOS beside the old one (WebKit bug 258922). So a "quiet" update
 * there would pop every message, which is the spam this module exists to end.
 */
function browserRenotifies(): boolean {
    try {
        return typeof Notification !== 'undefined' && 'renotify' in Notification.prototype;
    } catch {
        return false;
    }
}

/** The web app's notification for one conversation: tagged by it, so the
 *  browser replaces rather than adds; `renotify` only when it should pop. A
 *  quiet update with no notification left (the user closed it) shows
 *  nothing: a browser cannot add one without popping it. Where the browser
 *  has no `renotify` (browserRenotifies), a quiet update leaves the one there
 *  as it is (its count catches up at the next pop) and a pop closes it first,
 *  so it pops whatever that browser does with a replacement. Says whether one
 *  is there now, so a message that shows nothing is not also kept quiet. */
function showWebNotification(key: string, step: Pick<GroupStep, 'pop' | 'title' | 'body'>): boolean {
    const prev = webLive.get(key);
    if (!step.pop && !prev) return false;
    const renotifies = browserRenotifies();
    if (!step.pop && !renotifies) return true;
    if (step.pop && prev && !renotifies) {
        webLive.delete(key);
        try { prev.close(); } catch { /* already gone */ }
    }
    try {
        // `renotify` is in the spec and in Chromium, not in TypeScript's DOM types.
        const options: NotificationOptions & { renotify?: boolean } = {
            body: step.body,
            tag: key,
            silent: true, // the app plays its own sound; two is jarring
            ...(renotifies ? { renotify: step.pop } : {}),
        };
        const n = new Notification(step.title, options);
        webLive.set(key, n);
        n.onclick = () => {
            void focusApp();
            activateConversation(key);
            n.close();
        };
        n.onclose = () => { if (webLive.get(key) === n) webLive.delete(key); };
        // The browser could not show it: there is nothing to update, so the
        // next quiet message is not quiet either.
        n.onerror = () => { if (webLive.get(key) === n) webLive.delete(key); };
        return true;
    } catch {
        // As below: construction can fail with permission granted.
        return false;
    }
}

/** For tests: forget every conversation and what the shell answered. */
export function resetConversationNotificationsForTests(): void {
    groups.clear();
    activations.clear();
    webLive.clear();
    nativeToasts = 'unknown';
    nativeQueue = Promise.resolve();
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
 *    frame carries no mention marker; with grouping on, a mention the OPEN
 *    channel decrypts still pops, through its own report).
 *  - `outcome: 'fired'` but nothing in the shade → the failure is below this
 *    layer: the native plugin or the OS.
 *  - `outcome: 'updated'` → grouped into a conversation whose notification
 *    already popped in this burst: it changed in place, deliberately without
 *    popping up. `live.groups` says how many each conversation holds and
 *    `live.nativeToasts` what the desktop app's own toasts last answered
 *    ('off': Windows has Púca's notifications turned off, so nothing shows;
 *    'failed': Windows refused the last one; 'no': a shell without them, so
 *    the plugin's toasts, one per burst).
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
            groupNotifications: groupingOn(),
            nativeToasts,
            // Keys (ids only) and counts. Never the names the toast shows.
            groups: groups.keys().map(key => ({ key, count: groups.get(key)?.count ?? 0 })),
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
 * Whether a due item will raise a notification on DESKTOP, for Púca Notes'
 * Reminders banner when Notes runs inside the desktop app. Púca's own setting
 * is the whole answer. NOT `Notification.permission`: inside the Tauri
 * webview that is the notification plugin's stand-in, which reads "denied"
 * until something first asks — so the banner said notifications were blocked
 * "for this site in the browser" on a desktop that shows them. The OS side is
 * granted on desktop: Windows has no prompt, only a per-app switch in
 * Settings, which toasts.rs reads before every toast it shows.
 */
export function desktopNotificationState(): 'granted' | 'default' {
    return loadSettings().desktopNotifications ? 'granted' : 'default';
}

/**
 * Turn desktop notifications on the way Settings' toggle does: ask the OS
 * through the Tauri plugin (never the webview) and store the answer in the
 * same setting. Resolves with the new desktopNotificationState().
 */
export async function enableDesktopNotifications(): Promise<'granted' | 'default'> {
    let granted = true;
    try {
        const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
        granted = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
    } catch {
        // Plugin unavailable: still switch it on, as Settings does, rather
        // than refuse in silence.
    }
    saveSettings({ ...loadSettings(), desktopNotifications: granted });
    return desktopNotificationState();
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
    /** The conversation this message belongs to (api/notifyGroups.ts). With
     *  it, and the setting on, this updates that conversation's one
     *  notification instead of raising one of its own, in the desktop and web
     *  apps (Android and an embedding host keep `notifyKey`, which already
     *  replaces there). `title` is then what Android and the host show. */
    group?: GroupMessage;
    /** This report exists only to tell its conversation's notification
     *  something (an open channel's mention); anywhere notifications are not
     *  grouped it shows nothing, because another report of the same message
     *  already did everything there. */
    onlyIfGrouped?: boolean;
}): NotifyDecision {
    const mobileNative = isMobile() && mobileAppAvailable();
    const settings = loadSettings();
    // An embedding host (embedHost.ts) shows them itself: Púca for Steam
    // Deck as Steam toasts. Like the desktop app's, its path has no browser
    // permission to ask, and only it can say whether the app is on screen —
    // a hidden Steam browser view reports focus all the time.
    const host = hostShowsNotifications();
    const inputs: NotifyInput = {
        isOwn: opts.isOwn,
        isMuted: opts.isMuted,
        // Read at fire time — never from a cached flag. Platform-aware: on
        // mobile this is visibilityState, because document.hasFocus() stays
        // TRUE in a backgrounded Android WebView and silently suppressed every
        // message notification. See appIsForeground.
        hasFocus: (host ? hostSaysForeground() : null) ?? appIsForeground(),
        // On desktop the WEBVIEW's permission is irrelevant — the notification
        // goes through the OS via Tauri, which asks for its own permission.
        // Leaving the webview check in place would gate the native path behind
        // a 'default'/'denied' that means nothing there, and silently suppress
        // every notification on the platform this feature exists for.
        // Android's native path likewise manages POST_NOTIFICATIONS itself
        // (unposted notifications are dropped by the OS, not errored).
        permission: isTauri() || mobileNative || host ? 'granted' : notificationPermission(),
        setting: isMobile() ? settings.mobileNotifications : settings.desktopNotifications,
        mobile: isMobile(),
        mobileNative,
    };
    const decision = shouldNotify(inputs);
    // Grouped only where this module draws the notification itself: Android's
    // plugin and an embedding host already replace by notifyKey, and are left
    // exactly as they were.
    const group = decision.fire && !host && !(inputs.mobile && inputs.mobileNative) && opts.group && groupingOn()
        ? opts.group : null;
    // A report that exists only for a grouped notification, where there is
    // none: the message's other report did everything, and was recorded.
    if (opts.onlyIfGrouped && !group) return decision.fire ? { fire: true, quiet: true } : decision;
    const step = group ? groups.record(group) : null;
    recordNotify({
        at: new Date().toISOString(),
        kind: 'message',
        key: group?.key ?? opts.notifyKey ?? '(no key)',
        outcome: !decision.fire ? decision.reason
            : !group ? 'fired'
                : !step ? 'duplicate'
                    : step.pop ? 'fired' : 'updated',
        inputs,
    });
    // Taskbar/tray unread badge: judged from the RAW inputs (never the
    // decision's short-circuited reason), wider than the toast — a message
    // that only failed the toast gates (setting off / no OS permission) is
    // still unseen. Cleared by Chat's window-focus listener.
    if (isBadgeWorthy(inputs)) setUnreadBadge(true);
    if (!decision.fire) return decision;

    if (host) {
        notifyHost({ title: opts.title, body: 'New message', key: opts.notifyKey ?? opts.title, kind: 'message' }, opts.onActivate);
        return decision;
    }

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

    // ONE PER CONVERSATION (see the header). A message counted already (the
    // open channel and the cross-channel frame both report it) shows nothing
    // more, and neither does an update: both are quiet to the caller too.
    if (group) {
        if (!step) return { fire: true, quiet: true };
        const nav = opts.nav;
        // Re-inserted, so the Map's order is least recently notified first,
        // and bounded like the counts (a click on a forgotten one still opens
        // the place its key names).
        activations.delete(group.key);
        activations.set(group.key, opts.onActivate ?? (nav ? () => requestNavigation(nav) : () => {
            const fromKey = navForGroupKey(group.key);
            if (fromKey) requestNavigation(fromKey);
        }));
        while (activations.size > 200) {
            const oldest = activations.keys().next().value;
            if (oldest === undefined) break;
            activations.delete(oldest);
        }
        if (isTauri()) {
            // Quiet here is still on screen: Windows updates the toast where it
            // is, or puts it back in the notification centre (toasts.rs).
            // Not quiet where the last answer said nothing shows: the shell
            // has no toasts of its own (a build for anything but Windows),
            // Windows has Púca's notifications turned off, or refused the
            // last one. There a quiet message shows nothing, so it must not
            // take the app's sound away too. Read before this message's own
            // answer: the burst's pop has answered by now.
            const quiet = !step.pop && nativeToastsShowing();
            void showNativeToast(group.key, step);
            return quiet ? { fire: true, quiet: true } : decision;
        }
        // The web: a quiet message with nothing left to update (the user
        // closed it) shows nothing, so it is not quiet to the caller either,
        // and the app's own sound still says it arrived.
        const shown = showWebNotification(group.key, step);
        return step.pop || !shown ? decision : { fire: true, quiet: true };
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
        void pluginNotify(opts.title, 'New message');
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
 * Clicking it raises the app and opens the Tasks view on its Reminders tab —
 * the grouped list of what is due — via the `sovereign:open-reminders` event
 * Chat listens for: in the web app from the Notification's click, in the
 * desktop app from its toast's (toasts.rs, `toast-activated` with
 * TASKS_DUE_KEY), and from a toast left from before a reload through the
 * 'reminders' navigation target. The event carries the due ids, and Púca
 * Notes opens that one item's note when exactly one is due
 * (notes/native/useNativeReminders, which also carries the merge note about
 * this event's name). Drop the detail and that tap quietly stops working.
 *
 * There is no in-app sound for a reminder, so the OS's sound is its only
 * audible cue: the web Notification is not `silent`, and the desktop toast
 * asks for Windows' default sound (the plugin's toasts were silent: notify-rust
 * hands tauri-winrt-notification no sound, written as `<audio silent="true"/>`).
 */
export function notifyTasksDue(count: number, due: DueReminder[] = []): void {
    if (count <= 0) return;
    const mobileNative = isMobile() && mobileAppAvailable();
    const settings = loadSettings();
    const setting = isMobile() ? settings.mobileNotifications : settings.desktopNotifications;
    // Logged on the same buffer as messages, and that comparison is the point:
    // a task entry beside NO message entries proves the two paths diverge
    // before this module, not inside it.
    const record = (outcome: string) => recordNotify({ at: new Date().toISOString(), kind: 'task', key: 'tasks-due', outcome });
    if (isMobile() && !mobileNative) { record('mobile'); return; }
    if (!setting) { record('setting-off'); return; }

    const body = count === 1 ? 'A task is due' : `${count} tasks are due`;

    // Chat.tsx reads the ids to flash the item; Púca Notes opens its note (above).
    const openReminders = () => {
        try { window.dispatchEvent(new CustomEvent('sovereign:open-reminders', { detail: { ids: due.map(d => d.id) } })); } catch { /* non-DOM env */ }
    };

    if (hostShowsNotifications()) {
        record('fired');
        notifyHost({ title: 'Púca Tasks', body, key: TASKS_DUE_KEY, kind: 'tasks' }, openReminders);
        return;
    }

    if (isMobile() && mobileNative) {
        void (async () => {
            // Púca Notes on this phone AND able to deliver THESE (its own
            // answer: same account on the same server, keeping up,
            // notifications on, alarm set, every one of `due` armed under
            // the same mark): it owns them, so Púca stays quiet and one due
            // item is one notification. Anything else — no, not installed, an
            // older Notes or an older Púca APK that cannot ask, an item Notes
            // has not fetched yet — Púca notifies. ONE diagnostics entry,
            // written once the gate has answered, so the buffer never says
            // 'fired' for something that was not posted.
            const uid = currentUserIdFromToken();
            const account = uid === null ? null : String(uid);
            if (await notesOwnsDueReminders({ account, server: API_BASE_URL, due }) === true) {
                record('notes-app-owns');
                return;
            }
            record('fired');
            // 'reminders' = the Tasks view's Reminders tab. Java passes nav
            // through as an opaque string, so an older APK needs no change.
            await postMobileNotification(TASKS_DUE_KEY, 'Púca Tasks', body, 'reminders');
        })();
        return;
    }
    record('fired');

    if (isTauri()) {
        // The desktop app's own toast (toasts.rs), whatever the message
        // grouping setting says: one reminder entry that each new one
        // replaces, with Windows' default sound, and a click that opens
        // Reminders (activateConversation). The newest due ids win.
        activations.delete(TASKS_DUE_KEY);
        activations.set(TASKS_DUE_KEY, openReminders);
        void (async () => {
            const asked = await askNativeToast({ key: TASKS_DUE_KEY, title: 'Púca Tasks', body, popup: true, sound: true });
            // A shell without them (not Windows): the plugin's, which can
            // neither sound nor be clicked through.
            if (!asked) await pluginNotify('Púca Tasks', body);
        })();
        return;
    }

    if (notificationPermission() !== 'granted') return;
    try {
        // No `silent`: there is no in-app sound for reminders, so the OS
        // default chime is the only audible cue.
        const n = new Notification('Púca Tasks', { body, tag: TASKS_DUE_KEY });
        n.onclick = () => {
            void focusApp();
            openReminders();
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
    if (notifyHost({ title: 'Púca', body: 'Test notification — this is what a new message looks like.', key: 'test', kind: 'test' })) {
        return { ok: true };
    }
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
    // The desktop app's own toast, as a grouped message uses (toasts.rs):
    // a second press replaces the first rather than adding one, and it says
    // what Windows did with it, so a test that showed nothing says so.
    if (groupingOn()) {
        const asked = await askNativeToast({
            key: 'test', title: 'Púca', body: 'Test notification — this is what a new message looks like.', popup: true, sound: false,
        });
        if (asked) {
            if (nativeToasts === 'off') return { ok: false, reason: 'Windows has notifications for Púca turned off' };
            if (nativeToasts === 'failed') return { ok: false, reason: 'Windows refused to show it' };
            return { ok: true };
        }
        // A shell without them: the plugin below, as before.
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
