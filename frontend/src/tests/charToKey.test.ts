/**
 * The latch's character re-route: while a modifier is held, a typed character
 * travels as the PHYSICAL key that produces it (a text frame is
 * KEYEVENTF_UNICODE on the host, which no held modifier can touch).
 *
 * The load-bearing assertion is the ALLOWLIST CROSS-CHECK: a code emitted
 * here that `isInjectableKey` refuses — or that crates/puca-input's
 * `code_to_vk` does not map — is a key that travels the whole way and is
 * dropped at the far end with nothing shown to anyone. `isInjectableKey`'s
 * own comment pins it to `code_to_vk`, so checking against it checks both.
 */
import { describe, it, expect } from 'vitest';
import { charToKey, MAPPABLE_CHARS } from '../api/devices/charToKey';
import { isInjectableKey } from '../api/devices/pointerMapping';

describe('charToKey', () => {
    it('letters map to their key, uppercase carrying Shift', () => {
        expect(charToKey('a')).toEqual({ code: 'KeyA', shift: false });
        expect(charToKey('z')).toEqual({ code: 'KeyZ', shift: false });
        expect(charToKey('A')).toEqual({ code: 'KeyA', shift: true });
    });

    it('digits and space map plainly', () => {
        expect(charToKey('0')).toEqual({ code: 'Digit0', shift: false });
        expect(charToKey('9')).toEqual({ code: 'Digit9', shift: false });
        expect(charToKey(' ')).toEqual({ code: 'Space', shift: false });
    });

    it('US punctuation maps to its position, shifted glyphs carrying Shift', () => {
        expect(charToKey('/')).toEqual({ code: 'Slash', shift: false });
        expect(charToKey('?')).toEqual({ code: 'Slash', shift: true });
        expect(charToKey('=')).toEqual({ code: 'Equal', shift: false });
        expect(charToKey('+')).toEqual({ code: 'Equal', shift: true });
        expect(charToKey('!')).toEqual({ code: 'Digit1', shift: true });
    });

    it('anything without a US-keyboard position is null — the text path takes it', () => {
        expect(charToKey('é')).toBeNull();
        expect(charToKey('あ')).toBeNull();
        expect(charToKey('😀')).toBeNull();
        expect(charToKey('ab'), 'more than one character is never a key').toBeNull();
        expect(charToKey('')).toBeNull();
    });

    it('EVERY emitted code passes the injectable-key allowlist', () => {
        // The allowlist is pinned to the host's code_to_vk map; a mapping this
        // module invents that the allowlist refuses is a silently dead key.
        expect(MAPPABLE_CHARS.length).toBeGreaterThan(80); // the map is real
        for (const ch of MAPPABLE_CHARS) {
            const key = charToKey(ch);
            expect(key, `charToKey must map its own advertised character ${JSON.stringify(ch)}`).not.toBeNull();
            expect(isInjectableKey(key!.code), `${JSON.stringify(ch)} → ${key!.code} must be injectable`).toBe(true);
        }
        // POSITIVE CONTROL: the cross-check can fail — a made-up code is refused.
        expect(isInjectableKey('KeyÉ')).toBe(false);
    });
});
