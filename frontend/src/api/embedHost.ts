/**
 * Embedding hosts (docs/EMBEDDING.md): programs that run Púca's web client
 * somewhere that is not an ordinary browser tab and drive it from controls of
 * their own. The first is Púca for Steam Deck (integrations/decky), a Decky
 * Loader plugin that keeps the web client in a hidden Steam browser view and
 * puts the call in the Quick Access menu.
 *
 * OPT-IN BY THE HOST. It defines `window.__PUCA_EMBED_HOST__` before the
 * app's scripts run (a DevTools "evaluate on new document", a webview
 * preload). Without that object nothing changes: embedHost() answers null,
 * every helper here does exactly what the browser would have done, and the
 * control API (embedApi.ts) is never installed. The declaration is read once,
 * on first use, and its functions are copied out, so a script that runs later
 * can neither opt the page in nor swap a host function.
 *
 * This file holds what the rest of the app asks of a host: the microphone, a
 * screen share's picture, notifications and presence. Steam's browser refuses getUserMedia to every
 * site that is not Steam's own (measured on a Deck, 2026-10-22:
 * NotAllowedError in a browser view, in an iframe, and with a DevTools
 * permission grant), so the plugin opens the microphone in Steam's own
 * context and hands the page the track. There is no notification prompt to
 * answer there, so notifications go to the host, which shows them as Steam
 * toasts. And the page never sees the person play (their input goes to the
 * game and the Deck's controls), so the host says how long they have been
 * away, or Púca's AFK move would take a player out of the call mid-game.
 */

export const EMBED_API_VERSION = 1;

export interface EmbedNotification {
    /** Hand back to pucaEmbed.activateNotification when the person taps it. */
    id: string;
    title: string;
    /** Content-free, as every notification here is (desktopNotify.ts). */
    body: string;
    /** Collapses repeats from one conversation: 'dm:<id>', 'chan:<serverId>', 'tasks-due', 'test', 'clip:<id>'. */
    key: string;
    kind: 'message' | 'tasks' | 'test' | 'clip';
}

/** The host's declaration, as read: every function bound to the object it came from. */
export interface EmbedHost {
    apiVersion: number;
    /** Shown where the app names the host (Settings, log lines). */
    name: string;
    /** Supplies the microphone: called instead of navigator.mediaDevices.getUserMedia for audio. */
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    /** Supplies a screen share's video: called instead of navigator.mediaDevices.getDisplayMedia. */
    getDisplayMedia?: (options: DisplayMediaStreamOptions) => Promise<MediaStream>;
    notify?: (n: EmbedNotification) => void;
    /** Receives the state snapshot (embedApi.ts) whenever it changes. */
    onStateChange?: (state: unknown) => void;
    /** Is the app on screen? Decides whether a notification is due. */
    isForeground?: () => boolean;
    /** Seconds since the person last used the device, as the host sees it:
     *  input the page itself never receives (Púca for Steam Deck reads the
     *  Deck's own controls). Null when the host cannot tell right now. The
     *  AFK move uses it as the desktop app uses the system's idle time. */
    idleSeconds?: () => number | null | Promise<number | null>;
}

let resolved: EmbedHost | null | undefined;

/** The embedding host, or null in a browser tab and both native shells. */
export function embedHost(): EmbedHost | null {
    if (resolved === undefined) resolved = readDeclaration();
    return resolved;
}

