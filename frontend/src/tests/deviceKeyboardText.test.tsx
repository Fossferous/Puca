/**
 * Typing on a phone must actually reach the remote machine — and stop when the
 * user says stop.
 *
 * The mobile keyboard overlay had modifier and navigation keys and NO letters,
 * so "tapping the keyboard icon" produced a Ctrl/Alt/arrow pad and no way to
 * type a single character. The fix is not more buttons: it is a real, focusable
 * field that the Android IME types into, forwarded as TEXT rather than as key
 * codes — an IME reports `keyCode` 229 for every character and delivers what
 * was actually typed (including predictions, autocorrections and emoji) only as
 * text. There is no scan code to send.
 *
 * These tests pin the translation, because every failure mode here looks the
 * same from the phone: the keyboard appears, you type, and nothing happens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** The native "show the IME" (APKs from 0.8.104). Answers false by default —
 *  the web / old-APK case — and the raise tests flip it. */
const showMobileKeyboard = vi.fn(async () => false);
vi.mock('../api/mobileApp', () => ({
    showMobileKeyboard: () => showMobileKeyboard(),
}));

import { KeyboardOverlay } from '../components/DeviceStageMobileKeyboard';

const send = vi.fn();
/** The stage's latch registrar (heldKeysRef + gate-bypassing release). What
 *  reaches it is what survives blur/session-end release — a modifier sent
 *  through plain `send` instead would be invisible to that safety net. */
const holdKey = vi.fn();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<KeyboardOverlay send={send} holdKey={holdKey} />);
    });
    const field = host.querySelector('input.device-stage-keyboard-capture');
    expect(field, 'the capture field must exist or nothing can be typed').toBeTruthy();
    return field as HTMLInputElement;
}

