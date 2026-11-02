/**
 * Server modes (docs/SERVER_MODES.md): a named set of channels listed only while
 * the mode is on, with an optional background picture and accent colour.
 *
 * Hiding is tidiness, not access. `shownWithParent` decides what the channel LIST
 * shows; a hidden channel is still in the rows, still reachable from a #mention,
 * or a notification, and an older client lists it. Permissions stay the
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

interface ModeRow {
    id: number;
    parent_id?: number | null;
    mode_ids?: number[];
    /** The collection's modes, for a reader who has no row of that collection. */
    parent_mode_ids?: number[];
    is_afk?: boolean;
}

/** Dispatched on `window` when a mode switches, for what keeps its own copy of the servers. */
export const MODES_CHANGED_EVENT = 'sovereign:modes-changed';

const parentModes = <C extends ModeRow>(channel: C, channels: readonly C[]): number[] | undefined =>
    channels.find(c => c.id === channel.parent_id)?.mode_ids ?? channel.parent_mode_ids;

/**
 * `shownByMode` for a channel among its siblings: a subchannel goes with its
 * collection, whichever kind of channel it is. Every list that shows or names a
 * channel goes through this. The AFK channel is exempt: an idle member is moved
 * into it, so a mode cannot hide it, even through its collection.
 */
export function shownWithParent<C extends ModeRow>(
    channel: C,
    channels: readonly C[],
    activeModeId: number | null | undefined,
): boolean {
    if (channel.is_afk) return true;
    if (!shownByMode(channel, activeModeId)) return false;
    if (channel.parent_id == null) return true;
    return shownByMode({ mode_ids: parentModes(channel, channels) }, activeModeId);
}

/**
 * Is this channel listed under nothing at all? Ticked in one mode while its collection is
 * ticked in others: each hides it from the other, and with no mode on it is hidden too. The
 * rule is the server's as well. The editor has to say so, since both cards show a tick.
 */
export function neverListed<C extends ModeRow>(channel: C, channels: readonly C[]): boolean {
    if (channel.is_afk || channel.parent_id == null) return false;
    const own = channel.mode_ids ?? [];
    const parent = parentModes(channel, channels) ?? [];
    return own.length > 0 && parent.length > 0 && !own.some(m => parent.includes(m));
}

/** Is the channel in this mode: ticked, or under a ticked collection? */
export function channelInMode<C extends ModeRow>(channel: C, channels: readonly C[], modeId: number): boolean {
    if (channel.is_afk) return false;
    if (channel.mode_ids?.includes(modeId)) return true;
    return channel.parent_id != null && !!parentModes(channel, channels)?.includes(modeId);
}

/**
 * Whether the channel list shows a channel. A mode hides it, except that what is
 * open stays until you leave it (a list must not lose what you are reading: an open
 * collection keeps its text subchannels), and a voice channel with people in it is
 * never hidden: a call nobody can see is not tidy, it is a secret.
 */
export function listedNow<C extends ModeRow & { channel_type: number }>(
    channel: C,
    channels: readonly C[],
    activeModeId: number | null | undefined,
    here: { openChannelId?: number | null; voiceChannelId?: number | null; occupants: (channelId: number) => number },
): boolean {
    return shownWithParent(channel, channels, activeModeId)
        || here.openChannelId === channel.id
        || (channel.channel_type !== 1 && channel.parent_id != null && here.openChannelId === channel.parent_id
            && shownByMode(channel, activeModeId))
        || here.voiceChannelId === channel.id
        || (channel.channel_type === 1 && here.occupants(channel.id) > 0);
}

/**
 * The voice channels a switch would end the calls in: in the mode that is on and
 * not listed under the one coming on. Mirrors the server's `channels_hidden_by`.
 * This one only words the warning; the server decides.
 */
