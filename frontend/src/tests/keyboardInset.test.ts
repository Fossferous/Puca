/**
 * WHERE THE SOFT KEYBOARD IS — three sources, one answer.
 *
 * Nothing in this app measured the Android IME before this, and the three ways
 * to do it are unequal: the native plugin is truth, the visual viewport is real
 * for the webapp in mobile Chrome and silent inside the Android WebView, and the
 * assumed fraction is a guess that exists so the feature works on an APK that
 * predates the plugin (and on API 24-29, where Type.ime() is unreliable and
 * minSdk here is 24).
 *
 * So the two properties worth pinning are the CONVERSION (a density-based one is
 * wrong by a plausible-looking 10-30% and that is the worst kind of wrong) and
 * the PRECEDENCE (a lower source silently winning is a band in the wrong place
 * with nothing on screen to say so).
 *
 * jsdom has no visualViewport and no plugin, so both are faked. The "does not
 * fire yet" assertions all have a sibling that fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const keyboardState = vi.fn();
const onKeyboard = vi.fn();

vi.mock('../api/mobileApp', () => ({
    mobileKeyboardState: () => keyboardState(),
    onMobileKeyboard: (cb: unknown) => onKeyboard(cb),
}));

const {
    KEYBOARD_ASSUME_AFTER_MS, VV_MIN_COVER_PX,
    imeTopToCss, watchKeyboardInset, currentKeyboardInset,
} = await import('../api/keyboardInset');

type Listener = () => void;

interface FakeVv {
    height: number;
    offsetTop: number;
    listeners: Map<string, Set<Listener>>;
    addEventListener: (t: string, l: Listener) => void;
    removeEventListener: (t: string, l: Listener) => void;
}

function fakeVisualViewport(height: number, offsetTop = 0): FakeVv {
    const listeners = new Map<string, Set<Listener>>();
    const vv: FakeVv = {
        height, offsetTop, listeners,
        addEventListener: (t, l) => {
            if (!listeners.has(t)) listeners.set(t, new Set());
            listeners.get(t)!.add(l);
        },
        removeEventListener: (t, l) => { listeners.get(t)?.delete(l); },
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    return vv;
}

function fireVv(vv: FakeVv, type = 'resize'): void {
    for (const l of [...(vv.listeners.get(type) ?? [])]) l();
}

function countVvListeners(vv: FakeVv): number {
    let n = 0;
    for (const set of vv.listeners.values()) n += set.size;
    return n;
}

/** The layout viewport, which is what CSS px are measured in. */
function setViewport(w: number, h: number): void {
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: h });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
}

let stop: Array<() => void> = [];

function watch(): Array<ReturnType<typeof currentKeyboardInset>> {
    const seen: Array<ReturnType<typeof currentKeyboardInset>> = [];
    stop.push(watchKeyboardInset(i => seen.push(i)));
    return seen;
}

beforeEach(() => {
    vi.useFakeTimers();
    // Both plugin calls reject by default: that is every APK before this one.
    keyboardState.mockReset();
    keyboardState.mockRejectedValue(new Error('no such method'));
    onKeyboard.mockReset();
    onKeyboard.mockResolvedValue(null);
    setViewport(390, 844);
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: null });
});

afterEach(() => {
    for (const s of stop) s();
    stop = [];
    vi.useRealTimers();
});

describe('imeTopToCss — raw px in, CSS px out', () => {
    it('scales by the WebView\'s own height fraction', () => {
        // A 2400px-tall WebView whose IME top is at 1200 is exactly half way
        // down, so on an 844px layout viewport that is 422.
        expect(imeTopToCss(1200, 2400, 844)).toBe(422);
        expect(imeTopToCss(0, 2400, 844)).toBe(0);
        expect(imeTopToCss(2400, 2400, 844)).toBe(844);
    });

    it('refuses to invent a number it does not have', () => {
        expect(imeTopToCss(1200, 0, 844), 'no view yet').toBeNull();
        expect(imeTopToCss(1200, -1, 844)).toBeNull();
        expect(imeTopToCss(-1, -1, 844), 'the plugin\'s "nothing observed" sentinel').toBeNull();
        expect(imeTopToCss(1200, 2400, 0)).toBeNull();
        expect(imeTopToCss(Number.NaN, 2400, 844)).toBeNull();
    });
});

