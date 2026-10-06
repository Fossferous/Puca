/**
 * Audio Hub control over My Devices — the wire contract and the pure parts.
 *
 * Audio Hub is the owner's own tray app on a Windows PC (AirPods + Sony XM6
 * hand-over). It serves a loopback-only API on that PC; this feature lets the
 * owner's phone ask THEIR OWN PC, through an ordinary device session, to make
 * one of five calls against it. The session layer (session.ts) carries the
 * request and answer as sealed signals:
 *
 *   controller -> host  { kind: 'audio-hub', op, rid }
 *   host -> controller  { kind: 'audio-hub-result', rid, op, running, status?, body?, error?, unsupported? }
 *
 * Sealed under the session key like every other signal, bound to the session
 * and strictly ordered (openSignal), so the relay can neither read, forge,
 * splice nor replay one. The HOST is the gate: it answers only a same-account
 * controller (never a friend's share), only after the unattended passphrase
 * on an armed machine, and only for an op in AUDIO_HUB_OPS — which the Tauri
 * side checks AGAIN by deserialising into a five-variant enum
 * (src-tauri/src/audio_hub.rs). There is no path, host, port, method or
 * header in the request for anyone to choose.
 *
 * Compatibility: a host from before this feature drops the unknown kind (every
 * signal handler is an `if (data.kind === …)` chain), so the controller's
 * deadline is what says "update that PC". A controller from before it never
 * sends one, so nothing changes for it.
 */

/** The allow-list. Kebab-case, the same spelling `AudioHubOp` deserialises
 *  in audio_hub.rs (pinned on both sides). */
export const AUDIO_HUB_OPS = ['status', 'airpods-phone', 'airpods-pc', 'xm6-phone', 'xm6-pc'] as const;
export type AudioHubOp = typeof AUDIO_HUB_OPS[number];

export function isAudioHubOp(v: unknown): v is AudioHubOp {
    return typeof v === 'string' && (AUDIO_HUB_OPS as readonly string[]).includes(v);
}

/** The hand-over ops that leave a headset free for the PHONE to connect. */
export function isToPhone(op: AudioHubOp): boolean {
    return op === 'airpods-phone' || op === 'xm6-phone';
}

/** A request id: correlates an answer with its question on the controller.
 *  Opaque, short, and from a fixed alphabet so it is never more than a key. */
const RID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isAudioHubRid(v: unknown): v is string {
    return typeof v === 'string' && RID_RE.test(v);
}

