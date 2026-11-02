// @vitest-environment jsdom
/**
 * startNativeFeed / stopNativeFeed against a stand-in shell: what happens to a
 * key that is down when the feed changes under it. No other test reached these
 * two functions (they return at once without a Tauri runtime), so "the feed fell
 * over mid-hold" had nothing watching it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { invoke, listen, hotkeyListener } = vi.hoisted(() => ({
    invoke: vi.fn(),
    listen: vi.fn(),
    hotkeyListener: { current: null as null | ((e: { payload: unknown }) => void) },
}));

vi.mock('../api/platform', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

import {
    registerHold, resetHotkeysForTest, startNativeFeed, stopNativeFeed,
} from '../api/hotkeys';
import type { KeyBinding } from '../components/settingsStore';

const SPACE: KeyBinding = { keyCode: 32, ctrl: false, alt: false, shift: false, label: 'Space' };
const edge = (keyCode: number, down: boolean) => hotkeyListener.current?.({
    payload: { keyCode, ctrlKey: false, altKey: false, shiftKey: false, down, foreground: false },
});

describe('a key that is down when the native feed changes', () => {
    let ups = 0;

    beforeEach(() => {
        ups = 0;
        hotkeyListener.current = null;
        invoke.mockReset().mockResolvedValue(true);
        listen.mockReset().mockImplementation(async (name: string, cb: (e: { payload: unknown }) => void) => {
            if (name === 'global-hotkey') hotkeyListener.current = cb;
            return () => { if (name === 'global-hotkey') hotkeyListener.current = null; };
        });
        registerHold('voice.ptt', () => SPACE, { onDown: () => { /* counted by ups */ }, onUp: () => { ups++; } });
    });
    afterEach(async () => {
        invoke.mockReset().mockResolvedValue(true);
        await stopNativeFeed('test over');
        resetHotkeysForTest();
    });

    it('a re-registration the hook refuses releases what the live feed held', async () => {
        await startNativeFeed(['voice.ptt'], [32]);
        edge(32, true);
        invoke.mockResolvedValue(false); // a settings save, and no hook this time
        await startNativeFeed(['voice.ptt'], [32]);
        expect(ups, 'no native key-up can come now, and the app may not have focus').toBe(1);
    });

    it('a re-registration that throws does too', async () => {
        await startNativeFeed(['voice.ptt'], [32]);
        edge(32, true);
        invoke.mockRejectedValue(new Error('no shell'));
        await startNativeFeed(['voice.ptt'], [32]);
        expect(ups).toBe(1);
    });

    it('positive control: a refused start with no live feed leaves an in-app hold alone', async () => {
        // Nothing fell over: the in-app listeners were the only feed before and
        // still are, and they will see the key come up.
        const e = new KeyboardEvent('keydown', { bubbles: true });
        Object.defineProperty(e, 'keyCode', { value: 32 });
        window.dispatchEvent(e);
        invoke.mockResolvedValue(false);
        await startNativeFeed(['voice.ptt'], [32]);
        expect(ups).toBe(0);
    });

    it('a re-registration that succeeds leaves a held key held', async () => {
        await startNativeFeed(['voice.ptt'], [32]);
        edge(32, true);
        await startNativeFeed(['voice.toggleMute', 'voice.ptt'], [77, 32]);
        expect(ups).toBe(0);
        edge(32, false);
        expect(ups).toBe(1);
    });

    it('the release the native side owes reaches the page while the new list is still on its way', async () => {
        await startNativeFeed(['voice.ptt', 'voice.toggleMute'], [32, 77]);
        edge(32, true);
        // start() answers only after it has sent the release: the page has
        // narrowed its allow-list and is still waiting on the command.
        let answer: (hooked: boolean) => void = () => {};
        invoke.mockImplementation(() => new Promise<boolean>(r => { answer = r; }));
        const restart = startNativeFeed(['voice.toggleMute'], [77]);
        await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('start_hotkey_listener', { keys: [77] }));
        edge(32, false);
        expect(ups).toBe(1);
        answer(true);
        await restart;
    });

    it('stopping the feed releases what it held, because the native side will not', async () => {
        // hotkeys.rs stop() clears its bits and emits nothing; this is why it may.
        await startNativeFeed(['voice.ptt'], [32]);
        edge(32, true);
        await stopNativeFeed('left voice');
        expect(ups).toBe(1);
    });
});
