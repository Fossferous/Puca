// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    eventMatchesBinding,
    matchesRegisteredHotkey,
    registerHold,
    unregisterHold,
    registerPress,
    resetHotkeysForTest,
    nativeKeyEvent,
} from '../api/hotkeys';
import type { KeyBinding } from '../components/settingsStore';

const SPACE: KeyBinding = { keyCode: 32, ctrl: false, alt: false, shift: false, label: 'Space' };
const CTRL_M: KeyBinding = { keyCode: 77, ctrl: true, alt: false, shift: false, label: 'M' };

function key(type: 'keydown' | 'keyup', keyCode: number, opts: Partial<KeyboardEventInit> & { repeat?: boolean } = {}) {
    const e = new KeyboardEvent(type, { bubbles: true, ...opts });
    // KeyboardEventInit has no keyCode; jsdom stores what we define.
    Object.defineProperty(e, 'keyCode', { value: keyCode });
    if (opts.repeat) Object.defineProperty(e, 'repeat', { value: true });
    window.dispatchEvent(e);
}

describe('eventMatchesBinding', () => {
    it('requires the exact modifier set (press actions)', () => {
        expect(eventMatchesBinding({ keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false }, CTRL_M)).toBe(true);
        expect(eventMatchesBinding({ keyCode: 77, ctrlKey: false, altKey: false, shiftKey: false }, CTRL_M)).toBe(false);
        expect(eventMatchesBinding({ keyCode: 77, ctrlKey: true, altKey: true, shiftKey: false }, CTRL_M)).toBe(false);
        expect(eventMatchesBinding({ keyCode: 32, ctrlKey: true, altKey: false, shiftKey: false }, CTRL_M)).toBe(false);
    });

    it('subset mode tolerates extra modifiers (hold actions in games)', () => {
        // Holding PTT (Space) while sprinting with Shift must still transmit.
        expect(eventMatchesBinding({ keyCode: 32, ctrlKey: false, altKey: false, shiftKey: true }, SPACE, 'subset')).toBe(true);
        expect(eventMatchesBinding({ keyCode: 32, ctrlKey: true, altKey: true, shiftKey: true }, SPACE, 'subset')).toBe(true);
        // …but the binding's OWN modifiers are still required.
        expect(eventMatchesBinding({ keyCode: 77, ctrlKey: false, altKey: false, shiftKey: false }, CTRL_M, 'subset')).toBe(false);
        expect(eventMatchesBinding({ keyCode: 77, ctrlKey: true, altKey: false, shiftKey: true }, CTRL_M, 'subset')).toBe(true);
        // Wrong key never matches.
        expect(eventMatchesBinding({ keyCode: 65, ctrlKey: false, altKey: false, shiftKey: true }, SPACE, 'subset')).toBe(false);
    });
});

describe('matchesRegisteredHotkey', () => {
    afterEach(() => resetHotkeysForTest());

    it('matches EXACTLY for both kinds — deliberately narrower than hold dispatch', () => {
        registerPress('t.press', () => CTRL_M, () => { /* noop */ });
        registerHold('t.hold', () => SPACE, { onDown: () => { /* noop */ }, onUp: () => { /* noop */ } });

        // Press: exact modifiers only.
        expect(matchesRegisteredHotkey({ keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false })).toBe(true);
        expect(matchesRegisteredHotkey({ keyCode: 77, ctrlKey: true, altKey: false, shiftKey: true }),
            'extra Shift must NOT claim a press binding — dispatch would not fire it').toBe(false);
        // Hold: the bare binding matches…
        expect(matchesRegisteredHotkey({ keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false })).toBe(true);
        // …but extra modifiers do NOT, even though hold DISPATCH subset-
        // matches them: a PTT on bare V must not swallow Ctrl+V from the
        // remote-control stage (paste would silently stop reaching the host).
        expect(matchesRegisteredHotkey({ keyCode: 32, ctrlKey: false, altKey: false, shiftKey: true })).toBe(false);
        // Unrelated key (positive control that false is reachable).
        expect(matchesRegisteredHotkey({ keyCode: 65, ctrlKey: false, altKey: false, shiftKey: false })).toBe(false);
    });

    it('matches nothing when nothing is registered', () => {
        expect(matchesRegisteredHotkey({ keyCode: 77, ctrlKey: true, altKey: false, shiftKey: false })).toBe(false);
    });
});

