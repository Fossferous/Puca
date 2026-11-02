/**
 * Server modes (docs/SERVER_MODES.md): a named set of channels listed only while
 * the mode is on, with an optional background picture and accent colour.
 *
 * Hiding is tidiness, not access. `shownByMode` decides what the channel LIST
 * shows; a hidden channel is still in the rows, still reachable from a #mention,
 * a notification or a link, and an older client lists it. Permissions stay the
 * one thing that keeps anybody out.
 *
 * No DOM in here (the frames, the rules and the colour arithmetic are pure); what
 * needs a document is api/modeLook.ts.
 */
import { apiClient } from './client';

export interface ServerMode {
    id: number;
    name: string;
    /** A plain server asset like the server icon: not end-to-end encrypted. */
    background_file_id: string | null;
    /** `#rrggbb` as the editor chose it; each reader's theme adjusts it. */
    accent_color: string | null;
    /** Where the start notice's Join and Call everyone back go. Null when none
     *  is set, or the reader cannot see it. */
    home_channel_id: number | null;
    auto_off: boolean;
    /** The channels of this mode the reader can see. */
    channel_ids: number[];
}

export interface ServerModes {
    active_mode_id: number | null;
    can_switch: boolean;
    can_edit: boolean;
    can_call_back: boolean;
    modes: ServerMode[];
}

/** A field left out is left alone. `''` clears background and accent, 0 the main
 *  channel. */
export interface ModeEdit {
    name?: string;
    channel_ids?: number[];
    background_file_id?: string;
    accent_color?: string;
    home_channel_id?: number;
    auto_off?: boolean;
}

export function listModes(serverId: string): Promise<ServerModes> {
    return apiClient.get(`/servers/${serverId}/modes`);
}

export function createMode(serverId: string, edit: ModeEdit): Promise<{ id: number }> {
    return apiClient.post(`/servers/${serverId}/modes`, edit);
}

export function updateMode(serverId: string, modeId: number, edit: ModeEdit): Promise<void> {
    return apiClient.patch(`/servers/${serverId}/modes/${modeId}`, edit);
}

export function deleteMode(serverId: string, modeId: number): Promise<void> {
    return apiClient.delete(`/servers/${serverId}/modes/${modeId}`);
}

/** Turn a mode on, replacing the current one, or (null) turn it off. */
export function setActiveMode(
    serverId: string,
    modeId: number | null,
): Promise<{ active_mode_id: number | null; disconnected: number | null }> {
    return apiClient.put(`/servers/${serverId}/modes/active`, { mode_id: modeId });
}

export function callEveryoneBack(serverId: string): Promise<{ moved: number; skipped: number }> {
    return apiClient.post(`/servers/${serverId}/modes/active/call-back`);
}

// --- The rules ---

/**
 * Does the mode that is on (or none) list this channel? A channel in no mode is
 * always listed, and so is any channel on an older backend (`mode_ids` absent).
 */
export function shownByMode(channel: { mode_ids?: number[] }, activeModeId: number | null | undefined): boolean {
    const ids = channel.mode_ids;
    if (!ids || ids.length === 0) return true;
    return activeModeId != null && ids.includes(activeModeId);
}

/**
 * `shownByMode` for a channel among its siblings: a subchannel goes with its
 * collection, as the channel list renders it, so a list of places to go must agree.
 */
export function shownWithParent<C extends { id: number; parent_id?: number | null; mode_ids?: number[] }>(
    channel: C,
    channels: readonly C[],
    activeModeId: number | null | undefined,
): boolean {
    if (!shownByMode(channel, activeModeId)) return false;
    if (channel.parent_id == null) return true;
    const parent = channels.find(c => c.id === channel.parent_id);
    return !parent || shownByMode(parent, activeModeId);
}

/**
 * Whether the channel list shows a channel. A mode hides it, except that what is
 * open stays until you leave it (a list must not lose what you are reading), and
 * a voice channel with people in it is never hidden: a call nobody can see is not
 * tidy, it is a secret.
 */
