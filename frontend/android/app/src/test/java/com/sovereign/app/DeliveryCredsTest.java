package com.sovereign.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DeliveryCredsTest {

    private static final String URL = "wss://chat.example.test/ws";
    private static final String TOKEN = "jwt-one";

    @Test
    public void sameCredentialsAreNotAChange() {
        // The whole point: JS re-syncs on every WebView reconnect, and each
        // one used to drop and redial a healthy delivery socket.
        assertFalse(DeliveryCreds.changed(URL, TOKEN, "dev-a", URL, TOKEN, "dev-a"));
    }

    @Test
    public void aRenewedTokenIsAChange() {
        // HIGHEST-CONSEQUENCE case in this class. If this ever returns false,
        // the socket keeps using a token that expires ~24h later and delivery
        // dies silently, long after any deploy. Both halves of the dedupe get
        // a test for exactly this reason.
        assertTrue(DeliveryCreds.changed(URL, TOKEN, "dev-a", URL, "jwt-two", "dev-a"));
    }

    @Test
    public void aChangedUrlIsAChange() {
        assertTrue(DeliveryCreds.changed(URL, TOKEN, "dev-a",
                "wss://other.example.test/ws", TOKEN, "dev-a"));
    }

    @Test
    public void anAbsentDeviceIdIsNotAChange() {
        // Enrolment finishes AFTER the first credential sync, so a null id
        // means "not enrolled yet this boot", not "no device". Mirrors the
        // storage rule in SovereignAppPlugin.setNativeDelivery.
        assertFalse(DeliveryCreds.changed(URL, TOKEN, "dev-a", URL, TOKEN, null));
        assertFalse(DeliveryCreds.changed(URL, TOKEN, "dev-a", URL, TOKEN, ""));
    }

    @Test
    public void aFirstDeviceIdIsAChange() {
        // The claim is what lets "sign out this device" reach this socket, so
        // acquiring one must reconnect to actually present it.
        assertTrue(DeliveryCreds.changed(URL, TOKEN, null, URL, TOKEN, "dev-a"));
    }

    @Test
    public void aDifferentDeviceIdIsAChange() {
        assertTrue(DeliveryCreds.changed(URL, TOKEN, "dev-a", URL, TOKEN, "dev-b"));
    }

    @Test
    public void clearingLiveCredentialsIsAChange() {
        // Logout and the background-delivery opt-out both land here: the
        // socket must actually come down.
        assertTrue(DeliveryCreds.changed(URL, TOKEN, "dev-a", null, null, null));
        assertTrue(DeliveryCreds.changed(URL, TOKEN, "dev-a", null, TOKEN, "dev-a"));
    }

    @Test
    public void clearingAlreadyClearCredentialsIsNotAChange() {
        // Positive control for the branch above: no socket, nothing to drop.
        assertFalse(DeliveryCreds.changed(null, null, null, null, null, null));
    }

    @Test
    public void arrivingFromNothingIsAChange() {
        assertTrue(DeliveryCreds.changed(null, null, null, URL, TOKEN, "dev-a"));
    }
}
