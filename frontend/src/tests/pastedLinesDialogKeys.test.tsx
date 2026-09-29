/**
 * The paste question and Púca's own hotkeys.
 *
 * PastedLinesDialog takes the focus off the field a paste went into, so that
 * a reflexive Enter answers nothing — and puts it on the question itself, an
 * element that is not editable. A PRESS hotkey bound to a bare key (plain M
 * for mute) is kept from firing only by the focus being somewhere a key is
 * typing (hotkeys.ts's isEditableTarget), in the in-app feed and in the
 * desktop's native feed alike, so under the question it fired where the
 * input it came from had kept it quiet. One dialog, shared by every paste
 * path — Notes' composer and open note, Púca's Tasks view and a channel's
 * checklist — so it is checked here, once, against the dialog itself.
 *
 * HOLD actions are not part of this: push-to-talk has always worked from a
 * focused input, because you hold it while typing, and it still does.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PastedLinesDialog } from '../components/PastedLinesDialog';
import { nativeKeyEvent, registerHold, registerPress, resetHotkeysForTest } from '../api/hotkeys';
import type { KeyBinding } from '../components/settingsStore';

const M: KeyBinding = { keyCode: 77, ctrl: false, alt: false, shift: false, label: 'M' };
const CTRL_M: KeyBinding = { ...M, ctrl: true };
const SPACE: KeyBinding = { keyCode: 32, ctrl: false, alt: false, shift: false, label: 'Space' };

let root: Root;
let host: HTMLDivElement;
let outside: HTMLButtonElement;

beforeEach(() => {
    outside = document.createElement('button');
    document.body.appendChild(outside);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root.render(<PastedLinesDialog lines={['Milk', 'Bread', 'Eggs']} onAddSeparate={() => {}} onAddOne={() => {}} onCancel={() => {}} />);
    });
});
afterEach(() => {
    act(() => { root.unmount(); });
    document.body.innerHTML = '';
    resetHotkeysForTest();
});

const question = () => document.querySelector<HTMLElement>('.notes-paste-dialog')!;
/** A key-down where the focus is, as the browser delivers it. */
function keyAtFocus(keyCode: number, init: KeyboardEventInit = {}) {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(e, 'keyCode', { value: keyCode });
    (document.activeElement ?? document.body).dispatchEvent(e);
}
const native = (b: KeyBinding) => nativeKeyEvent('down', { keyCode: b.keyCode, ctrlKey: b.ctrl, altKey: b.alt, shiftKey: b.shift }, undefined, { foreground: true });

describe('a bare-key press hotkey under the paste question', () => {
    it('the question has the focus when it opens', () => {
        expect(document.activeElement).toBe(question());
    });

    it('does not fire from the question, its answers or its X — in-app feed', () => {
        let presses = 0;
        registerPress('voice.toggleMute', () => M, () => { presses++; });
        keyAtFocus(77);
        for (const b of document.querySelectorAll<HTMLButtonElement>('.notes-dialog button')) {
            b.focus();
            keyAtFocus(77);
        }
        expect(presses).toBe(0);
        // POSITIVE CONTROL: the same key, focus anywhere else, is the command.
        outside.focus();
        keyAtFocus(77);
        expect(presses).toBe(1);
    });

    it('does not fire from the question with Púca in front — native feed', () => {
        let presses = 0;
        registerPress('voice.toggleMute', () => M, () => { presses++; });
        native(M);
        expect(presses).toBe(0);
        outside.focus();
        native(M);
        expect(presses).toBe(1);
    });

    it('a Ctrl combo still fires from the question, as it does from an input', () => {
        let presses = 0;
        registerPress('voice.toggleMute', () => CTRL_M, () => { presses++; });
        keyAtFocus(77, { ctrlKey: true });
        expect(presses).toBe(1);
    });

    it('push-to-talk still opens the mic from the question, as it does from an input', () => {
        let downs = 0;
        registerHold('voice.ptt', () => SPACE, { onDown: () => { downs++; }, onUp: () => {} });
        keyAtFocus(32);
        expect(downs).toBe(1);
    });
});