export function listedNow(
    channel: { id: number; channel_type: number; mode_ids?: number[] },
    activeModeId: number | null | undefined,
    here: { openChannelId?: number | null; voiceChannelId?: number | null; occupants: (channelId: number) => number },
): boolean {
    return shownByMode(channel, activeModeId)
        || here.openChannelId === channel.id
        || here.voiceChannelId === channel.id
        || (channel.channel_type === 1 && here.occupants(channel.id) > 0);
}

/**
 * The voice channels a switch would end the calls in: in the mode that is on and
 * not in the one coming on. Mirrors the server's `channels_hidden_by`. This one
 * only words the warning; the server decides.
 */
export function channelsEndedBySwitch(
    modes: ServerMode[],
    activeModeId: number | null | undefined,
    nextModeId: number | null,
): number[] {
    const current = modes.find(m => m.id === activeModeId);
    if (!current) return [];
    const next = modes.find(m => m.id === nextModeId);
    return current.channel_ids.filter(id => !next?.channel_ids.includes(id));
}

/**
 * The mode's main voice channel, if a person can actually go there: it exists
 * for them and the mode that is on lists it. A main channel another mode has
 * since taken over is nowhere anyone could follow, and the server refuses it too.
 */
export function usableHome<C extends { id: number; channel_type: number; mode_ids?: number[] }>(
    mode: ServerMode | null | undefined,
    channels: C[],
): C | null {
    if (mode?.home_channel_id == null) return null;
    const home = channels.find(c => c.id === mode.home_channel_id);
    return home && home.channel_type === 1 && shownByMode(home, mode.id) ? home : null;
}

// --- The frames ---

export interface ServerModeChangedFrame {
    server_id: string;
    active_mode_id: number | null;
    previous_mode_id: number | null;
    /** Who switched it; null when the mode turned itself off. */
    by: number | null;
}

const idOrNull = (v: unknown): number | null | undefined =>
    v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** `ServerModeChanged`, checked; `null` for any other frame or a malformed one. */
export function parseServerModeChanged(msg: { type: string; payload?: unknown }): ServerModeChangedFrame | null {
    if (msg.type !== 'ServerModeChanged') return null;
    const p = msg.payload;
    if (!p || typeof p !== 'object') return null;
    const { server_id, active_mode_id, previous_mode_id, by } = p as Record<string, unknown>;
    const active = idOrNull(active_mode_id);
    const previous = idOrNull(previous_mode_id);
    const actor = idOrNull(by);
    if (typeof server_id !== 'string' || server_id === '') return null;
    if (active === undefined || previous === undefined || actor === undefined) return null;
    return { server_id, active_mode_id: active, previous_mode_id: previous, by: actor };
}

