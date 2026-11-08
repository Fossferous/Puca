package com.sovereign.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * The rules of the remote-control notification's key buttons: what is drawn,
 * and what a press may do. Each case states what would have to break for it
 * to go red.
 */
public class ShadeKeysTest {

    private static ShadeKeys keys(String... idLabelPairs) {
        List<String> ids = new java.util.ArrayList<>();
        List<String> labels = new java.util.ArrayList<>();
        for (int i = 0; i + 1 < idLabelPairs.length; i += 2) {
            ids.add(idLabelPairs[i]);
            labels.add(idLabelPairs[i + 1]);
        }
        return ShadeKeys.from(ids, labels, null);
    }

    // --- what is drawn ------------------------------------------------------

    @Test
    public void buttonsShowOnlyWhileAControlSessionIsLive() {
        ShadeKeys k = keys("a1", "F5", "b2", "Ctrl+C");
        assertEquals(2, k.shown(true, false).size());
        // The session ended (the page could not say so, the WebView died):
        // the CONTROL reason alone takes the buttons away.
        assertTrue(k.shown(false, false).isEmpty());
    }

    @Test
    public void liteNeverDrawsAButton() {
        assertTrue(keys("a1", "F5").shown(true, true).isEmpty());
    }

    @Test
    public void atMostThreeInThePagesOrder() {
        ShadeKeys k = keys("a", "1", "b", "2", "c", "3", "d", "4");
        List<ShadeKeys.Key> shown = k.shown(true, false);
        assertEquals(3, shown.size());
        assertEquals("a", shown.get(0).id);
        assertEquals("c", shown.get(2).id);
    }

    @Test
    public void badIdsEmptyLabelsAndDuplicatesAreDroppedNotRepaired() {
        ShadeKeys k = ShadeKeys.from(
                Arrays.asList("ok1", "BAD", "has space", null, "ok1", "x".repeat(25), "ok2", "ok3"),
                Arrays.asList("F1", "F2", "F3", "F4", "again", "F6", "  ", "F8"),
                null);
        List<ShadeKeys.Key> shown = k.shown(true, false);
        assertEquals(2, shown.size());
        assertEquals("ok1", shown.get(0).id);
        assertEquals("F1", shown.get(0).label);
        // "ok2" had a blank label and is gone; "ok3" is kept.
        assertEquals("ok3", shown.get(1).id);
    }

    @Test
    public void mismatchedListsReadOnlyTheirCommonLength() {
        ShadeKeys k = ShadeKeys.from(Arrays.asList("a", "b"), Collections.singletonList("F5"), null);
        assertEquals(1, k.shown(true, false).size());
        assertTrue(ShadeKeys.from(null, null, "x").shown(true, false).isEmpty());
    }

    @Test
    public void labelsAreOneCleanCappedLine() {
        assertEquals("Ctrl+C", ShadeKeys.clean("  Ctrl\n+C\u0007 ", 24));
        assertNull(ShadeKeys.clean("\n\t", 24));
        assertEquals(24, ShadeKeys.clean("W".repeat(40), 24).length());
        // A cut that would split a surrogate pair stops before it.
        String s = "abc😀";
        assertEquals("abc", ShadeKeys.clean(s, 4));
    }

    @Test
    public void theStatusLineGoesWithTheButtons() {
        ShadeKeys k = keys("a1", "F5").withStatus("Last sent: F5");
        assertEquals("Last sent: F5", k.statusShown(true, false));
        assertNull(k.statusShown(false, false));
        assertNull(k.withoutKeys().statusShown(true, false));
    }

    // --- what a press may do ------------------------------------------------

    @Test
    public void anUnlockedPressOnACurrentButtonSends() {
        assertEquals(ShadeKeys.Outcome.SEND, keys("a1", "F5").decide("a1", true, false, false));
    }

    @Test
    public void aLockedPhoneNeverSendsWhateverTheId() {
        ShadeKeys k = keys("a1", "F5");
        assertEquals(ShadeKeys.Outcome.LOCKED, k.decide("a1", true, true, false));
        assertEquals(ShadeKeys.Outcome.LOCKED, k.decide("zz", true, true, false));
        assertEquals(ShadeKeys.Outcome.LOCKED, k.decide(null, true, true, false));
    }

    @Test
    public void noSessionMeansNoSendEvenUnlocked() {
        ShadeKeys k = keys("a1", "F5");
        assertEquals(ShadeKeys.Outcome.NOT_LIVE, k.decide("a1", false, false, false));
        assertEquals(ShadeKeys.Outcome.NOT_LIVE, k.decide("a1", true, false, true));
        assertEquals(ShadeKeys.Outcome.NOT_LIVE, ShadeKeys.NONE.decide("a1", true, false, false));
    }

    @Test
    public void aStaleButtonSendsNothing() {
        // Unpinned (or moved out of the notification) a moment before the press.
        ShadeKeys k = keys("a1", "F5");
        assertEquals(ShadeKeys.Outcome.UNKNOWN, k.decide("b2", true, false, false));
        assertEquals(ShadeKeys.Outcome.UNKNOWN, k.decide(null, true, false, false));
    }

    @Test
    public void aDroppedIdCannotBePressed() {
        // "BAD" never became a button, so a forged press for it is unknown.
        ShadeKeys k = ShadeKeys.from(Arrays.asList("BAD", "ok"), Arrays.asList("F1", "F2"), null);
        assertEquals(ShadeKeys.Outcome.UNKNOWN, k.decide("BAD", true, false, false));
        assertEquals(ShadeKeys.Outcome.SEND, k.decide("ok", true, false, false));
    }

    @Test
    public void aPressWaitsForTheKeyguardToGoButNotForEver() {
        // Unlocked: nothing to wait for.
        assertEquals(false, ShadeKeys.keepWaiting(false, 0));
        // The press Android delivers right after the PIN: the keyguard is
        // still going, so it waits...
        assertEquals(true, ShadeKeys.keepWaiting(true, 0));
        assertEquals(true, ShadeKeys.keepWaiting(true, ShadeKeys.UNLOCK_GRACE_MS - 1));
        // ...and a phone that stays locked is decided (and refused) at the end.
        assertEquals(false, ShadeKeys.keepWaiting(true, ShadeKeys.UNLOCK_GRACE_MS));
        assertEquals(ShadeKeys.Outcome.LOCKED, keys("a1", "F5").decide("a1", true, true, false));
        assertTrue(ShadeKeys.UNLOCK_GRACE_MS <= 3000);
    }
}
