/**
 * holdSystemBarsHidden (api/systemBars.ts): while a video is in the player's
 * in-app fullscreen on Android, the status and navigation bars are hidden
 * (Capacitor's own SystemBars plugin), and they come back when it ends —
 * including after a page reload that left them hidden. Off Android, nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    platform: 'android',
    missing: false,
    calls: [] as string[],
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => h.platform,
        isNativePlatform: () => h.platform !== 'web',
    },
    SystemBars: {
        hide: async () => {
            h.calls.push('hide');
            if (h.missing) throw new Error('"SystemBars.hide()" is not implemented on android');
        },
        show: async () => {
            h.calls.push('show');
            if (h.missing) throw new Error('"SystemBars.show()" is not implemented on android');
        },
    },
}));

import { __resetSystemBars, holdSystemBarsHidden, restoreSystemBarsAtBoot } from '../api/systemBars';

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    // A test that failed half way must not leave a holder for the next one.
    __resetSystemBars();
    h.platform = 'android';
    h.missing = false;
    h.calls = [];
});

describe('holdSystemBarsHidden', () => {
    it('on Android: hidden while held, shown again on release (twice is harmless)', async () => {
        const release = holdSystemBarsHidden();
        await settle();
        expect(h.calls).toEqual(['hide']);
        release();
        await settle();
        expect(h.calls).toEqual(['hide', 'show']);
        release();
        await settle();
        expect(h.calls).toEqual(['hide', 'show']);
    });

    it('two holders: the bars come back only when the LAST one lets go', async () => {
        const first = holdSystemBarsHidden();
        const second = holdSystemBarsHidden();
        first();
        await settle();
        expect(h.calls).toEqual(['hide', 'hide']);
        // A boot-time restore while something still holds them changes nothing.
        restoreSystemBarsAtBoot();
        await settle();
        expect(h.calls).toEqual(['hide', 'hide']);
        second();
        await settle();
        expect(h.calls).toEqual(['hide', 'hide', 'show']);
    });

    it('a page starting with nothing held shows the bars (an update applied mid-fullscreen)', async () => {
        restoreSystemBarsAtBoot();
        await settle();
        expect(h.calls).toEqual(['show']);
    });

    it('an APK without SystemBars: no error escapes', async () => {
        h.missing = true;
        const release = holdSystemBarsHidden();
        await settle();
        release();
        restoreSystemBarsAtBoot();
        await settle();
        expect(h.calls).toEqual(['hide', 'show', 'show']);
    });

    it('positive control: off Android (the web, the desktop app, iOS) it asks nothing at all', async () => {
        for (const p of ['web', 'ios']) {
            h.platform = p;
            const release = holdSystemBarsHidden();
            release();
            restoreSystemBarsAtBoot();
        }
        await settle();
        expect(h.calls).toEqual([]);
    });
});
