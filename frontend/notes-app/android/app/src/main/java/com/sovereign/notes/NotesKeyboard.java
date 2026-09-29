package com.sovereign.notes;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.view.inputmethod.InputMethodManager;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * Bring the soft keyboard up for the field the page has already focused in
 * the WebView (NotesNativePlugin.showKeyboard).
 *
 * Android's WebView raises the keyboard for a TAP on a field, not for a
 * focus() the page makes itself, so a composer opened from outside the app
 * — a launcher shortcut, the quick tile, the widget, MacroDroid or Tasker
 * sending the same intent, "Open Púca Notes to" — had its field focused and
 * still needed a tap. (Measured on the emulator: every cold start; a warm
 * start only escaped it when the field was focused before the window came
 * back to the front, which is a race Android's own "restore the keyboard
 * on forward navigation" sometimes wins.) This asks the input method
 * directly: the WebView takes the view focus, then
 * InputMethodManager.showSoftInput(SHOW_IMPLICIT), and Chromium hands the
 * input method the field the page focused. When to ask,
 * and when to stop, is KeyboardPlan.
 *
 * Main thread only. It reads nothing from the page and types nothing into
 * it: what the keyboard types into is whatever the page has focused.
 */
final class NotesKeyboard {

    private NotesKeyboard() {}

    interface Result {
        void done(boolean shown);
    }

    /** Ask, look again, and answer once (true = the keyboard is up). */
    static void raise(final View view, final Result result) {
        final Handler handler = new Handler(Looper.getMainLooper());
        final long start = SystemClock.uptimeMillis();
        final InputMethodManager imm =
                (InputMethodManager) view.getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        handler.post(new Runnable() {
            @Override
            public void run() {
                KeyboardPlan.Step step;
                try {
                    step = KeyboardPlan.next(SystemClock.uptimeMillis() - start,
                            view.hasWindowFocus(), view.onCheckIsTextEditor(), imeVisible(view));
                    if (step == KeyboardPlan.Step.ASK) {
                        view.requestFocus();
                        if (imm != null) imm.showSoftInput(view, InputMethodManager.SHOW_IMPLICIT);
                    }
                } catch (Throwable t) {
                    // A keyboard that could not be asked for is a tap away,
                    // exactly as before this existed; never a crash.
                    result.done(false);
                    return;
                }
                if (step == KeyboardPlan.Step.SHOWN) result.done(true);
                else if (step == KeyboardPlan.Step.GIVE_UP) result.done(false);
                else handler.postDelayed(this, KeyboardPlan.STEP_MS);
            }
        });
    }

    /**
     * No keyboard over a drawing or a photo opened from outside the app
     * (NotesNativePlugin.hideKeyboard): watch through the window's return
     * and put away a keyboard that shows with no field focused in the page.
     * When, and when to stop, is KeyboardPlan.nextLower. Answers once
     * (true = the keyboard is down).
     */
    static void lower(final View view, final Result result) {
        final Handler handler = new Handler(Looper.getMainLooper());
        final long start = SystemClock.uptimeMillis();
        final long[] focusedAt = { -1 };
        final InputMethodManager imm =
                (InputMethodManager) view.getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        handler.post(new Runnable() {
            @Override
            public void run() {
                KeyboardPlan.Lower step;
                boolean up;
                try {
                    long now = SystemClock.uptimeMillis();
                    if (focusedAt[0] < 0 && view.hasWindowFocus()) focusedAt[0] = now;
                    up = imeVisible(view);
                    step = KeyboardPlan.nextLower(now - start, focusedAt[0] < 0 ? -1 : now - focusedAt[0],
                            view.onCheckIsTextEditor(), up);
                    if (step == KeyboardPlan.Lower.HIDE && imm != null) {
                        imm.hideSoftInputFromWindow(view.getWindowToken(), 0);
                    }
                } catch (Throwable t) {
                    // A keyboard that could not be put away is one tap away,
                    // exactly as before this existed; never a crash.
                    result.done(false);
                    return;
                }
                if (step == KeyboardPlan.Lower.DONE) result.done(!up);
                else handler.postDelayed(this, KeyboardPlan.STEP_MS);
            }
        });
    }

    /** Is the keyboard on screen for this view's window? */
    static boolean imeVisible(View view) {
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(view);
        return insets != null && insets.isVisible(WindowInsetsCompat.Type.ime());
    }
}
