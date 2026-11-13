package com.sovereign.app.control;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.res.Resources;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * What the phone shows, over every app, while someone is controlling it: an
 * orange frame round the whole screen and, at the top, "<name> is controlling
 * this phone" with a Stop button. Accessibility overlays (the service's own
 * window type) need no "draw over other apps" permission and sit above
 * ordinary apps, so this is on screen wherever the person goes, and it is in
 * the shared picture too: the viewer sees it as well. Main thread.
 *
 * The frame and the words take no touches: they sit over the top of whatever
 * app is open (its search bar, its title), and the first version, one pill
 * that took every touch on it, blocked those for the viewer and the person at
 * the phone alike (the emulator walk found it on Settings' search bar). Only
 * the Stop button, a small window of its own beside the words, takes a touch;
 * a viewer can press it as well, which ends their own control and nothing
 * else.
 */
final class Indicator {

    private static final String TAG = "PucaPhoneControl";
    /** Orange: the same signal Android uses for a live microphone or camera. */
    private static final int FRAME = Color.rgb(0xFF, 0x8A, 0x00);
    private static final int PILL = Color.argb(0xF0, 0x1C, 0x1D, 0x21);
    /** White on this red is 5.6:1. */
    private static final int STOP = Color.rgb(0xC6, 0x28, 0x28);

    private final AccessibilityService service;
    private View frame;
    private View pill;
    private View stopButton;
    private TextView label;

    Indicator(AccessibilityService service) {
        this.service = service;
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                service.getResources().getDisplayMetrics()));
    }

    private int statusBarHeight() {
        Resources r = Resources.getSystem();
        int id = r.getIdentifier("status_bar_height", "dimen", "android");
        return id > 0 ? r.getDimensionPixelSize(id) : dp(24);
    }

    boolean showing() {
        return frame != null || pill != null || stopButton != null;
    }

    void show(String viewer, Runnable onStop) {
        WindowManager wm = (WindowManager) service.getSystemService(Context.WINDOW_SERVICE);
        if (wm == null) return;
        String text = viewer + " is controlling this phone";
        if (showing()) {
            if (label != null) label.setText(text);
            return;
        }
        try {
            FrameLayout f = new FrameLayout(service);
            GradientDrawable border = new GradientDrawable();
            border.setColor(Color.TRANSPARENT);
            border.setStroke(dp(4), FRAME);
            f.setBackground(border);
            f.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            WindowManager.LayoutParams fp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                            | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT);
            if (Build.VERSION.SDK_INT >= 28) {
                fp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            }
            wm.addView(f, fp);
            frame = f;

            // The words: a chip that lets every touch through.
            TextView t = new TextView(service);
            t.setText(text);
            t.setTextColor(Color.WHITE);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            t.setMaxLines(2);
            t.setMaxWidth(dp(220));
            t.setGravity(Gravity.CENTER_VERTICAL);
            t.setMinHeight(dp(48));
            t.setPadding(dp(16), dp(4), dp(16), dp(4));
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(PILL);
            bg.setCornerRadius(dp(24));
            bg.setStroke(dp(2), FRAME);
            t.setBackground(bg);
            label = t;

            TextView stop = new TextView(service);
            stop.setText("Stop");
            stop.setTextColor(Color.WHITE);
            stop.setTypeface(Typeface.DEFAULT_BOLD);
            stop.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            stop.setGravity(Gravity.CENTER);
            stop.setMinWidth(dp(64));
            stop.setMinHeight(dp(48));
            stop.setPadding(dp(16), 0, dp(16), 0);
            GradientDrawable sb = new GradientDrawable();
            sb.setColor(STOP);
            sb.setCornerRadius(dp(20));
            stop.setBackground(sb);
            stop.setContentDescription("Stop remote control");
            stop.setClickable(true);
            stop.setFocusable(true);
            stop.setOnClickListener(v -> onStop.run());

            // Side by side, centred together: measured first, then each
            // window placed by its offset from the centre.
            int any = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED);
            t.measure(any, any);
            stop.measure(any, any);
            int gap = dp(8);
            int lw = t.getMeasuredWidth();
            int sw = stop.getMeasuredWidth();
            int total = lw + gap + sw;
            int top = statusBarHeight() + dp(8);

            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                            | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
            lp.x = (lw - total) / 2;
            lp.y = top;
            wm.addView(t, lp);
            pill = t;

            WindowManager.LayoutParams sp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    PixelFormat.TRANSLUCENT);
            sp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
            sp.x = (total - sw) / 2;
            sp.y = top + Math.max(0, (t.getMeasuredHeight() - stop.getMeasuredHeight()) / 2);
            wm.addView(stop, sp);
            stopButton = stop;
        } catch (RuntimeException e) {
            // The overlay is the person's signal that someone is in control:
            // without it the session must not run (PhoneControl.begin checks).
            Log.w(TAG, "indicator refused", e);
            hide();
        }
    }

    void hide() {
        WindowManager wm = (WindowManager) service.getSystemService(Context.WINDOW_SERVICE);
        for (View v : new View[] { stopButton, pill, frame }) {
            if (v == null || wm == null) continue;
            try {
                wm.removeViewImmediate(v);
            } catch (RuntimeException ignored) {
                // already gone with the service
            }
        }
        stopButton = null;
        pill = null;
        frame = null;
        label = null;
    }
}
