package com.sovereign.app;

/**
 * One reading of the soft keyboard's position: where its top edge sits in the
 * WebView's own coordinate space, and how tall that WebView is — both in RAW
 * PIXELS — plus the decision of whether a new reading is worth telling the web
 * layer about.
 *
 * Pure — no Android imports — so the dedupe matrix runs under plain JUnit (see
 * ImeInsetsTest), the same pattern as {@link PushGate} and
 * {@link DeliveryCreds}. SovereignAppPlugin makes the framework calls and
 * delegates the decision here; this class must never grow an Android import.
 *
 * <p>RAW pixels, not CSS px, because the conversion is
 * {@code topPx / viewHeightPx * document.documentElement.clientHeight} and only
 * the web layer knows that last number. Dividing by
 * {@code DisplayMetrics.density} here would be wrong whenever the CSS scale is
 * not exactly 1/density, which is the normal case: the layout viewport is
 * whatever the page's own width/initial-scale resolves to, not the display
 * metrics. Emitting the pair keeps the ratio exact on every device.
 */
final class ImeInsets {

    /**
     * Nothing has been measured yet. Deliberately distinguishable from a
     * measured "the keyboard is closed" (which is {@code visible=false} with
     * real pixel values): JS must be able to tell "this APK/OS never reported"
     * — fall through to the visualViewport/assumed ladder — from "the native
     * layer says there is no keyboard", which is the truth and stops the
     * follow. The -1s are that unknown marker.
     */
    static final ImeInsets UNKNOWN = new ImeInsets(false, -1, -1);

    /**
     * Movement smaller than this is the slide-in animation, not news. Window
     * insets are dispatched once per animation frame (~60/s for ~250 ms while
     * the keyboard rises), and an un-deduped notifyListeners at that rate is
     * exactly the ~70-bridge-calls-per-second pathology already measured in
     * this app's mobileApp bridge. 8 px is well under one text line at any
     * density, so nothing the follow cares about is swallowed.
     */
    static final int MIN_TOP_DELTA_PX = 8;

    /** Is the IME actually on screen (WindowInsetsCompat.Type.ime()). */
    final boolean visible;

    /** The keyboard's top edge, in pixels, measured from the WebView's own top
     *  edge — the WebView need not start at the window's top (status bar,
     *  cutout), and the IME inset is measured from the WINDOW's bottom. */
    final int topPx;

    /** The WebView's height in pixels — the denominator JS scales by. */
    final int viewHeightPx;

    ImeInsets(boolean visible, int topPx, int viewHeightPx) {
        this.visible = visible;
        this.topPx = topPx;
        this.viewHeightPx = viewHeightPx;
    }

    /**
     * Should this reading be pushed to the web layer?
     *
     * <p>A null {@code prev} means nothing has been dispatched for this WebView
     * yet, so the first reading always goes out — an activity recreation gives
     * us a new view whose geometry has nothing to do with the last one's.
     *
     * <p>An open/close flip and a WebView-height change (rotation, fold, an
     * OEM split-screen resize) are never swallowed: the first is the whole
     * signal, and the second changes the denominator JS divides by, so a
     * numerically identical topPx means a different place on screen.
     */
    static boolean worthNotifying(ImeInsets prev, ImeInsets next) {
        if (prev == null) return true;
        if (prev.visible != next.visible) return true;
        if (prev.viewHeightPx != next.viewHeightPx) return true;
        return Math.abs(prev.topPx - next.topPx) >= MIN_TOP_DELTA_PX;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof ImeInsets)) return false;
        ImeInsets other = (ImeInsets) o;
        return visible == other.visible
                && topPx == other.topPx
                && viewHeightPx == other.viewHeightPx;
    }

    @Override
    public int hashCode() {
        int h = visible ? 1 : 0;
        h = 31 * h + topPx;
        h = 31 * h + viewHeightPx;
        return h;
    }

    @Override
    public String toString() {
        return "ImeInsets{visible=" + visible
                + ", topPx=" + topPx
                + ", viewHeightPx=" + viewHeightPx + "}";
    }
}
