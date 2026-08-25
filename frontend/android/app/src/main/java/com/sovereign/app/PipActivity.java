package com.sovereign.app;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Rational;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

/**
 * The floating window a watched stream lives in while the user is in another
 * app — Android's picture-in-picture, for the Capacitor build.
 *
 * WHY A SECOND ACTIVITY, AND WHY IT BORROWS THE WEBVIEW. The Android WebView
 * has no web picture-in-picture API at all (document.pictureInPictureEnabled
 * is false), so the OS feature is the only way. The obvious shape — put
 * MainActivity itself into PiP — has a fatal edge: when the user swipes the
 * PiP window away (or taps its X) Android REMOVES THAT TASK, which finishes
 * the activity in it. For MainActivity that destroys the one WebView, i.e. the
 * whole JS app: the voice call the stream belonged to, the sessions, all of it.
 * A stream viewer is almost always in the voice channel it comes from, so
 * "swipe the video away" would hang up the call.
 *
 * So the PiP window is THIS activity, in its own task, and for its lifetime it
 * borrows the app's single WebView: detached from MainActivity's layout in
 * onCreate, shown full-bleed here, and handed back the moment this activity
 * goes away for any reason (expand, dismiss, refusal). MainActivity is only
 * ever paused/stopped, never finished; the JS realm never notices beyond a
 * visibility flip. Views can be moved between windows of one process; the
 * WebView keeps rendering and decoding wherever it is attached.
 *
 * WHAT THE PIP WINDOW SHOWS is whatever the web page renders — the WebView is
 * resized to the small window. The JS side (StreamPopout) covers the page with
 * a full-viewport <video> of the popped stream BEFORE asking for this, so the
 * shrunk page IS the video. Nothing here knows about streams.
 *
 * FLOW: JS enterPip → {@link #start} parks the WebView + aspect in statics and
 * launches this activity in a new task → onCreate adopts the WebView →
 * onWindowFocusChanged asks the OS for PiP → the user taps "expand" →
 * onPictureInPictureModeChanged(false) → {@link #returnHome} gives the WebView
 * back and brings MainActivity forward. Dismiss → onDestroy → gives it back
 * (MainActivity stays in the background, alive). Every exit path notifies JS
 * through {@link SovereignAppPlugin#notifyPip}, so the popped state clears.
 *
 * TWO TASKS HAVE TWO CONSEQUENCES, both handled here:
 *  - When this task is pinned, the task UNDER it — MainActivity's, WebView-less
 *    — becomes the top full-screen task, so the user would be looking at a
 *    blank Puca with the video floating over it. On entry we push
 *    MainActivity's task to the back (home / the previous app shows under the
 *    window — the popup-player behaviour people know), and any later resume of
 *    MainActivity by the user (launcher, a notification) RECLAIMS the WebView
 *    ({@link MainActivity#onResume} → {@link #reclaimIfLive}) — the person
 *    chose the app, so the float is moot. A short grace after entry keeps the
 *    automatic transition-time resume from being mistaken for that choice.
 *  - If MainActivity is destroyed while the WebView is borrowed (the app swiped
 *    out of Recents; the PiP task is not in Recents), Capacitor destroys the
 *    WebView from BridgeActivity.onDetachedFromWindow — while it is attached to
 *    THIS window. MainActivity therefore takes it back first
 *    ({@link #reclaimIfLive} from its onDestroy/onDetachedFromWindow); the app
 *    then closes, PiP included, which is what swiping it away means.
 */
public final class PipActivity extends Activity {

    /** Where the WebView came from and how to put it back. */
    private static final class Home {
        final ViewGroup parent;
        final int index;
        final ViewGroup.LayoutParams lp;
        Home(ViewGroup parent, int index, ViewGroup.LayoutParams lp) {
            this.parent = parent; this.index = index; this.lp = lp;
        }
    }

    // Hand-off between the two activities. Set by start(), consumed by onCreate().
    // ONLY touched on the main thread (start, onCreate, and the posted
    // finish/cancel below), so "cancelled before onCreate" and "finished after"
    // are the only two orders there are.
    private static WebView pendingWeb;
    private static Rational pendingAspect;
    private static volatile PipActivity live;
    /** From start() until the OS has floated us AND MainActivity has been
     *  pushed back (plus a grace) — while true, MainActivity resuming is the
     *  transition itself, not the user coming back. */
    private static volatile boolean transitioning;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    /** Bumped per start(); the entry-grace runnable checks it so a previous
     *  window's timer cannot end (or cancel) a later window's transition. */
    private static int generation;
    /** How long after entry a MainActivity resume still counts as the
     *  transition rather than the user's choice. */
    private static final long ENTRY_GRACE_MS = 1500;

