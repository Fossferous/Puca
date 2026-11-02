// @vitest-environment jsdom
/**
 * Server modes (docs/SERVER_MODES.md): what a mode hides, the frames that say a
 * mode changed, and the colour arithmetic that keeps one person's choice of
 * picture and accent readable on everyone else's theme. The contrast tests run
 * against the REAL themes, read out of styles/theme.css, so a theme that changes
 * cannot leave them proving something about colours nobody uses.
 */
import { describe, it, expect } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    ACCENT_MIN_LABEL_CONTRAST,
    ACCENT_MIN_SURFACE_CONTRAST,
    TEXT_MIN_CONTRAST,
    accentTokens,
    adoptModeFrame,
    applyActiveMode,
    channelInMode,
    channelsEndedBySwitch,
    contrast,
    listedNow,
    luminance,
    neverListed,
    notificationNav,
    parseCssColor,
    parseServerModeChanged,
    parseServerModesEdited,
    pictureLimit,
    pictureRoleColour,
    pictureTextColours,
    planTone,
    shownByMode,
    shownWithParent,
    toneMap,
    usableHome,
    type PictureLimit,
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

    it('takes a VOICE subchannel with its collection too, and never the AFK channel', () => {
        const collection = { id: 1, channel_type: 2, mode_ids: [7] };
        const room = { id: 2, channel_type: 1, parent_id: 1, mode_ids: [] };
        const afk = { id: 3, channel_type: 1, parent_id: 1, mode_ids: [], is_afk: true };
        const all = [collection, room, afk];
        expect(shownWithParent(room, all, null)).toBe(false);
        expect(shownWithParent(room, all, 7)).toBe(true);
        expect(shownWithParent(afk, all, null), 'idle members are moved into it').toBe(true);
        expect(channelInMode(room, all, 7), 'its own row names no mode, and it is in this one').toBe(true);
        expect(channelInMode(room, all, 8)).toBe(false);
        expect(channelInMode(collection, all, 7)).toBe(true);
        expect(channelInMode(afk, all, 7)).toBe(false);
    });

    const hidden = { id: 5, channel_type: 1, mode_ids: [7] };
    const nowhere = { openChannelId: null, voiceChannelId: null, occupants: () => 0 };

    it('takes a hidden channel out of the list', () => {
        expect(listedNow(hidden, [hidden], null, nowhere)).toBe(false);
    });

    it('never takes away what is open, or the call you are in', () => {
        expect(listedNow(hidden, [hidden], null, { ...nowhere, openChannelId: 5 })).toBe(true);
        expect(listedNow(hidden, [hidden], null, { ...nowhere, voiceChannelId: 5 })).toBe(true);
    });

    it('never hides a voice channel with people in it, and says nothing of a text channel', () => {
        expect(listedNow(hidden, [hidden], null, { ...nowhere, occupants: () => 1 })).toBe(true);
        expect(listedNow({ ...hidden, channel_type: 0 }, [hidden], null, { ...nowhere, occupants: () => 1 })).toBe(false);
    });

    describe('under a collection a mode hides', () => {
        const collection = { id: 1, channel_type: 2, mode_ids: [7] };
        const room = { id: 2, channel_type: 1, parent_id: 1, mode_ids: [] };
        const s1 = { id: 3, channel_type: 0, parent_id: 1, mode_ids: [] };
        const s2 = { id: 4, channel_type: 0, parent_id: 1, mode_ids: [] };
        const ownMode = { id: 6, channel_type: 0, parent_id: 1, mode_ids: [8] };
        const all = [collection, room, s1, s2, ownMode];
        const listedOf = (here: { openChannelId?: number | null }) =>
            all.filter(c => listedNow(c, all, null, { ...nowhere, ...here })).map(c => c.id);

        it('a voice room is not listed, though its own row names no mode', () => {
            expect(listedNow(room, all, null, nowhere)).toBe(false);
            expect(listedNow(room, all, 7, nowhere), 'control: with the mode on').toBe(true);
        });

        it('...unless somebody is in it', () => {
            expect(listedNow(room, all, null, { ...nowhere, occupants: () => 1 })).toBe(true);
        });

        it('one open subchannel does not bring its siblings back', () => {
            expect(listedOf({ openChannelId: s1.id })).toEqual([s1.id]);
        });

        it('an open collection keeps its text subchannels, not its voice rooms or one another mode hides', () => {
            expect(listedOf({ openChannelId: collection.id })).toEqual([collection.id, s1.id, s2.id]);
        });
    });
});

