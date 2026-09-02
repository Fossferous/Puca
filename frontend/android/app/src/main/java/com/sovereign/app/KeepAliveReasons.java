package com.sovereign.app;

/**
 * Why {@link KeepAliveService} is running, as an immutable set of reasons.
 *
 * Pure Java, no Android imports, for the same reason as {@link PushGate} and
 * {@code GeofenceEngine}: the whole decision matrix then runs under plain
 * JUnit. What lives here is the DECISION — which reasons hold, what the
 * notification says, whether the CPU wake lock is wanted, which foreground
 * service type to declare. What stays in the service is the Android plumbing
 * that acts on it.
 *
 * <h3>The four reasons</h3>
 *
 * <ul>
 *   <li>{@code control} — a My Devices remote-control session is live.</li>
 *   <li>{@code notify} — the user opted into background delivery.</li>
 *   <li>{@code geofence} — location reminders have fences to watch.</li>
 *   <li>{@code voice} — the user is in a voice call. Android 14+ silences a
 *       backgrounded app's microphone unless a foreground service holding the
 *       {@code microphone} type is running, and that type may only be
 *       requested while the app is still eligible (in practice: at join time,
 *       before the user switches away). Without it, peers stopped hearing the
 *       user the moment the screen locked — the 0.9.1 first-run report.</li>
 * </ul>
 *
 * <h3>Declarations and events</h3>
 *
 * There are two ways the service is started, and conflating them cost a real
 * user real remote-control sessions:
 *
 * <ul>
 *   <li>A <b>declaration</b> comes from JS and carries the complete desired
 *       state. It REPLACES all four reasons. JS is the authority on what is
 *       wanted, because JS is what knows a session or a call is live.</li>
 *   <li>An <b>event</b> — today only the wake doorbell — carries no opinion
 *       about what is wanted. It means "something needs delivery, run with the
 *       truth you already have". See {@link #withWake()}.</li>
 * </ul>
 *
 * The wake used to arrive shaped like a declaration ({@code control=false},
 * {@code notify=true}, {@code geofence=false}), which is how a doorbell rung
 * at a backgrounded phone silently released the wake lock holding up a live
 * My Devices session, and stopped a geofence-only service's location watch on
 * the way past. The service now remembers the last complete set it was given
 * so an event can be expressed without impersonating a declaration.
 *
 * <p>This is a deliberate, narrow amendment to the old contract comment ("the
 * service holds no truth of its own"): the service still holds no truth about
 * what is WANTED — only a memory of what it was last TOLD. That memory dies
 * with the process ({@code START_NOT_STICKY}), so it can never resurrect a
 * reason that outlived its owner.
 */
final class KeepAliveReasons {

    /** Nothing is wanted — the state a freshly created service starts in. */
    static final KeepAliveReasons NONE = new KeepAliveReasons(false, false, false, false);

    final boolean control;
    final boolean notify;
    final boolean geofence;
    final boolean voice;

    private KeepAliveReasons(boolean control, boolean notify, boolean geofence, boolean voice) {
        this.control = control;
        this.notify = notify;
        this.geofence = geofence;
        this.voice = voice;
    }

    /** A complete desired state from JS. Replaces everything. */
    static KeepAliveReasons declared(boolean control, boolean notify, boolean geofence, boolean voice) {
        return new KeepAliveReasons(control, notify, geofence, voice);
    }

    /**
     * The doorbell rang: delivery must be running. Every OTHER reason is
     * preserved exactly, because a wake signal is evidence about the server's
     * queue and evidence about nothing else — least of all about whether the
     * user is in the middle of controlling their PC or talking to someone.
     */
    KeepAliveReasons withWake() {
        return notify ? this : new KeepAliveReasons(control, true, geofence, voice);
    }

    /** Is any reason left? If not, the service has nothing to stay alive for. */
    boolean any() {
        return control || notify || geofence || voice;
    }

    /**
     * The CPU wake lock follows CONTROL and VOICE. An active session or call
     * must survive the screen turning off mid-use; notification delivery must
     * not pin the CPU around the clock — for that, the process being alive is
     * enough for the socket to wake it.
     */
    boolean wantsWakeLock() {
        return control || voice;
    }

    /** Should the location watch be running, given fences and permission? */
    boolean wantsLocationWatch(boolean hasFences, boolean hasPermission) {
        return geofence && hasFences && hasPermission;
    }

    /**
     * The foreground-service type mask. The constants are passed in rather
     * than imported so this class stays testable off-device; the caller
     * supplies {@code ServiceInfo.FOREGROUND_SERVICE_TYPE_*}.
     *
     * The location type is what keeps fixes flowing while backgrounded on
     * 14+, and the microphone type is what keeps capture flowing — but
     * declaring either WITHOUT its runtime permission is a SecurityException,
     * so the mask is computed, never constant. The mic type is only ever
     * added while a call is live: declaring it unconditionally would claim a
     * live microphone in the shade for a mere "Connected" service.
     */
    int fgsType(boolean hasLocationPermission, boolean hasMicPermission,
                int specialUse, int location, int microphone) {
        int type = specialUse;
        if (geofence && hasLocationPermission) {
            type |= location;
        }
        if (voice && hasMicPermission) {
            type |= microphone;
        }
        return type;
    }

    /** Ongoing-notification title for the highest-priority reason held. The
     *  call outranks everything: it is the reason with a live microphone. */
    String title() {
        if (voice) return "In a voice call";
        if (control) return "Device session active";
        if (notify) return "Connected";
        return "Location reminders active";
    }

    /**
     * Ongoing-notification body. The location watch is never HIDDEN behind a
     * higher-priority reason's text — being watchable in the shade is part of
     * that feature's honesty budget.
     */
    String text() {
        String text;
        if (voice) {
            text = "Your microphone stays on for the call while you use other apps.";
        } else if (control) {
            text = "The session stays connected while you use other apps.";
        } else if (notify) {
            text = "Message notifications arrive while Púca runs here.";
        } else {
            return "Watching for your saved places, on this phone only.";
        }
        if (geofence) {
            text += " Location reminders are on.";
        }
        return text;
    }
}
