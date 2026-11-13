/**
 * What a key press types on a phone being controlled (components/
 * phoneKeyText.ts, used by StreamStage's key handler). The rule it replaced
 * sent a character only with no Ctrl and no Alt held, so AltGr (Ctrl+Alt to
 * Windows) typed the key under it: '@' on a German keyboard, AltGr+Q, became
 * a 'q'. The AltGr and Option cases are the ones that rule failed.
 */
import { describe, it, expect } from 'vitest';
import { phoneDropsKey, phoneKeyText } from '../components/phoneKeyText';

type Ev = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; altGraph?: boolean };
const ev = (e: Ev) => ({
    key: e.key,
    ctrlKey: !!e.ctrlKey,
    metaKey: !!e.metaKey,
    altKey: !!e.altKey,
    getModifierState: (k: string) => k === 'AltGraph' && !!e.altGraph,
});
/** The rule before: for the negative control. */
const old = (e: ReturnType<typeof ev>) =>
    (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey ? e.key : null);

describe('phoneKeyText', () => {
    it('a plain character, shifted or not, is text', () => {
        expect(phoneKeyText(ev({ key: 'a' }), false)).toBe('a');
        expect(phoneKeyText(ev({ key: 'A' }), false)).toBe('A');
        expect(phoneKeyText(ev({ key: 'é' }), false)).toBe('é');
    });

    it('AltGr (Ctrl+Alt to Windows, told apart by AltGraph) types its character', () => {
        const altGrQ = ev({ key: '@', ctrlKey: true, altKey: true, altGraph: true });
        expect(phoneKeyText(altGrQ, false)).toBe('@');
        expect(old(altGrQ), 'NEGATIVE CONTROL: the old rule sent it as a key').toBeNull();
    });

    it('Option on a Mac types its character; Alt elsewhere is a shortcut', () => {
        const optionL = ev({ key: '@', altKey: true });
        expect(phoneKeyText(optionL, true)).toBe('@');
        expect(old(optionL), 'NEGATIVE CONTROL').toBeNull();
        expect(phoneKeyText(ev({ key: 'f', altKey: true }), false)).toBeNull();
    });

    it('a phone gets no shortcut, dead key or IME key at all; named keys still go', () => {
        // Each of these typed a stray letter on the phone.
        expect(phoneDropsKey(ev({ key: 'a', ctrlKey: true }), false), 'Ctrl+A').toBe(true);
        expect(phoneDropsKey(ev({ key: 'v', metaKey: true }), true), 'Cmd+V').toBe(true);
        expect(phoneDropsKey(ev({ key: 'f', altKey: true }), false), 'Alt+F').toBe(true);
        expect(phoneDropsKey(ev({ key: 'Dead' }), false), 'a dead key').toBe(true);
        expect(phoneDropsKey(ev({ key: 'Process' }), false), 'a desktop IME').toBe(true);
        expect(phoneDropsKey(ev({ key: 'Unidentified' }), false)).toBe(true);
        // What a phone does take.
        expect(phoneDropsKey(ev({ key: 'Enter' }), false)).toBe(false);
        expect(phoneDropsKey(ev({ key: 'Backspace' }), false)).toBe(false);
        expect(phoneDropsKey(ev({ key: 'Escape' }), false)).toBe(false);
        expect(phoneDropsKey(ev({ key: 'Control', ctrlKey: true }), false), 'the modifier itself').toBe(false);
        expect(phoneDropsKey(ev({ key: 'a' }), false), 'text is sent as text, not dropped').toBe(false);
        expect(phoneDropsKey(ev({ key: '@', ctrlKey: true, altKey: true, altGraph: true }), false), 'AltGr').toBe(false);
    });

    it('shortcuts and named keys go as keys', () => {
        expect(phoneKeyText(ev({ key: 'c', ctrlKey: true }), false)).toBeNull();
        expect(phoneKeyText(ev({ key: 'c', ctrlKey: true, altKey: true }), false), 'Ctrl+Alt that is not AltGr').toBeNull();
        expect(phoneKeyText(ev({ key: 'v', metaKey: true }), true)).toBeNull();
        expect(phoneKeyText(ev({ key: 'Enter' }), false)).toBeNull();
        expect(phoneKeyText(ev({ key: 'Dead' }), false)).toBeNull();
        expect(phoneKeyText(ev({ key: 'Backspace' }), false)).toBeNull();
    });
});