describe('a collection the reader has no row of', () => {
    // Denied the collection: its row is withheld, and a child does not inherit VIEW.
    const voice = { id: 2, parent_id: 1, channel_type: 1, mode_ids: [], parent_mode_ids: [7] };

    it('still takes its subchannel with it, from what the row says', () => {
        expect(shownWithParent(voice, [voice], null)).toBe(false);
        expect(shownWithParent(voice, [voice], 8)).toBe(false);
        expect(shownWithParent(voice, [voice], 7)).toBe(true);
        expect(channelInMode(voice, [voice], 7)).toBe(true);
        expect(channelInMode(voice, [voice], 8)).toBe(false);
    });

    it('agrees with the row when there is one, and with an older server that says nothing', () => {
        const parent = { id: 1, channel_type: 2, mode_ids: [7] };
        const old = { id: 2, parent_id: 1, channel_type: 1, mode_ids: [] };
        expect(shownWithParent(old, [parent, old], null), 'the collection\'s own row').toBe(false);
        expect(shownWithParent(old, [old], null), 'nothing to go on: listed, as before').toBe(true);
    });
});

describe('a channel listed under nothing', () => {
    const parent = { id: 1, channel_type: 2, mode_ids: [7] };

    it('is one ticked in one mode while its collection is in another', () => {
        const sub = { id: 2, parent_id: 1, channel_type: 1, mode_ids: [8] };
        expect(neverListed(sub, [parent, sub])).toBe(true);
        for (const on of [null, 7, 8]) expect(shownWithParent(sub, [parent, sub], on), `with ${on} on`).toBe(false);
    });

    it('CONTROLS: in the same mode, in none, or with no collection, it can be listed', () => {
        const same = { id: 2, parent_id: 1, channel_type: 1, mode_ids: [7] };
        const none = { id: 3, parent_id: 1, channel_type: 1, mode_ids: [] };
        const top = { id: 4, channel_type: 1, mode_ids: [8] };
        expect(neverListed(same, [parent, same])).toBe(false);
        expect(shownWithParent(same, [parent, same], 7)).toBe(true);
        expect(neverListed(none, [parent, none])).toBe(false);
        expect(neverListed(top, [parent, top])).toBe(false);
    });
});

describe('who a switch cuts off', () => {
    const channels = [
        { id: 10, channel_type: 1, mode_ids: [1, 2] },
        { id: 11, channel_type: 1, mode_ids: [1] },
        { id: 12, channel_type: 1, mode_ids: [2] },
        { id: 13, channel_type: 0, mode_ids: [1] },
        { id: 14, channel_type: 1, mode_ids: [] },
    ];

    it('is the voice channels of the mode that was on and not of the next one', () => {
        expect(channelsEndedBySwitch(channels, 1, null)).toEqual([10, 11]);
        expect(channelsEndedBySwitch(channels, 1, 2)).toEqual([11]);
    });

    it('is nobody when no mode was on', () => {
        expect(channelsEndedBySwitch(channels, null, 1)).toEqual([]);
    });

    it('takes in the voice rooms under a ticked collection, by the rule the server uses', () => {
        const rows = [
            { id: 1, channel_type: 2, mode_ids: [1, 2] },
            { id: 2, channel_type: 1, parent_id: 1, mode_ids: [] },
            { id: 3, channel_type: 1, parent_id: 1, mode_ids: [], is_afk: true },
            { id: 4, channel_type: 2, mode_ids: [1] },
            { id: 5, channel_type: 1, parent_id: 4, mode_ids: [2] },
        ];
        expect(channelsEndedBySwitch(rows, 1, null), 'not the AFK channel').toEqual([2, 5]);
        expect(channelsEndedBySwitch(rows, 1, 2), 'ticked in the next mode, under a collection it does not tick').toEqual([5]);
    });
});

