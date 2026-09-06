/**
 * Which settings tabs a platform gets (settingsModal.utils' settingsSections()).
 *
 * Phones must not be offered the Keybinds tab: every row on it captures a
 * key combination for the desktop hotkey hook, so on a touch device it was a
 * page of controls over hardware the user does not have. The decision is a
 * pure function precisely so this can be checked without mounting the modal.
 *
 * "Phone" is isTouchDevice(): the Capacitor app OR a coarse primary pointer,
 * so a phone that opened the web app in a browser is covered too. The same
 * predicate gates the Toggle Mute / Toggle Deafen presses in VoicePanel.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { COARSE_POINTER_QUERY, isTouchDevice, settingsSections } from '../components/settingsModal.utils';

/** What the Capacitor shell would answer; flipped per test. */
let nativeMobile = false;
vi.mock('../api/platform', () => ({
    isMobile: () => nativeMobile,
}));

/** Stand in for window.matchMedia: `coarse` is what the pointer query matches;
 *  every other query is a bug in the predicate, so it throws. */
function stubMatchMedia(coarse: boolean) {
    window.matchMedia = ((q: string) => {
        if (q !== COARSE_POINTER_QUERY) throw new Error(`unexpected media query ${q}`);
        return { matches: coarse, media: q } as MediaQueryList;
    }) as unknown as typeof window.matchMedia;
}

describe('isTouchDevice', () => {
    afterEach(() => {
        nativeMobile = false;
        delete (window as { matchMedia?: unknown }).matchMedia;
    });

    it('desktop: not native, fine pointer (positive control for the rest)', () => {
        stubMatchMedia(false);
        expect(isTouchDevice()).toBe(false);
    });

    it('the Capacitor app is a touch device whatever the media query says', () => {
        nativeMobile = true;
        stubMatchMedia(false);
        expect(isTouchDevice()).toBe(true);
    });

    it('a phone in a BROWSER is a touch device too — the finding this fixes', () => {
        // Not the shipped app; the coarse-pointer query is the only evidence.
        stubMatchMedia(true);
        expect(isTouchDevice()).toBe(true);
    });

    it('asks the bare coarse-pointer query, not the phone-layout one', () => {
        // A landscape iPad is wider than Chat.tsx's 1024px layout gate and
        // still has no key to press; the width must not be in the question.
        expect(COARSE_POINTER_QUERY).toBe('(pointer: coarse)');
        expect(COARSE_POINTER_QUERY).not.toMatch(/max-width/);
    });

    it('no matchMedia at all (bare jsdom, SSR) is not a phone', () => {
        delete (window as { matchMedia?: unknown }).matchMedia;
        expect(isTouchDevice()).toBe(false);
    });
});

describe('settingsSections', () => {
    it('desktop offers the Keybinds tab (positive control for the mobile case)', () => {
        const ids = settingsSections({ mobile: false }).map(s => s.id);
        expect(ids).toContain('keybinds');
    });

    it('mobile does not offer the Keybinds tab', () => {
        const ids = settingsSections({ mobile: true }).map(s => s.id);
        expect(ids).not.toContain('keybinds');
        expect(ids.length).toBeGreaterThan(0);
    });

    it('Keybinds is the ONLY tab mobile loses, and the order is untouched', () => {
        const desktop = settingsSections({ mobile: false });
        const mobile = settingsSections({ mobile: true });
        expect(mobile).toEqual(desktop.filter(s => s.id !== 'keybinds'));
        expect(mobile.length).toBe(desktop.length - 1);
    });

    it('every tab has a unique id and a label the header can show', () => {
        for (const mobile of [false, true]) {
            const list = settingsSections({ mobile });
            expect(new Set(list.map(s => s.id)).size).toBe(list.length);
            for (const s of list) {
                expect(s.label.trim().length).toBeGreaterThan(0);
                expect(s.icon.length).toBeGreaterThan(0);
            }
        }
    });

    it('a caller mutating the returned array cannot corrupt the next call', () => {
        // The modal treats its copy as its own. If the implementation ever
        // handed back the master list itself, the splice below would delete
        // Keybinds for every later desktop render and the push would add a
        // phantom tab to every platform — so the second call is what is
        // asserted, not the identity of the first.
        const a = settingsSections({ mobile: false });
        const before = a.length;
        a.splice(a.findIndex(s => s.id === 'keybinds'), 1);
        a.push({ id: 'phantom', label: 'Phantom', icon: 'settings' });

        const desktop = settingsSections({ mobile: false });
        expect(desktop.map(s => s.id)).toContain('keybinds');
        expect(desktop.map(s => s.id)).not.toContain('phantom');
        expect(desktop.length).toBe(before);

        const mobile = settingsSections({ mobile: true });
        expect(mobile.map(s => s.id)).not.toContain('phantom');
        expect(mobile.length).toBe(before - 1);
    });
});
