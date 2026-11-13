package com.sovereign.app.control;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/**
 * Where a viewer's point lands on the phone, and when it may not. Each case
 * says what would have to break for it to go red.
 */
public class ScreenMapTest {

    private static final long NOW = 100_000;

    private static ScreenMap.Share share(int w, int h, boolean visible, long changedAt) {
        return new ScreenMap.Share(w, h, visible, changedAt);
    }

    @Test
    public void theWholeScreenSettledMaps() {
        assertNull(ScreenMap.refusal(share(1080, 2400, true, NOW - 5000), 1080, 2400, NOW));
        // Rounding between the capture and the screen is not "one app".
        assertNull(ScreenMap.refusal(share(1080, 2397, true, NOW - 5000), 1080, 2400, NOW));
    }

    @Test
    public void noShareIsNotSharing() {
        assertEquals(ScreenMap.NOT_SHARING, ScreenMap.refusal(null, 1080, 2400, NOW));
        assertEquals(ScreenMap.NOT_SHARING, ScreenMap.refusal(share(0, 0, true, 0), 1080, 2400, NOW));
        // The host answers null with no share running.
        assertNull(ScreenMap.Share.of(null));
        assertEquals(ScreenMap.NOT_SHARING, ScreenMap.refusal(ScreenMap.Share.of(null), 1080, 2400, NOW));
    }

    @Test
    public void oneAppInAWindowIsRefused() {
        // Split screen: the shared app's window is half the screen.
        assertEquals(ScreenMap.ONE_APP, ScreenMap.refusal(share(1080, 1180, true, NOW - 5000), 1080, 2400, NOW));
    }

    @Test
    public void sharedContentBehindAnotherAppIsRefused() {
        assertEquals(ScreenMap.HIDDEN, ScreenMap.refusal(share(1080, 2400, false, NOW - 5000), 1080, 2400, NOW));
    }

    @Test
    public void justAfterTheScreenTurnsItIsRefusedUntilItSettles() {
        // The capture already turned, a moment ago: the viewer's picture has not.
        assertEquals(ScreenMap.SETTLING, ScreenMap.refusal(share(2400, 1080, true, NOW - 200), 2400, 1080, NOW));
        assertNull(ScreenMap.refusal(share(2400, 1080, true, NOW - ScreenMap.SETTLE_MS), 2400, 1080, NOW));
        // The screen turned and the capture has not caught up: the same
        // screen the other way round is settling, never "one app".
        assertEquals(ScreenMap.SETTLING, ScreenMap.refusal(share(1080, 2400, true, NOW - 9000), 2400, 1080, NOW));
    }

    @Test
    public void beginTreatsSettlingAsFineAndHiddenAsOneApp() {
        assertNull(ScreenMap.beginRefusal(share(1080, 2400, true, NOW - 10), 1080, 2400, NOW));
        // The person is looking at Púca to press Allow: content hidden then
        // means it is some OTHER app that is shared.
        assertEquals(ScreenMap.ONE_APP, ScreenMap.beginRefusal(share(1080, 2400, false, NOW - 9000), 1080, 2400, NOW));
        assertEquals(ScreenMap.NOT_SHARING, ScreenMap.beginRefusal(null, 1080, 2400, NOW));
    }

    @Test
    public void pointsMapByFractionAndStayOnTheScreen() {
        assertArrayEquals(new float[] { 540, 1200 }, ScreenMap.toScreen(0.5, 0.5, 1080, 2400), 0.01f);
        assertArrayEquals(new float[] { 0, 0 }, ScreenMap.toScreen(0, 0, 1080, 2400), 0.01f);
        // The far edge is the last pixel, not one past it (dispatchGesture
        // refuses a path off the screen).
        assertArrayEquals(new float[] { 1079, 2399 }, ScreenMap.toScreen(1, 1, 1080, 2400), 0.01f);
        assertArrayEquals(new float[] { 0, 2399 }, ScreenMap.toScreen(-3, 7, 1080, 2400), 0.01f);
        // Sideways: the same fractions on the turned screen.
        assertArrayEquals(new float[] { 600, 270 }, ScreenMap.toScreen(0.25, 0.25, 2400, 1080), 0.01f);
        // Garbage is the middle, never a NaN path.
        assertArrayEquals(new float[] { 540, 1200 }, ScreenMap.toScreen(Double.NaN, Double.NaN, 1080, 2400), 0.01f);
    }

    @Test
    public void hostStateReadsInOrder() {
        ScreenMap.Share s = ScreenMap.Share.of(new long[] { 1080, 2400, 0, 42 });
        assertEquals(1080, s.contentW);
        assertEquals(2400, s.contentH);
        assertEquals(false, s.visible);
        assertEquals(42, s.changedAt);
        assertNull(ScreenMap.Share.of(new long[] { 1, 2 }));
    }
}
