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
}
