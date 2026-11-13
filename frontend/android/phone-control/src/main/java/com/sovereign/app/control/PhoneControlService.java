package com.sovereign.app.control;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * Púca's remote-control service: how someone in a call, allowed on this
 * phone, taps, swipes and types on it while its screen is shared. A non-root
 * app can put input into OTHER apps only through an AccessibilityService
 * (dispatchGesture, global actions, the focused field's text); this is that,
 * and nothing more.
 *
 * <ul>
 *   <li>The person turns it on in Android's Accessibility settings, and it
 *       still does NOTHING until they press Allow on this phone for one
 *       viewer, during a share of the whole screen ({@link PhoneControl}).</li>
 *   <li>It reads nothing: {@link #onAccessibilityEvent} is empty, and the one
 *       look at a window is finding the focused text field when a viewer who
 *       is in control types.</li>
 *   <li>Only in the FULL APK: the module it lives in is not a dependency of
 *       Lite, so Lite's manifest does not declare it and its dex does not
 *       carry it (frontend/android/app/build.gradle).</li>
 * </ul>
 */
public class PhoneControlService extends AccessibilityService {

    static volatile PhoneControlService current;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        current = this;
        PhoneControl.serviceChanged();
    }

    @Override
    public boolean onUnbind(Intent intent) {
        gone();
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        gone();
        super.onDestroy();
    }

    private void gone() {
        if (current == this) {
            current = null;
            PhoneControl.serviceChanged();
        }
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Nothing: Púca does not read what is on the screen.
    }

    @Override
    public void onInterrupt() {
        // No feedback of ours to interrupt.
    }

    /**
     * Type into the focused field (TEXT / ENTER / BACKSPACE / DELETE). False
     * when there is no editable field in focus, or the field will not take it.
     * A password field is not edited: its text cannot be read back, so it
     * could only be replaced whole.
     */
    boolean edit(String action, String typed) {
        AccessibilityNodeInfo f = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (f == null || !f.isEditable()) return false;
        if (TouchPlanner.ENTER.equals(action)) {
            if (Build.VERSION.SDK_INT >= 30
                    && f.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) {
                return true;
            }
            if (!f.isMultiLine()) return false;
            action = TouchPlanner.TEXT;
            typed = "\n";
        }
        if (f.isPassword()) return false;
        CharSequence cur = f.getText();
        if (Build.VERSION.SDK_INT >= 26 && f.isShowingHintText()) cur = "";
        TextEdit.Result r = TextEdit.apply(cur == null ? "" : cur.toString(),
                f.getTextSelectionStart(), f.getTextSelectionEnd(), action, typed);
        if (r == null) return true;
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, r.text);
        if (!f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return false;
        Bundle sel = new Bundle();
        sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, r.caret);
        sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, r.caret);
        f.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel);
        return true;
    }
}