describe('where a notification goes', () => {
    const rows = [
        { id: 1, mode_ids: [7] },
        { id: 2, parent_id: 1, mode_ids: [] },
        { id: 3, mode_ids: [] },
    ];

    it('is the server, unless the list there has no row to press', () => {
        expect(notificationNav('s', 3, rows, null)).toBe('server:s');
        expect(notificationNav('s', 1, rows, 7)).toBe('server:s');
        expect(notificationNav('s', 1, rows, null)).toBe('channel:s:1');
        expect(notificationNav('s', 2, rows, null)).toBe('channel:s:2');
    });

    it('is the server for a channel this device has no row for', () => {
        expect(notificationNav('s', 9, rows, null)).toBe('server:s');
        expect(notificationNav('s', 1, undefined, null)).toBe('server:s');
    });
});

describe('a frame beats a fetch already in flight', () => {
    type Row = { id: string; active_mode_id: number | null };
    const KEY = ['servers'];
    const deferred = () => {
        let resolve!: (rows: Row[]) => void;
        const promise = new Promise<Row[]>(r => { resolve = r; });
        return { promise, resolve };
    };

    /** A fetch that read the row before the switch, answering after its frame. */
    async function run(adopt: (client: QueryClient) => void) {
        const client = new QueryClient();
        const before = deferred();
        const after = deferred();
        const answers = [before, after];
        const tick = () => new Promise(r => setTimeout(r, 0));
        client.setQueryData<Row[]>(KEY, [{ id: 's', active_mode_id: null }]);
        // Observed, as useServers is: the read starts on subscribing.
        const observer = new QueryObserver<Row[]>(client, { queryKey: KEY, queryFn: () => answers.shift()!.promise, staleTime: 0 });
        const stop = observer.subscribe(() => {});
        await tick();
        expect(answers, 'the read is in flight').toHaveLength(1);
        adopt(client);
        before.resolve([{ id: 's', active_mode_id: null }]);
        await tick();
        after.resolve([{ id: 's', active_mode_id: 3 }]);
        await tick();
        stop();
        return client.getQueryData<Row[]>(KEY)?.[0].active_mode_id;
    }

    it('and the row says what the frame said', async () => {
        const adopted = await run(client => adoptModeFrame<Row>(client, KEY, { server_id: 's', active_mode_id: 3 }));
        expect(adopted).toBe(3);
    });

    it('CONTROL: only setting the row loses to the fetch', async () => {
        const lost = await run(client => client.setQueryData<Row[]>(KEY, old => applyActiveMode(old, { server_id: 's', active_mode_id: 3 })));
        expect(lost).toBeNull();
    });
});

