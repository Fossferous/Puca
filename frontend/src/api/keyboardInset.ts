/**
 * WHERE THE SOFT KEYBOARD'S TOP EDGE IS, in CSS px, in layout-viewport
 * coordinates.
 *
 * Nothing in this app measured the Android IME before this: there is no
 * @capacitor/keyboard, no visualViewport use, and no windowSoftInputMode. On
 * Android 15+ (edge-to-edge, targetSdk 36) the WebView is never resized for the
 * keyboard either — Capacitor's SystemBars only applies an IME margin with
 * `viewport-fit=cover`, which this app deliberately does NOT set (it would turn
 * on real env(safe-area-inset-*) app-wide). So the layout viewport keeps its
 * full height while the keyboard covers the bottom 40-55% of it, and the web
 * layer has to be told.
 *
 * Its own module rather than part of mobileApp.ts: that file is the PLUGIN
 * wrapper, with a documented silent-degradation policy per method. This merges
 * THREE sources, only one of which is the plugin, and owns a fallback policy
 * that has nothing to do with Capacitor.
 *
 * PRECEDENCE, highest first — a lower source never overwrites a higher one that
 * has spoken this session:
 *  1. native — the plugin's `keyboard` event plus a one-shot keyboardState() on
 *     the first watch. Native is truth: a DeX setup or a hardware keyboard
 *     reports visible:false and nothing follows.
 *  2. visual-viewport — real for the WEBAPP in mobile Chrome, which does shrink
 *     the visual viewport. Normally silent in the Android WebView, and that is
 *     the documented finding rather than dead code.
 *  3. assumed — a fraction of the viewport, after a short delay, when nothing
 *     higher has spoken. This is the API 24-29 path and the old-APK path: a
 *     slightly wrong band beats no feature. Its known degradation is that a
 *     back-gesture IME dismissal is invisible, so the follow stays armed with a
 *     phantom inset until the caller stops asking.
 */
import { mobileKeyboardState, onMobileKeyboard } from './mobileApp';

export interface KeyboardInset {
    visible: boolean;
    /** The keyboard's TOP edge in CSS px, layout-viewport coordinates. null =
     *  nothing has measured it. Equal to the viewport height when the keyboard
     *  is down (or when the OS already resized the WebView so it does not
     *  overlap — Android <= 14 — where the surface box excludes it and the
     *  bottom inset comes out 0 by construction). */
    top: number | null;
    source: 'native' | 'visual-viewport' | 'assumed' | 'none';
}

/** Android raises the IME ~150-250ms after the focus that happens inside the
 *  opening tap. 350ms is past that and still inside the first placement the
 *  user could notice. */
export const KEYBOARD_ASSUME_AFTER_MS = 350;
/** What fraction of the viewport a soft keyboard covers when NOTHING can
 *  measure it. Gboard with a suggestion strip lands at 0.35-0.45 portrait. A
 *  measured value always wins; this exists so the feature works on an APK that
 *  predates the plugin method and in a browser that does not shrink. */
export const KEYBOARD_ASSUMED_FRACTION_PORTRAIT = 0.42;
export const KEYBOARD_ASSUMED_FRACTION_LANDSCAPE = 0.55;
/** A visual-viewport shrink smaller than this is a URL bar or an in-page
 *  scroll, not a keyboard. */
export const VV_MIN_COVER_PX = 80;

/**
 * The native side's RAW px into CSS px.
 *
 * `topPx / viewHeightPx` is the WebView's own height fraction, and the layout
 * viewport's `clientHeight` is what that fraction means in CSS px. Deliberately
 * NOT `topPx / density`: the WebView's CSS scale is only 1/density while nothing
 * has changed it, and a system display-size change or any future `initial-scale`
 * makes a density conversion wrong by a plausible-looking 10-30% — the worst
 * kind of error, because the band still looks nearly right.
 *
 * null for "unknown": a non-positive `viewHeightPx` (no view yet) or a negative
 * `topPx` (the plugin's "nothing observed yet" sentinel).
 */
export function imeTopToCss(topPx: number, viewHeightPx: number, cssViewportH: number): number | null {
    if (!Number.isFinite(topPx) || !Number.isFinite(viewHeightPx) || !Number.isFinite(cssViewportH)) return null;
    if (!(viewHeightPx > 0) || !(cssViewportH > 0)) return null;
    if (topPx < 0) return null;
    return (topPx / viewHeightPx) * cssViewportH;
}

const RANK: Record<KeyboardInset['source'], number> = {
    none: 0, assumed: 1, 'visual-viewport': 2, native: 3,
};

let current: KeyboardInset = { visible: false, top: null, source: 'none' };
const watchers = new Set<(i: KeyboardInset) => void>();

/** Teardown for everything the first watcher installed. */
let uninstall: (() => void) | null = null;
/** The visual viewport has genuinely seen a keyboard-sized shrink at least
 *  once. Until it has, a "no shrink" reading must NOT claim the source — in the
 *  Android WebView the visual viewport never shrinks for the IME, and claiming
 *  it would lock out the assumed tier that is the only live source there. */