export function newAudioHubRid(): string {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/** How long the controller waits. The host ACKNOWLEDGES a request it will
 *  serve before making any call, so silence past the short deadline means the
 *  host never understood it — in practice a Púca from before this feature.
 *  The host's own calls are bounded (1.5 s connect + 8 s read, twice for a
 *  status), so a live host always answers inside the long one. Both pause
 *  while the person here is typing an unattended passphrase (session.ts). */
export const AUDIO_HUB_ACK_TIMEOUT_MS = 8_000;
export const AUDIO_HUB_RESULT_TIMEOUT_MS = 30_000;

/* The panel's clocks (DeviceAudioHubPanel.tsx). Here rather than in the
   component because a .tsx file may export only components. */

/**
 * After a hand-over, when to read the status again (ms after Audio Hub's
 * answer). A 200 means Audio Hub QUEUED the hand-over, not that it finished —
 * its worker and FlooCast run it in the background, and a reconnect can take
 * well over a few seconds. So the panel looks a few times, stops as soon as
 * the headset is where it was sent, and polls nothing once settled.
 */
export const AUDIO_HUB_REREAD_MS = [2_500, 6_000, 12_000] as const;

/** A panel left open is not a reason to keep a session to the PC (and the
 *  PC's tray saying so) alive for hours: after this long with nothing pressed,
 *  the session this panel opened is ended. A borrowed one is left alone. */
export const AUDIO_HUB_IDLE_CLOSE_MS = 5 * 60_000;

/** The Tauri command's answer (`AudioHubReply` in audio_hub.rs). */
export interface AudioHubShellReply {
    running: boolean;
    status?: number;
    body?: unknown;
    error?: string;
}

/** Bound on the passed-through JSON. Audio Hub's answers are a few hundred
 *  bytes; the shell caps the HTTP response at 16 KiB, and this keeps the sealed
 *  reply small whatever that body holds. */
const MAX_BODY_JSON = 8 * 1024;
const MAX_TEXT = 300;

/** A string from the peer, clipped — or null when it is absent or BLANK.
 *  Audio Hub sends "" for a line it has nothing for yet (the AirPods before
 *  its worker reports, the XM6 with FlooCast not installed), and an empty
 *  string must fall back exactly like a missing one. */
function clip(v: unknown): string | null {
    if (typeof v !== 'string' || v.trim() === '') return null;
    return v.slice(0, MAX_TEXT);
}

/**
 * HOST: shape the signal that answers request `rid`. `reply` is what the
 * Tauri command returned, or `null` when this host cannot reach Audio Hub at
 * all (not the desktop app, or a desktop build without the command).
 */
export function buildAudioHubResult(
    rid: string,
    op: AudioHubOp,
    reply: AudioHubShellReply | null,
): Record<string, unknown> {
    if (!reply) {
        return { kind: 'audio-hub-result', rid, op, running: false, unsupported: true };
    }
    const out: Record<string, unknown> = { kind: 'audio-hub-result', rid, op, running: reply.running === true };
    if (typeof reply.status === 'number' && Number.isInteger(reply.status)) out.status = reply.status;
    if (reply.body !== undefined && reply.body !== null && typeof reply.body === 'object' && !Array.isArray(reply.body)) {
        const json = JSON.stringify(reply.body);
        if (json.length <= MAX_BODY_JSON) out.body = reply.body;
        else out.error = "Audio Hub's answer was too large";
    }
    const err = clip(reply.error);
    if (err && out.error === undefined) out.error = err;
    return out;
}

/** One headset as the panel shows it. */
export interface AudioHubHeadset {
    line: string;
    /** AirPods: linked to the PC. XM6: true/false, or null when unknown. */
    onPc: boolean | null;
}

export interface AudioHubStatus {
    name: string | null;
    airpods: AudioHubHeadset & { handedToPhone: boolean };
    xm6: AudioHubHeadset & { available: boolean };
    devices: string | null;
}

/** What one request came to, for the panel. */
export type AudioHubOutcome =
    /** Nothing is listening for Audio Hub on that PC. */
    | { kind: 'not-running'; message: string }
    /** The PC's Púca cannot do this (a phone host, a build without it, or a
     *  host that never answered — the likeliest cause being an older Púca). */
    | { kind: 'unsupported'; message: string }
    | { kind: 'status'; status: AudioHubStatus }
    /** A hand-over's answer, success or Audio Hub's own refusal. */
    | { kind: 'action'; ok: boolean; message: string | null; error: string | null; httpStatus: number | null }
    /** Audio Hub is running but this request did not produce a usable answer. */
    | { kind: 'error'; message: string };

export const NOT_RUNNING_MESSAGE = "Audio Hub isn't running on that PC.";
export const NEEDS_UPDATE_MESSAGE = "That PC's Púca can't control Audio Hub yet — update Púca on it.";
/** 401 in Púca's words, ALWAYS. Audio Hub's own body says "not paired", which
 *  is written for its home-network phone app and means nothing here: what
 *  failed is the token Púca read from that PC (stale, unreadable, or another
 *  Windows user's AppData). */
export const TOKEN_REFUSED_MESSAGE =
    "Audio Hub didn't accept Púca's access token. Open Audio Hub on that PC again, and check it runs as the same Windows user as Púca.";

/** Audio Hub's refusals in words, when its own JSON gives none. */
function httpWords(status: number): string {
    switch (status) {
        case 401: return TOKEN_REFUSED_MESSAGE;
        case 403: return 'Audio Hub refused the request.';
        case 409: return "Audio Hub can't do that yet.";
        case 503: return "That part of Audio Hub isn't running.";
        default: return `Audio Hub answered with an error (${status}).`;
    }
}

function parseStatus(body: Record<string, unknown>): AudioHubStatus | null {
    const a = body.airpods as Record<string, unknown> | undefined;
    const x = body.xm6 as Record<string, unknown> | undefined;
    if (!a || typeof a !== 'object' || !x || typeof x !== 'object') return null;
    const xOnPc = x.on_pc;
    return {
        name: clip(body.name),
        airpods: {
            line: clip(a.line) ?? 'AirPods',
            onPc: typeof a.on_pc === 'boolean' ? a.on_pc : null,
            handedToPhone: a.handed_to_phone === true,
        },
        xm6: {
            line: clip(x.line) ?? 'XM6',
            onPc: typeof xOnPc === 'boolean' ? xOnPc : null,
            available: x.available === true,
        },
        devices: clip(body.devices),
    };
}

/**
 * CONTROLLER: read the host's `audio-hub-result` into an outcome. Everything
 * here came from the peer and is validated by type, never trusted by shape;
 * strings are clipped and rendered as text, never as markup.
 */
export function parseAudioHubResult(op: AudioHubOp, data: Record<string, unknown>): AudioHubOutcome {
    if (data.unsupported === true) return { kind: 'unsupported', message: NEEDS_UPDATE_MESSAGE };
    const error = clip(data.error);
    if (data.running !== true) {
        return { kind: 'not-running', message: NOT_RUNNING_MESSAGE };
    }
    const status = typeof data.status === 'number' && Number.isInteger(data.status) ? data.status : null;
    const body = data.body && typeof data.body === 'object' && !Array.isArray(data.body)
        ? data.body as Record<string, unknown> : null;

    if (op === 'status') {
        if (status === 200 && body) {
            const parsed = parseStatus(body);
            if (parsed) return { kind: 'status', status: parsed };
            return { kind: 'error', message: 'Audio Hub sent a status Púca could not read.' };
        }
        const said = body && status !== 401 ? clip(body.error) : null;
        if (status !== null) return { kind: 'error', message: said ?? httpWords(status) };
        return { kind: 'error', message: error ?? 'Audio Hub did not give a status.' };
    }

    // A hand-over.
    if (status === null || !body) {
        return { kind: 'error', message: error ?? 'Audio Hub did not answer the request.' };
    }
    const ok = status === 200 && body.ok === true;
    return {
        kind: 'action',
        ok,
        message: ok ? clip(body.message) : null,
        error: ok ? null : ((status !== 401 ? clip(body.error) : null) ?? httpWords(status)),
        httpStatus: status,
    };
}

/**
 * HOST: make the call through the desktop shell. `null` when this host has no
 * such command — a phone, a browser, or a desktop build from before it — so
 * the controller is told the PC cannot do it rather than left to time out.
 */
export async function callAudioHubShell(op: AudioHubOp): Promise<AudioHubShellReply | null> {
    let invoke: typeof import('@tauri-apps/api/core').invoke;
    try {
        ({ invoke } = await import('@tauri-apps/api/core'));
    } catch {
        return null;
    }
    try {
        const reply = await invoke<AudioHubShellReply>('audio_hub_request', { op });
        if (!reply || typeof reply !== 'object' || typeof reply.running !== 'boolean') return null;
        return reply;
    } catch (e) {
        // Not running inside Tauri, or an app with no such command: both are
        // "cannot", not "Audio Hub is off".
        console.warn('[audio-hub] shell call failed', e instanceof Error ? e.message : String(e));
        return null;
    }
}
