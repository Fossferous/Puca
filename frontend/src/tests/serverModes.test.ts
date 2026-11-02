// @vitest-environment jsdom
/**
 * Server modes (docs/SERVER_MODES.md): what a mode hides, the frames that say a
 * mode changed, and the colour arithmetic that keeps one person's choice of
 * picture and accent readable on everyone else's theme. The contrast tests run
 * against the REAL themes, read out of styles/theme.css, so a theme that changes
 * cannot leave them proving something about colours nobody uses.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    ACCENT_MIN_LABEL_CONTRAST,
    ACCENT_MIN_SURFACE_CONTRAST,
    SCRIM_MAX,
    SCRIM_MIN,
    TEXT_MIN_CONTRAST,
    accentTokens,
    applyActiveMode,
    channelsEndedBySwitch,
    composite,
    contrast,
    listedNow,
    parseCssColor,
    parseServerModeChanged,
    parseServerModesEdited,
    scrimAlpha,
    shownByMode,
    shownWithParent,
    textFloor,
    usableHome,
    type Rgb,
    type ServerMode,
} from '../api/serverModes';

const mode = (over: Partial<ServerMode>): ServerMode => ({
    id: 1,
    name: 'Clocktower',
    background_file_id: null,
    accent_color: null,
    home_channel_id: null,
    auto_off: true,
    channel_ids: [],
    ...over,
});

describe('what a mode hides', () => {
    it('lists a channel in no mode always, and one in a mode only while that mode is on', () => {
        expect(shownByMode({ mode_ids: [] }, null)).toBe(true);
        expect(shownByMode({ mode_ids: [] }, 7)).toBe(true);
        expect(shownByMode({ mode_ids: [7] }, 7)).toBe(true);
        expect(shownByMode({ mode_ids: [7, 8] }, 8)).toBe(true);
        expect(shownByMode({ mode_ids: [7] }, 8)).toBe(false);
        expect(shownByMode({ mode_ids: [7] }, null)).toBe(false);
    });

    it('lists everything on a backend that predates modes (mode_ids absent)', () => {
        expect(shownByMode({}, null)).toBe(true);
        expect(shownByMode({}, undefined)).toBe(true);
    });

    it('takes a subchannel with its collection, in lists of places to go as in the channel list', () => {
        type Row = { id: number; parent_id?: number | null; mode_ids?: number[] };
        const collection: Row = { id: 1, mode_ids: [7] };
        const sub: Row = { id: 2, parent_id: 1, mode_ids: [] };
        const loose: Row = { id: 3, mode_ids: [] };
        const all = [collection, sub, loose];
        expect(shownWithParent(sub, all, null)).toBe(false);
        expect(shownWithParent(sub, all, 7)).toBe(true);
        expect(shownWithParent(loose, all, null), 'control: under nothing').toBe(true);
        expect(shownWithParent({ id: 4, parent_id: 99 }, all, null), 'a parent this reader cannot see').toBe(true);
        expect(shownWithParent({ id: 5, parent_id: 3, mode_ids: [8] }, all, null), 'hidden itself').toBe(false);
    });

    const hidden = { id: 5, channel_type: 1, mode_ids: [7] };
    const nowhere = { openChannelId: null, voiceChannelId: null, occupants: () => 0 };

    it('takes a hidden channel out of the list', () => {
        expect(listedNow(hidden, null, nowhere)).toBe(false);
    });

    it('never takes away what is open, or the call you are in', () => {
        expect(listedNow(hidden, null, { ...nowhere, openChannelId: 5 })).toBe(true);
        expect(listedNow(hidden, null, { ...nowhere, voiceChannelId: 5 })).toBe(true);
    });

    it('never hides a voice channel with people in it, and says nothing of a text channel', () => {
        expect(listedNow(hidden, null, { ...nowhere, occupants: () => 1 })).toBe(true);
        expect(listedNow({ ...hidden, channel_type: 0 }, null, { ...nowhere, occupants: () => 1 })).toBe(false);
    });
});

describe('who a switch cuts off', () => {
    const a = mode({ id: 1, channel_ids: [10, 11] });
    const b = mode({ id: 2, channel_ids: [10, 12] });

    it('is the channels of the mode that was on and not of the next one', () => {
        expect(channelsEndedBySwitch([a, b], 1, null)).toEqual([10, 11]);
        expect(channelsEndedBySwitch([a, b], 1, 2)).toEqual([11]);
    });

    it('is nobody when no mode was on', () => {
        expect(channelsEndedBySwitch([a, b], null, 1)).toEqual([]);
    });
});

describe('the main voice channel', () => {
    const channels = [
        { id: 1, channel_type: 1, mode_ids: [7] },
        { id: 2, channel_type: 1, mode_ids: [] },
        { id: 3, channel_type: 1, mode_ids: [8] },
        { id: 4, channel_type: 0, mode_ids: [7] },
    ];
    const home = (id: number | null) => usableHome(mode({ id: 7, home_channel_id: id }), channels)?.id ?? null;

    it('may be one of the mode, or always listed', () => {
        expect(home(1)).toBe(1);
        expect(home(2)).toBe(2);
    });

    it('is nowhere when another mode has taken it, it is gone, it is text, or none is set', () => {
        expect(home(3)).toBeNull();
        expect(home(99)).toBeNull();
        expect(home(4)).toBeNull();
        expect(home(null)).toBeNull();
        expect(usableHome(null, channels)).toBeNull();
    });
});

describe('the frames', () => {
    const frame = (payload: unknown) => ({ type: 'ServerModeChanged', payload });

    it('reads what the server sends', () => {
        expect(parseServerModeChanged(frame({ server_id: 's', active_mode_id: 3, previous_mode_id: null, by: 9 })))
            .toEqual({ server_id: 's', active_mode_id: 3, previous_mode_id: null, by: 9 });
        expect(parseServerModeChanged(frame({ server_id: 's', active_mode_id: null, previous_mode_id: 3, by: null })))
            .toEqual({ server_id: 's', active_mode_id: null, previous_mode_id: 3, by: null });
    });

    it('takes nothing else', () => {
        expect(parseServerModeChanged({ type: 'GamesEnabled', payload: { server_id: 's' } })).toBeNull();
        expect(parseServerModeChanged(frame(null))).toBeNull();
        expect(parseServerModeChanged(frame({ active_mode_id: 3, previous_mode_id: null, by: null }))).toBeNull();
        expect(parseServerModeChanged(frame({ server_id: '', active_mode_id: 3, previous_mode_id: null, by: null }))).toBeNull();
        expect(parseServerModeChanged(frame({ server_id: 's', active_mode_id: '3', previous_mode_id: null, by: null }))).toBeNull();
        expect(parseServerModeChanged(frame({ server_id: 's', previous_mode_id: null, by: null }))).toBeNull();
    });

    it('reads the edit frame', () => {
        expect(parseServerModesEdited({ type: 'ServerModesEdited', payload: { server_id: 's' } })).toBe('s');
        expect(parseServerModesEdited({ type: 'ServerModesEdited', payload: {} })).toBeNull();
        expect(parseServerModesEdited({ type: 'Other', payload: { server_id: 's' } })).toBeNull();
    });

    it('lands in the cached rows as a NEW array, or the same one when nothing changes', () => {
        const rows = [{ id: 's', active_mode_id: null }, { id: 't', active_mode_id: 2 }];
        const next = applyActiveMode(rows, { server_id: 's', active_mode_id: 3 });
        expect(next).not.toBe(rows);
        expect(next?.[0].active_mode_id).toBe(3);
        expect(next?.[1]).toBe(rows[1]);
        expect(applyActiveMode(rows, { server_id: 't', active_mode_id: 2 })).toBe(rows);
        expect(applyActiveMode(rows, { server_id: 'unknown', active_mode_id: 2 })).toBe(rows);
        expect(applyActiveMode(undefined, { server_id: 's', active_mode_id: 2 })).toBeUndefined();
    });
});

/** Every theme's real colours, from the stylesheet the app ships. */
function themes(): Record<string, { surfaces: Rgb[]; primary: Rgb; texts: Rgb[] }> {
    const css = readFileSync(resolve(__dirname, '../styles/theme.css'), 'utf8');
    const block = (selector: string) => {
        // The LAST one: the tinted themes also share a block whose selector list
        // ends with `[data-theme="yellow"] {`, and it holds no hue of its own.
        const start = css.lastIndexOf(`${selector} {`);
        expect(start, selector).toBeGreaterThanOrEqual(0);
        return css.slice(start, css.indexOf('}', start));
    };
    const token = (text: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(text)?.[1].trim();
    const hsl = (h: number, s: number, l: number): Rgb => {
        const [sn, ln] = [s / 100, l / 100];
        const a = sn * Math.min(ln, 1 - ln);
        const f = (n: number) => {
            const k = (n + h / 30) % 12;
            return Math.round(255 * (ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
        };
        return [f(0), f(8), f(4)];
    };
    const root = block(':root');
    const value = (text: string, name: string): Rgb => parseCssColor(token(text, name) ?? token(root, name) ?? '')!;
    const out: Record<string, { surfaces: Rgb[]; primary: Rgb; texts: Rgb[] }> = {};
    for (const [name, text] of [['dark', root], ['light', block('[data-theme="light"]')], ['amoled', block('[data-theme="amoled"]')]] as const) {
        const primary = value(text, '--bg-primary');
        out[name] = {
            primary,
            surfaces: [primary, value(text, '--bg-secondary')],
            texts: [value(text, '--text-normal'), value(text, '--text-muted'), value(text, '--text-link')],
        };
    }
    for (const name of ['pink', 'purple', 'green', 'orange', 'yellow']) {
        const text = block(`[data-theme="${name}"]`);
        const hue = parseFloat(token(text, '--theme-hue')!);
        const sat = parseFloat(token(text, '--theme-sat')!);
        const primary = hsl(hue, sat, 11);
        out[name] = {
            primary,
            surfaces: [primary, hsl(hue, sat * 1.2, 7)],
            texts: [value(root, '--text-normal'), value(root, '--text-muted'), value(root, '--text-link')],
        };
    }
    return out;
}

describe('the themes this is measured against', () => {
    it('are the eight the app ships, read as real colours', () => {
        const t = themes();
        expect(Object.keys(t).sort()).toEqual(['amoled', 'dark', 'green', 'light', 'orange', 'pink', 'purple', 'yellow']);
        for (const [name, theme] of Object.entries(t)) {
            for (const c of [...theme.surfaces, ...theme.texts]) {
                expect(c, name).toHaveLength(3);
                expect(c.every(v => Number.isFinite(v) && v >= 0 && v <= 255), name).toBe(true);
            }
        }
        expect(t.light.primary).toEqual([255, 255, 255]);
        expect(t.amoled.primary).toEqual([0, 0, 0]);
    });
});

describe('an accent on eight themes', () => {
    const WHITE: Rgb = [255, 255, 255];
    const hex = (h: number, s: number, l: number) => {
        // A spread of real choices: every hue, at the saturations and lightnesses people pick.
        const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
        const f = (n: number) => {
            const k = (n + h / 30) % 12;
            return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
        };
        return `#${f(0)}${f(8)}${f(4)}`;
    };

    it('keeps a white label readable and stays visible on every surface, for any colour on any theme', () => {
        for (const [name, theme] of Object.entries(themes())) {
            for (let h = 0; h < 360; h += 15) {
                for (const s of [0, 40, 100]) {
                    for (const l of [5, 30, 50, 70, 95]) {
                        const chosen = hex(h, s, l);
                        const tokens = accentTokens(chosen, theme.surfaces);
                        expect(tokens, `${name} ${chosen}`).not.toBeNull();
                        const primary = parseCssColor(tokens!.primary)!;
                        expect(contrast(primary, WHITE), `${name} ${chosen} label`).toBeGreaterThanOrEqual(ACCENT_MIN_LABEL_CONTRAST);
                        for (const surface of theme.surfaces) {
                            expect(contrast(primary, surface), `${name} ${chosen} surface`).toBeGreaterThanOrEqual(ACCENT_MIN_SURFACE_CONTRAST);
                        }
                    }
                }
            }
        }
    });

    it('leaves a colour alone when it already works, and darker states stay readable', () => {
        const surfaces = themes().dark.surfaces;
        const ok = '#a8476a';
        expect(contrast(parseCssColor(ok)!, WHITE)).toBeGreaterThanOrEqual(ACCENT_MIN_LABEL_CONTRAST);
        expect(contrast(parseCssColor(ok)!, surfaces[0])).toBeGreaterThanOrEqual(ACCENT_MIN_SURFACE_CONTRAST);
        const tokens = accentTokens(ok, surfaces)!;
        expect(tokens.primary).toBe(ok);
        expect(contrast(parseCssColor(tokens.hover)!, WHITE)).toBeGreaterThanOrEqual(ACCENT_MIN_LABEL_CONTRAST);
        expect(contrast(parseCssColor(tokens.active)!, WHITE)).toBeGreaterThanOrEqual(ACCENT_MIN_LABEL_CONTRAST);
    });

    it('moves a colour that would not work: the negative control', () => {
        // Bright yellow: a white label on it is unreadable.
        const bright = '#ffee00';
        expect(contrast(parseCssColor(bright)!, WHITE)).toBeLessThan(ACCENT_MIN_LABEL_CONTRAST);
        expect(accentTokens(bright, themes().dark.surfaces)!.primary).not.toBe(bright);
    });

    it('does not guess at something that is not a colour', () => {
        expect(accentTokens('red', [])).toBeNull();
        expect(accentTokens('', [])).toBeNull();
    });
});

describe('a background on eight themes', () => {
    const BLACK: Rgb = [0, 0, 0];
    const WHITE: Rgb = [255, 255, 255];
    const GREY: Rgb = [128, 128, 128];

    /** The reader's text against the picture's worst point, under the veil. */
    const worst = (extremes: readonly Rgb[], surface: Rgb, text: Rgb, alpha: number) =>
        Math.min(...extremes.map(p => contrast(text, composite(surface, p, alpha))));

    it('keeps every text colour readable at the picture\'s lightest and darkest points', () => {
        for (const [name, theme] of Object.entries(themes())) {
            for (const extremes of [[BLACK, WHITE], [WHITE], [BLACK], [GREY], [[20, 0, 40], [255, 240, 0]]] as Rgb[][]) {
                const alpha = scrimAlpha(extremes, theme.primary, theme.texts);
                for (const text of theme.texts) {
                    expect(worst(extremes, theme.primary, text, alpha), `${name} ${JSON.stringify(extremes)} a=${alpha}`)
                        .toBeGreaterThanOrEqual(textFloor(text, theme.primary));
                }
            }
        }
    });

    it('dims no further than the picture needs: a dark picture shows more on a dark theme, and on a light one the reverse', () => {
        const { dark, light } = themes();
        const nightOnDark = scrimAlpha([[5, 5, 20], [40, 40, 70]], dark.primary, dark.texts);
        const whiteOnDark = scrimAlpha([[200, 200, 200], [255, 255, 255]], dark.primary, dark.texts);
        expect(nightOnDark).toBe(SCRIM_MIN);
        expect(whiteOnDark).toBeGreaterThan(nightOnDark + 0.1);
        const nightOnLight = scrimAlpha([[5, 5, 20], [40, 40, 70]], light.primary, light.texts);
        const whiteOnLight = scrimAlpha([[250, 250, 250], [255, 255, 255]], light.primary, light.texts);
        expect(whiteOnLight).toBe(SCRIM_MIN);
        expect(nightOnLight).toBeGreaterThan(whiteOnLight + 0.1);
    });

    it('holds text that has AA on its theme to AA, and text that does not to within a tenth of what it has', () => {
        const { dark, light } = themes();
        const muted = dark.texts[1];
        expect(contrast(muted, dark.primary)).toBeGreaterThan(TEXT_MIN_CONTRAST);
        expect(textFloor(muted, dark.primary)).toBe(TEXT_MIN_CONTRAST);
        const link = light.texts[2];
        const own = contrast(link, light.primary);
        expect(own, 'the light theme\'s links, on plain white').toBeLessThan(TEXT_MIN_CONTRAST);
        expect(textFloor(link, light.primary)).toBeCloseTo(own * 0.9, 5);
    });

    it('fails a fixed veil on a bright picture: the negative control', () => {
        const { dark } = themes();
        const muted = dark.texts[1];
        expect(worst([WHITE], dark.primary, muted, SCRIM_MIN)).toBeLessThan(TEXT_MIN_CONTRAST);
    });

    it('stays inside its bounds', () => {
        for (const theme of Object.values(themes())) {
            const a = scrimAlpha([BLACK, WHITE], theme.primary, theme.texts);
            expect(a).toBeGreaterThanOrEqual(SCRIM_MIN);
            expect(a).toBeLessThanOrEqual(SCRIM_MAX);
        }
    });
});

describe('reading colours', () => {
    it('reads what a browser reports and a stylesheet writes', () => {
        expect(parseCssColor('#fff')).toEqual([255, 255, 255]);
        expect(parseCssColor('#18191C')).toEqual([24, 25, 28]);
        expect(parseCssColor('rgb(24, 25, 28)')).toEqual([24, 25, 28]);
        expect(parseCssColor('rgba(24, 25, 28, 0.5)')).toEqual([24, 25, 28]);
        expect(parseCssColor('rgb(24 25 28)')).toEqual([24, 25, 28]);
    });

    it('reads nothing else', () => {
        expect(parseCssColor('red')).toBeNull();
        expect(parseCssColor('#12')).toBeNull();
        expect(parseCssColor('')).toBeNull();
    });
});
