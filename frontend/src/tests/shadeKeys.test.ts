/**
 * Keys in the Android notification (api/devices/shadeKeys.ts): which buttons
 * the page declares, what a press may send, and that the declaration reaches
 * the native plugin deduplicated and never in a retry loop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ keys: unknown; status: unknown }> = [];
let listener: ((d: { id: string }) => void) | null = null;
let platform = 'android';
let pluginThere = true;
let reject = false;
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => platform,
        isPluginAvailable: (name: string) => pluginThere && name === 'SovereignShadeKeys',
    },
    registerPlugin: () => ({
        set: async (opts: { keys: unknown; status: unknown }) => {
            calls.push(opts);
            if (reject) throw new Error('refused');
        },
        addListener: async (_e: string, cb: (d: { id: string }) => void) => {
            listener = cb;
            return { remove: async () => { listener = null; } };
        },
    }),
}));

const {
    __resetShadeKeysForTests, decideShadePress, onShadeKeyPress, repushShadeKeys,
    setShadeKeys, shadeButtons, shadeKeysAvailable,
} = await import('../api/devices/shadeKeys');
const { SAS_CODE } = await import('../api/devices/pinnedKeys');
type Pin = import('../api/devices/pinnedKeys').PinnedKey;

const live = { live: true, canInput: true, controlEnabled: true };
const pins: Pin[] = [
    { id: 'a1', code: 'F5', mods: [], shade: true },
    { id: 'b2', code: 'KeyC', mods: ['ctrl'], shade: false },
    { id: 'c3', code: SAS_CODE, mods: [], shade: true },
    { id: 'd4', code: 'Tab', mods: ['alt'], shade: true },
];
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
    calls.length = 0;
    listener = null;
    platform = 'android';
    pluginThere = true;
    reject = false;
    __resetShadeKeysForTests();
});

describe('which buttons the notification gets', () => {
    it('the pins marked for it, in order, labelled as on the stage', () => {
        expect(shadeButtons(pins, live)).toEqual([
            { id: 'a1', label: 'F5' },
            { id: 'c3', label: 'Ctrl+Alt+Del' },
            { id: 'd4', label: 'Alt+Tab' },
        ]);
    });

    it('none at all unless input can really land', () => {
        expect(shadeButtons(pins, { ...live, live: false })).toEqual([]);
        expect(shadeButtons(pins, { ...live, canInput: false })).toEqual([]);      // a view-only share
        expect(shadeButtons(pins, { ...live, controlEnabled: false })).toEqual([]); // paused
    });

    it('never more than three, even if a list somehow marks more', () => {
        const four = [...pins, { id: 'e5', code: 'F6', mods: [], shade: true } as Pin];
        expect(shadeButtons(four, live)).toHaveLength(3);
    });
});

describe('a press from the notification', () => {
    it('sends that pin\'s complete tap', () => {
        expect(decideShadePress(pins, 'd4', live)).toEqual({
            send: true,
            label: 'Alt+Tab',
            frames: [
                { t: 'key', code: 'AltLeft', down: true },
                { t: 'key', code: 'Tab', down: true },
                { t: 'key', code: 'Tab', down: false },
                { t: 'key', code: 'AltLeft', down: false },
            ],
        });
        expect(decideShadePress(pins, 'c3', live)).toMatchObject({ send: true, frames: [{ t: 'sas' }] });
    });

    it('a stale button (unpinned, or no longer in the notification) sends nothing', () => {
        expect(decideShadePress(pins, 'zz', live)).toEqual({ send: false, why: 'unknown' });
        expect(decideShadePress(pins, 'b2', live)).toEqual({ send: false, why: 'unknown' });
        expect(decideShadePress(pins, 42, live)).toEqual({ send: false, why: 'unknown' });
    });

    it('nothing without a session that takes input, nothing while paused', () => {
        expect(decideShadePress(pins, 'a1', { ...live, live: false })).toEqual({ send: false, why: 'not-live' });
        expect(decideShadePress(pins, 'a1', { ...live, canInput: false })).toEqual({ send: false, why: 'not-live' });
        expect(decideShadePress(pins, 'a1', { ...live, controlEnabled: false })).toEqual({ send: false, why: 'paused' });
    });
});

describe('reaching the native side', () => {
    it('only on Android with the plugin present', async () => {
        expect(shadeKeysAvailable()).toBe(true);
        pluginThere = false;
        expect(shadeKeysAvailable()).toBe(false);
        setShadeKeys([{ id: 'a1', label: 'F5' }], null);
        platform = 'web';
        pluginThere = true;
        expect(shadeKeysAvailable()).toBe(false);
        setShadeKeys([{ id: 'a1', label: 'F5' }], null);
        await flush();
        expect(calls).toEqual([]);
    });

    it('deduplicated, latest state wins, and a refusal is not retried in a loop', async () => {
        setShadeKeys([{ id: 'a1', label: 'F5' }], null);
        setShadeKeys([{ id: 'a1', label: 'F5' }], 'Last sent: F5'); // while the first is out
        await flush(); await flush();
        expect(calls).toEqual([
            { keys: [{ id: 'a1', label: 'F5' }], status: null },
            { keys: [{ id: 'a1', label: 'F5' }], status: 'Last sent: F5' },
        ]);
        setShadeKeys([{ id: 'a1', label: 'F5' }], 'Last sent: F5');  // unchanged
        await flush();
        expect(calls).toHaveLength(2);

        reject = true;
        setShadeKeys([], null);
        await flush(); await flush(); await flush();
        expect(calls).toHaveLength(3);                                 // tried once, not again and again

        // Back in the foreground: posted again even though unchanged.
        reject = false;
        repushShadeKeys();
        await flush();
        expect(calls).toHaveLength(4);
        expect(calls[3]).toEqual({ keys: [], status: null });
    });

    it('presses arrive as ids, and unsubscribing stops them', async () => {
        const got: string[] = [];
        const off = onShadeKeyPress(id => got.push(id));
        await flush();
        listener!({ id: 'a1' });
        expect(got).toEqual(['a1']);
        off();
        await flush();
        expect(listener).toBeNull();
    });
});
