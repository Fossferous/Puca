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

    // --- the other way: no keyboard over a drawing or a photo -----------------

    /*
     * A drawing or a photo opened from outside the app has nothing to type
     * into, and the page leaves no field focused under it. Android still puts
     * the keyboard back when the window regains focus if it was up when the
     * app left — a list opened the same way, with the keyboard, then Home,
     * then Draw (SHOW_RESTORE_IME_VISIBILITY, measured on the emulator: up
     * over the canvas or the photo composer with inputType 0x0, typing into
     * nothing). That restore lands as the window comes back, AFTER the page's
     * request, so NotesKeyboard.lower waits for the window's focus and then
     * watches for SETTLE_MS, putting the keyboard away whenever it shows with
     * no field focused. A focused field is never touched: the person chose
     * it. Pure, like next(): KeyboardPlanTest.
     */

    /** How long it watches once the window has focus: the restore comes
     *  with the window's focus, well inside this. */
    static final long SETTLE_MS = 1000;

    /** The longest a request lives, focus or no focus. */
    static final long LOWER_CAP_MS = 3000;

    enum Lower {
        /** Put the keyboard away now, then keep watching. */
        HIDE,
        /** Look again after STEP_MS. */
        WAIT,
        /** Finished: answer whether the keyboard is down. */
        DONE,
    }

    /**
     * @param elapsedMs  since the page asked
     * @param focusedMs  since this request first saw its window with input
     *                   focus, or -1 while it has not
     * @param textField  the WebView reports a focused editable field
     * @param imeVisible the keyboard is on screen
     */
    static Lower nextLower(long elapsedMs, long focusedMs, boolean textField, boolean imeVisible) {
        if (elapsedMs >= LOWER_CAP_MS) return Lower.DONE;
        if (focusedMs < 0) return Lower.WAIT;
        if (focusedMs >= SETTLE_MS) return Lower.DONE;
        if (imeVisible && !textField) return Lower.HIDE;
        return Lower.WAIT;
    }
}
