package com.sovereign.app.control;

/**
 * Whether a viewer's input may touch this phone right now, and what each
 * refusal does to the session. Pure (ControlGateTest).
 *
 * Two kinds of refusal:
 * <ul>
 *   <li>ENDING ones end the session on the phone's side, and the page tells
 *       the viewer: the phone locked or its screen went off (whoever is at it
 *       put it away), the person switched Púca's service off in Android's
 *       settings, the share is over, or is of one app (Android 14+), which
 *       includes one app shared that is now behind another. Control never
 *       resumes by itself after one of these; the viewer asks again and the
 *       person answers again.</li>
 *   <li>Passing ones only drop input while they last: the screen turning,
 *       Android taking the service away for a moment while its switch stays
 *       on.</li>
 * </ul>
 *
 * Every reason a native end gives the page (PhoneControl.end with tell)
 * needs its own sentence in phoneControl.ts's endedWords:
 * src/tests/phoneControlEndReasons.test.ts reads this folder and fails on a
 * reason that has none.
 */
final class ControlGate {

    private ControlGate() {}

    static final String NO_SESSION = "no-session";
    static final String SERVICE_OFF = "service-off";
    /** At Allow ({@link #beginRefusal}), the person's switch is off in
     *  Android's Accessibility settings: the page shows the way to it. */
    static final String SERVICE_DISABLED = "service-disabled";
    /** Android has taken the service away for now while the person's switch
     *  is still on: anything using UiAutomation (test tools, some
     *  automation apps) makes Android unbind every other accessibility
     *  service while it runs. Nothing can land meanwhile, and nothing has
     *  changed about what the person allowed: the session waits for the
     *  service to come back (PhoneControl, at most RESUME_MS). At Allow it is
     *  the refusal too, and the page does not send the person to a switch
     *  that is already on. */
    static final String SERVICE_SUSPENDED = "service-suspended";
    /** The end of a SERVICE_SUSPENDED wait: Android did not give the service
     *  back within PhoneControl.RESUME_MS. Not SERVICE_OFF: the person's
     *  switch is still on, and the page must not send them looking for a
     *  setting nobody changed. */
    static final String SERVICE_LOST = "service-lost";
    /** Android refused the overlay that shows who is in control: at Allow
     *  nothing starts, and when the service comes back the session ends. */
    static final String NO_INDICATOR = "no-indicator";
    static final String LOCKED = "locked";
    static final String SCREEN_OFF = "screen-off";
    /** Android 7 (API 24, 25): a press is played live as continued strokes
     *  (GestureDescription.StrokeDescription with willContinue, and
     *  continueStroke), which Android has only from 8.0 (API 26). Calling
     *  them on 7 throws NoSuchMethodError, an Error no catch here takes: the
     *  app, and the call with it, went down on the first tap. */
    static final String UNSUPPORTED = "unsupported";
    static final int MIN_SDK = 26;

    /** Whether this Android can be controlled at all. */
    static boolean supported(int sdk) {
        return sdk >= MIN_SDK;
    }

    /**
     * The refusal for input now, or null. In order: no session the person
     * allowed, the phone put away, no service to inject with (switched off,
     * or only taken away for now), then the share's own state
     * ({@link ScreenMap#refusal}).
     *
     * The phone put away comes BEFORE the service: a session paused because
     * Android took the service away, on a phone then locked with its screen
     * on (no screen-off broadcast), read "paused", and unlocked before the
     * service came back it resumed with no new Allow.
     */
    static String refusal(boolean session, boolean serviceConnected, boolean serviceEnabled,
                          boolean keyguardLocked, boolean interactive, String shareRefusal) {
        if (!session) return NO_SESSION;
        if (!interactive) return SCREEN_OFF;
        if (keyguardLocked) return LOCKED;
        if (!serviceConnected) return serviceEnabled ? SERVICE_SUSPENDED : SERVICE_OFF;
        return shareRefusal;
    }

    /**
     * Why Allow cannot start a session now, or null: {@link #refusal} for a
     * session about to start, with the service not bound told apart by the
     * switch. Off, {@link #SERVICE_DISABLED} (the page shows the way to it);
     * on, {@link #SERVICE_SUSPENDED}. Before, the switch on with the service
     * not bound answered SERVICE_OFF, and the page told the person to turn on
     * a switch that was already on.
     */
    static String beginRefusal(boolean serviceConnected, boolean serviceEnabled,
                               boolean keyguardLocked, boolean interactive, String shareRefusal) {
        String r = refusal(true, serviceConnected, serviceEnabled, keyguardLocked, interactive, shareRefusal);
        return SERVICE_OFF.equals(r) ? SERVICE_DISABLED : r;
    }

    /** Whether a refusal ends the session (true) or only drops input (false). */
    static boolean ends(String refusal) {
        if (refusal == null) return false;
        switch (refusal) {
            case SERVICE_OFF:
            case LOCKED:
            case SCREEN_OFF:
            case ScreenMap.NOT_SHARING:
            case ScreenMap.ONE_APP:
            // One app shared, and the person switched to another: it used to
            // only drop input, and control came back by itself, with no new
            // Allow, the moment they went back to that app.
            case ScreenMap.HIDDEN:
                return true;
            default:
                return false;
        }
    }
}