function readDeclaration(): EmbedHost | null {
    if (typeof window === 'undefined') return null;
    let d: unknown;
    try {
        d = (window as unknown as { __PUCA_EMBED_HOST__?: unknown }).__PUCA_EMBED_HOST__;
    } catch {
        return null;
    }
    if (!d || typeof d !== 'object') return null;
    const o = d as Record<string, unknown>;
    if (o.apiVersion !== EMBED_API_VERSION) {
        // A host written for another version would misread everything it is
        // sent: run as a plain web client rather than half-embedded.
        console.warn(`[embed] the host declares API version ${String(o.apiVersion)}; this Púca speaks ${EMBED_API_VERSION}, so it is not embedding`);
        return null;
    }
    const bound = <T>(v: unknown): T | undefined =>
        (typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(o) as T : undefined);
    const host: EmbedHost = Object.freeze({
        apiVersion: EMBED_API_VERSION,
        name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : 'an embedding host',
        getUserMedia: bound<EmbedHost['getUserMedia']>(o.getUserMedia),
        getDisplayMedia: bound<EmbedHost['getDisplayMedia']>(o.getDisplayMedia),
        notify: bound<EmbedHost['notify']>(o.notify),
        onStateChange: bound<EmbedHost['onStateChange']>(o.onStateChange),
        isForeground: bound<EmbedHost['isForeground']>(o.isForeground),
        idleSeconds: bound<EmbedHost['idleSeconds']>(o.idleSeconds),
    });
    console.log(`[embed] running inside ${host.name}`);
    return host;
}

/** Tests only: read the declaration again on next use. */
export function resetEmbedHostForTest(): void {
    resolved = undefined;
    activations.clear();
}

// ---- The microphone --------------------------------------------------------

/** The host's name when it supplies the microphone (Settings shows it in
 *  place of the device list, which the host does not follow), else null. */
export function hostMicrophone(): string | null {
    const h = embedHost();
    return h?.getUserMedia ? h.name : null;
}

/**
 * navigator.mediaDevices.getUserMedia for every capture that includes the
 * microphone. With a host that supplies it, the AUDIO comes from the host (a
 * camera asked for in the same call still comes from the browser); anywhere
 * else this is the browser's own call, unchanged.
 *
 * The host is handed the app's audio constraints as they are. It decides what
 * it can honour: Púca for Steam Deck applies echo cancellation, noise
 * suppression and gain control, and opens the system's default input
 * whatever deviceId was asked for. A host's refusal should be a DOMException
 * with the browser's names (NotAllowedError, NotFoundError,
 * NotReadableError...), because media.ts decides between the permission help
 * and joining listen-only by the name. A host that answers with no audio
 * track at all is reported as NotReadableError: no usable microphone.
 */
export async function getUserMediaForMic(constraints: MediaStreamConstraints): Promise<MediaStream> {
    const host = embedHost();
    if (!host?.getUserMedia || !constraints.audio) return navigator.mediaDevices.getUserMedia(constraints);
    const stream = await host.getUserMedia({ audio: constraints.audio, video: false });
    if (!stream || typeof stream.getAudioTracks !== 'function' || stream.getAudioTracks().length === 0) {
        try { stream?.getTracks?.().forEach(t => t.stop()); } catch { /* nothing to stop */ }
        throw new DOMException(`${host.name} supplied no microphone`, 'NotReadableError');
    }
    if (!constraints.video) return stream;
    try {
        const camera = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints.video });
        camera.getVideoTracks().forEach(t => stream.addTrack(t));
        return stream;
    } catch (err) {
        stream.getTracks().forEach(t => t.stop());
        throw err;
    }
}

// ---- Screen sharing --------------------------------------------------------

/**
 * Whether a screen share can start here. Everywhere but inside a host this is
 * whatever the platform could always do; a host shares only if it supplies the
 * picture itself (Steam's browser refuses capture to every site that is not
 * Steam's own, so its Share button could only ever fail).
 */
export function screenShareAvailable(): boolean {
    const h = embedHost();
    return !h || !!h.getDisplayMedia;
}

/** The host's name when it supplies a share's picture, else null. */
export function hostScreenShare(): string | null {
    const h = embedHost();
    return h?.getDisplayMedia ? h.name : null;
}

