/**
 * ONE APP WINDOW, shown and controlled on its own (My Devices).
 *
 * The owner's ask (2026-11-20): while controlling a PC, pick one of its open
 * windows and have the stage show and drive just that window, sized to it,
 * with an obvious way back to the whole screen. The host's agent crops its
 * screen to the window and aims input inside it (crates/puca-agent
 * window_pick.rs, which has the why of every choice); docs/REMOTE_CONTROL.md,
 * *One window*, is the people-facing account.
 *
 * This module is the plain-data half both ends share: the wire shapes, the
 * checks every received list goes through (it comes from the peer, sealed but
 * not trusted to be well-formed), the icon chunking that keeps each sealed
 * signal under the server's 64 KB relay cap, the search, and the sentences.
 *
 * Wire (sealed device signals, docs/REMOTE_CONTROL.md):
 *   host -> viewer   { kind: 'features', windows: true }       after the proof
 *   viewer -> host   { kind: 'list-windows', rid }
 *   host -> viewer   { kind: 'windows', rid, windows, front? }
 *                    { kind: 'window-icons', rid, icons }       zero or more
 *                    { kind: 'windows-failed', rid, reason }
 *   viewer -> host   { kind: 'set-window', hwnd, pid } | { kind: 'set-window', hwnd: null }
 *   host -> viewer   { kind: 'window-active', window | null, reason? }
 *                    { kind: 'window-failed', reason }
 *                    { kind: 'window-front', front }
 */

/** One window as the host lists it. `hwnd` + `pid` name it: a handle is
 *  reused by another window once this one closes. */
export interface RemoteWindow {
    hwnd: number;
    pid: number;
    title: string;
    /** The program's name for itself ("Google Chrome"), else its file name. */
    app: string;
    /** Key into the icons that arrive with the list. */
    icon?: string;
    minimized?: boolean;
    /** Runs as administrator: Windows drops input aimed at it, though it can
     *  still be watched (the agent's input_reach.rs). */
    elevated?: boolean;
    /** The host's screen (capture index) holding most of it. */
    monitor?: number;
}

/** The window the host says its picture shows on its own. */
export interface ShownWindow {
    hwnd: number;
    pid: number;
    title: string;
    app: string;
    /** What the picture shows, in the host's physical pixels: the surface the
     *  stage maps the caret over. */
    width: number;
    height: number;
}

/** At most this many windows are taken from one list (the agent sends at
 *  most 64; anything past that is not from it). */
export const MAX_WINDOWS = 64;
const MAX_TITLE = 160;
const MAX_APP = 64;
/** One icon's data URL. A 24 px PNG stored without compression is about
 *  3.3 KB of base64; this leaves room and refuses anything else. */
export const MAX_ICON_URL = 12_000;
/** Bytes of icons per `window-icons` frame. The server refuses a device
 *  signal over 64 KB, and sealing grows the plaintext by a third (base64)
 *  plus the envelope: 36 KB of icons seals to well under 50 KB. */
export const ICON_FRAME_BUDGET = 36_000;

const ICON_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

function str(v: unknown, max: number): string | null {
    if (typeof v !== 'string') return null;
    // Control characters out (a title can carry anything), then bounded.
    // eslint-disable-next-line no-control-regex
    const clean = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
    return clean ? [...clean].slice(0, max).join('') : null;
}

function handle(v: unknown): number | null {
    return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** One list entry, checked: anything malformed is dropped whole. */
export function sanitizeWindow(raw: unknown): RemoteWindow | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const hwnd = handle(r.hwnd);
    const pid = handle(r.pid);
    const title = str(r.title, MAX_TITLE);
    if (hwnd === null || pid === null || title === null) return null;
    const app = str(r.app, MAX_APP) ?? 'Program';
    const out: RemoteWindow = { hwnd, pid, title, app };
    const icon = str(r.icon, 32);
    if (icon && /^[A-Za-z0-9]+$/.test(icon)) out.icon = icon;
    if (r.minimized === true) out.minimized = true;
    if (r.elevated === true) out.elevated = true;
    if (typeof r.monitor === 'number' && Number.isInteger(r.monitor) && r.monitor >= 0 && r.monitor < 255) {
        out.monitor = r.monitor;
    }
    return out;
}

export function sanitizeWindowList(raw: unknown): RemoteWindow[] {
    if (!Array.isArray(raw)) return [];
    const out: RemoteWindow[] = [];
    const seen = new Set<string>();
    for (const item of raw.slice(0, MAX_WINDOWS)) {
        const w = sanitizeWindow(item);
        if (!w) continue;
        const id = windowId(w);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(w);
    }
    return out;
}

