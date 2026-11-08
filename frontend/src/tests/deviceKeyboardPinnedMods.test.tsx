/**
 * The keyboard bar and a modifier a PINNED KEY holds (DeviceStagePinnedKeys).
 *
 * The bar types characters as `{t:'text'}`, which the Windows host injects
 * with KEYEVENTF_UNICODE, where a held modifier changes nothing. So "hold the
 * Ctrl pin, type c" used to type a "c" over the selection instead of copying
 * it. A modifier the stage reports as held elsewhere now makes the character
 * a chord, as the bar's own latch does — and the bar never presses or lifts a
 * Shift a pin holds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/mobileApp', () => ({ showMobileKeyboard: async () => false }));

import { KeyboardOverlay } from '../components/DeviceStageMobileKeyboard';

const send = vi.fn();
const holdKey = vi.fn();
let held = new Set<string>();
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(withHeld = true) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<KeyboardOverlay send={send} holdKey={holdKey} heldElsewhere={withHeld ? () => held : undefined} />);
    });
    return host.querySelector('input.device-stage-keyboard-capture') as HTMLInputElement;
}
function type(field: HTMLInputElement, value: string) {
    act(() => {
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const frames = () => send.mock.calls.map(c => c[0] as Record<string, unknown>);

beforeEach(() => { send.mockClear(); holdKey.mockClear(); held = new Set(); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

describe('the keyboard bar with a pinned key held', () => {
    it('a held Ctrl pin makes a typed "c" a chord: KeyC down and up, no text', () => {
        const field = mount();
        held = new Set(['ControlLeft']);
        type(field, field.value + 'c');
        expect(frames()).toEqual([
            { t: 'key', code: 'KeyC', down: true },
            { t: 'key', code: 'KeyC', down: false },
        ]);
    });

    it('a held Shift pin is neither pressed nor lifted by the bar for a capital', () => {
        const field = mount();
        held = new Set(['ShiftLeft', 'ControlLeft']);
        type(field, field.value + 'A');
        expect(frames()).toEqual([
            { t: 'key', code: 'KeyA', down: true },
            { t: 'key', code: 'KeyA', down: false },
        ]);
    });

    it('a Shift pin alone is no chord: a typed "@" stays exact text (a US key would differ on other layouts)', () => {
        const field = mount();
        held = new Set(['ShiftLeft']);
        type(field, field.value + '@');
        expect(frames()).toEqual([{ t: 'text', text: '@' }]);
    });

    it('a pinned key that is not a modifier changes nothing: text stays text', () => {
        const field = mount();
        held = new Set(['F5']);
        type(field, field.value + 'c');
        expect(frames()).toEqual([{ t: 'text', text: 'c' }]);
    });

    it('CONTROL: with nothing held elsewhere, a typed "c" is text, as before', () => {
        const field = mount(false);
        type(field, field.value + 'c');
        expect(frames()).toEqual([{ t: 'text', text: 'c' }]);
    });
});
