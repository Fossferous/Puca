package com.sovereign.notes;

/**
 * When NotesKeyboard asks Android for the keyboard, and when it stops.
 *
 * The page has just focused a field (the composer opened by a shortcut, the
 * quick tile, the widget, an app like MacroDroid sending the same intent, or
 * "Open Púca Notes to") and asks for the keyboard. Two things are usually
 * not ready at that instant, and asking early is simply ignored:
 *
 *  - the WINDOW's focus. A warm start's intent reaches the page through
 *    onNewIntent, BEFORE onResume, so the page focuses its field while the
 *    activity is still coming to the front; Android drops a show request
 *    from a window without input focus.
 *  - Chromium's news that an editable field is focused. It reaches the
 *    WebView a frame or two after focus(); until then the WebView is not a
 *    text editor, and the input method has nothing to type into.
 *
 * The second is also the guard: with no field focused in the page there is
 * never anything to type into, so it never asks — no keyboard over a
 * drawing, a sign-in page that did not ask, or a field the person has
 * since left.
 *
 * So it looks again every STEP_MS, asking while the window has focus, a
 * field is focused and the keyboard is not up. It stops the moment the
 * keyboard shows — and never asks again after that, so a keyboard the person
 * then puts away stays away — or once BUDGET_MS has gone by, when the request
 * is stale: the person may be doing something else by then. Pure, so the JVM
 * tests it (KeyboardPlanTest).
 */
final class KeyboardPlan {

    private KeyboardPlan() {}

    /** How long to wait before looking again. */
    static final long STEP_MS = 100;

    /** How long a request lives. A warm start's window focus comes back
     *  well inside it; a cold start's page loads long after the window has
     *  focus, so there the first ask that finds the field is the one. */
    static final long BUDGET_MS = 1500;

    enum Step {
        /** The keyboard is up: answer shown, and never ask again. */
        SHOWN,
        /** Ask for it now, then look again after STEP_MS. */
        ASK,
        /** The window has no focus yet, or the page has no field focused
         *  (as far as the WebView knows yet): look again after STEP_MS. */
        WAIT,
        /** Out of time: answer not shown. */
        GIVE_UP,
    }

    /**
     * @param windowFocused the WebView's window has input focus
     * @param textField     the WebView reports a focused editable field
     *                      (View.onCheckIsTextEditor)
     * @param imeVisible    the keyboard is on screen
     */
    static Step next(long elapsedMs, boolean windowFocused, boolean textField, boolean imeVisible) {
        if (imeVisible) return Step.SHOWN;
        if (elapsedMs >= BUDGET_MS) return Step.GIVE_UP;
        if (!windowFocused || !textField) return Step.WAIT;
        return Step.ASK;
    }
}
