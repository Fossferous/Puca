// @vitest-environment jsdom
/**
 * api/keyboardUp.ts: the phone's bottom tab bar steps aside while the soft
 * keyboard is up for a text field (mobile.css, :root[data-keyboard-up]).
 * Before 2026-11-12 it stayed on top of the keyboard while typing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    native: null as ((d: { visible: boolean; topPx?: number }) => void) | null,
    state: null as { visible: boolean; topPx: number; viewHeightPx: number } | null,
}));

vi.mock('../api/mobileApp', () => ({
    mobileKeyboardState: async () => h.state,
    onMobileKeyboard: async (cb: (d: { visible: boolean; topPx?: number }) => void) => {
        h.native = cb;
        return { remove: async () => { h.native = null; } };
    },
}));

import { installKeyboardUp, isTextEntry, keyboardIsUp } from '../api/keyboardUp';

const up = () => 'keyboardUp' in document.documentElement.dataset;
const settle = () => new Promise(r => setTimeout(r, 0));

describe('keyboardIsUp', () => {
    const base = { typing: true, nativeVisible: null, layoutHeight: 844, visualHeight: 844 };
    it('the Android app: its own answer, whatever the viewport says', () => {
        expect(keyboardIsUp({ ...base, nativeVisible: true })).toBe(true);
        // Back closed the keyboard and left the field focused.
        expect(keyboardIsUp({ ...base, nativeVisible: false, visualHeight: 400 })).toBe(false);
    });
    it('an iPhone or a phone browser: the visual viewport shrank by a keyboard', () => {
        expect(keyboardIsUp({ ...base, visualHeight: 470 })).toBe(true);
        expect(keyboardIsUp({ ...base, visualHeight: 800 })).toBe(false); // a URL bar
        expect(keyboardIsUp({ ...base, visualHeight: null })).toBe(false);
    });
    it('nothing is typed into: never, keyboard or not', () => {
        expect(keyboardIsUp({ ...base, typing: false, nativeVisible: true })).toBe(false);
        expect(keyboardIsUp({ ...base, typing: false, visualHeight: 470 })).toBe(false);
    });
});

describe('isTextEntry', () => {
    it('fields typed into, and not the ones that are not', () => {
        const make = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
        expect(isTextEntry(make('<textarea></textarea>'))).toBe(true);
        expect(isTextEntry(make('<input type="text">'))).toBe(true);
        expect(isTextEntry(make('<input type="search">'))).toBe(true);
        expect(isTextEntry(make('<input type="password">'))).toBe(true);
        expect(isTextEntry(make('<input type="checkbox">'))).toBe(false);
        expect(isTextEntry(make('<input type="range">'))).toBe(false);
        expect(isTextEntry(make('<textarea readonly></textarea>'))).toBe(false);
        expect(isTextEntry(make('<button></button>'))).toBe(false);
        expect(isTextEntry(null)).toBe(false);
    });
});

describe('installKeyboardUp marks <html>', () => {
    let stop: () => void;
    let box: HTMLTextAreaElement;
    beforeEach(() => {
        h.native = null;
        h.state = null;
        box = document.createElement('textarea');
        document.body.appendChild(box);
        stop = installKeyboardUp();
    });
    afterEach(() => {
        stop();
        box.remove();
    });

    it('the Android app: up while its keyboard is up for the message box, down after Back closes it', async () => {
        await settle();
        box.focus();
        expect(up()).toBe(false); // focused, no keyboard yet
        h.native!({ visible: true });
        expect(up()).toBe(true);
        h.native!({ visible: false }); // Back: the box keeps the focus
        expect(document.activeElement).toBe(box);
        expect(up()).toBe(false);
        h.native!({ visible: true });
        box.blur();
        await settle();
        expect(up()).toBe(false);
    });

    it('control: a keyboard event with nothing focused (a hardware keyboard, a field that went away) leaves the bar', async () => {
        await settle();
        h.native!({ visible: true });
        expect(up()).toBe(false);
    });

    it('the app\'s "nothing measured yet" (topPx -1, Android 7 to 10 for good) is no answer: the visual viewport decides', async () => {
        // Review finding: read as "keyboard down", it locked the viewport out for the session.
        stop();
        await settle(); // the first install's listener is let go before the second one's arrives
        const vv = Object.assign(new EventTarget(), { height: window.innerHeight, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
        h.state = { visible: false, topPx: -1, viewHeightPx: 0 };
        stop = installKeyboardUp();
        await settle();
        h.native!({ visible: false, topPx: -1 });
        box.focus();
        vv.height = Math.round(window.innerHeight * 0.55);
        vv.dispatchEvent(new Event('resize'));
        expect(up()).toBe(true);
        // CONTROL: a measured "down" from the app is believed over the viewport.
        h.native!({ visible: false, topPx: 900 });
        expect(up()).toBe(false);
        Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
    });

    it('stopping takes the mark away', async () => {
        await settle();
        box.focus();
        h.native!({ visible: true });
        expect(up()).toBe(true);
        stop();
        expect(up()).toBe(false);
        stop = () => {};
    });
});
