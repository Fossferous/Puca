/**
 * Android's BACK on the remote-control prompts (components/RemoteControlOverlay.tsx).
 * They took none: on the Android app, with Settings (or a menu, or the picture
 * viewer) open, "Allow control of this phone?" came up over it and Back went past
 * the prompt to close Settings out of sight; the next Back left the app with the
 * prompt still waiting (review finding). Back on a consent prompt is its refusal:
 * Deny for a request, No thanks for an offer, and never the grant.
 *
 * The native side is the SovereignApp plugin's two calls, played as in
 * backCloseOverlays.test.tsx; `back()` is the gesture. The control module is a
 * recorder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ControlState } from '../api/remoteControl';

const h = vi.hoisted(() => ({
    enabled: [] as boolean[],
    listeners: [] as Array<() => void>,
    push: (() => {}) as (s: ControlState) => void,
    answered: [] as boolean[],
    offers: [] as string[],
    phoneHost: true,
}));

vi.mock('@capacitor/core', async (importOriginal) => {
    const real = await importOriginal<typeof import('@capacitor/core')>();
    const absent = () => new Proxy({}, {
        get: (_t, p) => (p === 'then' ? undefined : () => Promise.reject(new Error('not here'))),
    });
    return {
        ...real,
        Capacitor: {
            ...real.Capacitor,
            getPlatform: () => 'android',
            isNativePlatform: () => true,
            isPluginAvailable: () => false,
        },
        registerPlugin: (name: string) => (name === 'SovereignApp'
            ? {
                setBackIntercept: async (o: { enabled: boolean }) => { h.enabled.push(o.enabled); },
                addListener: async (evt: string, cb: () => void) => {
                    if (evt === 'backButton') h.listeners.push(cb);
                    return { remove: async () => { h.listeners = h.listeners.filter(f => f !== cb); } };
                },
            }
            : absent()),
    };
});
vi.mock('../api/remoteControl', () => ({
    subscribeControl: (fn: (s: ControlState) => void) => { h.push = fn; return () => {}; },
    respondToControlRequest: (granted: boolean) => { h.answered.push(granted); },
    revokeControl: () => {},
    acceptControlOffer: () => { h.offers.push('accepted'); },
    declineControlOffer: () => { h.offers.push('declined'); },
    clearNotice: () => {},
    initRemoteControl: () => {},
    extendControlPrompt: () => {},
}));
vi.mock('../api/phoneControl', () => ({
    onPhoneControlStatusChanged: () => () => {},
    openPhoneControlSettings: async () => {},
    phoneControlStatus: async () => ({ refusal: null, sdk: 34 }),
    phoneHostPossible: () => h.phoneHost,
    refusalWords: () => null,
}));
vi.mock('../components/settingsStore', () => ({
    loadSettings: () => ({ remoteControlKillKey: null, remoteControlAnyInputKill: false }),
}));

import { RemoteControlOverlay } from '../components/RemoteControlOverlay';
import { useBackClose } from '../hooks/useBackClose';

const quiet: ControlState = { incomingRequest: null, controlledBy: null, controlling: null, offer: null, notice: null };
const asking: ControlState = { ...quiet, incomingRequest: { userId: 42, username: 'Aoife' } };
const offering: ControlState = { ...quiet, offer: { userId: 43, username: 'Bran' } };

let host: HTMLDivElement;
let root: Root;
const back = () => act(async () => { for (const cb of [...h.listeners]) cb(); });
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
/** Settings, say: a layer opened before the prompt came up over it. */
const closedUnder = vi.fn();
function Under() { useBackClose(closedUnder); return null; }

beforeEach(() => {
    h.enabled = [];
    h.listeners = [];
    h.answered = [];
    h.offers = [];
    closedUnder.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

for (const kind of ['phone', 'desktop'] as const) {
    it(`the ${kind}'s "Allow control?" prompt: Back is Deny, and nothing under it closes`, async () => {
        h.phoneHost = kind === 'phone';
        act(() => root.render(<><Under /></>));
        act(() => root.render(<><Under /><RemoteControlOverlay /></>));
        act(() => h.push(asking));
        await settle();
        expect(host.querySelector('.rc-prompt'), 'the prompt is up').toBeTruthy();
        await back();
        expect(h.answered, 'refused, never granted').toEqual([false]);
        expect(closedUnder, 'Settings under it stays open').not.toHaveBeenCalled();
        // The module answers by clearing the request; then Back is the layer's under it again.
        act(() => h.push(quiet));
        await settle();
        expect(host.querySelector('.rc-prompt')).toBeNull();
        await back();
        expect(closedUnder).toHaveBeenCalledTimes(1);
        expect(h.answered).toEqual([false]);
    });
}

it('a host offering me control: Back is No thanks, never Take control', async () => {
    h.phoneHost = true;
    act(() => root.render(<><Under /></>));
    act(() => root.render(<><Under /><RemoteControlOverlay /></>));
    act(() => h.push(offering));
    await settle();
    expect(host.textContent).toContain('Take control?');
    await back();
    expect(h.offers).toEqual(['declined']);
    expect(closedUnder).not.toHaveBeenCalled();
});

it('control: with no prompt up the overlay holds no Back (the banner and the toast are not layers)', async () => {
    h.phoneHost = true;
    act(() => root.render(<><Under /><RemoteControlOverlay /></>));
    act(() => h.push({ ...quiet, controlledBy: { userId: 42, username: 'Aoife' }, notice: 'hello' }));
    await settle();
    expect(host.querySelector('[data-testid="rc-banner"]')).toBeTruthy();
    await back();
    expect(closedUnder).toHaveBeenCalledTimes(1);
    expect(h.answered).toEqual([]);
    expect(h.offers).toEqual([]);
});

describe('positive control: the gesture reaches the page at all', () => {
    it('Back with only Settings open closes Settings', async () => {
        act(() => root.render(<Under />));
        await settle();
        expect(h.enabled.at(-1)).toBe(true);
        await back();
        expect(closedUnder).toHaveBeenCalledTimes(1);
    });
});