let vvClaimed = false;

export function currentKeyboardInset(): KeyboardInset {
    return current;
}

function publish(next: KeyboardInset): void {
    if (RANK[next.source] < RANK[current.source]) return;      // precedence
    if (next.visible === current.visible && next.top === current.top && next.source === current.source) return;
    current = next;
    for (const cb of [...watchers]) {
        try {
            cb(next);
        } catch {
            // One consumer throwing must not stop the others, and must not tear
            // down a listener the whole feature depends on.
        }
    }
}

function viewportH(): number {
    // clientHeight, not innerHeight: the layout viewport is what CSS px are
    // measured in, and it is the same number the native conversion multiplies.
    const doc = typeof document !== 'undefined' ? document.documentElement : null;
    return doc && doc.clientHeight > 0 ? doc.clientHeight : window.innerHeight;
}

function readVisualViewport(): void {
    const vv = window.visualViewport;
    if (!vv) return;
    const h = viewportH();
    const top = vv.offsetTop + vv.height;
    const covered = h - top;
    if (covered > VV_MIN_COVER_PX) {
        vvClaimed = true;
        publish({ visible: true, top, source: 'visual-viewport' });
        return;
    }
    // No shrink. Only meaningful once this source has proved it CAN see one.
    if (!vvClaimed) return;
    publish({ visible: false, top: h, source: 'visual-viewport' });
}

function assumedInset(): KeyboardInset {
    const h = viewportH();
    const portrait = h >= window.innerWidth;
    const f = portrait ? KEYBOARD_ASSUMED_FRACTION_PORTRAIT : KEYBOARD_ASSUMED_FRACTION_LANDSCAPE;
    return { visible: true, top: h * (1 - f), source: 'assumed' };
}

/**
 * Watch the keyboard inset. Reference counted: several callers may watch, only
 * the first installs anything. The returned function removes exactly what it
 * added.
 */
export function watchKeyboardInset(cb: (i: KeyboardInset) => void): () => void {
    watchers.add(cb);
    if (watchers.size === 1) {
        // install() reads every source it can read synchronously and publishes
        // through the set this watcher is already in, so replaying here as well
        // would deliver the same reading twice.
        install();
    } else if (current.source !== 'none') {
        // A watcher that arrives after the sources have spoken must not have to
        // wait for the next change to learn where the keyboard is.
        try {
            cb(current);
        } catch {
            // As in publish(): the caller's problem.
        }
    }
    return () => {
        watchers.delete(cb);
        if (watchers.size === 0) {
            uninstall?.();
            uninstall = null;
        }
    };
}

function install(): void {
    const cleanups: Array<() => void> = [];

    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (vv) {
        const onVv = () => readVisualViewport();
        vv.addEventListener('resize', onVv);
        vv.addEventListener('scroll', onVv);
        cleanups.push(() => {
            vv.removeEventListener('resize', onVv);
            vv.removeEventListener('scroll', onVv);
        });
        readVisualViewport();
    }

    // The assumed tier, re-derived on rotation: the fraction is of the viewport,
    // and the viewport changes shape.
    const onResize = () => {
        if (RANK[current.source] > RANK.assumed) return;
        if (current.source === 'assumed') publish(assumedInset());
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    cleanups.push(() => {
        window.removeEventListener('resize', onResize);
        window.removeEventListener('orientationchange', onResize);
    });

    const assumeTimer = window.setTimeout(() => {
        if (current.source !== 'none') return;   // something better spoke
        publish(assumedInset());
    }, KEYBOARD_ASSUME_AFTER_MS);
    cleanups.push(() => window.clearTimeout(assumeTimer));

    // NATIVE, last to be installed and first in precedence: both calls are
    // async, and an old APK rejects both without poisoning anything.
    let live = true;
    const fromNative = (d: { visible: boolean; topPx: number; viewHeightPx: number }) => {
        if (!live) return;
        const top = imeTopToCss(d.topPx, d.viewHeightPx, viewportH());
        // Unknown geometry is not a measurement: claiming the native source on
        // it would lock out the ladder for a number we do not have.
        if (top === null) return;
        publish({ visible: d.visible, top, source: 'native' });
    };
    void mobileKeyboardState().then(s => { if (s) fromNative(s); }).catch(() => undefined);
    const handle = onMobileKeyboard(fromNative);
    cleanups.push(() => {
        live = false;
        void handle.then(h => h?.remove()).catch(() => undefined);
    });

    uninstall = () => {
        for (const c of cleanups) {
            try {
                c();
            } catch {
                // Removing a listener must never throw its way out of an
                // unmount.
            }
        }
        // The next watcher starts from scratch, including the assume timer: a
        // stale "keyboard is up" from a previous panel is worse than no reading.
        current = { visible: false, top: null, source: 'none' };
        vvClaimed = false;
    };
}
