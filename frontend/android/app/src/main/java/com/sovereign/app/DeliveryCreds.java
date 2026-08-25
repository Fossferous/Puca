package com.sovereign.app;

/**
 * Does a credential sync actually change what the delivery socket connects
 * with? Pure Java, no Android imports, so the matrix runs under plain JUnit —
 * the {@link PushGate} pattern.
 *
 * This exists because {@code credentialsChanged()} drops and redials
 * unconditionally, which is correct for a REAL change and pure waste
 * otherwise: JS re-syncs credentials on every device attestation, i.e. on
 * every WebView reconnect, so a flaky network was tearing down a perfectly
 * healthy delivery socket over and over. The comparison belongs here rather
 * than in the JS caller because Java is the only side that knows what the
 * socket is currently holding — a guard in JS could be bypassed by any future
 * caller.
 */
final class DeliveryCreds {

    private DeliveryCreds() {}

    /**
     * Compare stored credentials against an incoming sync.
     *
     * <p>The device id follows the SAME rule the storage path uses: an absent
     * or empty incoming id means "not enrolled YET this boot", NOT "no
     * device" — enrolment finishes after the first sync, so the id arrives on
     * a later re-sync and the stored one is deliberately kept in the interim.
     * Treating that absence as a change would count every pre-attestation
     * sync as a credential change and redial exactly as often as before,
     * which is the bug this class exists to remove.
     */
    static boolean changed(String oldUrl, String oldToken, String oldDevice,
                           String newUrl, String newToken, String newDevice) {
        // Clearing credentials (logout, opt-out) is a change whenever there
        // was anything to clear — the socket must actually be taken down.
        if (newUrl == null || newToken == null) {
            return oldUrl != null || oldToken != null;
        }
        if (!newUrl.equals(oldUrl) || !newToken.equals(oldToken)) {
            return true;
        }
        if (newDevice == null || newDevice.isEmpty()) {
            return false; // not enrolled yet; the stored claim stands
        }
        return !newDevice.equals(oldDevice);
    }
}
