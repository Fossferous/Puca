package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The one decision that keeps a voice note off the network: TranscribeGate.
 *
 * The rule under test is not "returns the right string" but "there is NO way
 * to get ALLOW without an on-device recogniser". The sweep at the bottom is
 * the real gate -- delete the isOnDeviceRecognitionAvailable check in
 * TranscribeGate and it goes red, which is what it is for.
 */
public class TranscribeGateTest {

    @Test
    public void allowsOnlyOnAndroid13OrNewerWithAnOnDeviceModel() {
        // Positive control: the one combination that IS allowed.
        TranscribeGate.Decision ok = TranscribeGate.decide(33, true);
        assertTrue("API 33 with an on-device model must be allowed", ok.allowed);
        assertEquals("", ok.reason);

        assertTrue(TranscribeGate.decide(34, true).allowed);
        assertTrue(TranscribeGate.decide(36, true).allowed);
    }

    @Test
    public void refusesBelowAndroid13BecauseARecordedFileCannotBeFedToTheRecogniser() {
        for (int sdk : new int[] { 24, 29, 31, 32 }) {
            TranscribeGate.Decision d = TranscribeGate.decide(sdk, true);
            assertFalse("SDK " + sdk + " must be refused", d.allowed);
            assertEquals(TranscribeGate.REASON_SDK, d.reason);
        }
    }

    @Test
    public void refusesWhenThereIsNoOnDeviceModel() {
        TranscribeGate.Decision d = TranscribeGate.decide(34, false);
        assertFalse(d.allowed);
        assertEquals(TranscribeGate.REASON_NO_MODEL, d.reason);
    }

    @Test
    public void everyRefusalCarriesAReasonTheUserCanBeTold() {
        for (int sdk = 21; sdk <= 40; sdk++) {
            for (boolean onDevice : new boolean[] { false, true }) {
                TranscribeGate.Decision d = TranscribeGate.decide(sdk, onDevice);
                if (!d.allowed) {
                    assertFalse("sdk=" + sdk + " onDevice=" + onDevice + " refused with no reason",
                            d.reason == null || d.reason.isEmpty());
                }
            }
        }
    }

    /**
     * THE GATE. No input combination may return ALLOW while the phone has no
     * on-device recogniser -- a networked fallback is the single change that
     * would turn a private feature into a cloud one.
     */
    @Test
    public void noInputEverAllowsWithoutAnOnDeviceRecogniser() {
        int allowed = 0;
        for (int sdk = 0; sdk <= 60; sdk++) {
            assertFalse("sdk=" + sdk + " allowed transcription with no on-device model",
                    TranscribeGate.decide(sdk, false).allowed);
            if (TranscribeGate.decide(sdk, true).allowed) allowed++;
        }
        // Positive control for the sweep: it did see allowed cases, so the
        // assertion above is not passing because nothing was allowed at all.
        assertEquals("every SDK from 33 to 60 with a model should be allowed", 28, allowed);
    }

    // --- the session watchdog ------------------------------------------------
    // A recognition session that is started but never calls back leaves the
    // PluginCall unanswered, and the page deletes the plaintext PCM from the
    // app's cache only when that call RETURNS. So the wait must be finite for
    // EVERY input, including the ones that come from a file that cannot be
    // read (length 0) or a nonsense sample rate.

    @Test
    public void theWaitIsAlwaysFiniteAndInsideItsOwnBounds() {
        long[] sizes = { 0L, 1L, 32_000L, 640_000L, 3_840_000L, 500_000_000L, Long.MAX_VALUE / 2_000L };
        int[] rates = { 0, -1, 8_000, 16_000, 48_000 };
        for (long bytes : sizes) {
            for (int rate : rates) {
                long ms = TranscribeGate.watchdogMs(bytes, rate);
                assertTrue("bytes=" + bytes + " rate=" + rate + " gave " + ms,
                        ms >= TranscribeGate.WATCHDOG_MIN_MS && ms <= TranscribeGate.WATCHDOG_MAX_MS);
            }
        }
    }

    @Test
    public void aLongerClipGetsLongerUntilTheCap() {
        // 16 kHz mono 16-bit: 32 000 bytes is one second.
        long oneSecond = TranscribeGate.watchdogMs(32_000L, 16_000);
        long twentySeconds = TranscribeGate.watchdogMs(20L * 32_000L, 16_000);
        long twoMinutes = TranscribeGate.watchdogMs(120L * 32_000L, 16_000);
        // Positive control: this is not one constant wearing three names.
        assertTrue("a longer clip must get longer", twentySeconds > oneSecond);
        assertEquals(TranscribeGate.WATCHDOG_MIN_MS, oneSecond);
        assertEquals(45_000L, twentySeconds);
        assertEquals(TranscribeGate.WATCHDOG_MAX_MS, twoMinutes);
    }

    @Test
    public void anUnreadableFileStillGetsTheFloorRatherThanNoWaitAtAll() {
        // length() answers 0 for a file that vanished: a zero budget would
        // fire the watchdog before the recogniser had a chance to speak.
        assertEquals(TranscribeGate.WATCHDOG_MIN_MS, TranscribeGate.watchdogMs(0L, 16_000));
        assertEquals(TranscribeGate.WATCHDOG_MIN_MS, TranscribeGate.watchdogMs(-5L, 16_000));
        assertEquals(TranscribeGate.WATCHDOG_MIN_MS, TranscribeGate.watchdogMs(640_000L, 0));
    }

    /** The page waits a little longer than the phone does (audioNote.ts's
     *  transcribeBudgetMs adds five seconds), so the phone normally answers
     *  first with words rather than the page giving up on it. */
    @Test
    public void theBoundsMatchTheOnesThePageWaitsOn() {
        assertEquals(20_000L, TranscribeGate.WATCHDOG_MIN_MS);
        assertEquals(60_000L, TranscribeGate.WATCHDOG_MAX_MS);
    }
}
