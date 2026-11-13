/**
 * The host's Allow control (components/RemoteControlOverlay.tsx) works only
 * ALLOW_ARM_MS after a prompt for THIS requester is shown, on the desktop's
 * prompt and the phone's. Before, a request withdrawn and another sent at
 * once re-rendered the same prompt with the new name and Allow still
 * enabled, under a finger already on its way to it. Red without the
 * per-requester key (the swap keeps Allow armed) or without the delay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ControlState } from '../api/remoteControl';

let push: (s: ControlState) => void = () => {};
const answered: boolean[] = [];
vi.mock('../api/remoteControl', () => ({
    subscribeControl: (fn: (s: ControlState) => void) => { push = fn; return () => {}; },
    respondToControlRequest: (granted: boolean) => { answered.push(granted); },
    revokeControl: () => {},
    acceptControlOffer: () => {},
    declineControlOffer: () => {},
    clearNotice: () => {},
    initRemoteControl: () => {},
    extendControlPrompt: () => {},
}));
let phoneHost = false;
vi.mock('../api/phoneControl', () => ({
    onPhoneControlStatusChanged: () => () => {},
    openPhoneControlSettings: async () => {},
    phoneControlStatus: async () => ({ refusal: null, sdk: 34 }),
    phoneHostPossible: () => phoneHost,
    refusalWords: () => null,
}));
vi.mock('../components/settingsStore', () => ({
    loadSettings: () => ({ remoteControlKillKey: null, remoteControlAnyInputKill: false }),
}));

import { RemoteControlOverlay, ALLOW_ARM_MS } from '../components/RemoteControlOverlay';

const asking = (userId: number, username: string): ControlState => ({
    incomingRequest: { userId, username },
    controlledBy: null,
    controlling: null,
    offer: null,
    notice: null,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<RemoteControlOverlay />); });
}
const allow = () => {
    const b = [...host!.querySelectorAll('button')].find(x => x.textContent?.trim() === 'Allow control');
    expect(b, 'the Allow button').toBeTruthy();
    return b as HTMLButtonElement;
};

beforeEach(() => { vi.useFakeTimers(); answered.length = 0; });
afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
});

for (const kind of ['desktop', 'phone'] as const) {
    describe(`the ${kind}'s prompt`, () => {
        beforeEach(() => { phoneHost = kind === 'phone'; });

        it('arms Allow only after a moment, and again for a different requester', async () => {
            render();
            act(() => push(asking(42, 'Aoife')));
            // Let the phone's status answer (a resolved promise).
            await act(async () => { await Promise.resolve(); });
            expect(allow().disabled, 'not at once').toBe(true);
            await act(async () => { vi.advanceTimersByTime(ALLOW_ARM_MS); await Promise.resolve(); });
            expect(allow().disabled, 'armed after the moment').toBe(false);
            // Aoife withdraws and Bran asks at once: the same spot, a new name.
            act(() => push(asking(43, 'Bran')));
            await act(async () => { await Promise.resolve(); });
            expect(host!.textContent).toContain('Bran');
            expect(allow().disabled, 'a new requester waits again').toBe(true);
            act(() => { allow().click(); });
            expect(answered, 'a press before it arms answers nothing').toEqual([]);
            await act(async () => { vi.advanceTimersByTime(ALLOW_ARM_MS); await Promise.resolve(); });
            expect(allow().disabled).toBe(false);
            act(() => { allow().click(); });
            expect(answered).toEqual([true]);
        });
    });
}