/**
 * navigator.mediaDevices.getDisplayMedia for a screen share. With a host that
 * supplies it, the picture comes from the host (Púca for Steam Deck: the
 * Deck's own screen, encoded by its hardware); anywhere else this is the
 * browser's own call, unchanged. A host is handed the app's options as they
 * are and decides what it can honour. It should refuse with the browser's
 * names (NotAllowedError when the person did not ask for the share). One that
 * answers with no video track is reported as NotReadableError.
 */
export async function getDisplayMediaForShare(options: DisplayMediaStreamOptions): Promise<MediaStream> {
    const host = embedHost();
    if (!host) return navigator.mediaDevices.getDisplayMedia(options);
    if (!host.getDisplayMedia) throw new DOMException(`${host.name} cannot share a screen`, 'NotSupportedError');
    const stream = await host.getDisplayMedia(options);
    if (!stream || typeof stream.getVideoTracks !== 'function' || stream.getVideoTracks().length === 0) {
        try { stream?.getTracks?.().forEach(t => t.stop()); } catch { /* nothing to stop */ }
        throw new DOMException(`${host.name} supplied no picture`, 'NotReadableError');
    }
    return stream;
}

// ---- Notifications ---------------------------------------------------------

const MAX_ACTIVATIONS = 20;
/** What a tap on a notification does, by the id the host was given. Bounded:
 *  a notification nobody tapped must not keep its closure forever. */
const activations = new Map<string, () => void>();
let notificationSeq = 0;

/** Whether notifications go to the host. desktopNotify.ts asks, so the
 *  browser's permission (there is no prompt to answer) never gates them. */
export function hostShowsNotifications(): boolean {
    return !!embedHost()?.notify;
}

/** Is the app on screen, by the host's answer? Null without a host that
 *  says. A hidden Steam browser view reports document.hasFocus() true, which
 *  would hold back every notification as "already looking at it". */
export function hostSaysForeground(): boolean | null {
    const h = embedHost();
    if (!h?.isForeground) return null;
    try {
        return h.isForeground() === true;
    } catch {
        return null;
    }
}

// ---- Presence --------------------------------------------------------------

/** Whether the host can tell how long the person has been away from the
 *  device. The AFK check (VoicePanel) asks it where the desktop app asks the
 *  operating system. */
export function hostReportsIdle(): boolean {
    return !!embedHost()?.idleSeconds;
}

/**
 * Seconds since the person last used the device, by the host's answer, or null
 * when there is no host that says or it cannot tell right now. Throws when the
 * host's function throws or answers something that is not a number of seconds:
 * the AFK check treats that as a failed probe and waits a whole window again,
 * because moving someone who is there is the worse mistake.
 */
export async function hostIdleSeconds(): Promise<number | null> {
    const h = embedHost();
    if (!h?.idleSeconds) return null;
    const v = await h.idleSeconds();
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new TypeError(`${h.name} answered idleSeconds with ${String(v)}`);
    }
    return v;
}

/** Hand a notification to the host. False when there is no host that shows
 *  them (the caller falls back to its own path). */
export function notifyHost(n: Omit<EmbedNotification, 'id'>, onActivate?: () => void): boolean {
    const host = embedHost();
    if (!host?.notify) return false;
    const id = `n${++notificationSeq}`;
    if (onActivate) {
        activations.set(id, onActivate);
        while (activations.size > MAX_ACTIVATIONS) {
            const oldest = activations.keys().next().value;
            if (oldest === undefined) break;
            activations.delete(oldest);
        }
    }
    try {
        host.notify({ ...n, id });
    } catch (err) {
        // The host's failure must never break message handling.
        console.warn('[embed] the host could not show a notification:', err);
    }
    return true;
}

/** The person tapped notification `id` in the host: do what a click on the
 *  browser's notification would have done. Once only. */
export function activateHostNotification(id: string): boolean {
    const fn = activations.get(id);
    if (!fn) return false;
    activations.delete(id);
    try {
        fn();
    } catch (err) {
        console.warn('[embed] opening a notification failed:', err);
    }
    return true;
}
