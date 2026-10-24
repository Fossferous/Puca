// @vitest-environment jsdom
/**
 * api/phoneSideways.ts: "a phone held on its side" is the DEVICE's
 * orientation on a phone-sized screen in the phone layout — never the
 * viewport's shape.
 *
 * The review that produced this: keyed on `(orientation: landscape) and
 * (max-height: 500px)`, an Android WebView shrinking for the keyboard (a
 * 360x640 phone typing upright is a 360x278 viewport) switched the sideways
 * layout on and left the composer 0 px wide. And the old test answered
 * "landscape" to any query that merely contained the words, so dropping the
 * pointer or height condition still passed. Here the fake window evaluates
 * ONE query, the real one, and throws on any other.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    PHONE_LAYOUT_QUERY, deviceLandscape, installPhoneSideways, isPhoneSideways, phoneSideways, subscribePhoneSideways,
} from '../api/phoneSideways';

interface Env {
    coarse: boolean;
    /** Viewport width: the phone layout's max-width: 1024px. */
    vw: number;
    screen: { width: number; height: number };
    /** screen.orientation.type, or undefined for an engine without it. */
    type?: string;
    /** window.orientation (older iOS), or undefined. */
    legacy?: number;
}

function fakeWindow(env: Env) {
    // defineProperty, not Object.assign: assign would copy each getter's
    // value once and the fake could never turn.
    const target = new EventTarget();
    let orientation: EventTarget | undefined;
    if (env.type !== undefined) {
        orientation = new EventTarget();
        Object.defineProperty(orientation, 'type', { get: () => env.type });
    }
    Object.defineProperty(target, 'orientation', { get: () => env.legacy });
    return Object.assign(target, {
        document,
        screen: {
            get width() { return env.screen.width; },
            get height() { return env.screen.height; },
            orientation,
        },
        matchMedia: (q: string) => {
            if (q !== PHONE_LAYOUT_QUERY) throw new Error(`unexpected query: ${q}`);
            return { matches: env.coarse && env.vw <= 1024, addEventListener() {}, removeEventListener() {} };
        },
    }) as unknown as Window & { orientation?: number };
}

const IPHONE_SIDEWAYS: Env = { coarse: true, vw: 844, screen: { width: 390, height: 844 }, type: 'landscape-primary' };

afterEach(() => { delete document.documentElement.dataset.phoneSideways; });

describe('the gate', () => {
    it('is mobile.css\'s own phone-layout gate', () => {
        const mobile = readFileSync(join(__dirname, '..', 'mobile.css'), 'utf8');
        expect(mobile).toContain(`@media ${PHONE_LAYOUT_QUERY}`);
    });
});

describe('isPhoneSideways', () => {
    it('an iPhone turned sideways (its screen does not rotate; its orientation does)', () => {
        expect(isPhoneSideways(fakeWindow(IPHONE_SIDEWAYS))).toBe(true);
    });

    it('an Android phone typing UPRIGHT with the viewport shrunk to 360x278 is not sideways', () => {
        expect(isPhoneSideways(fakeWindow({ coarse: true, vw: 360, screen: { width: 360, height: 640 }, type: 'portrait-primary' }))).toBe(false);
    });

    it('a short, wide DESKTOP window (fine pointer) is not, whatever its shape', () => {
        expect(isPhoneSideways(fakeWindow({ ...IPHONE_SIDEWAYS, coarse: false, vw: 1000 }))).toBe(false);
    });

    it('a touch laptop (coarse, but wider than the phone layout) is not', () => {
        expect(isPhoneSideways(fakeWindow({ ...IPHONE_SIDEWAYS, vw: 1280, screen: { width: 1280, height: 800 } }))).toBe(false);
    });

    it('a tablet on its side is not a phone (short side over 500 px)', () => {
        expect(isPhoneSideways(fakeWindow({ coarse: true, vw: 1024, screen: { width: 1024, height: 768 }, type: 'landscape-primary' }))).toBe(false);
    });

    it('the largest phone (440 px short side) is', () => {
        expect(isPhoneSideways(fakeWindow({ coarse: true, vw: 956, screen: { width: 440, height: 956 }, type: 'landscape-secondary' }))).toBe(true);
    });
});

describe('deviceLandscape: the device, in order of trust', () => {
    it('screen.orientation first', () => {
        expect(deviceLandscape(fakeWindow({ ...IPHONE_SIDEWAYS, type: 'portrait-primary', legacy: 90 }))).toBe(false);
    });
    it('then window.orientation (older iOS: +-90 is sideways)', () => {
        expect(deviceLandscape(fakeWindow({ ...IPHONE_SIDEWAYS, type: undefined, legacy: -90 }))).toBe(true);
        expect(deviceLandscape(fakeWindow({ ...IPHONE_SIDEWAYS, type: undefined, legacy: 0 }))).toBe(false);
    });
    it('then the SCREEN\'s aspect, never the viewport\'s', () => {
        expect(deviceLandscape(fakeWindow({ ...IPHONE_SIDEWAYS, type: undefined, screen: { width: 844, height: 390 } }))).toBe(true);
        expect(deviceLandscape(fakeWindow({ ...IPHONE_SIDEWAYS, type: undefined, screen: { width: 390, height: 844 } }))).toBe(false);
    });
});

describe('installPhoneSideways', () => {
    it('publishes <html data-phone-sideways>, follows a turn, tells subscribers, and undoes itself', () => {
        const env: Env = { coarse: true, vw: 390, screen: { width: 390, height: 844 }, type: 'portrait-primary' };
        const win = fakeWindow(env);
        let calls = 0;
        const unsub = subscribePhoneSideways(() => { calls++; });
        const undo = installPhoneSideways(win);
        expect(document.documentElement.dataset.phoneSideways).toBeUndefined();
        expect(phoneSideways()).toBe(false);

        env.type = 'landscape-primary'; env.vw = 844;
        win.dispatchEvent(new Event('orientationchange'));
        expect(document.documentElement.dataset.phoneSideways).toBe('true');
        expect(phoneSideways()).toBe(true);
        expect(calls).toBe(1);

        // The keyboard shrinking the viewport is a resize, not a turn.
        env.type = 'portrait-primary'; env.vw = 360;
        win.dispatchEvent(new Event('resize'));
        expect(document.documentElement.dataset.phoneSideways).toBeUndefined();
        expect(calls).toBe(2);

        undo();
        unsub();
        expect(phoneSideways()).toBe(false);
    });
});