    private WebView web;
    private Home home;
    private FrameLayout root;
    private boolean askedForPip;
    /** onStart..onStop — the lifecycle state that tells expand from dismiss. */
    private boolean started;

    /** Android 8+ phones with the system feature; the per-app PiP toggle in
     *  Settings is not knowable here — a refusal shows up as
     *  enterPictureInPictureMode returning false, handled below. */
    static boolean supported(Context c) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    static boolean isLive() {
        return live != null;
    }

    static boolean isTransitioning() {
        return transitioning;
    }

    /**
     * MainActivity is coming forward on the user's initiative (launcher tap, a
     * notification, Recents) or going away for good: take the WebView back and
     * drop the floating window. Nothing to do when nothing floats or when the
     * resume is the entry transition's own. Main thread.
     */
    static void reclaimIfLive() {
        if (live == null && pendingWeb == null) return;
        if (transitioning) return;
        cancelOrFinish();
    }

    /**
     * MainActivity is being DESTROYED: take the WebView back no matter what —
     * the entry grace exists only to filter the transition's own resume and
     * must never gate teardown, or a MainActivity destroyed inside that grace
     * ("Don't keep activities", memory pressure, a config change outside the
     * manifest's list) would have Capacitor destroy the WebView while it is
     * still attached to this activity's window. Main thread.
     */
    static void reclaimNow() {
        if (live == null && pendingWeb == null) return;
        cancelOrFinish();
    }

