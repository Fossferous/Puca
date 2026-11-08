// @vitest-environment jsdom
/**
 * Pinned keys (api/devices/pinnedKeys.ts): what can be pinned, what a pin
 * presses, and what survives storage.
 *
 * THE CATALOGUE IS CHECKED AGAINST THE HOST'S OWN SOURCE. A code the picker
 * offers but the host's `code_to_vk` (crates/puca-input/src/lib.rs) does not
 * map travels the whole way and is dropped over there with nothing shown —
 * a pinned button that does nothing. So this reads the Rust function and
 * requires every catalogue code to be mapped by it, and every code the page
 * allows (isInjectableKey) too. And the reverse claim the editor makes in
 * words — media and volume keys cannot be sent — is pinned the same way: the
 * day the host learns them, this fails and asks for the catalogue (and the
 * sentence) to follow.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    KEY_CATALOG, MAX_PINS, MAX_SHADE, PINS_STORE_KEY, SAS_CODE,
    canonicalPin, isPinnableCode, makePin, movePin, pinCodes, pinLabel, pinName, pinTapFrames, refusedChord,
    readPins, readShowPins, samePin, sanitizePins, setShade, writePins, writeShowPins,
    type PinnedKey,
} from '../api/devices/pinnedKeys';
import { isInjectableKey } from '../api/devices/pointerMapping';

const rust = readFileSync(resolve(__dirname, '../../../crates/puca-input/src/lib.rs'), 'utf8').replace(/\r/g, '');
const fnStart = rust.indexOf('fn code_to_vk(');
const codeToVk = rust.slice(fnStart, rust.indexOf('\n}\n', fnStart));

/** Does the host's code_to_vk map this code? Its prefix rules, then its table. */
function hostMaps(code: string): boolean {
    if (/^Key[A-Z]$/.test(code) && codeToVk.includes('strip_prefix("Key")')) return true;
    if (/^Digit[0-9]$/.test(code) && codeToVk.includes('strip_prefix("Digit")')) return true;
    if (/^Numpad[0-9]$/.test(code) && codeToVk.includes('strip_prefix("Numpad")') && codeToVk.includes('*d <= 9')) return true;
    const f = /^F(\d+)$/.exec(code);
    if (f && codeToVk.includes("strip_prefix('F')") && codeToVk.includes('(1..=24)')) {
        const n = Number(f[1]);
        return n >= 1 && n <= 24;
    }
    return new RegExp(`"${code}"( \\| "[A-Za-z]+")* =>|\\| "${code}" =>`).test(codeToVk);
}

const allCodes = KEY_CATALOG.flatMap(g => g.keys.map(k => k.code));
const pin = (code: string, mods: PinnedKey['mods'] = [], id = 'a1', shade = false): PinnedKey => ({ id, code, mods, shade });

