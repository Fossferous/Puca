/**
 * Clipboard sharing between a controller and the device it is driving.
 *
 * Rides the EXISTING sealed control channel as another event kind, so it needs
 * no new crypto, no new relay, and no new authorization: it is covered by the
 * same session key, the same monotonic sequence, and the same "only the two
 * pinned sockets" routing as input.
 *
 * DELIBERATELY NOT AUTOMATIC. Auto-sync-on-change is the obvious design and it
 * is a data-exfiltration footgun: password managers put secrets on the
 * clipboard, so a session that silently mirrors every change would stream them
 * to the other machine — and, on a compromised host, to whoever is there. So:
 * explicit user action, text only, size-capped, and off unless the user asks.
 */
import { isTauri, isAndroidApp } from '../platform';
import { readMobileClipboard } from '../mobileApp';

/**
 * The relay caps every sealed control frame at 8 KiB (src/ws.rs
 * MAX_CONTROL_EVENT_LEN). The frame is base64(nonce ‖ ciphertext ‖ tag) of the
 * JSON `{s, e:{t,mime,data}}`: 4/3 × (json + 28) ≤ 8192 ⇒ json ≤ 6116, and the
 * envelope around `data` is ~55 bytes. So the budget is ~6060 bytes of
 * JSON-ENCODED text — measured after escaping, because that is what rides
 * the wire (a paste full of quotes or newlines doubles). This cap is what
 * actually fits; the previous 256 KiB let a paste "send" (the UI said
 * "Clipboard sent") and be thrown away by the server as "input too long".
 * A paste bigger than this is almost certainly a file or an image dump anyway.
 */
export const MAX_CLIPBOARD_BYTES = 6000;

/** Bytes the text occupies INSIDE the JSON frame (UTF-8, JSON-escaped, no
 *  surrounding quotes) — the size the relay cap is really about. */
export function clipboardWireBytes(text: string): number {
    return new TextEncoder().encode(JSON.stringify(text)).length - 2;
}

export interface ClipboardEvent {
    t: 'clip';
    mime: 'text/plain';
    data: string;
}

/** Build a clipboard event, or null when the text cannot be sent. */
export function buildClipboardEvent(text: string): ClipboardEvent | null {
    if (!text) return null;
    if (clipboardWireBytes(text) > MAX_CLIPBOARD_BYTES) return null;
    return { t: 'clip', mime: 'text/plain', data: text };
}

/** Is this an inbound clipboard event we should act on? */
export function isClipboardEvent(event: unknown): event is ClipboardEvent {
    if (!event || typeof event !== 'object') return false;
    const e = event as Partial<ClipboardEvent>;
    return e.t === 'clip'
        && e.mime === 'text/plain'
        && typeof e.data === 'string'
        && clipboardWireBytes(e.data) <= MAX_CLIPBOARD_BYTES;
}

/**
 * What a local clipboard read produced. Discriminated on purpose: "this
 * device cannot hand the app its clipboard" and "the read was refused" must
 * read differently to the user — the first is not something they can fix.
 */
export type ClipboardRead =
    | { ok: true; text: string }
    | { ok: false; why: 'unsupported' | 'denied' };

/**
 * Read the local clipboard.
 *
 * `navigator.clipboard.readText()` needs document focus and a permission grant,
 * so it is unreliable for a HOST that is running in the background — which is
 * exactly when a device session wants it. Desktop therefore goes through the
 * native side.
 *
 * ANDROID: the System WebView implements the async-clipboard WRITE but not
 * READ — `readText()` rejects with NotAllowedError because WebView has no
 * clipboard-read permission delegate. Every "could not read this device's
 * clipboard" report from a phone was this. So the phone reads natively through
 * SovereignAppPlugin (APKs from 0.8.91); an older APK is reported as
 * `unsupported`, not `denied`.
 *
 * The browser API is only a fallback for a focused controller in a plain tab.
 */
export async function readLocalClipboardDetailed(): Promise<ClipboardRead> {
    if (isTauri()) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            return { ok: true, text: await invoke<string>('clipboard_read_text') };
        } catch {
            return { ok: false, why: 'denied' };
        }
    }
    // ANDROID, not "mobile": the native reader lives in the Android plugin
    // only. Gating on isMobile() sent iOS here too, where readMobileClipboard
    // answers `unsupported` unconditionally — so iOS was told to "update the
    // app" and could no longer reach the browser path it used before.
    if (isAndroidApp()) {
        const r = await readMobileClipboard();
        if ('text' in r) return { ok: true, text: r.text };
        if ('unsupported' in r) return { ok: false, why: 'unsupported' };
        return { ok: false, why: 'denied' };
    }
    try {
        return { ok: true, text: await navigator.clipboard.readText() };
    } catch {
        // Denied or unfocused — the caller shows why rather than failing mute.
        return { ok: false, why: 'denied' };
    }
}

/** Read the local clipboard; null when it could not be read (see the
 *  detailed variant for WHY — callers that can show a reason should use it). */
export async function readLocalClipboard(): Promise<string | null> {
    const r = await readLocalClipboardDetailed();
    return r.ok ? r.text : null;
}

/** Write text to the local clipboard. Returns whether it landed. */
export async function writeLocalClipboard(text: string): Promise<boolean> {
    if (isTauri()) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('clipboard_write_text', { text });
            return true;
        } catch {
            return false;
        }
    }
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}
