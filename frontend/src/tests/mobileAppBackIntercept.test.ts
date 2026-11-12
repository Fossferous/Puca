/**
 * interceptBack (api/mobileApp.ts): while a video is in the player's in-app
 * fullscreen, Android's BACK gesture closes the fullscreen instead of sending
 * the app away (SovereignAppPlugin.setBackIntercept, APKs after 0.9.836).
 * Everywhere else, and on an older APK, back is what it always was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    platform: 'android',
    missing: false,
    calls: [] as Array<{ enabled: boolean }>,
    listeners: new Map<string, Array<() => void>>(),
    removed: 0,
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => h.platform,
        isNativePlatform: () => h.platform !== 'web',
    },
    registerPlugin: () => ({
        setBackIntercept: async (opts: { enabled: boolean }) => {
            h.calls.push(opts);
            if (h.missing) throw new Error('"SovereignApp.setBackIntercept()" is not implemented on android');
        },
        // The base Plugin's addListener resolves on every APK, with or
        // without the method (mobileApp.ts says so for 'keyboard').
        addListener: async (evt: string, cb: () => void) => {
            const list = h.listeners.get(evt) ?? [];
            list.push(cb);
            h.listeners.set(evt, list);
            return { remove: async () => { h.removed++; h.listeners.set(evt, (h.listeners.get(evt) ?? []).filter((f) => f !== cb)); } };
        },
    }),
}));

import { interceptBack } from '../api/mobileApp';

const settle = () => new Promise((r) => setTimeout(r, 0));
const back = () => { for (const cb of h.listeners.get('backButton') ?? []) cb(); };

beforeEach(() => {
    h.platform = 'android';
    h.missing = false;
    h.calls = [];
    h.listeners = new Map();
    h.removed = 0;
});

describe('interceptBack', () => {
    it('on Android: back calls the handler instead of leaving, until released', async () => {
        const onBack = vi.fn();
        const release = interceptBack(onBack);
        await settle();
        expect(h.calls).toEqual([{ enabled: true }]);
        back();
        expect(onBack).toHaveBeenCalledTimes(1);
        release();
        await settle();
        expect(h.calls).toEqual([{ enabled: true }, { enabled: false }]);
        expect(h.removed).toBe(1);
        back();
        expect(onBack).toHaveBeenCalledTimes(1);
        release(); // twice is harmless
        await settle();
        expect(h.calls).toHaveLength(2);
    });

    it('a second taker takes over; the first letting go late does not switch back off under it', async () => {
        const first = vi.fn();
        const second = vi.fn();
        const releaseFirst = interceptBack(first);
        const releaseSecond = interceptBack(second);
        await settle();
        back();
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
        releaseFirst();
        await settle();
        expect(h.calls.at(-1)).toEqual({ enabled: true });
        releaseSecond();
        await settle();
        expect(h.calls.at(-1)).toEqual({ enabled: false });
    });

    it('takers STACK: the newest closes first, and letting it go hands back to the one under it', async () => {
        // Settings (older) with a question over it (newer). The single owner
        // this replaced switched back off when the question closed, so the
        // next press left the app with Settings still open.
        const settings = vi.fn();
        const question = vi.fn();
        const releaseSettings = interceptBack(settings);
        const releaseQuestion = interceptBack(question);
        await settle();
        back();
        expect(question).toHaveBeenCalledTimes(1);
        expect(settings).not.toHaveBeenCalled();
        releaseQuestion();
        await settle();
        expect(h.calls.at(-1)).toEqual({ enabled: true });
        back();
        expect(settings).toHaveBeenCalledTimes(1);
        expect(question).toHaveBeenCalledTimes(1);
        releaseSettings();
        await settle();
        expect(h.calls.at(-1)).toEqual({ enabled: false });
        expect(h.listeners.get('backButton') ?? []).toHaveLength(0);
    });

    it('one press closes ONE layer, even straight after the last one let go and a new one opened', async () => {
        const first = vi.fn();
        const releaseFirst = interceptBack(first);
        releaseFirst(); // the listener is still being removed...
        const second = vi.fn();
        const releaseSecond = interceptBack(second); // ...when the next layer opens
        back(); // both listeners may still be there: only the current one acts
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
        await settle();
        expect(h.listeners.get('backButton') ?? []).toHaveLength(1);
        releaseSecond();
        await settle();
    });

    it('a layer taken while another is open asks for the intercept again (the native side may have switched itself off)', async () => {
        const releaseA = interceptBack(() => {});
        const releaseB = interceptBack(() => {});
        await settle();
        expect(h.calls).toEqual([{ enabled: true }, { enabled: true }]);
        releaseB();
        releaseA();
        await settle();
        expect(h.calls.at(-1)).toEqual({ enabled: false });
    });

    it('an APK without the method: no error escapes, and nothing else changes', async () => {
        h.missing = true;
        const onBack = vi.fn();
        const release = interceptBack(onBack);
        await settle();
        release();
        await settle();
        expect(h.calls).toEqual([{ enabled: true }, { enabled: false }]);
    });

    it('positive control: not on Android (the web, the desktop app), it asks nothing at all', async () => {
        h.platform = 'web';
        const release = interceptBack(() => {});
        await settle();
        release();
        await settle();
        expect(h.calls).toEqual([]);
        expect(h.listeners.size).toBe(0);
    });
});
