/**
 * The plugin's own settings, kept by the backend in
 * ~/homebrew/settings/<plugin>/settings.json. Everything about the account and
 * the call lives in Púca itself; these are only what the Deck adds.
 */

export type PushToTalkButton = 'off' | 'L4' | 'R4' | 'L5' | 'R5';

export interface PluginSettings {
    /** The Púca web client's address, '' until someone sets it. */
    appUrl: string;
    /** The back button that talks while held; 'off' leaves Púca's own input mode alone. */
    pushToTalk: PushToTalkButton;
    /** Show Púca's notifications as Steam toasts. */
    notifications: boolean;
    /** Play Steam's notification sound with them. */
    notificationSound: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    appUrl: '',
    pushToTalk: 'off',
    notifications: true,
    notificationSound: true,
};

export const PUSH_TO_TALK_BUTTONS: readonly PushToTalkButton[] = ['off', 'L4', 'R4', 'L5', 'R5'];

/** Settings as stored, with anything missing or malformed back at its default. */
export function readSettings(raw: unknown): PluginSettings {
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const url = typeof o.appUrl === 'string' ? normalizeAppUrl(o.appUrl) : null;
    return {
        appUrl: url && url.ok ? url.url : '',
        pushToTalk: PUSH_TO_TALK_BUTTONS.includes(o.pushToTalk as PushToTalkButton) ? o.pushToTalk as PushToTalkButton : 'off',
        notifications: typeof o.notifications === 'boolean' ? o.notifications : DEFAULT_SETTINGS.notifications,
        notificationSound: typeof o.notificationSound === 'boolean' ? o.notificationSound : DEFAULT_SETTINGS.notificationSound,
    };
}

export type AppUrlResult = { ok: true; url: string; origin: string } | { ok: false; error: string };

/**
 * What someone typed on the on-screen keyboard -> the web client's address.
 * "chat.example.com" is enough: https is assumed, and required, because the
 * web client's encryption only runs in a secure context. The one exception is
 * http on the Deck's own loopback (localhost, 127.0.0.1), which browsers
 * also treat as secure: a server on the Deck itself, or a developer's tunnel.
 * A path is kept for a server that serves the client below the root; a query,
 * a fragment and a user:password are not.
 */
export function normalizeAppUrl(input: string): AppUrlResult {
    const text = input.trim();
    if (!text) return { ok: false, error: 'Type your Púca address, for example chat.example.com' };
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    let u: URL;
    try {
        u = new URL(withScheme);
    } catch {
        return { ok: false, error: "That doesn't look like an address" };
    }
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
        return { ok: false, error: 'The address must start with https://' };
    }
    if (u.username || u.password) return { ok: false, error: 'Leave the name and password out of the address' };
    if (!u.hostname || (!u.hostname.includes('.') && u.hostname !== 'localhost')) {
        return { ok: false, error: "That doesn't look like an address" };
    }
    const path = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
    return { ok: true, url: `${u.origin}${path}`, origin: u.origin };
}
