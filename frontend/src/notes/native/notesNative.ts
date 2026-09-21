/**
 * The JS handle on Púca Notes' own Android plugin (NotesNativePlugin.java in
 * frontend/notes-app): due reminders that fire with the app closed, the
 * ~hourly background refresh, notification / exact-alarm / battery status,
 * the share sheet, "add to the phone's calendar", and landing a notification
 * tap on the Reminders view.
 *
 * FEATURE-DETECTED, NEVER THROWS. The browser has no such plugin, and neither
 * does a Púca Notes APK built before it existed; there every call resolves to
 * a harmless "unsupported" answer and callers keep today's behaviour. Nothing
 * here is Púca's: the Púca app never registers "NotesNative", so this module
 * is inert in it too.
 *
 * Content: reminder entries are ids and times (the server already holds both
 * in clear); status calls carry nothing. Only shareText and addToPhoneCalendar
 * move user content, and only when the user asked for that, at that moment.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { decodeJwtPayload } from '../../api/auth';
import type { ReminderEntry } from '../../api/reminderFeed';

export interface NotesNotificationStatus {
    granted: boolean;
    needsRequest: boolean;
    /** Off at the app or Reminders-channel level: only Settings can fix it. */
    blocked: boolean;
}

interface NotesNativePlugin {
    info(): Promise<{ api: number; features: string[] }>;
    syncReminders(opts: { account: string; entries: ReminderEntry[] }): Promise<{ count: number }>;
    clearAll(): Promise<void>;
    setBackgroundRefresh(opts: { apiBase: string | null; token: string | null; account: string | null }): Promise<{ scheduled?: boolean }>;
    takeRenewedToken(): Promise<{ token: string | null; account: string | null }>;
    notificationStatus(): Promise<NotesNotificationStatus>;
    requestNotificationPermission(): Promise<{ granted: boolean }>;
    openNotificationSettings(): Promise<void>;
    exactAlarmStatus(): Promise<{ exact: boolean }>;
    openExactAlarmSettings(): Promise<void>;
    batteryStatus(): Promise<{ ignoring: boolean }>;
    requestIgnoreBatteryOptimizations(): Promise<void>;
    shareText(opts: { filename: string; mime: string; text: string; subject?: string }): Promise<{ ok: boolean; reason?: string }>;
    addToPhoneCalendar(opts: { title: string; beginMs: number; endMs?: number; allDay?: boolean; location?: string }): Promise<{ ok: boolean; reason?: string }>;
    consumeLaunchNav(): Promise<{ target: string | null; item?: number | null }>;
    consumeLaunchShare(): Promise<NativeSharedPayload>;
    requestAddTile(): Promise<{ ok: boolean; reason?: string }>;
    addListener(eventName: 'navigate', listener: (data: { target: string; item?: number | null }) => void): Promise<PluginListenerHandle>;
    addListener(eventName: 'share', listener: () => void): Promise<PluginListenerHandle>;
}

/** One picture another app shared in, already copied out of its content://
 *  URI by the native side. `url` is the app's OWN origin
 *  (https://localhost/_capacitor_file_/…), so fetching it needs no CSP
 *  change — `connect-src 'self'` already covers it. */
export interface NativeSharedFile {
    url: string | null;
    name: string;
    mime: string;
    size: number;
}

/** What another app shared into Notes. Decrypted note content: it is handed
 *  over ONCE and the native side erases its copy (NotesNativePlugin). */
export interface NativeSharedPayload {
    text: string | null;
    subject: string | null;
    files: NativeSharedFile[];
}

const NOTHING_SHARED: NativeSharedPayload = { text: null, subject: null, files: [] };

const Native = registerPlugin<NotesNativePlugin>('NotesNative');

/** Is the plugin in this shell? Synchronous — Capacitor knows at load. */
export function notesNativeAvailable(): boolean {
    try {
        return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NotesNative');
    } catch {
        return false;
    }
}

/** Run a plugin call, or answer `fallback` when there is no plugin or the
 *  call fails (an older APK without that method, a bridge hiccup). */
async function call<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    if (!notesNativeAvailable()) return fallback;
    try {
        return await fn();
    } catch {
        return fallback;
    }
}