    /**
     * Park the WebView and launch. Called on the UI thread from MainActivity.
     * The aspect ratio is the VIDEO's, so the window is the video's shape.
     */
    static boolean start(Activity from, WebView web, int width, int height) {
        if (!supported(from) || web == null) return false;
        PipActivity current = live;
        if (current != null && !current.isFinishing()) {
            // Already floating: the OS window is up and showing the page. JS
            // has just (re)mounted a host and is waiting for {active:true} —
            // events are not retained, so re-assert the level for it. (A
            // FINISHING one is not floating: fall through and launch afresh —
            // its onDestroy clears `live` only if it is still itself.)
            SovereignAppPlugin.notifyPip(true);
            return true;
        }
        pendingWeb = web;
        pendingAspect = clampAspect(width, height);
        transitioning = true;
        generation++;
        Intent i = new Intent(from, PipActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        from.startActivity(i);
        return true;
    }

    /** JS asked to leave PiP (the stream ended, "bring back" from the app, an
     *  unmount that raced the OS). Takes the floating window down WITHOUT
     *  bringing the app forward — if the user is in another app, popping
     *  Puca over it would be rude; the WebView simply goes back to the
     *  (backgrounded) MainActivity. Any thread. */
    static void finishIfLive() {
        MAIN.post(PipActivity::cancelOrFinish);
    }

    /** Main thread. Either the activity is not up yet — withdraw the hand-off
     *  so its onCreate has nothing to adopt — or it is, and it hands back and
     *  finishes. Posted rather than direct so it can never interleave with
     *  onCreate's take of pendingWeb (both run on this thread). */
    private static void cancelOrFinish() {
        PipActivity p = live;
        if (p != null) {
            if (!p.isFinishing()) { p.giveBack(); p.finish(); }
            return;
        }
        if (pendingWeb != null) {
            // Cancelled before it ever floated: JS is waiting on the event.
            pendingWeb = null;
            transitioning = false;
            SovereignAppPlugin.notifyPip(false);
        }
    }

    /** Android refuses ratios outside 1/2.39 … 2.39 (throws). Compared with the
     *  real bound, not a rounding of it: 0.418 let 0.4181..0.41841 through. */
    static Rational clampAspect(int w, int h) {
        if (w <= 0 || h <= 0) return new Rational(16, 9);
        double r = (double) w / h;
        if (r > 2.39) return new Rational(239, 100);
        if (r < 1.0 / 2.39) return new Rational(100, 239);
        return new Rational(w, h);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView w = pendingWeb;
        pendingWeb = null;
        if (w == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // No hand-off: cancelled before we got here (JS unmounted in the
            // gap), or recreated by the system (process death, a launch that
            // was not ours). Nothing to show; say so in case JS is waiting.
            transitioning = false;
            SovereignAppPlugin.notifyPip(false);
            finish();
            return;
        }
        live = this;
        web = w;
        ViewGroup parent = (ViewGroup) w.getParent();
        if (parent != null) {
            home = new Home(parent, parent.indexOfChild(w), w.getLayoutParams());
            parent.removeView(w);
        }
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.addView(w, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        getWindow().getDecorView().setBackgroundColor(Color.BLACK);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Ask ONCE, once the window is really up: enterPictureInPictureMode
        // wants a resumed, visible activity, and onResume can be too early on
        // some OEM builds. A refusal (the user turned PiP off for this app in
        // Settings, or another PiP is pinned) returns false — go home honestly
        // instead of leaving a full-screen black activity over the app.
        if (hasFocus && !askedForPip && web != null && !isFinishing()) {
            askedForPip = true;
            boolean ok = false;
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ok = enterPictureInPictureMode(new PictureInPictureParams.Builder()
                            .setAspectRatio(pendingAspect == null ? new Rational(16, 9) : pendingAspect)
                            .build());
                }
            } catch (IllegalStateException | IllegalArgumentException e) {
                ok = false;
            }
            if (!ok) returnHome();
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        started = true;
    }

    @Override
    protected void onStop() {
        started = false;
        super.onStop();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        SovereignAppPlugin.notifyPip(isInPictureInPictureMode);
        if (isInPictureInPictureMode) {
            // We are floating; the task under us is MainActivity's, WebView-less
            // and blank. Push it back so home / the previous app shows under
            // the window, then end the transition after a grace — a resume of
            // MainActivity from here on is the user coming back to the app.
            MainActivity m = MainActivity.current();
            if (m != null) m.moveTaskToBack(true);
            final int mine = generation;
            MAIN.postDelayed(() -> {
                // A stale timer (this window already gone, another started)
                // must touch nothing of the newer one.
                if (mine != generation || live != this) return;
                transitioning = false;
                // If the user reached the app within the grace (launcher tap),
                // it is sitting there blank: honour that choice now.
                MainActivity mm = MainActivity.current();
                if (mm != null && mm.isResumedNow()) cancelOrFinish();
            }, ENTRY_GRACE_MS);
            return;
        }
        transitioning = false;
        // Leaving PiP happens two ways, told apart by lifecycle state (the
        // documented recipe): EXPAND leaves the activity started (it is about
        // to fill the screen — not what the user meant, they want the app, so
        // give the WebView back and bring MainActivity up); DISMISS/close
        // stops it first (onStop precedes this call) and the system is about
        // to finish it — hand the WebView back and stay out of the way. Coming
        // forward on a dismiss would put Puca over whatever app the user
        // is actually using.
        if (started) returnHome();
        else giveBack();
    }

    /** Back to the app: WebView home first (so MainActivity has something to
     *  draw the instant it resumes), then bring it forward, then go. */
    private void returnHome() {
        giveBack();
        Intent i = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(i);
        finish();
    }

    /** Idempotent: put the WebView back where it was taken from and tell JS the
     *  floating window is gone. Called from every exit path — expand, dismiss
     *  (onDestroy is the only signal Android gives for a swipe-away), a refused
     *  request, and JS's own exitPip. */
    private void giveBack() {
        transitioning = false;
        WebView w = web;
        if (w == null) return;
        web = null;
        ViewGroup current = (ViewGroup) w.getParent();
        if (current != null) current.removeView(w);
        if (home != null && home.parent != null) {
            int at = Math.min(home.index, home.parent.getChildCount());
            if (home.lp != null) home.parent.addView(w, at, home.lp);
            else home.parent.addView(w, at);
        }
        SovereignAppPlugin.notifyPip(false);
    }

    @Override
    protected void onDestroy() {
        giveBack();
        if (live == this) live = null;
        if (root != null) root.removeAllViews();
        super.onDestroy();
    }

    /** No touch reaches a PiP window's content, and full-screen (after expand)
     *  is handed straight back to MainActivity — so there is nothing for a
     *  back press to do but the same. */
    @Override
    public void onBackPressed() {
        returnHome();
    }

    /** Keep the borrowed view from being drawn under a status bar during the
     *  brief full-screen moment before/after PiP. */
    @Override
    protected void onResume() {
        super.onResume();
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }
}