/** `ServerModesEdited`'s server id, or null. */
export function parseServerModesEdited(msg: { type: string; payload?: unknown }): string | null {
    if (msg.type !== 'ServerModesEdited') return null;
    const id = (msg.payload as { server_id?: unknown } | null | undefined)?.server_id;
    return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * The cached server rows with one server's `active_mode_id` replaced. A NEW array
 * when it changes (react-query compares by identity), the same one when the
 * server is not listed or already says so.
 */
export function applyActiveMode<T extends { id: string; active_mode_id?: number | null }>(
    rows: T[] | undefined,
    f: Pick<ServerModeChangedFrame, 'server_id' | 'active_mode_id'>,
): T[] | undefined {
    if (!rows) return rows;
    const i = rows.findIndex(r => r.id === f.server_id);
    if (i === -1 || rows[i].active_mode_id === f.active_mode_id) return rows;
    const next = rows.slice();
    next[i] = { ...rows[i], active_mode_id: f.active_mode_id };
    return next;
}

// --- Colour ---
//
// A mode's look is chosen by one person and read by everyone, on eight themes.
// So neither is taken on trust: an accent is moved in lightness until it works on
// the reader's theme, and a background is dimmed exactly as far as its own
// brightest and darkest parts need for the reader's text to stay readable.

export type Rgb = readonly [number, number, number];

/** `#rgb`, `#rrggbb`, `rgb(...)` or `rgba(...)`, as a browser reports a colour. */
export function parseCssColor(value: string): Rgb | null {
    const v = value.trim().toLowerCase();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
    if (hex) {
        const h = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return null;
}

function linear(channel: number): number {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance([r, g, b]: Rgb): number {
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio. */
export function contrast(a: Rgb, b: Rgb): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
    const [rn, gn, bn] = [r / 255, g / 255, b / 255];
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
    h /= 6;
    return [h, s, l];
}

function fromHsl(h: number, s: number, l: number): Rgb {
    if (s === 0) {
        const v = Math.round(l * 255);
        return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t0: number) => {
        const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

function toHex([r, g, b]: Rgb): string {
    return `#${[r, g, b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Labels on a brand-coloured button are white everywhere in the app. */
const WHITE: Rgb = [255, 255, 255];
/** AA for a button's label. */
export const ACCENT_MIN_LABEL_CONTRAST = 4.5;
/** AA for a non-text mark against the surface it sits on. */
export const ACCENT_MIN_SURFACE_CONTRAST = 3;

export interface AccentTokens {
    primary: string;
    hover: string;
    active: string;
}

/**
 * The accent's three brand tokens for a theme: the chosen hue and saturation, at
 * the nearest lightness where a white label stays readable on it and it stays
 * visible on every surface given. Null when no lightness does both, or the colour
 * cannot be read; the theme's own brand then stands.
 */
export function accentTokens(hex: string, surfaces: readonly Rgb[]): AccentTokens | null {
    const rgb = parseCssColor(hex);
    if (!rgb) return null;
    const [h, s, l] = toHsl(rgb);
    const ok = (l2: number) => {
        const c = fromHsl(h, s, l2);
        return contrast(c, WHITE) >= ACCENT_MIN_LABEL_CONTRAST
            && surfaces.every(surface => contrast(c, surface) >= ACCENT_MIN_SURFACE_CONTRAST);
    };
    for (let step = 0; step <= 100; step++) {
        for (const candidate of [l - step / 100, l + step / 100]) {
            if (candidate < 0 || candidate > 1 || !ok(candidate)) continue;
            return {
                primary: toHex(fromHsl(h, s, candidate)),
                hover: toHex(fromHsl(h, s, Math.max(0, candidate - 0.06))),
                active: toHex(fromHsl(h, s, Math.max(0, candidate - 0.12))),
            };
        }
    }
    return null;
}

/** Below this the picture competes with the words, whatever the arithmetic says. */
export const SCRIM_MIN = 0.6;
export const SCRIM_MAX = 0.97;
/** AA for text. */
export const TEXT_MIN_CONTRAST = 4.5;

/**
 * What a text colour has to keep over a picture: AA if it has AA on the theme's
 * own surface. A colour that is already below it (the light theme's links are
 * 2.6:1 on plain white) cannot be held to AA by a veil, nor to exactly what it has
 * by anything short of hiding the picture, so it may lose at most a tenth.
 */
export function textFloor(text: Rgb, surface: Rgb): number {
    const own = contrast(text, surface);
    return own >= TEXT_MIN_CONTRAST ? TEXT_MIN_CONTRAST : own * 0.9;
}

/** `over` laid on `under` at `alpha`, in the space a browser composites in. */
export function composite(over: Rgb, under: Rgb, alpha: number): Rgb {
    return [
        over[0] * alpha + under[0] * (1 - alpha),
        over[1] * alpha + under[1] * (1 - alpha),
        over[2] * alpha + under[2] * (1 - alpha),
    ];
}

/**
 * How opaque the theme-coloured layer over a picture has to be, so that `texts`
 * stay readable at the picture's lightest and darkest points (`extremes`): the
 * least that does it, so a dark picture on a dark theme shows far more than a
 * bright one does.
 */
export function scrimAlpha(extremes: readonly Rgb[], surface: Rgb, texts: readonly Rgb[]): number {
    const holds = (alpha: number) =>
        extremes.every(pixel => {
            const under = composite(surface, pixel, alpha);
            return texts.every(text => contrast(text, under) >= textFloor(text, surface));
        });
    for (let a = SCRIM_MIN; a < SCRIM_MAX; a += 0.01) {
        if (holds(a)) return Math.round(a * 100) / 100;
    }
    return SCRIM_MAX;
}