export type Outcome = { ok: true } | { ok: false; reason: string };

const UNSUPPORTED: Outcome = { ok: false, reason: 'unsupported' };

export async function notesNativeFeatures(): Promise<string[]> {
    return (await call(() => Native.info(), { api: 0, features: [] as string[] })).features;
}

/** Hand the native alarm engine the current reminder entries for `account`. */
export async function syncNativeReminders(account: string, entries: ReminderEntry[]): Promise<Outcome> {
    return call(async () => { await Native.syncReminders({ account, entries }); return { ok: true } as Outcome; }, UNSUPPORTED);
}

/** Every way out of a session: alarms, markers, token, job, fences, notices. */
export async function clearNativeSession(): Promise<void> {
    await call(() => Native.clearAll(), undefined);
}

/** Give (or, with null, take back) the background refresh its credentials. */
export async function setNativeBackgroundRefresh(
    creds: { apiBase: string; token: string; account: string } | null,
): Promise<void> {
    await call(() => Native.setBackgroundRefresh(creds ?? { apiBase: null, token: null, account: null }), {});
}

export async function nativeNotificationStatus(): Promise<NotesNotificationStatus | null> {
    return call<NotesNotificationStatus | null>(() => Native.notificationStatus(), null);
}

export async function requestNativeNotificationPermission(): Promise<boolean> {
    return (await call(() => Native.requestNotificationPermission(), { granted: false })).granted;
}

export async function openNativeNotificationSettings(): Promise<boolean> {
    return call(async () => { await Native.openNotificationSettings(); return true; }, false);
}

/** null = no plugin. `exact: false` = alarms may arrive minutes late. */
export async function nativeExactAlarmStatus(): Promise<{ exact: boolean } | null> {
    return call<{ exact: boolean } | null>(() => Native.exactAlarmStatus(), null);
}

export async function openNativeExactAlarmSettings(): Promise<boolean> {
    return call(async () => { await Native.openExactAlarmSettings(); return true; }, false);
}

export async function nativeBatteryStatus(): Promise<{ ignoring: boolean } | null> {
    return call<{ ignoring: boolean } | null>(() => Native.batteryStatus(), null);
}

export async function requestNativeBatteryExemption(): Promise<boolean> {
    return call(async () => { await Native.requestIgnoreBatteryOptimizations(); return true; }, false);
}

/** Send text out through Android's share sheet (as a file). */
export async function shareText(opts: { filename: string; mime: string; text: string; subject?: string }): Promise<Outcome> {
    return call(async () => {
        const r = await Native.shareText(opts);
        return r.ok ? { ok: true } as Outcome : { ok: false, reason: r.reason ?? 'could not share' } as Outcome;
    }, UNSUPPORTED);
}

/** Open the phone's calendar app on a pre-filled event (no calendar grant). */
export async function addToPhoneCalendar(opts: { title: string; beginMs: number; endMs?: number; allDay?: boolean; location?: string }): Promise<Outcome> {
    return call(async () => {
        const r = await Native.addToPhoneCalendar(opts);
        return r.ok ? { ok: true } as Outcome : { ok: false, reason: r.reason ?? 'could not open the calendar' } as Outcome;
    }, UNSUPPORTED);
}

/** Where a launch came from: a nav target and, when a due notification
 *  named the ONE item that came due, its id. */
export interface NativeLaunchNav {
    target: string | null;
    /** The single due item's id, or null. Normalised HERE, in one place, so
     *  an older APK (no field at all), a 0 and a -1 are the same thing to
     *  every caller. */
    item: number | null;
}

function normaliseItem(raw: unknown): number | null {
    return typeof raw === 'number' && raw > 0 ? raw : null;
}

/** The nav target a notification, shortcut, tile or widget tap launched the
 *  app with (one-shot). */
export async function consumeNativeLaunchNav(): Promise<NativeLaunchNav> {
    const r = await call(() => Native.consumeLaunchNav(), { target: null } as { target: string | null; item?: number | null });
    return { target: r.target, item: normaliseItem(r.item) };
}

/** A notification (or shortcut, tile, widget) tap while the app runs.
 *  Returns an unsubscribe. */