describe('what can be pinned', () => {
    it('found the host function it checks against (or every check below would be vacuous)', () => {
        expect(fnStart).toBeGreaterThan(0);
        expect(codeToVk).toContain('"Escape" => VK_ESCAPE');
        // CONTROLS for the checker itself: a mapped code is found, an unmapped one is not.
        expect(hostMaps('PageDown')).toBe(true);
        expect(hostMaps('F24')).toBe(true);
        expect(hostMaps('NumpadEnter')).toBe(true);
        expect(hostMaps('F25')).toBe(false);
        expect(hostMaps('Fn')).toBe(false);
    });

    it('every key in the picker is one the page forwards AND the host maps', () => {
        const keys = allCodes.filter(c => c !== SAS_CODE);
        expect(keys.length).toBeGreaterThan(100);
        const notForwarded = keys.filter(c => !isInjectableKey(c));
        const notMapped = keys.filter(c => !hostMaps(c));
        expect(notForwarded).toEqual([]);
        expect(notMapped).toEqual([]);
    });

    it('offers the keys asked for: letters, digits, F1-F24, arrows, Enter, Esc, Tab, Space, Backspace, Delete, Home/End/PgUp/PgDn, Insert', () => {
        for (const c of ['KeyA', 'KeyZ', 'Digit0', 'Digit9', 'F1', 'F12', 'F24', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
            'Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', SAS_CODE]) {
            expect(isPinnableCode(c), c).toBe(true);
        }
        expect(new Set(allCodes).size).toBe(allCodes.length); // no key listed twice
    });

    it('Pause is NOT offered: the host maps it and then refuses to inject it', () => {
        // The crate's own test pins the refusal; when it stops refusing, this
        // fails so Pause can be offered (and the docs' sentence changed).
        expect(rust).toContain('assert!(inject(ControlInput::Key { code: "Pause".into(), down: true }).is_err());');
        expect(rust).toContain('no scan code for {code}');
        expect(isPinnableCode('Pause')).toBe(false);
    });

    it('media and volume keys are NOT offered, because the host cannot press them', () => {
        const media = ['MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaStop', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute'];
        for (const c of media) {
            expect(isPinnableCode(c), c).toBe(false);
            // The editor says so in words; when the host learns one, this
            // fails so the catalogue and the sentence follow it.
            expect(hostMaps(c), `the host now maps ${c}: offer it and change the editor's note`).toBe(false);
            expect(codeToVk).not.toMatch(/VK_MEDIA_|VK_VOLUME_/);
        }
    });
});

describe('what a pin presses', () => {
    it('modifiers first in Win, Ctrl, Alt, Shift order, then the key; released in reverse', () => {
        const p = pin('KeyS', ['shift', 'win']);
        expect(pinCodes(p)).toEqual(['MetaLeft', 'ShiftLeft', 'KeyS']);
        expect(pinTapFrames(p)).toEqual([
            { t: 'key', code: 'MetaLeft', down: true },
            { t: 'key', code: 'ShiftLeft', down: true },
            { t: 'key', code: 'KeyS', down: true },
            { t: 'key', code: 'KeyS', down: false },
            { t: 'key', code: 'ShiftLeft', down: false },
            { t: 'key', code: 'MetaLeft', down: false },
        ]);
        expect(pinLabel(p)).toBe('Win+Shift+S');
        expect(pinName(p)).toBe('Win + Shift + S');
    });

    it('Ctrl+Alt+Del is the Secure Attention frame, never three injected keys', () => {
        const p = pin(SAS_CODE, ['ctrl', 'alt']);
        expect(pinCodes(p)).toBeNull();
        expect(pinTapFrames(p)).toEqual([{ t: 'sas' }]);
        expect(pinLabel(p)).toBe('Ctrl+Alt+Del');
    });

    it('a modifier pinned with itself held presses it once', () => {
        const p = pin('ControlLeft', ['ctrl', 'shift']);
        expect(pinCodes(p)).toEqual(['ShiftLeft', 'ControlLeft']);
        expect(pinLabel(p)).toBe('Shift+Ctrl');
    });

    it('Ctrl + Alt + Delete chosen as keys IS the Secure Attention pin (three injected keys do nothing)', () => {
        expect(canonicalPin('Delete', ['alt', 'ctrl'])).toEqual({ code: SAS_CODE, mods: [] });
        expect(canonicalPin('Delete', ['ctrl', 'alt', 'shift'])).toEqual({ code: SAS_CODE, mods: [] });
        expect(canonicalPin('Delete', ['ctrl'])).toEqual({ code: 'Delete', mods: ['ctrl'] });
        expect(canonicalPin('NumpadDecimal', ['ctrl', 'alt'])).toEqual({ code: SAS_CODE, mods: [] });   // the number pad's Del
        expect(makePin('Delete', ['ctrl', 'alt'], []).code).toBe(SAS_CODE);
        expect(samePin(pin('Delete', ['ctrl', 'alt']), pin(SAS_CODE))).toBe(true);
        expect(pinTapFrames(makePin('Delete', ['ctrl', 'alt'], []))).toEqual([{ t: 'sas' }]);
    });

    it('Win + L is refused (Windows does not lock for it injected); Win + other letters are not', () => {
        expect(refusedChord('KeyL', ['win'])).toMatch(/Lock in the More menu/);
        expect(refusedChord('KeyL', ['win', 'shift'])).not.toBeNull();
        expect(refusedChord('KeyL', ['ctrl'])).toBeNull();
        expect(refusedChord('KeyD', ['win'])).toBeNull();
    });

    it('same key and modifiers is the same pin, in any order; SAS ignores modifiers', () => {
        expect(samePin(pin('KeyC', ['shift', 'ctrl']), pin('KeyC', ['ctrl', 'shift']))).toBe(true);
        expect(samePin(pin('KeyC', ['ctrl']), pin('KeyC', []))).toBe(false);
        expect(samePin(pin(SAS_CODE, ['ctrl']), pin(SAS_CODE, []))).toBe(true);
    });
});

describe('the list', () => {
    // setup.ts makes localStorage a set of bare vi.fn()s; give it a memory.
    const store = new Map<string, string>();
    beforeEach(() => {
        store.clear();
        vi.mocked(localStorage.getItem).mockImplementation(k => store.get(k) ?? null);
        vi.mocked(localStorage.setItem).mockImplementation((k, v) => { store.set(k, String(v)); });
    });

    it('survives a reload: written, read back the same', () => {
        const a = makePin('F5', [], []);
        const b = makePin('KeyC', ['ctrl'], [a]);
        expect(a.id).not.toBe(b.id);
        writePins([a, { ...b, shade: true }]);
        expect(readPins()).toEqual([a, { ...b, shade: true }]);
    });

    it('whatever storage holds is made safe: unknown keys, bad ids, duplicates and extras dropped', () => {
        localStorage.setItem(PINS_STORE_KEY, JSON.stringify([
            { id: 'ok1', code: 'F5', mods: [], shade: true },
            { id: 'BAD', code: 'F6', mods: [] },
            { id: 'ok2', code: 'MediaPlayPause', mods: [] },     // the host cannot press it
            { id: 'ok3', code: 'F5', mods: [] },                 // the same pin again
            { id: 'ok4', code: 'KeyV', mods: ['ctrl', 'hyper', 7], shade: true },
            null, 'F7', { id: 'ok5' },
            { id: 'ok6', code: 'KeyL', mods: ['win'] },               // refused chord
            { id: 'ok7', code: 'Pause', mods: [] },                   // the host refuses it
            { id: 'ok8', code: 'Delete', mods: ['ctrl', 'alt'] },     // becomes the SAS pin
        ]));
        expect(readPins()).toEqual([
            { id: 'ok1', code: 'F5', mods: [], shade: true },
            { id: 'ok4', code: 'KeyV', mods: ['ctrl'], shade: true },
            { id: 'ok8', code: SAS_CODE, mods: [], shade: false },
        ]);
        localStorage.setItem(PINS_STORE_KEY, '{not json');
        expect(readPins()).toEqual([]);
    });

    it('at most MAX_PINS, and at most MAX_SHADE keep their notification flag (the first ones)', () => {
        const many = Array.from({ length: MAX_PINS + 3 }, (_, i) => ({ id: 'k' + i, code: 'F' + (i + 1), mods: [], shade: true }));
        const safe = sanitizePins(many);
        expect(safe).toHaveLength(MAX_PINS);
        expect(safe.filter(p => p.shade).map(p => p.id)).toEqual(['k0', 'k1', 'k2']);
        expect(MAX_SHADE).toBe(3);
    });

    it('reorders one place at a time and ignores a move off either end', () => {
        const list = [pin('F1', [], 'a'), pin('F2', [], 'b'), pin('F3', [], 'c')];
        expect(movePin(list, 2, -1).map(p => p.id)).toEqual(['a', 'c', 'b']);
        expect(movePin(list, 0, 1).map(p => p.id)).toEqual(['b', 'a', 'c']);
        expect(movePin(list, 0, -1).map(p => p.id)).toEqual(['a', 'b', 'c']);
        expect(movePin(list, 2, 1).map(p => p.id)).toEqual(['a', 'b', 'c']);
    });

    it('a fourth key cannot join the notification; turning one off makes room', () => {
        let list = [pin('F1', [], 'a', true), pin('F2', [], 'b', true), pin('F3', [], 'c', true), pin('F4', [], 'd')];
        expect(setShade(list, 'd', true).find(p => p.id === 'd')!.shade).toBe(false);
        list = setShade(list, 'a', false);
        expect(setShade(list, 'd', true).find(p => p.id === 'd')!.shade).toBe(true);
    });

    it('"Show pinned keys" is on until turned off, and remembered', () => {
        expect(readShowPins()).toBe(true);
        writeShowPins(false);
        expect(readShowPins()).toBe(false);
        writeShowPins(true);
        expect(readShowPins()).toBe(true);
    });
});
