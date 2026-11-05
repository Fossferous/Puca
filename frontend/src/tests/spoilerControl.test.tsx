/**
 * A `||spoiler||` is a control (components/Spoiler.tsx): until 0.9.857 it was a bare span
 * that no key could reach, whose hidden words a screen reader read out loud.
 *
 * jsdom has no accessibility tree, no focus ring and no Tab order of its own, so what
 * is asserted here is what a browser builds them from: the role, the tab stop, the name,
 * aria-expanded, `inert` and aria-hidden on the hidden words, and the keys. The real tree,
 * the real Tab and the ring on all eight themes are in e2e/spoiler-keyboard-real-browser.mjs.
 *
 * The keys run through the REAL hotkeys registry (api/hotkeys.ts): since 0.9.855 a hold on
 * Space or Enter bound as a voice hotkey presses nothing that has the focus, by preventing
 * the default of the keydown, and a control of its own has to ask `defaultPrevented`. A
 * spoiler that did not would reveal on every push-to-talk press.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageContent } from '../components/MessageContent';
import { registerHold, registerPress, resetHotkeysForTest, unregisterHold } from '../api/hotkeys';

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => resetHotkeysForTest());
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    resetHotkeysForTest();
});

function render(content: string) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<MessageContent content={content} members={[]} channels={[]} />));
    return host;
}

const spoilers = () => Array.from(host!.querySelectorAll<HTMLElement>('.spoiler'));
const bodyOf = (s: HTMLElement) => s.querySelector<HTMLElement>(':scope > .spoiler-body')!;

/** A keydown as a keyboard makes it: bubbling, cancelable, with the legacy code the hotkeys read. */
function press(el: Element, key: string, init: { repeat?: boolean } = {}): KeyboardEvent {
    const codes: Record<string, number> = { Enter: 13, ' ': 32, Tab: 9, a: 65 };
    const e = new KeyboardEvent('keydown', { key, keyCode: codes[key] ?? 0, bubbles: true, cancelable: true, repeat: init.repeat ?? false });
    act(() => { el.dispatchEvent(e); });
    return e;
}

describe('a spoiler is a button', () => {
    it('has the role, a tab stop, a name that is not its words, and says it is closed', () => {
        render('The twist: ||the demon is Alice|| ok');
        const [s] = spoilers();
        expect(s.getAttribute('role')).toBe('button');
        expect(s.tabIndex).toBe(0);
        expect(s.getAttribute('aria-expanded')).toBe('false');
        expect(s.getAttribute('aria-label')).toBe('Spoiler');
        expect(s.getAttribute('aria-label')).not.toMatch(/demon|alice/i);
    });

    it('hides its words from the accessibility tree and the tab order until it is revealed', () => {
        render('||the demon is Alice [a link](https://example.org/x)||');
        const [s] = spoilers();
        const body = bodyOf(s);
        // aria-hidden takes it out of the tree, inert out of the tab order and off the pointer.
        expect(body.getAttribute('aria-hidden')).toBe('true');
        expect(body.hasAttribute('inert')).toBe(true);
        expect(body.textContent).toContain('demon'); // the words are in the page, only not in its tree
        press(s, 'Enter');
        expect(body.hasAttribute('aria-hidden')).toBe(false);
        expect(body.hasAttribute('inert')).toBe(false);
    });

    it('Enter reveals it and a second press hides it again; Space does the same', () => {
        render('||secret||');
        const [s] = spoilers();
        expect(press(s, 'Enter').defaultPrevented).toBe(true);
        expect(s.classList.contains('revealed')).toBe(true);
        expect(s.getAttribute('aria-expanded')).toBe('true');
        // Revealed, it is named by what it says: the words are read once, not "Spoiler" and again.
        expect(s.hasAttribute('aria-label')).toBe(false);
        press(s, 'Enter');
        expect(s.classList.contains('revealed')).toBe(false);
        expect(s.getAttribute('aria-expanded')).toBe('false');
        expect(s.getAttribute('aria-label')).toBe('Spoiler');
        // Space scrolls the chat unless prevented.
        expect(press(s, ' ').defaultPrevented).toBe(true);
        expect(s.classList.contains('revealed')).toBe(true);
        press(s, ' ');
        expect(s.classList.contains('revealed')).toBe(false);
    });

    it('a held key does not flicker it, and another key does nothing', () => {
        render('||secret||');
        const [s] = spoilers();
        press(s, 'Enter');
        expect(s.classList.contains('revealed')).toBe(true);
        const repeat = press(s, 'Enter', { repeat: true });
        expect(s.classList.contains('revealed')).toBe(true);
        expect(repeat.defaultPrevented).toBe(true); // still kept off the page
        press(s, 'a');
        press(s, 'Tab');
        expect(s.classList.contains('revealed')).toBe(true);
    });

    it('a mouse press still reveals and hides it', () => {
        render('||secret||');
        const [s] = spoilers();
        act(() => { s.click(); });
        expect(s.getAttribute('aria-expanded')).toBe('true');
        act(() => { s.click(); });
        expect(s.getAttribute('aria-expanded')).toBe('false');
    });

    it('a press on a link inside a revealed spoiler is the link\'s, and leaves it revealed', () => {
        render('||[the link](https://example.org/x)||');
        const [s] = spoilers();
        act(() => { s.click(); });
        const a = s.querySelector('a')!;
        const open = new MouseEvent('click', { bubbles: true, cancelable: true });
        open.preventDefault();
        act(() => { a.dispatchEvent(open); });
        expect(s.classList.contains('revealed')).toBe(true);
        // Nor does Enter, which a link takes as its own, bubble up and hide it.
        press(a, 'Enter');
        expect(s.classList.contains('revealed')).toBe(true);
    });

    it('each spoiler of a message is a control of its own', () => {
        render('||one|| and ||two||');
        const [one, two] = spoilers();
        expect(spoilers()).toHaveLength(2);
        for (const s of [one, two]) expect(s.getAttribute('role')).toBe('button');
        press(one, 'Enter');
        expect(one.classList.contains('revealed')).toBe(true);
        expect(two.classList.contains('revealed')).toBe(false);
    });
});

