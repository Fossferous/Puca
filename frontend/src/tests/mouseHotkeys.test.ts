/**
 * Mouse-button hotkey bindings (the "PTT/PTM on Mouse 4" feature) and the
 * push-to-mute-hold regression: mouse buttons ride the same VK space as keys
 * (BUTTON_TO_VK) through the existing hold/press machinery, driven by real
 * window mouse events in the in-app feed.
 *
 * Context for the PTM report ("hold to mute doesn't work, toggles do"): the
 * hold machinery itself is sound — these tests prove a hold binding tracks
 * down/up edges for both keyboard (via nativeKeyEvent) and mouse (via the
 * window feed). What CANNOT hold is a mouse side button that the mouse
 * driver emits as a media-key PULSE (down+up in one instant, e.g. VK 178) —
 * binding the real button, which this feature enables, is the fix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    registerHold, unregisterHold, registerPress, unregisterPress,
    nativeKeyEvent, setHotkeyCaptureMode,
} from '../api/hotkeys';
import { VK_XBUTTON1, VK_XBUTTON2, BUTTON_TO_VK } from '../api/inputCodes';
import type { KeyBinding } from '../components/settingsStore';

const bind = (keyCode: number): KeyBinding =>
    ({ keyCode, ctrl: false, alt: false, shift: false, label: `vk${keyCode}` });

const mouse = (type: string, button: number) =>
    window.dispatchEvent(new MouseEvent(type, { button, cancelable: true }));

describe('mouse-button hotkeys', () => {
    let downs = 0;
    let ups = 0;

    beforeEach(() => {
        downs = 0; ups = 0;
        setHotkeyCaptureMode(false);
        registerHold('test.hold', () => bind(VK_XBUTTON1), {
            onDown: () => { downs++; },
            onUp: () => { ups++; },
        });
    });

    afterEach(() => {
        unregisterHold('test.hold');
        unregisterPress('test.press');
    });

    it('holds across mousedown/mouseup of the bound button (Mouse 4)', () => {
        mouse('mousedown', 3); // DOM button 3 = XBUTTON1
        expect(downs).toBe(1);
        expect(ups).toBe(0);
        mouse('mouseup', 3);
        expect(ups).toBe(1);
    });

    it('ignores unbound buttons and never reacts to left click', () => {
        mouse('mousedown', 1); // middle — not bound
        mouse('mousedown', 0); // left — never a hotkey
        mouse('mouseup', 1);
        mouse('mouseup', 0);
        expect(downs).toBe(0);
        expect(ups).toBe(0);
    });

    it('prevents the default action of a BOUND button (X-button history nav)', () => {
        const e = new MouseEvent('mousedown', { button: 3, cancelable: true });
        window.dispatchEvent(e);
        expect(e.defaultPrevented).toBe(true);
        const up = new MouseEvent('mouseup', { button: 3, cancelable: true });
        window.dispatchEvent(up);
        expect(up.defaultPrevented).toBe(true);
    });

    it('leaves an UNBOUND button\'s default alone', () => {
        const e = new MouseEvent('mousedown', { button: 4, cancelable: true });
        window.dispatchEvent(e);
        expect(e.defaultPrevented).toBe(false);
    });

    it('a modifier-bound button clicked WITHOUT the modifier stays a normal click', () => {
        unregisterHold('test.hold');
        registerHold('test.hold', () => ({ keyCode: VK_XBUTTON1, ctrl: true, alt: false, shift: false, label: 'Ctrl+M4' }), {
            onDown: () => { downs++; },
            onUp: () => { ups++; },
        });
        const e = new MouseEvent('mousedown', { button: 3, cancelable: true });
        window.dispatchEvent(e);
        expect(downs).toBe(0);                 // no match without Ctrl
        expect(e.defaultPrevented).toBe(false); // and the click is NOT swallowed
        const aux = new MouseEvent('auxclick', { button: 3, cancelable: true });
        window.dispatchEvent(aux);
        expect(aux.defaultPrevented).toBe(false); // follow-up untouched too
    });

    it('the follow-up auxclick of a MATCHED press is swallowed', () => {
        mouse('mousedown', 3);
        expect(downs).toBe(1);
        mouse('mouseup', 3);
        const aux = new MouseEvent('auxclick', { button: 3, cancelable: true });
        window.dispatchEvent(aux);
        expect(aux.defaultPrevented).toBe(true);
    });

    it('fires press actions bound to a mouse button', () => {
        let presses = 0;
        registerPress('test.press', () => bind(VK_XBUTTON2), () => { presses++; });
        mouse('mousedown', 4); // XBUTTON2
        expect(presses).toBe(1);
    });

    it('capture mode suspends the mouse feed', () => {
        setHotkeyCaptureMode(true);
        mouse('mousedown', 3);
        expect(downs).toBe(0);
        setHotkeyCaptureMode(false);
    });

    it('the NATIVE feed drives the same hold with a mouse VK (global path)', () => {
        const key = { keyCode: VK_XBUTTON1, ctrlKey: false, altKey: false, shiftKey: false };
        nativeKeyEvent('down', key, new Set(['test.hold']));
        expect(downs).toBe(1);
        nativeKeyEvent('up', key, new Set(['test.hold']));
        expect(ups).toBe(1);
    });

    it('PTM-style keyboard hold still tracks edges (regression guard)', () => {
        let held = false;
        registerHold('test.ptm', () => bind(77), {
            onDown: () => { held = true; },
            onUp: () => { held = false; },
        });
        const m = { keyCode: 77, ctrlKey: false, altKey: false, shiftKey: false };
        nativeKeyEvent('down', m, new Set(['test.ptm']));
        expect(held).toBe(true);
        nativeKeyEvent('up', m, new Set(['test.ptm']));
        expect(held).toBe(false);
        unregisterHold('test.ptm');
    });

    it('BUTTON_TO_VK maps every DOM button to its Windows VK', () => {
        expect(BUTTON_TO_VK[0]).toBe(1);
        expect(BUTTON_TO_VK[1]).toBe(4);
        expect(BUTTON_TO_VK[2]).toBe(2);
        expect(BUTTON_TO_VK[3]).toBe(5);
        expect(BUTTON_TO_VK[4]).toBe(6);
    });
});

// vi is imported for parity with the suite's lint expectations.
void vi;
