package com.sovereign.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Which start a screen share's events answer (ScreenShareSlot). The review
 * found the first Share after a reload always failed: the new start stopped
 * the share the old page left running, and that share's END answered the
 * NEW start, while Android's dialog was still open.
 */
public class ScreenShareSlotTest {

    @Test
    public void anOldSharesEndDoesNotAnswerTheNewStart() {
        ScreenShareSlot<String> slot = new ScreenShareSlot<>();
        long old = slot.begin("old call", "cb1", "n1", 1280, 720, 30).id;
        assertSame("old call", slot.take(old).call); // the old share started
        long fresh = slot.begin("new call", "cb2", "n2", 1280, 720, 30).id;
        assertNotEquals(old, fresh);
        // The old share now ends (stopped to make way for the new one):
        assertNull("its end must not take the new start", slot.take(old));
        assertTrue(slot.busy());
        assertSame("new call", slot.take(fresh).call);
        assertFalse(slot.busy());
    }

    @Test
    public void theConsentAnswerIsTakenOnlyByTheCallThatAsked() {
        ScreenShareSlot<String> slot = new ScreenShareSlot<>();
        slot.begin("call", "cb7", "n", 1280, 720, 30);
        assertNull("a different call (an earlier page's) is not the waiting start", slot.forCall("cb6"));
        assertNull(slot.forCall(null));
        assertEquals("n", slot.forCall("cb7").nonce);
    }

    @Test
    public void aShareStartsWithTheNonceAndSizeOfItsOwnStart() {
        ScreenShareSlot<String> slot = new ScreenShareSlot<>();
        ScreenShareSlot.Pending<String> p = slot.begin("c", "cb", "abc", 1920, 1080, 60);
        assertEquals("abc", slot.peek(p.id).nonce);
        assertEquals(1920, p.width);
        assertEquals(1080, p.height);
        assertEquals(60, p.fps);
        assertNull(slot.peek(p.id + 1));
    }

    @Test
    public void aPageThatGoesAwayTakesWhateverWasWaiting() {
        ScreenShareSlot<String> slot = new ScreenShareSlot<>();
        long id = slot.begin("c", "cb", "n", 1, 1, 1).id;
        assertSame("c", slot.takeAny().call);
        assertNull("and a capture starting afterwards finds nobody", slot.take(id));
        assertNull(slot.takeAny());
    }
}
