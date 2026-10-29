package com.sovereign.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The capture size and the frame gate of a phone's screen share
 * (ScreenShareFrames). The size decides what the viewers see; the gate
 * decides whether a slow page is handed a backlog.
 */
public class ScreenShareFramesTest {

    @Test
    public void anUprightPhoneFitsTheDialogsBoxTurnedUpright() {
        // 1080x2400 into "1280x720": the box turns to 720x1280, height binds.
        assertArrayEquals(new int[] { 576, 1280 }, ScreenShareFrames.fit(1080, 2400, 1280, 720));
        // Asked the other way round, the answer is the same.
        assertArrayEquals(new int[] { 576, 1280 }, ScreenShareFrames.fit(1080, 2400, 720, 1280));
    }

    @Test
    public void aSidewaysPhoneFitsTheBoxAsItIs() {
        assertArrayEquals(new int[] { 1280, 576 }, ScreenShareFrames.fit(2400, 1080, 1280, 720));
    }

    @Test
    public void neverLargerThanTheScreen() {
        assertArrayEquals(new int[] { 720, 1600 }, ScreenShareFrames.fit(720, 1600, 3840, 2160));
    }

    @Test
    public void desktopSizesAreCappedAtTheDialogs1080p() {
        // "Source" asks 3840x2160; a 1440x3200 phone gets the 1080x1920 box.
        assertArrayEquals(new int[] { 864, 1920 }, ScreenShareFrames.fit(1440, 3200, 3840, 2160));
        assertArrayEquals(new int[] { 864, 1920 }, ScreenShareFrames.fit(1440, 3200, 1920, 1080));
    }

    @Test
    public void alwaysEven() {
        int[] s = ScreenShareFrames.fit(721, 1601, 721, 1601);
        assertArrayEquals(new int[] { 720, 1600 }, s);
        // A scale that lands on an odd number is rounded down, not up.
        int[] t = ScreenShareFrames.fit(1080, 2340, 1920, 1080);
        assertEquals(0, t[0] % 2);
        assertEquals(0, t[1] % 2);
        assertTrue(t[1] <= 1920 && t[0] <= 1080);
    }

    @Test
    public void noAskMeansTheWholeScreenWithinTheCap() {
        assertArrayEquals(new int[] { 720, 1600 }, ScreenShareFrames.fit(720, 1600, 0, 0));
        assertArrayEquals(new int[] { 864, 1920 }, ScreenShareFrames.fit(1080, 2400, 0, 0));
    }

    @Test
    public void anUnknownScreenIsNothing() {
        assertArrayEquals(new int[] { 0, 0 }, ScreenShareFrames.fit(0, 2400, 1280, 720));
    }

    @Test
    public void theFrameRateIsCappedAtThirty() {
        assertEquals(30, ScreenShareFrames.clampFps(60));
        assertEquals(15, ScreenShareFrames.clampFps(15));
        assertEquals(30, ScreenShareFrames.clampFps(0));
    }

    @Test
    public void theGateKeepsTheFrameRate() {
        ScreenShareFrames.Gate g = new ScreenShareFrames.Gate(10); // 100 ms
        assertTrue(g.tryAcquire(1000));
        g.release();
        assertFalse("too soon", g.tryAcquire(1050));
        assertTrue("on time", g.tryAcquire(1100));
        g.release();
        // vsync jitter: a frame slightly early is still on time
        assertTrue(g.tryAcquire(1190));
    }

    @Test
    public void thirtyFpsSurvivesASixtyHertzScreen() {
        // Frames every 16.67 ms; at 30 fps every other one must go. A strict
        // `>= interval` check let only every THIRD go (15-ish fps).
        ScreenShareFrames.Gate g = new ScreenShareFrames.Gate(30);
        int sent = 0;
        for (int i = 0; i < 60; i++) {
            long t = Math.round(i * 1000.0 / 60);
            if (g.tryAcquire(t)) {
                sent++;
                g.release();
            }
        }
        assertEquals(30, sent);
    }

    @Test
    public void aPageThatFallsBehindIsHandedNoBacklog() {
        ScreenShareFrames.Gate g = new ScreenShareFrames.Gate(30);
        assertTrue(g.tryAcquire(0));
        assertTrue(g.tryAcquire(100));
        assertEquals(2, g.inFlight());
        // Two unacknowledged: nothing more is encoded, however long it waits.
        assertFalse(g.tryAcquire(200));
        assertFalse(g.tryAcquire(1000));
        g.release();
        assertTrue("one acknowledged, the next may go", g.tryAcquire(1100));
    }

    @Test
    public void lostAcksExpireSoTheShareNeverFreezes() {
        // The field failure this guards: acks that never arrive held a share
        // on its second frame for good.
        ScreenShareFrames.Gate g = new ScreenShareFrames.Gate(30);
        assertTrue(g.tryAcquire(0));
        assertTrue(g.tryAcquire(100));
        assertFalse(g.tryAcquire(100 + ScreenShareFrames.STALE_MS - 1));
        assertTrue(g.tryAcquire(100 + ScreenShareFrames.STALE_MS));
        assertEquals(1, g.inFlight());
    }

    @Test
    public void moreReleasesThanFramesNeverOpenTheGateWider() {
        ScreenShareFrames.Gate g = new ScreenShareFrames.Gate(30);
        g.release();
        g.release();
        assertEquals(0, g.inFlight());
        assertTrue(g.tryAcquire(0));
        assertTrue(g.tryAcquire(100));
        assertFalse(g.tryAcquire(200));
    }
}
