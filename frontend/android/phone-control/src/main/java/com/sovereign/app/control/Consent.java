package com.sovereign.app.control;

/**
 * The person's own Allow, asked by Android's dialog in Púca's activity, after
 * the page's prompt and before any session starts. Pure (ConsentTest); the
 * plugin shows the dialog and feeds it the presses.
 *
 * Why the page's Allow is not enough: the page is JavaScript, and anything
 * that ever ran in it (a rendering bug that let a message run script, an
 * update signed by a stolen key) could call {@code begin} and then
 * {@code inject} without the person pressing anything, and drive every app
 * on the phone. A dialog the page cannot reach (WebView script cannot touch
 * native views), naming who asked, closes that: no session starts without a
 * press on it.
 *
 * <ul>
 *   <li>One question at a time, and none while a session lasts (a viewer in
 *       control could otherwise press Allow for someone else).</li>
 *   <li>Allow ignores presses for {@link #ARM_MS} after the question appears,
 *       so a dialog that pops up under a moving finger is not answered by
 *       it.</li>
 *   <li>Unanswered for {@link #TIMEOUT_MS}, it is a No.</li>
 *   <li>Answered once: every later press, timeout or withdrawal is
 *       ignored.</li>
 * </ul>
 */
final class Consent {

    static final long ARM_MS = 800;
    static final long TIMEOUT_MS = 30_000;

    /** Refusals, in the page's vocabulary (api/phoneControl.ts refusalWords). */
    static final String DECLINED = "declined";
    static final String NOT_CONFIRMED = "not-confirmed";
    static final String WITHDRAWN = "withdrawn";
    static final String BUSY = "busy";

    interface Answer {
        /** {@code why} null when allowed. */
        void done(boolean allowed, String why);
    }

    private Answer pending;
    private long askedAt;

    /** A question is open now. */
    boolean open() {
        return pending != null;
    }

    /** Ask, at {@code now}; false (and nothing asked) while another is open
     *  or a session lasts. */
    boolean ask(boolean sessionActive, long now, Answer answer) {
        if (pending != null || sessionActive || answer == null) return false;
        pending = answer;
        askedAt = now;
        return true;
    }

    /** Whether Allow takes a press at {@code now}. */
    boolean armed(long now) {
        return pending != null && now - askedAt >= ARM_MS;
    }

    /** Allow pressed: true when it counted (and the question is closed). */
    boolean allow(long now) {
        if (!armed(now)) return false;
        finish(true, null);
        return true;
    }

    /** The person said No (Cancel, Back, a tap outside). */
    void decline() {
        finish(false, DECLINED);
    }

    /** Whether an open question has run out at {@code now}; closes it as a No. */
    boolean expire(long now) {
        if (pending == null || now - askedAt < TIMEOUT_MS) return false;
        finish(false, NOT_CONFIRMED);
        return true;
    }

    /** The page took the request back, or went away. */
    void withdraw() {
        finish(false, WITHDRAWN);
    }

    private void finish(boolean allowed, String why) {
        Answer a = pending;
        pending = null;
        if (a != null) a.done(allowed, why);
    }
}