export function channelsEndedBySwitch<C extends ModeRow & { channel_type: number }>(
    channels: readonly C[],
    activeModeId: number | null | undefined,
    nextModeId: number | null,
): number[] {
    if (activeModeId == null) return [];
    return channels
        .filter(c => c.channel_type === 1 && channelInMode(c, channels, activeModeId) && !shownWithParent(c, channels, nextModeId))
        .map(c => c.id);
}

/**
 * The mode's main voice channel, if a person can actually go there: it exists
 * for them and the mode that is on lists it. A main channel another mode has
 * since taken over is nowhere anyone could follow, and the server refuses it too.
 */
export function usableHome<C extends ModeRow & { channel_type: number }>(
    mode: ServerMode | null | undefined,
    channels: readonly C[],
): C | null {
    if (mode?.home_channel_id == null) return null;
    const home = channels.find(c => c.id === mode.home_channel_id);
    return home && home.channel_type === 1 && shownWithParent(home, channels, mode.id) ? home : null;
}

/**
 * Where an Android notification's tap lands. The server, as always, unless the list
 * there would not show this channel: a mode hides it, so there would be no row to
 * press. Rows the device does not hold yet read as listed. This web bundle is what reads
 * a `channel:` target, so an older APK passes it through untouched (`nav` is opaque in Java).
 * It is not the only thing that can send one: see opensFromNav.
 */