describe('hold actions', () => {
    let downs = 0;
    let ups = 0;

    beforeEach(() => {
        downs = 0; ups = 0;
        registerHold('t.hold', () => SPACE, {
            onDown: () => { downs++; },
            onUp: () => { ups++; },
        });
    });
    afterEach(() => resetHotkeysForTest());

    it('fires onDown once per press and onUp on release', () => {
        key('keydown', 32);
        key('keydown', 32, { repeat: true }); // OS auto-repeat
        key('keydown', 32, { repeat: true });
        expect(downs).toBe(1);
        expect(ups).toBe(0);
        key('keyup', 32);
        expect(ups).toBe(1);
    });

    it('releases the key on keyup even if modifiers changed mid-hold', () => {
        key('keydown', 32);
        key('keyup', 32, { shiftKey: true }); // let go of Space after pressing Shift
        expect(ups).toBe(1);
    });

    it('releases on window blur — never a stuck mic across alt-tab', () => {
        key('keydown', 32);
        window.dispatchEvent(new Event('blur'));
        expect(ups).toBe(1);
        // A later keyup for the already-released key must not double-fire.
        key('keyup', 32);
        expect(ups).toBe(1);
    });

    it('unregister releases a held key', () => {
        key('keydown', 32);
        unregisterHold('t.hold');
        expect(ups).toBe(1);
    });

    it('ignores non-matching keys', () => {
        key('keydown', 65);
        expect(downs).toBe(0);
    });

    it('fires a plain-key hold even while a game modifier is held', () => {
        // Regression: exact modifier matching meant Space+Shift (sprinting)
        // silently failed to open the mic — exactly when you are talking.
        key('keydown', 32, { shiftKey: true });
        expect(downs).toBe(1);
        key('keyup', 32, { shiftKey: true });
        expect(ups).toBe(1);
    });

    it('accepts native hook events through the same registry', () => {
        nativeKeyEvent('down', { keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false });
        expect(downs).toBe(1);
        nativeKeyEvent('up', { keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false });
        expect(ups).toBe(1);
    });

    it('scopes native dispatch to the allowed actions only', () => {
        // The native feed is restricted to voice actions — a global keypress
        // must not trigger unrelated actions sharing the same key.
        nativeKeyEvent('down', { keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false },
            new Set(['some.other.action']));
        expect(downs).toBe(0);
        nativeKeyEvent('down', { keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false },
            new Set(['t.hold']));
        expect(downs).toBe(1);
    });

    it('reads the binding per event, so a rebind applies live', () => {
        let binding = SPACE;
        registerHold('t.rebind', () => binding, {
            onDown: () => { downs += 10; },
            onUp: () => { /* not asserted */ },
        });
        binding = { keyCode: 66, ctrl: false, alt: false, shift: false, label: 'B' };
        key('keydown', 32); // old key: matches t.hold (downs+1) but not t.rebind
        key('keydown', 66); // new key: t.rebind only
        expect(downs).toBe(11);
    });
});

describe('press actions', () => {
    afterEach(() => resetHotkeysForTest());

    it('suppresses plain keys in editable targets but allows modified ones', () => {
        let plain = 0;
        let modified = 0;
        registerPress('t.plain', () => ({ keyCode: 75, ctrl: false, alt: false, shift: false, label: 'K' }), () => { plain++; });
        registerPress('t.mod', () => CTRL_M, () => { modified++; });

        const input = document.createElement('input');
        document.body.appendChild(input);
        const onInput = (type: 'keydown', keyCode: number, init: KeyboardEventInit) => {
            const e = new KeyboardEvent(type, { bubbles: true, ...init });
            Object.defineProperty(e, 'keyCode', { value: keyCode });
            input.dispatchEvent(e);
        };
        onInput('keydown', 75, {});                  // typing "k" in the input
        onInput('keydown', 77, { ctrlKey: true });   // Ctrl+M in the input
        expect(plain).toBe(0);
        expect(modified).toBe(1);
        key('keydown', 75); // outside an input, plain fires
        expect(plain).toBe(1);
        input.remove();
    });
});

/**
 * Bindings are UNSET by default now and every one can be cleared with the
 * trash control, so "no binding" is the common case rather than an edge case.
 * An unbound action must match nothing at all — and must not throw, which
 * matters because loadSettings() spreads a JSON.parse and its `any` hides
 * these dereferences from the typechecker.
 */
describe('unbound keybinds', () => {
    beforeEach(() => resetHotkeysForTest());
    afterEach(() => resetHotkeysForTest());

    it('matches no event', () => {
        expect(eventMatchesBinding({ keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false }, null)).toBe(false);
        expect(eventMatchesBinding({ keyCode: 0, ctrlKey: false, altKey: false, shiftKey: false }, null)).toBe(false);
        expect(eventMatchesBinding({ keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false }, undefined)).toBe(false);
    });

    it('never fires a hold action, and keyup does not throw', () => {
        let downs = 0, ups = 0;
        registerHold('test.unbound', () => null, { onDown: () => downs++, onUp: () => ups++ });
        key('keydown', 32);
        key('keyup', 32);
        expect(downs).toBe(0);
        expect(ups).toBe(0);
        unregisterHold('test.unbound');
    });

    it('never fires a press action', () => {
        let presses = 0;
        registerPress('test.unboundPress', () => null, () => presses++);
        key('keydown', 77, { ctrlKey: true });
        expect(presses).toBe(0);
    });

    it('ignores the native feed for an unbound action', () => {
        let downs = 0;
        registerHold('test.unboundNative', () => null, { onDown: () => downs++, onUp: () => { } });
        nativeKeyEvent({ keyCode: 32, ctrlKey: false, altKey: false, shiftKey: false, down: true });
        expect(downs).toBe(0);
        unregisterHold('test.unboundNative');
    });
});