describe('a voice hotkey on Space or Enter keeps the spoiler shut', () => {
    const bound = (keyCode: number) => ({ keyCode, ctrl: false, alt: false, shift: false, label: keyCode === 32 ? 'Space' : 'Enter' });

    it('a push-to-talk on Space: Space on a focused spoiler presses nothing, however long it is held', () => {
        render('||secret||');
        const [s] = spoilers();
        let down = 0;
        registerHold('t.ptt', () => bound(32), { onDown: () => { down++; }, onUp: () => {} });
        const first = press(s, ' ');
        const repeats = [press(s, ' ', { repeat: true }), press(s, ' ', { repeat: true })];
        expect(down).toBe(1); // the hotkey took the key
        expect(first.defaultPrevented).toBe(true);
        expect(repeats.every(e => e.defaultPrevented)).toBe(true);
        expect(s.classList.contains('revealed')).toBe(false);
        // Enter is not bound: it still works, so the swallow is the hotkey's and not the spoiler's.
        press(s, 'Enter');
        expect(s.classList.contains('revealed')).toBe(true);
        unregisterHold('t.ptt');
    });

    it('a push-to-talk on Enter: Enter presses nothing, Space still does', () => {
        render('||secret||');
        const [s] = spoilers();
        registerHold('t.ptt', () => bound(13), { onDown: () => {}, onUp: () => {} });
        press(s, 'Enter');
        expect(s.classList.contains('revealed')).toBe(false);
        press(s, ' ');
        expect(s.classList.contains('revealed')).toBe(true);
        unregisterHold('t.ptt');
    });

    it('a press action bound to Space (toggle mute) does not reveal it either', () => {
        render('||secret||');
        const [s] = spoilers();
        let muted = 0;
        registerPress('t.mute', () => bound(32), () => { muted++; });
        press(s, ' ');
        expect(muted).toBe(1);
        expect(s.classList.contains('revealed')).toBe(false);
    });

    it('CONTROL: with no hotkey bound, the same Space reveals it', () => {
        render('||secret||');
        const [s] = spoilers();
        press(s, ' ');
        expect(s.classList.contains('revealed')).toBe(true);
    });

    it('CONTROL: typing in a text box is untouched by the spoiler', () => {
        render('||secret|| and words');
        const box = document.createElement('textarea');
        host!.appendChild(box);
        const e = new KeyboardEvent('keydown', { key: ' ', keyCode: 32, bubbles: true, cancelable: true });
        act(() => { box.dispatchEvent(e); });
        expect(e.defaultPrevented).toBe(false); // the space is typed
        expect(spoilers()[0].classList.contains('revealed')).toBe(false);
    });
});