describe('the main voice channel', () => {
    const channels = [
        { id: 1, channel_type: 1, mode_ids: [7] },
        { id: 2, channel_type: 1, mode_ids: [] },
        { id: 3, channel_type: 1, mode_ids: [8] },
        { id: 4, channel_type: 0, mode_ids: [7] },
        { id: 5, channel_type: 2, mode_ids: [7] },
        { id: 6, channel_type: 1, parent_id: 5, mode_ids: [] },
        { id: 7, channel_type: 2, mode_ids: [8] },
        { id: 8, channel_type: 1, parent_id: 7, mode_ids: [] },
    ];
    const home = (id: number | null) => usableHome(mode({ id: 7, home_channel_id: id }), channels)?.id ?? null;

    it('may be one of the mode, or always listed', () => {
        expect(home(1)).toBe(1);
        expect(home(2)).toBe(2);
    });

    it('may be under a collection of the mode, and not under one of another', () => {
        expect(home(6)).toBe(6);
        expect(home(8)).toBeNull();
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
    /** A selector's rule. `at` -1 is its last, 0 its first: the tinted themes share a
     *  first block whose selector list ends with `[data-theme="yellow"] {`, holding
     *  their ladder and no hue of its own. */
    const block = (selector: string, at: -1 | 0 = -1) => {
        const start = at === 0 ? css.indexOf(`${selector} {`) : css.lastIndexOf(`${selector} {`);
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
    // The ladder the five tinted themes share, read like everything else here: a change
    // to these lines must change what is measured, or fail for not being understood.
    const tinted = block('[data-theme="yellow"]', 0);
    const primaryLine = /--bg-primary:\s*hsl\(var\(--theme-hue\) var\(--theme-sat\) ([\d.]+)%\)/.exec(tinted);
    const secondaryLine = /--bg-secondary:\s*hsl\(var\(--theme-hue\) calc\(var\(--theme-sat\) \* ([\d.]+)\) ([\d.]+)%\)/.exec(tinted);
    expect(primaryLine, 'the tinted themes\' --bg-primary').not.toBeNull();
    expect(secondaryLine, 'the tinted themes\' --bg-secondary').not.toBeNull();
    const primaryL = parseFloat(primaryLine![1]);
    const [secondaryS, secondaryL] = [parseFloat(secondaryLine![1]), parseFloat(secondaryLine![2])];
    for (const name of ['pink', 'purple', 'green', 'orange', 'yellow']) {
        const text = block(`[data-theme="${name}"]`);
        const hue = parseFloat(token(text, '--theme-hue')!);
        const sat = parseFloat(token(text, '--theme-sat')!);
        const primary = hsl(hue, sat, primaryL);
        out[name] = {
            primary,
            surfaces: [primary, hsl(hue, sat * secondaryS, secondaryL)],
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
    const WHITE: Rgb = [255, 255, 255];

    /** Every colour there is, coarsely. */
    const everyColour = () => {
        const out: number[] = [];
        for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) out.push(r, g, b, 255);
        return new Uint8ClampedArray(out);
    };
    const solid = ([r, g, b]: Rgb, n = 64) => {
        const out = new Uint8ClampedArray(n * 4);
        for (let i = 0; i < n; i++) out.set([r, g, b, 255], i * 4);
        return out;
    };
    /** Mostly one colour with a small bright part, so that the exposure answers to the rest and
     *  the bright part goes to the limit. A solid picture only ever reaches where it is exposed to. */
    const withSpark = (rest: Rgb, spark: Rgb) => {
        const out = solid(rest, 100);
        for (let i = 0; i < 10; i++) out.set([spark[0], spark[1], spark[2], 255], i * 4);
        return out;
    };
    const PICTURES: Record<string, () => Uint8ClampedArray> = {
        'every colour': everyColour,
        'a white spark on grey': () => withSpark([90, 90, 90], WHITE),
        'a black spark on grey': () => withSpark([200, 200, 200], [0, 0, 0]),
        white: () => solid(WHITE),
        black: () => solid([0, 0, 0]),
        grey: () => solid([128, 128, 128]),
        'pure red': () => solid([255, 0, 0]),
        'pure green': () => solid([0, 255, 0]),
        'pure blue': () => solid([0, 0, 255]),
    };
    const mapped = (rgba: Uint8ClampedArray, limit: PictureLimit) => {
        const out = rgba.slice();
        toneMap(out, planTone(out, limit));
        return out;
    };
    const pixels = (rgba: Uint8ClampedArray) => {
        const out: Rgb[] = [];
        for (let i = 0; i < rgba.length; i += 4) out.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
        return out;
    };
    /** The worst contrast of any colour over any pixel. */
    const worst = (rgba: Uint8ClampedArray, colours: readonly Rgb[]) =>
        Math.min(...pixels(rgba).map(p => Math.min(...colours.map(c => contrast(c, p)))));
    const tokensOf = ([normal, muted, link]: Rgb[]): Record<string, Rgb> => ({
        '--text-normal': normal,
        '--text-muted': muted,
        '--text-faint': muted,
        '--text-link': link,
        '--text-danger': [242, 63, 67],
        '--text-warning': [240, 178, 50],
        '--text-positive': [35, 165, 90],
    });
    const reading = (theme: { primary: Rgb; texts: Rgb[] }) => {
        const limit = pictureLimit(theme.primary);
        const text = pictureTextColours(tokensOf(theme.texts), limit);
        return { limit, colours: Object.values(text).map(c => parseCssColor(c)!) };
    };

    it('holds every text colour to AA over every pixel the curve can make, on every theme', () => {
        for (const [name, theme] of Object.entries(themes())) {
            const { limit, colours } = reading(theme);
            for (const [what, picture] of Object.entries(PICTURES)) {
                expect(worst(mapped(picture(), limit), colours), `${what} on ${name}`).toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
            }
        }
    });

    it('fails a curve that goes too far: the negative control', () => {
        const { dark, light } = themes();
        const onDark = reading(dark);
        const tooBright = mapped(withSpark([90, 90, 90], WHITE), { ...onDark.limit, luminance: onDark.limit.luminance * 1.6 });
        expect(worst(tooBright, onDark.colours)).toBeLessThan(TEXT_MIN_CONTRAST);
        const onLight = reading(light);
        const tooDark = mapped(withSpark([200, 200, 200], [0, 0, 0]), { ...onLight.limit, luminance: onLight.limit.luminance / 1.6 });
        expect(worst(tooDark, onLight.colours)).toBeLessThan(TEXT_MIN_CONTRAST);
    });

    it('fails the veil this replaced at the most it could show, and the theme\'s own text over the curve: negative controls', () => {
        const { dark } = themes();
        const veil = (over: Rgb, under: Rgb, a: number): Rgb => [0, 1, 2].map(i => over[i] * a + under[i] * (1 - a)) as unknown as Rgb;
        expect(contrast(dark.texts[1], veil(dark.primary, WHITE, 0.6))).toBeLessThan(TEXT_MIN_CONTRAST);
        expect(worst(mapped(withSpark([90, 90, 90], WHITE), pictureLimit(dark.primary)), [dark.texts[1]])).toBeLessThan(TEXT_MIN_CONTRAST);
    });

    it('moves a text colour only as far as it must, and keeps its hue', () => {
        const limit = pictureLimit(themes().dark.primary);
        const moved = pictureTextColours({ '--text-link': [0, 168, 252], '--text-muted': WHITE }, limit);
        expect(moved['--text-muted'], 'already holds').toBe('#ffffff');
        const link = parseCssColor(moved['--text-link'])!;
        expect(luminance(link)).toBeGreaterThan(luminance([0, 168, 252]));
        expect(link[2], 'still blue').toBeGreaterThan(link[0]);
    });

    it('moves a role\'s colour the same way, on a dark theme and a light one, and leaves what it cannot read', () => {
        const { dark, light } = themes();
        const gold = '#f0b232';
        for (const theme of [dark, light]) {
            const limit = pictureLimit(theme.primary);
            const moved = parseCssColor(pictureRoleColour(gold, limit))!;
            expect(worst(mapped(withSpark([200, 200, 200], WHITE), limit), [moved]), 'it holds').toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
            expect(moved[0], 'still gold').toBeGreaterThanOrEqual(moved[2]);
        }
        expect(pictureRoleColour('not a colour', pictureLimit(dark.primary))).toBe('not a colour');
    });

    const hueOf = ([r, g, b]: Rgb) => {
        const max = Math.max(r, g, b);
        const d = max - Math.min(r, g, b);
        if (d === 0) return 0;
        const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return (h * 60 + 360) % 360;
    };
    const satOf = ([r, g, b]: Rgb) => {
        const max = Math.max(r, g, b);
        return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
    };

    it('keeps hue and colour on a dark theme: nothing goes grey', () => {
        const limit = pictureLimit(themes().dark.primary);
        const before = pixels(everyColour());
        const after = pixels(mapped(everyColour(), limit));
        let compared = 0;
        before.forEach((p, i) => {
            const q = after[i];
            // Too few levels left to name a hue in, or a colourless one.
            if (Math.max(...q) < 32 || Math.max(...p) - Math.min(...p) < 34) return;
            compared++;
            const off = Math.abs(hueOf(p) - hueOf(q));
            expect(Math.min(off, 360 - off), `${p} -> ${q}`).toBeLessThan(12);
            expect(satOf(q), `${p} -> ${q}`).toBeGreaterThan(satOf(p) * 0.55);
        });
        expect(compared, 'control: this looked at something').toBeGreaterThan(500);
    });

    it('keeps the order of what is brighter, so shapes stay shapes', () => {
        for (const theme of Object.values(themes())) {
            const limit = pictureLimit(theme.primary);
            const ramp = new Uint8ClampedArray(256 * 4);
            for (let v = 0; v < 256; v++) ramp.set([v, v, v, 255], v * 4);
            const out = pixels(mapped(ramp, limit)).map(luminance);
            for (let v = 1; v < 256; v++) expect(out[v], `step ${v}`).toBeGreaterThanOrEqual(out[v - 1] - 0.002);
            expect(out[255] - out[0], 'and something is left of the ramp').toBeGreaterThan(0.08);
        }
    });

    it('a bright moon costs only the moon', () => {
        const limit = pictureLimit(themes().dark.primary);
        const sky: Rgb = [20, 24, 70];
        const picture = solid(sky, 1000);
        for (let i = 0; i < 40; i++) picture.set([255, 255, 240, 255], i * 4);
        const plan = planTone(picture, limit);
        expect(plan.gain, 'the sky is not dimmed for it').toBeGreaterThanOrEqual(1);
        const out = pixels(mapped(picture, limit));
        expect(luminance(out[500])).toBeGreaterThanOrEqual(luminance(sky) * 0.98);
        // To within what eight bits can say.
        expect(luminance(out[0]), 'the moon itself is what gives').toBeLessThanOrEqual(limit.luminance * 1.02);
    });

    it('a bright picture is exposed down, not flattened against the limit', () => {
        const limit = pictureLimit(themes().dark.primary);
        const picture = new Uint8ClampedArray(4 * 1000);
        for (let i = 0; i < 1000; i++) picture.set(i % 3 === 0 ? [240, 240, 240, 255] : i % 3 === 1 ? [160, 190, 230, 255] : [90, 150, 70, 255], i * 4);
        const [cloud, sky, grass] = pixels(mapped(picture, limit)).map(luminance);
        expect(cloud).toBeGreaterThan(sky * 1.1);
        expect(sky).toBeGreaterThan(grass * 1.3);
    });

    it('takes a picture in bands to the same result as whole: how a phone is spared', () => {
        const limit = pictureLimit(themes().dark.primary);
        const whole = mapped(everyColour(), limit);
        const banded = everyColour();
        const plan = planTone(banded, limit);
        for (let at = 0; at < banded.length; at += 4 * 97) toneMap(banded.subarray(at, at + 4 * 97), plan);
        expect(banded).toEqual(whole);
    });

    it('never changes anyone\'s theme: Settings is the one writer of data-theme, and nothing follows the time of day or the OS', () => {
        const root = resolve(__dirname, '..');
        const writers: string[] = [];
        const followers: string[] = [];
        const walk = (dir: string) => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const full = resolve(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name !== 'tests') walk(full);
                } else if (/\.(ts|tsx)$/.test(e.name)) {
                    const text = readFileSync(full, 'utf8');
                    if (/setAttribute\(\s*['"]data-theme['"]|dataset\.theme\s*=/.test(text)) writers.push(e.name);
                    if (/prefers-color-scheme/.test(text)) followers.push(e.name);
                }
            }
        };
        walk(root);
        expect(writers).toEqual(['settingsStore.ts']);
        expect(followers).toEqual([]);
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