/** Icons by key, each a PNG data URL of a sane size. Anything else is
 *  dropped: an `<img src>` from the peer must never be a URL that loads. */
export function sanitizeIcons(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    let n = 0;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (n >= MAX_WINDOWS) break;
        if (!/^[A-Za-z0-9]{1,32}$/.test(k)) continue;
        if (typeof v !== 'string' || v.length > MAX_ICON_URL || !ICON_URL.test(v)) continue;
        out[k] = v;
        n++;
    }
    return out;
}

/** The shown window in a `window-active` frame, checked. */
export function sanitizeShown(raw: unknown): ShownWindow | null {
    const w = sanitizeWindow(raw);
    if (!w) return null;
    const r = raw as Record<string, unknown>;
    const dim = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 16_384 ? v : null);
    const width = dim(r.width);
    const height = dim(r.height);
    if (width === null || height === null) return null;
    return { hwnd: w.hwnd, pid: w.pid, title: w.title, app: w.app, width, height };
}

export function windowId(w: { hwnd: number; pid: number }): string {
    return `${w.hwnd}:${w.pid}`;
}

/** HOST: split the icons into frames of at most `budget` bytes of URL each,
 *  in the list's order, so the first windows' pictures arrive first. One
 *  icon larger than the budget goes alone (the agent never makes one). */
export function chunkIcons(icons: Record<string, string>, budget = ICON_FRAME_BUDGET): Record<string, string>[] {
    const frames: Record<string, string>[] = [];
    let cur: Record<string, string> = {};
    let size = 0;
    for (const [k, v] of Object.entries(icons)) {
        const cost = k.length + v.length + 8;
        if (size > 0 && size + cost > budget) {
            frames.push(cur);
            cur = {};
            size = 0;
        }
        cur[k] = v;
        size += cost;
    }
    if (size > 0) frames.push(cur);
    return frames;
}

/** HOST: only the windows on screens the person at this PC shared. A
 *  one-screen consent offers that screen's windows and nothing else — the
 *  titles of windows on a screen they declined are exactly what the consent
 *  kept from the viewer. A window whose screen is unknown is left out of a
 *  one-screen consent for the same reason. */
export function windowsWithinConsent(
    windows: RemoteWindow[],
    consented: number | null,
    allDisplays: number,
): RemoteWindow[] {
    if (consented === null || consented === allDisplays) return windows;
    return windows.filter(w => w.monitor === consented);
}

/** VIEWER: the windows matching what was typed: every word must appear in
 *  the title or the program's name, case and accents ignored. */
export function matchWindows<T extends { title: string; app: string }>(windows: T[], query: string): T[] {
    const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return windows;
    return windows.filter(w => {
        const hay = fold(`${w.title} ${w.app}`);
        return words.every(word => hay.includes(word));
    });
}

/** The reasons a host gives for going back to the whole screen by itself
 *  (the agent's `Gone` codes), and the host app's own two. */
export type WindowEndReason = 'closed' | 'minimized' | 'offscreen' | 'screen' | 'unshared' | 'asked';

export function isWindowEndReason(v: unknown): v is WindowEndReason {
    return v === 'closed' || v === 'minimized' || v === 'offscreen' || v === 'screen'
        || v === 'unshared' || v === 'asked';
}

/** VIEWER: the line the stage shows when the picture went back to the whole
 *  screen without being asked. `asked` (the viewer chose Whole screen, or a
 *  screen) says nothing. */
export function windowEndWords(reason: WindowEndReason, title: string | null): string | null {
    const name = title ? `“${title.length > 60 ? `${title.slice(0, 57)}…` : title}”` : 'That window';
    switch (reason) {
        case 'closed': return `${name} was closed. Showing the whole screen.`;
        case 'minimized': return `${name} was minimised. Showing the whole screen. Choose it again to bring it back.`;
        case 'offscreen': return `${name} moved to another screen. Showing the whole screen.`;
        case 'unshared': return `${name} moved to a screen that was not shared. Showing the whole screen.`;
        case 'screen': return `The screens on that computer changed. Showing the whole screen.`;
        case 'asked': return null;
    }
}

/** VIEWER: why the host refused a choice, as it said it, else a plain line. */
export function windowFailedWords(reason: unknown): string {
    if (typeof reason === 'string') {
        const r = str(reason, 200);
        if (r) return `Could not show that window: ${r}.`.replace(/\.\.$/, '.');
    }
    return 'Could not show that window.';
}