export function onNativeNavigate(cb: (nav: NativeLaunchNav) => void): () => void {
    if (!notesNativeAvailable()) return () => {};
    let handle: PluginListenerHandle | null = null;
    let gone = false;
    void Native.addListener('navigate', d => cb({ target: d.target, item: normaliseItem(d.item) })).then(h => {
        if (gone) void h.remove();
        else handle = h;
    }).catch(() => { /* older APK */ });
    return () => {
        gone = true;
        if (handle) void handle.remove();
    };
}

// --- share INTO Notes -----------------------------------------------------------

/** What another app shared, once. An older APK has no such method, so `call`
 *  answers the empty payload and the page behaves exactly as it does today. */
export async function consumeNativeLaunchShare(): Promise<NativeSharedPayload> {
    const r = await call(() => Native.consumeLaunchShare(), NOTHING_SHARED);
    return {
        text: typeof r?.text === 'string' && r.text ? r.text : null,
        subject: typeof r?.subject === 'string' && r.subject ? r.subject : null,
        files: Array.isArray(r?.files) ? r.files : [],
    };
}

/** A share that arrived while the app was already up. The event carries NO
 *  content — it is a ping, and the page then asks. */
export function onNativeShare(cb: () => void): () => void {
    if (!notesNativeAvailable()) return () => {};
    let handle: PluginListenerHandle | null = null;
    let gone = false;
    void Native.addListener('share', () => cb()).then(h => {
        if (gone) void h.remove();
        else handle = h;
    }).catch(() => { /* older APK */ });
    return () => {
        gone = true;
        if (handle) void handle.remove();
    };
}

/**
 * Read the shared pictures into Files the composer can hold. The bytes come
 * over the app's own origin rather than base64 across the bridge, which would
 * copy a whole photo through the JSON channel. A file that cannot be read is
 * dropped: the rest of the share still arrives.
 */
export async function fetchSharedFiles(payload: NativeSharedPayload): Promise<File[]> {
    const out: File[] = [];
    for (const f of payload.files) {
        if (!f?.url) continue;
        try {
            const res = await fetch(f.url);
            if (!res.ok) continue;
            const blob = await res.blob();
            out.push(new File([blob], f.name || 'shared', { type: f.mime || blob.type || 'application/octet-stream' }));
        } catch {
            // A copy already pruned, or a bridge hiccup: skip this one.
        }
    }
    return out;
}

/** Ask Android (13+) to offer "add the Púca Notes tile". false = the user
 *  must add it from the shade's own edit screen. */
export async function requestNativeAddTile(): Promise<boolean> {
    return (await call(() => Native.requestAddTile(), { ok: false })).ok === true;
}

function claims(token: string | null): { sub: string | null; exp: number } {
    const p = token ? decodeJwtPayload(token) : null;
    const sub = p && (typeof p.sub === 'number' || typeof p.sub === 'string') ? String(p.sub) : null;
    const exp = p && typeof p.exp === 'number' ? p.exp : -1;
    return { sub, exp };
}

/**
 * Should the page adopt the token the background job holds? Only when it is
 * the SAME account as the page's own token and lives strictly longer — i.e.
 * the server renewed it while the app was closed. Never when the page is
 * signed out (a sign-out must not be undone by a stored copy) and never for
 * another account. Pure; the native side applies the same rule the other
 * way (JwtClaims.newer).
 */
export function pickAdoptableToken(current: string | null, candidate: string | null): string | null {
    if (!current || !candidate || current === candidate) return null;
    const a = claims(current);
    const b = claims(candidate);
    if (!a.sub || a.sub !== b.sub) return null;
    return b.exp > a.exp ? candidate : null;
}

/** Before the first API call of a launch: take over a token the background
 *  job renewed while Notes was closed, so the two copies do not diverge and
 *  an app closed for two days does not open on the sign-in screen. */
export async function adoptNativeRenewedToken(
    getToken: () => string | null,
    store: (sentWith: string, renewed: string) => void,
): Promise<boolean> {
    const r = await call(() => Native.takeRenewedToken(), { token: null, account: null });
    const current = getToken();
    const next = pickAdoptableToken(current, r.token);
    if (!current || !next) return false;
    store(current, next);
    return true;
}
