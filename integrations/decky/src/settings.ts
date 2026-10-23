/**
 * The plugin's own settings, kept by the backend in
 * ~/homebrew/settings/<plugin>/settings.json. Everything about the account and
 * the call lives in Púca itself; these are only what the Deck adds.
 */

export type PushToTalkButton = 'off' | 'L4' | 'R4' | 'L5' | 'R5';
/** A back grip, or 'off'. */
export type ButtonChoice = PushToTalkButton;

/** What a back grip can do. Each grip does at most one; when two settings
 *  claim one, the earlier job here keeps it. */
export type ButtonJob = 'pushToTalk' | 'muteButton' | 'deafenButton';
export const BUTTON_JOBS: readonly ButtonJob[] = ['pushToTalk', 'muteButton', 'deafenButton'];

export interface PluginSettings {
    /** The Púca web client's address, '' until someone sets it. */
    appUrl: string;
    /** The back button that talks while held; 'off' leaves Púca's own input mode alone. */
    pushToTalk: ButtonChoice;
    /** The back button that mutes and unmutes in a call. */
    muteButton: ButtonChoice;
    /** The back button that deafens and undeafens in a call. */
    deafenButton: ButtonChoice;
    /** Switch the Deck's own microphone on for a call when it is muted, and
     *  back after (py_modules/puca_mic.py). */
    micForCalls: boolean;
    /** Show Púca's notifications as Steam toasts. */
    notifications: boolean;
    /** Play Steam's notification sound with them. */
    notificationSound: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    appUrl: '',
    pushToTalk: 'off',
    muteButton: 'off',
    deafenButton: 'off',
    micForCalls: true,
    notifications: true,
    notificationSound: true,
};

export const PUSH_TO_TALK_BUTTONS: readonly PushToTalkButton[] = ['off', 'L4', 'R4', 'L5', 'R5'];

/** The job a back grip has in these settings, if any. */
export function jobOf(settings: PluginSettings, button: unknown): ButtonJob | null {
    if (typeof button !== 'string' || button === 'off') return null;
    return BUTTON_JOBS.find(job => settings[job] === button) ?? null;
}

/** The grips with a job, for the backend to follow during a call. */
export function watchedButtons(settings: PluginSettings): Exclude<ButtonChoice, 'off'>[] {
    return BUTTON_JOBS.map(job => settings[job]).filter((b): b is Exclude<ButtonChoice, 'off'> => b !== 'off');
}

/**
 * Give `job` the grip `button`. A grip has one job, so if another job had it,
 * that one is switched off; the answer says which, so the panel can say so.
 */
export function assignButton(settings: PluginSettings, job: ButtonJob, button: ButtonChoice): { settings: PluginSettings; took: ButtonJob | null } {
    const next = { ...settings, [job]: button };
    let took: ButtonJob | null = null;
    if (button !== 'off') {
        for (const other of BUTTON_JOBS) {
            if (other !== job && next[other] === button) {
                next[other] = 'off';
                took = other;
            }
        }
    }
    return { settings: next, took };
}

/** Settings as stored, with anything missing or malformed back at its default. */
export function readSettings(raw: unknown): PluginSettings {
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const url = typeof o.appUrl === 'string' ? normalizeAppUrl(o.appUrl) : null;
    const grips = {} as Record<ButtonJob, ButtonChoice>;
    const taken = new Set<ButtonChoice>();
    for (const job of BUTTON_JOBS) {
        let grip = PUSH_TO_TALK_BUTTONS.includes(o[job] as ButtonChoice) ? o[job] as ButtonChoice : 'off';
        if (grip !== 'off' && taken.has(grip)) grip = 'off';
        taken.add(grip);
        grips[job] = grip;
    }
    const flag = (k: 'micForCalls' | 'notifications' | 'notificationSound') =>
        typeof o[k] === 'boolean' ? o[k] as boolean : DEFAULT_SETTINGS[k];
    return {
        appUrl: url && url.ok ? url.url : '',
        ...grips,
        micForCalls: flag('micForCalls'),
        notifications: flag('notifications'),
        notificationSound: flag('notificationSound'),
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