/** Drive the field the way an IME does: change the value, then fire `input`. */
function type(field: HTMLInputElement, value: string) {
    act(() => {
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function sent(kind: string) {
    return send.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .filter((e) => e && e.t === kind);
}

function button(label: string) {
    const found = Array.from(host!.querySelectorAll('button')).find(
        (b) => b.textContent === label,
    );
    expect(found, `no button labelled ${label}`).toBeTruthy();
    return found!;
}

beforeEach(() => {
    send.mockClear();
    holdKey.mockClear();
    showMobileKeyboard.mockClear();
    showMobileKeyboard.mockImplementation(async () => false);
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe('the mobile keyboard forwards what was typed', () => {
    it('sends a typed character as text, not as a key code', () => {
        const field = mount();
        type(field, field.value + 'a');

        expect(sent('text')).toEqual([{ t: 'text', text: 'a' }]);
        expect(sent('key'), 'a character must not be sent as a key code').toEqual([]);
    });

    it('sends a whole word at once, because that is how a soft keyboard commits', () => {
        const field = mount();
        type(field, field.value + 'hello');
        expect(sent('text')).toEqual([{ t: 'text', text: 'hello' }]);
    });

    /**
     * The padding is the whole reason backspace works. Android fires no key
     * event for a backspace on an EMPTY field — there is nothing to delete — so
     * an unpadded field silently swallows every backspace.
     */
    it('turns a deleted padding character into a Backspace key', () => {
        const field = mount();
        const padded = field.value;
        expect(padded.length, 'the field must start padded').toBeGreaterThan(0);

        type(field, padded.slice(0, -1));
        expect(sent('key')).toEqual([
            { t: 'key', code: 'Backspace', down: true },
            { t: 'key', code: 'Backspace', down: false },
        ]);
        expect(sent('text'), 'a deletion is not text').toEqual([]);
    });

    /**
     * EVERY repeat has to be a COMPLETED press. The host drops a press for a key
     * it already holds and drops a release for one it never saw pressed, so
     * several presses in a row followed by their releases apply exactly ONE
     * deletion. That is holding backspace and losing a single character, or
     * Gboard's swipe-to-delete-a-word removing one letter.
     */
    it('completes each repeated key before starting the next', () => {
        const field = mount();
        type(field, field.value.slice(0, -3));

        expect(sent('key')).toEqual([
            { t: 'key', code: 'Backspace', down: true },
            { t: 'key', code: 'Backspace', down: false },
            { t: 'key', code: 'Backspace', down: true },
            { t: 'key', code: 'Backspace', down: false },
            { t: 'key', code: 'Backspace', down: true },
            { t: 'key', code: 'Backspace', down: false },
        ]);
    });

    it('restores the padding after every event, so backspace keeps working', () => {
        const field = mount();
        const padded = field.value;
        type(field, padded.slice(0, -1));
        expect(field.value).toBe(padded);
        send.mockClear();

        type(field, field.value.slice(0, -1));
        expect(sent('key').length, 'a second backspace was not seen').toBe(2);
    });

    /**
     * An IME that REPLACES the field — autocorrect, gesture typing, the
     * clipboard chip — delivers a value with no padding left, which is
     * indistinguishable from eight backspaces. Sending them would delete eight
     * characters the user had already committed to the remote machine, which
     * this field knows nothing about and cannot put back.
     */
    it('treats a replaced field as text, never as eight deletions', () => {
        const field = mount();
        type(field, 'corrected');

        expect(sent('text')).toEqual([{ t: 'text', text: 'corrected' }]);
        expect(sent('key'), 'a replacement must not delete committed text').toEqual([]);
    });

    /**
     * A carriage return typed literally is a real Enter on the remote machine —
     * enough to submit a form or run a line in whatever terminal has focus, as
     * a side effect of pasting. Enter exists deliberately, through the soft
     * keyboard's own key (PASSTHROUGH forwards it).
     */
    it('strips control characters out of pasted text', () => {
        const field = mount();
        type(field, field.value + 'line\r\nnext\tcol');
        expect(sent('text')).toEqual([{ t: 'text', text: 'linenextcol' }]);
    });

    /**
     * The host refuses an over-length event and that refusal is swallowed by
     * the injection path, so an unsplit paste would look exactly like the
     * keyboard being broken.
     */
    it('splits a long paste into chunks the host will accept', () => {
        const field = mount();
        type(field, field.value + 'x'.repeat(500));

        const texts = sent('text').map((e) => e.text as string);
        expect(texts.length).toBeGreaterThan(1);
        expect(texts.join('')).toBe('x'.repeat(500));
        for (const t of texts) expect(t.length).toBeLessThanOrEqual(256);
    });

    /**
     * Android reports `keyCode` 229 and a `key` of "Process"/"Unidentified" for
     * every character. A whitelist is what makes those harmless — but it must
     * not over-suppress: an Enter the IME names is still an Enter.
     */
    it('ignores an IME keydown but still forwards a key it names', () => {
        const field = mount();
        act(() => {
            field.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true }),
            );
            field.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Unidentified', bubbles: true }),
            );
        });
        expect(send, 'an unnamed IME key must send nothing').not.toHaveBeenCalled();

        act(() => {
            field.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }),
            );
        });
        expect(sent('key').map((e) => e.code)).toEqual(['Enter', 'Enter']);
    });

    it('forwards Enter and the arrows as real keys rather than as text', () => {
        const field = mount();
        for (const key of ['Enter', 'ArrowLeft']) {
            act(() => {
                field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            });
        }
        expect(sent('key').map((e) => e.code)).toEqual([
            'Enter', 'Enter', 'ArrowLeft', 'ArrowLeft',
        ]);
        expect(sent('text')).toEqual([]);
    });

    /**
     * THE LATCH. "Press Ctrl, then press A" has to arrive as Ctrl+A — the
     * 50 ms press-and-release this replaced made that physically impossible.
     * The modifier goes through the REGISTRAR (holdKey), never plain send:
     * that is what puts it in the stage's heldKeysRef, so blur or session
     * end releases it on the host like any physically held key.
     */
    it('a tapped modifier latches down through the registrar and stays down', () => {
        mount();
        act(() => button('Ctrl').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(holdKey.mock.calls).toEqual([['ControlLeft', true]]);
        expect(sent('key'), 'the modifier must ride the registrar, not send').toEqual([]);
    });

    it('typing a letter while Ctrl is latched sends Ctrl+KeyA, then spends the latch', () => {
        const field = mount();
        act(() => button('Ctrl').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        type(field, field.value + 'a');
        // The character is re-routed as the PHYSICAL key: a {t:'text'} frame
        // is KEYEVENTF_UNICODE on the host, which no held modifier can touch.
        expect(sent('text'), 'a chorded character must not travel as text').toEqual([]);
        expect(sent('key')).toEqual([
            { t: 'key', code: 'KeyA', down: true },
            { t: 'key', code: 'KeyA', down: false },
        ]);
        expect(holdKey.mock.calls).toEqual([['ControlLeft', true], ['ControlLeft', false]]);
    });

    it('an extra key completes the chord too, and only one-shot latches are spent', () => {
        mount();
        act(() => button('Ctrl').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        act(() => button('Esc').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(sent('key').map(e => [e.code, e.down])).toEqual([['Escape', true], ['Escape', false]]);
        expect(holdKey.mock.calls).toEqual([['ControlLeft', true], ['ControlLeft', false]]);
    });

    it('a second tap locks the modifier through any number of keys; a third releases it', () => {
        const field = mount();
        const ctrl = () => act(() => button('Ctrl').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        ctrl(); ctrl();                              // once → lock (still one down)
        expect(holdKey.mock.calls).toEqual([['ControlLeft', true]]);
        type(field, field.value + 'a');
        type(field, field.value + 'b');
        expect(sent('key').map(e => e.code)).toEqual(['KeyA', 'KeyA', 'KeyB', 'KeyB']);
        expect(holdKey.mock.calls, 'a lock survives keys').toEqual([['ControlLeft', true]]);
        ctrl();                                      // third tap releases
        expect(holdKey.mock.calls).toEqual([['ControlLeft', true], ['ControlLeft', false]]);
    });

    it('a shifted character while latched wraps the key in ShiftLeft', () => {
        const field = mount();
        act(() => button('Ctrl').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        type(field, field.value + 'A');
        expect(sent('key')).toEqual([
            { t: 'key', code: 'ShiftLeft', down: true },
            { t: 'key', code: 'KeyA', down: true },
            { t: 'key', code: 'KeyA', down: false },
            { t: 'key', code: 'ShiftLeft', down: false },
        ]);
    });

    it('unmappable input spends the one-shot latch and falls back to text', () => {
        const field = mount();
        act(() => button('Ctrl').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        type(field, field.value + 'héllo');
        expect(holdKey.mock.calls).toEqual([['ControlLeft', true], ['ControlLeft', false]]);
        expect(sent('text')).toEqual([{ t: 'text', text: 'héllo' }]);
    });

    it('unmounting with a latched modifier releases it', () => {
        mount();
        act(() => button('Ctrl').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        act(() => root!.unmount());
        expect(holdKey.mock.calls).toEqual([['ControlLeft', true], ['ControlLeft', false]]);
    });

    it('window blur clears the latch paint and releases through the registrar', () => {
        mount();
        act(() => button('Ctrl').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        act(() => { window.dispatchEvent(new Event('blur')); });
        expect(holdKey.mock.calls).toEqual([['ControlLeft', true], ['ControlLeft', false]]);
        expect(button('Ctrl').getAttribute('aria-pressed')).toBe('false');
    });

    it('the ^C button chords through the registrar without disturbing a latch', () => {
        mount();
        const cButton = Array.from(host!.querySelectorAll('button')).find(b => b.textContent === '^C')!;
        act(() => cButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(holdKey.mock.calls).toEqual([['ControlLeft', true], ['ControlLeft', false]]);
        expect(sent('key').map(e => e.code)).toEqual(['KeyC', 'KeyC']);
    });

    /**
     * Every button in the overlay would otherwise blur the hidden field, and
     * Android closes the soft keyboard when it loses focus — so one tap on Ctrl
     * silently ended the ability to type, with nothing on screen to say so.
     */
    it('does not let a button steal focus from the field', () => {
        mount();
        const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        act(() => { button('Ctrl').dispatchEvent(event); });
        expect(event.defaultPrevented, 'the tap will blur the field and close the keyboard').toBe(true);
    });

    /**
     * Positive control. Most assertions here are of the form "X was sent" or
     * "Y was NOT sent", and a component that had quietly stopped calling `send`
     * at all would satisfy every negative one. This proves the harness observes
     * real calls.
     */
    it('observes the buttons that were already working', () => {
        const field = mount();
        act(() => button('Esc').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(sent('key').map((e) => e.code)).toEqual(['Escape', 'Escape']);
        expect(field.value.length).toBeGreaterThan(0);
    });
});

/**
 * The bar's own height, reported to the stage.
 *
 * HONEST LIMITS: jsdom has no layout and no ResizeObserver, so this proves the
 * prop is WIRED — that it fires on mount and reports 0 on unmount — and nothing
 * about the number being right. The number is only provable on a phone, where
 * the unfolded bar is ~190px (the bare `button { min-height: 44px }` in
 * mobile.css beats .keyboard-btn, which sets no min-height) rather than the
 * ~33px this file's stylesheet comments claim. Do not mistake this for coverage
 * of the band the stage computes from it.
 */
describe('the bar reports its measured height', () => {
    it('fires on mount and zeroes on unmount', () => {
        const onHeight = vi.fn();
        const h = document.createElement('div');
        document.body.appendChild(h);
        const r = createRoot(h);
        act(() => { r.render(<KeyboardOverlay send={send} holdKey={holdKey} onHeight={onHeight} />); });
        expect(onHeight, 'the stage cannot compute a band it is never told about').toHaveBeenCalled();
        expect(typeof onHeight.mock.calls[0][0]).toBe('number');

        onHeight.mockClear();
        act(() => r.unmount());
        expect(onHeight, 'a stale height would leave a band with no bar').toHaveBeenCalledWith(0);
        h.remove();
    });

    it('is optional — the typing path must not depend on it', () => {
        // POSITIVE CONTROL for the whole file, really: every test above mounts
        // without onHeight, and this states that as a requirement rather than an
        // accident.
        const field = mount();
        type(field, field.value + 'a');
        expect(sent('text')).toEqual([{ t: 'text', text: 'a' }]);
    });
});

/**
 * RAISE ON DEMAND. The stage opens this panel by itself when a tap lands in a
 * text box on the remote machine (deviceAutoKeyboard.ts) — which it learns
 * from the host's caret report, long after the tap's own gesture. Blink will
 * not raise the IME for a focus that late, so the panel asks the native side
 * (showSoftInput has no gesture condition), and on an APK without that method
 * falls back to handing focus away and back — the only thing that makes a
 * back-gesture-dismissed keyboard return. Every branch below is one the phone
 * cannot report on, so each is pinned here.
 */
describe('raising the keyboard on demand', () => {
    function mountRaise(props: { raiseToken?: number; imeVisible?: boolean } = {}) {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        const render = (p: { raiseToken?: number; imeVisible?: boolean }) => act(() => {
            root!.render(<KeyboardOverlay send={send} holdKey={holdKey} {...p} />);
        });
        render(props);
        const field = host.querySelector('input.device-stage-keyboard-capture') as HTMLInputElement;
        expect(field).toBeTruthy();
        return { field, render };
    }
    const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

    it('a plain mount focuses the field AND asks the native show — the first open must not gamble on Blink', async () => {
        showMobileKeyboard.mockImplementation(async () => true);
        const { field } = mountRaise();
        await flush();
        expect(document.activeElement, 'the opening tap focuses the field').toBe(field);
        // A bare focus() left the first open to Blink's user-activation
        // heuristic, which this WebView fails often enough that "bar up, no
        // keyboard" was the first-open experience.
        expect(showMobileKeyboard, 'the mount itself must ask').toHaveBeenCalledTimes(1);
    });

    it('a token bump keeps the field focused and asks the native side to show the IME', async () => {
        showMobileKeyboard.mockImplementation(async () => true);
        const { field, render } = mountRaise();
        await flush();
        showMobileKeyboard.mockClear();          // the mount's own ask, counted above
        render({ raiseToken: 1 });
        await flush();
        expect(document.activeElement).toBe(field);
        expect(showMobileKeyboard).toHaveBeenCalledTimes(1);
        // Two raises in a row are two asks — the token is a counter, not a flag.
        render({ raiseToken: 2 });
        await flush();
        expect(showMobileKeyboard).toHaveBeenCalledTimes(2);
        // The same token again is not a new raise.
        render({ raiseToken: 2 });
        await flush();
        expect(showMobileKeyboard).toHaveBeenCalledTimes(2);
    });

    it('a mount WITH a token (the panel opened by the auto-keyboard) asks as well', async () => {
        showMobileKeyboard.mockImplementation(async () => true);
        const { field } = mountRaise({ raiseToken: 1 });
        await flush();
        expect(document.activeElement).toBe(field);
        // Mount raise + token raise: both fire, and both are harmless against
        // an IME that is already up (the native side is idempotent — it
        // double-taps showSoftInput itself).
        expect(showMobileKeyboard).toHaveBeenCalledTimes(2);
    });

    it('without the native show, a focused field is blurred and refocused while the IME is down', async () => {
        const { field, render } = mountRaise();
        await flush();
        expect(document.activeElement).toBe(field);
        showMobileKeyboard.mockClear();
        const blur = vi.spyOn(field, 'blur');
        const focus = vi.spyOn(field, 'focus');
        render({ raiseToken: 1, imeVisible: false });
        await flush();
        expect(showMobileKeyboard).toHaveBeenCalledTimes(1);
        expect(blur, 'focus() on the focused element is a no-op in Blink; it must change hands').toHaveBeenCalledTimes(1);
        expect(focus).toHaveBeenCalled();
        expect(document.activeElement, 'and end up focused').toBe(field);
    });

    it('…but never blurs an IME that is UP (the dance would hide it)', async () => {
        const { field, render } = mountRaise();
        await flush();
        const blur = vi.spyOn(field, 'blur');
        showMobileKeyboard.mockClear();
        render({ raiseToken: 1, imeVisible: true });
        await flush();
        expect(showMobileKeyboard).toHaveBeenCalledTimes(1);
        expect(blur).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(field);
    });

    it('with the native show available, no blur dance at all', async () => {
        showMobileKeyboard.mockImplementation(async () => true);
        const { field, render } = mountRaise();
        await flush();
        const blur = vi.spyOn(field, 'blur');
        render({ raiseToken: 1, imeVisible: false });
        await flush();
        expect(blur).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(field);
    });

    it('"Tap to type" goes through the same raise, so a dismissed keyboard comes back', async () => {
        showMobileKeyboard.mockImplementation(async () => true);
        const { field } = mountRaise();
        await flush();
        // The field is focused (the opening tap); the back gesture then
        // dismissed the IME. The button must not rely on focus() alone.
        expect(document.activeElement).toBe(field);
        showMobileKeyboard.mockClear();
        // The label has an icon in front of it, so match by class.
        const tap = host!.querySelector<HTMLButtonElement>('button.keyboard-btn-type');
        expect(tap).toBeTruthy();
        act(() => { tap!.click(); });
        await flush();
        expect(showMobileKeyboard).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(field);
    });
});