describe('the visual viewport (the webapp in mobile Chrome)', () => {
    it('POSITIVE CONTROL: a keyboard-sized shrink is reported as the band', () => {
        const vv = fakeVisualViewport(500);
        const seen = watch();
        // Installing reads it once, so the shrink is already visible.
        expect(seen.at(-1)).toEqual({ visible: true, top: 500, source: 'visual-viewport' });
        vv.height = 400;
        fireVv(vv);
        expect(seen.at(-1)).toEqual({ visible: true, top: 400, source: 'visual-viewport' });
    });

    it('ignores a shrink too small to be a keyboard', () => {
        // 844 - 804 = 40px: a URL bar, not an IME.
        fakeVisualViewport(804);
        watch();
        expect(844 - 804).toBeLessThan(VV_MIN_COVER_PX);
        expect(currentKeyboardInset()).toEqual({ visible: false, top: null, source: 'none' });
    });

    it('accounts for a scrolled visual viewport', () => {
        // offsetTop 100 + height 400 puts the keyboard's top edge at 500.
        fakeVisualViewport(400, 100);
        const seen = watch();
        expect(seen.at(-1)).toEqual({ visible: true, top: 500, source: 'visual-viewport' });
    });

    it('reports the keyboard going away once it has proved it can see one', () => {
        const vv = fakeVisualViewport(500);
        const seen = watch();
        expect(seen.at(-1)!.visible).toBe(true);
        vv.height = 844;
        fireVv(vv);
        expect(seen.at(-1)).toEqual({ visible: false, top: 844, source: 'visual-viewport' });
    });
});

describe('the assumed fraction (an old APK, or API 24-29)', () => {
    it('does not fire before the delay, and does after it', () => {
        const seen = watch();
        vi.advanceTimersByTime(KEYBOARD_ASSUME_AFTER_MS - 1);
        expect(seen, 'guessing immediately would fight the real measurement').toEqual([]);
        vi.advanceTimersByTime(1);
        // 844 * (1 - 0.42) = 489.52 (toBeCloseTo, not toBe: 1 - 0.42 is
        // 0.5800000000000001 in doubles, so the product lands a ulp out).
        expect(seen.at(-1)!.source).toBe('assumed');
        expect(seen.at(-1)!.visible).toBe(true);
        expect(seen.at(-1)!.top).toBeCloseTo(489.52, 9);
    });

    it('assumes more of a landscape viewport', () => {
        setViewport(844, 390);
        const seen = watch();
        vi.advanceTimersByTime(KEYBOARD_ASSUME_AFTER_MS);
        // 390 * (1 - 0.55) = 175.5
        expect(seen.at(-1)!.source).toBe('assumed');
        expect(seen.at(-1)!.top).toBeCloseTo(175.5, 9);
    });

    it('is not used when the visual viewport already measured one', () => {
        fakeVisualViewport(500);
        const seen = watch();
        vi.advanceTimersByTime(KEYBOARD_ASSUME_AFTER_MS * 4);
        expect(seen.every(i => i.source === 'visual-viewport')).toBe(true);
        expect(currentKeyboardInset().top).toBe(500);
    });
});