export function notificationNav<C extends ModeRow>(
    serverId: string,
    channelId: number,
    rows: readonly C[] | undefined,
    activeModeId: number | null | undefined,
): string {
    const row = rows?.find(c => c.id === channelId);
    return row && !shownWithParent(row, rows as readonly C[], activeModeId)
        ? `channel:${serverId}:${channelId}`
        : `server:${serverId}`;
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
 * A frame says which mode is on as of now. A `GET /servers` already in flight may have
 * read the row before that, and react-query would let its answer overwrite this one,
 * with nothing to heal it (no interval, no focus refetch, five minutes of staleness).
 * Invalidating cancels that fetch and starts one that reads after the frame.
 */
export function adoptModeFrame<T extends { id: string; active_mode_id?: number | null }>(
    client: {
        setQueryData: (key: readonly unknown[], update: (old: T[] | undefined) => T[] | undefined) => unknown;
        invalidateQueries: (filters: { queryKey: readonly unknown[]; exact: boolean }) => Promise<unknown>;
    },
    serversKey: readonly unknown[],
    f: Pick<ServerModeChangedFrame, 'server_id' | 'active_mode_id'>,
): void {
    client.setQueryData(serversKey, old => applyActiveMode(old, f));
    void client.invalidateQueries({ queryKey: serversKey, exact: true });
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
// the reader's theme, and a background is tone-mapped on the reader's device so the
// reader's text stays readable over every part of it.

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

/** AA for text. */
export const TEXT_MIN_CONTRAST = 4.5;

// --- A picture behind the chat ---
//
// A flat veil holds text to AA by dimming the whole picture as far as its brightest part
// needs, and greys it: a moon costs the whole sky. So the picture is not veiled. On the
// reader's device it is exposed, keeping every pixel's hue and saturation, and only what
// is still in the way of the text is compressed. A picture has to carry the weakest text
// colour on the screen, so while one shows, the reader's text colours move out of the
// band it needs: lighter on a dark theme, darker on a light one.

/** The brightest a picture gets behind text on a dark theme, as WCAG luminance. */
export const PICTURE_CEILING = 0.125;
/** The darkest it gets on a light theme. */
export const PICTURE_FLOOR = 0.3;
/**
 * What text is held to over the worst pixel the curve allows. Over AA, because the JPEG
 * the mapped picture is stored as rings a little at hard edges, and scaling blends.
 */
const PICTURE_TEXT_CONTRAST = 5.3;
/** Message text and headings, a step clearer than what sits beside them. */
const PICTURE_STRONG_CONTRAST = 6;
/** How the two are told apart when the theme says what its colours are. */
const STRONG_TEXT_TOKENS = ['--text-normal', '--header-primary'];
/** Every text colour that can land directly on the picture. */
export const PICTURE_TEXT_TOKENS = [
    ...STRONG_TEXT_TOKENS,
    '--text-muted',
    '--text-faint',
    '--text-link',
    '--header-secondary',
    '--text-positive',
    '--text-warning',
    '--text-danger',
];

export interface PictureLimit {
    /** A dark theme's light text limits how bright a pixel gets, a light theme's how dark. */
    kind: 'ceiling' | 'floor';
    luminance: number;
}

/** The band a picture has to stay in behind this theme's text. */
export function pictureLimit(surface: Rgb): PictureLimit {
    return luminance(surface) < 0.18
        ? { kind: 'ceiling', luminance: PICTURE_CEILING }
        : { kind: 'floor', luminance: PICTURE_FLOOR };
}

/** The same hue and saturation at the nearest lightness that `ok` accepts, walking `step` at a time. */
function atLightness(colour: Rgb, step: number, ok: (l: number) => boolean): Rgb {
    if (ok(luminance(colour))) return colour;
    const [h, s, l] = toHsl(colour);
    for (let at = l; at >= 0 && at <= 1; at += step) {
        const c = fromHsl(h, s, at);
        if (ok(luminance(c))) return c;
    }
    return step > 0 ? WHITE : [0, 0, 0];
}

/**
 * A theme's text colours for reading over a picture: each keeps its hue and goes only as far
 * as it must to hold over the worst pixel `limit` allows. A colour that already does stays.
 */
export function pictureTextColours(tokens: Readonly<Record<string, Rgb>>, limit: PictureLimit): Record<string, string> {
    const edge = limit.luminance + 0.05;
    const out: Record<string, string> = {};
    for (const [token, colour] of Object.entries(tokens)) {
        const want = STRONG_TEXT_TOKENS.includes(token) ? PICTURE_STRONG_CONTRAST : PICTURE_TEXT_CONTRAST;
        out[token] = toHex(limit.kind === 'ceiling'
            ? atLightness(colour, 0.005, l => l >= edge * want - 0.05)
            : atLightness(colour, -0.005, l => l <= edge / want - 0.05));
    }
    return out;
}

const roleColours = new Map<string, string>();

/**
 * A role's colour for a name written on a picture, which is the one text colour that is not a
 * theme's: the same treatment, remembered, since it is asked for every message on every render.
 */
export function pictureRoleColour(colour: string, limit: PictureLimit): string {
    const key = `${limit.kind}|${colour}`;
    const known = roleColours.get(key);
    if (known) return known;
    const rgb = parseCssColor(colour);
    const out = rgb ? pictureTextColours({ colour: rgb }, limit).colour : colour;
    roleColours.set(key, out);
    return out;
}

/** What a tone curve does to one picture. */
export interface TonePlan extends PictureLimit {
    /** Exposure, in linear light, before the limit is applied. */
    gain: number;
}

let toLinear: Float32Array | null = null;
let toSrgb: Uint8Array | null = null;
const SRGB_STEPS = 4095;

/** sRGB to linear and back as tables: a picture is a million pixels. */
function curves(): { toLinear: Float32Array; toSrgb: Uint8Array } {
    if (!toLinear || !toSrgb) {
        toLinear = new Float32Array(256);
        for (let i = 0; i < 256; i++) toLinear[i] = linear(i);
        toSrgb = new Uint8Array(SRGB_STEPS + 1);
        for (let i = 0; i <= SRGB_STEPS; i++) {
            const v = i / SRGB_STEPS;
            toSrgb[i] = Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
        }
    }
    return { toLinear, toSrgb };
}

/** Where the picture's mid-to-bright tones are put on a dark theme, as a share of the ceiling. */
const CEILING_EXPOSE_TO = 0.62;
/** A share of a bright picture may go past that and be compressed: a moon must not dim the sky. */
const BRIGHT_PERCENTILE = 0.75;
const GAIN_DARK_THEME = { min: 0.05, max: 1.5 };
/** Where they are put on a light theme. A dark picture is stretched to keep its shapes apart. */
const FLOOR_EXPOSE_TO = 0.6;
const GAIN_LIGHT_THEME = { min: 1, max: 16 };
/** Where compressing starts, as a share of the ceiling, and as a multiple of the floor. */
const CEILING_KNEE = 0.7;
const FLOOR_KNEE = 1.7;

/** Read off every sixteenth pixel or so: enough for a percentile, and a phone is waiting. */
export function planTone(rgba: Uint8ClampedArray, limit: PictureLimit): TonePlan {
    const { toLinear: lin, toSrgb: srgb } = curves();
    const stride = 4 * 16;
    const histogram = new Uint32Array(256);
    let samples = 0;
    for (let i = 0; i + 2 < rgba.length; i += stride) {
        const y = 0.2126 * lin[rgba[i]] + 0.7152 * lin[rgba[i + 1]] + 0.0722 * lin[rgba[i + 2]];
        histogram[srgb[Math.round(y * SRGB_STEPS)]]++;
        samples++;
    }
    let seen = 0;
    let bright = 255;
    for (let v = 0; v < 256; v++) {
        seen += histogram[v];
        if (seen >= samples * BRIGHT_PERCENTILE) {
            bright = v;
            break;
        }
    }
    const reference = Math.max(lin[bright], 1 / 255);
    const [target, range] = limit.kind === 'ceiling'
        ? [limit.luminance * CEILING_EXPOSE_TO, GAIN_DARK_THEME]
        : [FLOOR_EXPOSE_TO, GAIN_LIGHT_THEME];
    return { ...limit, gain: Math.min(range.max, Math.max(range.min, target / reference)) };
}

/**
 * The curve, over RGBA in place. Brighter stays brighter. Under a ceiling a pixel is scaled in
 * linear light, so it keeps its hue and saturation, and the exposed luminance rolls off towards
 * the ceiling without reaching it. Over a floor a dark pixel has to gain light, which can only
 * come from mixing towards white, so it keeps its hue, and loses only the saturation that takes.
 */
export function toneMap(rgba: Uint8ClampedArray, plan: TonePlan): void {
    const { toLinear: lin, toSrgb: srgb } = curves();
    const { gain, luminance: limit } = plan;
    const encode = (v: number) => srgb[Math.round(v * SRGB_STEPS)];
    if (plan.kind === 'ceiling') {
        const knee = limit * CEILING_KNEE;
        const span = limit - knee;
        for (let i = 0; i + 2 < rgba.length; i += 4) {
            const r = lin[rgba[i]];
            const g = lin[rgba[i + 1]];
            const b = lin[rgba[i + 2]];
            const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            if (y === 0) continue;
            const x = y * gain;
            const scale = (x <= knee ? x : knee + span * (1 - Math.exp((knee - x) / span))) / y;
            rgba[i] = encode(Math.min(1, r * scale));
            rgba[i + 1] = encode(Math.min(1, g * scale));
            rgba[i + 2] = encode(Math.min(1, b * scale));
        }
        return;
    }
    const knee = limit * FLOOR_KNEE;
    const span = knee - limit;
    for (let i = 0; i + 2 < rgba.length; i += 4) {
        const r = Math.min(1, lin[rgba[i]] * gain);
        const g = Math.min(1, lin[rgba[i + 1]] * gain);
        const b = Math.min(1, lin[rgba[i + 2]] * gain);
        const x = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const lift = x >= knee ? 0 : (limit + span * Math.exp((x - knee) / span) - x) / (1 - x);
        rgba[i] = encode(r + lift * (1 - r));
        rgba[i + 1] = encode(g + lift * (1 - g));
        rgba[i + 2] = encode(b + lift * (1 - b));
    }
}
