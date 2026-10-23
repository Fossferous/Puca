// @vitest-environment jsdom
/**
 * api/iosStandalone.ts: viewport-fit=cover for a Home Screen app on iPhone, and
 * for nothing else. The shared index.html must stay free of it (Android and the
 * desktop app use that file), so this module is the ONLY place it comes from;
 * these cases pin that it comes only where `navigator.standalone` says so, goes
 * away in landscape, and leaves the page's other viewport keys alone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { installIosStandalone, isIosStandalone, viewportContent } from '../api/iosStandalone';

const BASE = 'width=device-width, initial-scale=1.0';

afterEach(() => {
    document.head.innerHTML = '';
    delete document.documentElement.dataset.iosStandalone;
});

/** A window-shaped object with a controllable orientation. */
function fakeWindow(standalone: boolean | undefined) {
    document.head.innerHTML = `<meta name="viewport" content="${BASE}">`;
    let portrait = true;
    const listeners = new Set<() => void>();
    const mq = {
        get matches() { return portrait; },
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    const win = {
        document,
        navigator: { standalone },
        matchMedia: (q: string) => { expect(q).toBe('(orientation: portrait)'); return mq; },
    } as unknown as Window;
    return {
        win,
        rotate(toPortrait: boolean) { portrait = toPortrait; listeners.forEach((f) => f()); },
        content: () => document.querySelector('meta[name="viewport"]')!.getAttribute('content'),
        listeners,
    };
}

describe('viewportContent', () => {
    it('adds and removes viewport-fit, keeping the other keys', () => {
        expect(viewportContent(BASE, true)).toBe(`${BASE}, viewport-fit=cover`);
        expect(viewportContent(`${BASE}, viewport-fit=cover`, false)).toBe(BASE);
        expect(viewportContent(`${BASE}, viewport-fit=cover`, true)).toBe(`${BASE}, viewport-fit=cover`);
        expect(viewportContent('width=device-width, viewport-fit = contain', true)).toBe('width=device-width, viewport-fit=cover');
    });
});

describe('isIosStandalone', () => {
    it('is true only for navigator.standalone === true', () => {
        expect(isIosStandalone({ standalone: true })).toBe(true);
        expect(isIosStandalone({ standalone: false })).toBe(false); // Safari tab
        expect(isIosStandalone({})).toBe(false); // Android, desktop, Tauri: the property does not exist
    });
});

describe('installIosStandalone', () => {
    it('leaves a Safari tab, Android and desktop exactly as they were', () => {
        for (const standalone of [false, undefined]) {
            const f = fakeWindow(standalone);
            const undo = installIosStandalone(f.win);
            expect(f.content()).toBe(BASE);
            expect(document.documentElement.dataset.iosStandalone).toBeUndefined();
            expect(f.listeners.size).toBe(0);
            undo();
            expect(f.content()).toBe(BASE);
        }
    });

    it('covers the screen in portrait, takes cover off in landscape, and follows a rotation back', () => {
        const f = fakeWindow(true);
        installIosStandalone(f.win);
        expect(document.documentElement.dataset.iosStandalone).toBe('true');
        expect(f.content()).toBe(`${BASE}, viewport-fit=cover`);
        f.rotate(false);
        expect(f.content()).toBe(BASE);
        f.rotate(true);
        expect(f.content()).toBe(`${BASE}, viewport-fit=cover`);
    });

    it('undoes itself completely', () => {
        const f = fakeWindow(true);
        const undo = installIosStandalone(f.win);
        undo();
        expect(f.content()).toBe(BASE);
        expect(f.listeners.size).toBe(0);
        expect(document.documentElement.dataset.iosStandalone).toBeUndefined();
    });

    it('does not throw on a page with no viewport tag', () => {
        const f = fakeWindow(true);
        document.head.innerHTML = '';
        expect(() => installIosStandalone(f.win)()).not.toThrow();
    });
});