describe('precedence — a lower source never overrides a higher one', () => {
    it('native wins over a visual viewport that disagrees', async () => {
        const vv = fakeVisualViewport(844);
        keyboardState.mockResolvedValue({ visible: true, topPx: 1200, viewHeightPx: 2400 });
        const seen = watch();
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.at(-1)).toEqual({ visible: true, top: 422, source: 'native' });

        vv.height = 480;
        fireVv(vv);
        expect(
            currentKeyboardInset(),
            'the WebView\'s visual viewport does not shrink for the IME; native is truth',
        ).toEqual({ visible: true, top: 422, source: 'native' });
    });

    it('native saying "no keyboard" stops the follow — a hardware keyboard or DeX', async () => {
        keyboardState.mockResolvedValue({ visible: false, topPx: 2400, viewHeightPx: 2400 });
        const seen = watch();
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.at(-1)).toEqual({ visible: false, top: 844, source: 'native' });
        // ...and the assumed tier must not then invent one.
        await vi.advanceTimersByTimeAsync(KEYBOARD_ASSUME_AFTER_MS * 2);
        expect(currentKeyboardInset().source).toBe('native');
        expect(currentKeyboardInset().visible).toBe(false);
    });

    it('unknown native geometry is not a measurement and claims nothing', async () => {
        // The plugin returns -1/-1 until an inset has actually been dispatched.
        keyboardState.mockResolvedValue({ visible: false, topPx: -1, viewHeightPx: -1 });
        const seen = watch();
        await vi.advanceTimersByTimeAsync(0);
        expect(seen).toEqual([]);
        await vi.advanceTimersByTimeAsync(KEYBOARD_ASSUME_AFTER_MS);
        expect(currentKeyboardInset().source, 'the ladder must still run').toBe('assumed');
    });

    it('live native events keep updating the band', async () => {
        let push: ((d: { visible: boolean; topPx: number; viewHeightPx: number }) => void) | null = null;
        onKeyboard.mockImplementation((cb: (d: { visible: boolean; topPx: number; viewHeightPx: number }) => void) => {
            push = cb;
            return Promise.resolve({ remove: async () => {} });
        });
        const seen = watch();
        await vi.advanceTimersByTimeAsync(0);
        expect(push, 'the rig must have captured the listener').not.toBeNull();
        push!({ visible: true, topPx: 1200, viewHeightPx: 2400 });
        expect(seen.at(-1)).toEqual({ visible: true, top: 422, source: 'native' });
        // A language switch grows the keyboard.
        push!({ visible: true, topPx: 1000, viewHeightPx: 2400 });
        expect(seen.at(-1)!.top).toBeCloseTo(351.6666666666667, 9);
    });

    it('an old APK rejecting both calls does not stop the ladder', async () => {
        // The default mocks in beforeEach ARE the old APK. Its control is the
        // resolving mock above, which wins.
        fakeVisualViewport(500);
        const seen = watch();
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.at(-1)!.source).toBe('visual-viewport');
    });
});

describe('reference counting', () => {
    it('a second watcher does not double-install, and the last one removes', () => {
        const vv = fakeVisualViewport(500);
        const a = watchKeyboardInset(() => {});
        const installed = countVvListeners(vv);
        expect(installed, 'resize and scroll').toBeGreaterThan(0);
        const b = watchKeyboardInset(() => {});
        expect(countVvListeners(vv)).toBe(installed);
        a();
        expect(countVvListeners(vv), 'one watcher left, listeners stay').toBe(installed);
        b();
        expect(countVvListeners(vv)).toBe(0);
    });

    it('a watcher arriving after the sources spoke is told immediately', () => {
        fakeVisualViewport(500);
        const first = watchKeyboardInset(() => {});
        const late: Array<ReturnType<typeof currentKeyboardInset>> = [];
        const second = watchKeyboardInset(i => late.push(i));
        expect(late).toEqual([{ visible: true, top: 500, source: 'visual-viewport' }]);
        first();
        second();
    });

    it('a fresh watch starts from nothing rather than a stale keyboard', () => {
        fakeVisualViewport(500);
        const off = watchKeyboardInset(() => {});
        expect(currentKeyboardInset().visible).toBe(true);
        off();
        expect(currentKeyboardInset()).toEqual({ visible: false, top: null, source: 'none' });
    });
});
