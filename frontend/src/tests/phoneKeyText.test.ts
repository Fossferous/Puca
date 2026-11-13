/**
 * What a key press types on a phone being controlled (components/
 * phoneKeyText.ts, used by StreamStage's key handler). The rule it replaced
 * sent a character only with no Ctrl and no Alt held, so AltGr (Ctrl+Alt to
 * Windows) typed the key under it: '@' on a German keyboard, AltGr+Q, became
 * a 'q'. The AltGr and Option cases are the ones that rule failed.
 */
import { describe, it, expect } from 'vitest';
import { phoneKeyText } from '../components/phoneKeyText';

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

    it('shortcuts and named keys go as keys', () => {
        expect(phoneKeyText(ev({ key: 'c', ctrlKey: true }), false)).toBeNull();
        expect(phoneKeyText(ev({ key: 'c', ctrlKey: true, altKey: true }), false), 'Ctrl+Alt that is not AltGr').toBeNull();
        expect(phoneKeyText(ev({ key: 'v', metaKey: true }), true)).toBeNull();
        expect(phoneKeyText(ev({ key: 'Enter' }), false)).toBeNull();
        expect(phoneKeyText(ev({ key: 'Dead' }), false)).toBeNull();
        expect(phoneKeyText(ev({ key: 'Backspace' }), false)).toBeNull();
    });
});
