package com.sovereign.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The soft-keyboard dedupe, under plain JUnit — no device, no View, no insets.
 *
 * This matters because window insets are dispatched once per animation frame
 * while the keyboard rises: if worthNotifying() stops swallowing the in-between
 * readings, every keyboard open becomes ~15 bridge calls in 250 ms (the
 * pathology already measured on this app's bridge), and if it starts swallowing
 * too much the caret follow never learns the keyboard opened at all. So each
 * "swallowed" case has a sibling positive control proving the rig can also say
 * yes.
 *
 * All numbers are hand-derived from MIN_TOP_DELTA_PX = 8; the pixel values are
 * a plausible 1080x2400 phone.
 */
public class ImeInsetsTest {

    private static final int VIEW_H = 2400;

    private static ImeInsets hidden() {
        // A measured "no keyboard": the top edge is the bottom of the view.
        return new ImeInsets(false, VIEW_H, VIEW_H);
    }

    private static ImeInsets visibleAt(int topPx) {
        return new ImeInsets(true, topPx, VIEW_H);
    }

    @Test
    public void anOpeningKeyboardIsAlwaysReported() {
        // POSITIVE CONTROL for every "swallowed" case below: the rig can say yes.
        assertTrue(ImeInsets.worthNotifying(hidden(), visibleAt(1200)));
    }

    @Test
    public void anUnchangedHiddenReadingIsSwallowed() {
        // The steady state: insets are re-dispatched on unrelated layout passes
        // (status-bar changes, a scroll settling), and none of those are news.
        assertFalse(ImeInsets.worthNotifying(hidden(), hidden()));
    }

    @Test
    public void aFourPixelSlideIsSwallowed() {
        assertFalse(ImeInsets.worthNotifying(visibleAt(1200), visibleAt(1204)));
    }

    @Test
    public void aTwentyPixelMoveIsReported() {
        // A keyboard swapping to a taller layout (emoji panel, suggestion strip)
        // moves the strip enough that the caret placement is wrong until we say.
        assertTrue(ImeInsets.worthNotifying(visibleAt(1200), visibleAt(1220)));
    }

    @Test
    public void theEightPixelThresholdIsInclusive() {
        // Hand-derived boundary either side of MIN_TOP_DELTA_PX = 8.
        assertFalse(ImeInsets.worthNotifying(visibleAt(1200), visibleAt(1207)));
        assertTrue(ImeInsets.worthNotifying(visibleAt(1200), visibleAt(1208)));
        // Symmetric: it is the magnitude, not the sign, that decides.
        assertFalse(ImeInsets.worthNotifying(visibleAt(1200), visibleAt(1193)));
        assertTrue(ImeInsets.worthNotifying(visibleAt(1200), visibleAt(1192)));
    }

    @Test
    public void aClosingKeyboardIsAlwaysReported() {
        // Even when the pixel delta is under the threshold: a visibility flip is
        // the whole signal, and a swallowed close leaves the follow armed with a
        // phantom strip.
        assertTrue(ImeInsets.worthNotifying(visibleAt(2396), new ImeInsets(false, VIEW_H, VIEW_H)));
    }

    @Test
    public void theFirstReadingOfAWebViewIsAlwaysReported() {
        // null prev = an activity recreation handed us a new WebView; the old
        // reading was measured against a view that no longer exists.
        assertTrue(ImeInsets.worthNotifying(null, hidden()));
        assertTrue(ImeInsets.worthNotifying(null, visibleAt(1200)));
    }

    @Test
    public void aViewHeightChangeIsReportedEvenAtTheSameTopPx() {
        // Rotation / fold / split-screen: JS scales topPx by viewHeightPx, so
        // an identical topPx under a new height is a DIFFERENT place on screen.
        assertTrue(ImeInsets.worthNotifying(
                new ImeInsets(true, 1200, 2400),
                new ImeInsets(true, 1200, 1080)));
    }

    @Test
    public void theUnknownMarkerIsDistinguishableFromAMeasuredHiddenKeyboard() {
        // JS branches on this: -1s mean "nothing has measured it, fall back to
        // the visualViewport/assumed ladder", while a measured hidden keyboard
        // is the native layer telling the truth and must stop the follow.
        assertFalse(ImeInsets.UNKNOWN.visible);
        assertEquals(-1, ImeInsets.UNKNOWN.topPx);
        assertEquals(-1, ImeInsets.UNKNOWN.viewHeightPx);
        assertNotEquals(ImeInsets.UNKNOWN, hidden());
    }

    @Test
    public void equalReadingsAreEqualAndHashAlike() {
        ImeInsets a = new ImeInsets(true, 1200, VIEW_H);
        ImeInsets b = new ImeInsets(true, 1200, VIEW_H);
        assertEquals(a, b);
        assertEquals(a.hashCode(), b.hashCode());
        // Positive control that equals actually discriminates — an equals that
        // returns true for everything would pass the line above.
        assertNotEquals(a, new ImeInsets(true, 1201, VIEW_H));
        assertNotEquals(a, new ImeInsets(false, 1200, VIEW_H));
        assertNotEquals(a, new ImeInsets(true, 1200, VIEW_H + 1));
        assertNotEquals(a, "ImeInsets{visible=true, topPx=1200, viewHeightPx=2400}");
    }

    @Test
    public void toStringNamesTheFields() {
        // Read in log/assertion output; the field names are the point.
        assertEquals("ImeInsets{visible=true, topPx=1200, viewHeightPx=2400}",
                new ImeInsets(true, 1200, 2400).toString());
    }
}
