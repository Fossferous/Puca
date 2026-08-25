package com.sovereign.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import java.lang.ref.WeakReference;

public class MainActivity extends BridgeActivity {
    /** The live instance, for PipActivity to push back / ask about. Weak so a
     *  destroyed activity is never kept alive by the static. */
    private static WeakReference<MainActivity> current = new WeakReference<>(null);
    private boolean resumed;

    static MainActivity current() {
        return current.get();
    }

    boolean isResumedNow() {
        return resumed;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        current = new WeakReference<>(this);
        // Before super.onCreate — Capacitor collects registered plugins there.
        registerPlugin(SovereignFilesPlugin.class);
        registerPlugin(SovereignTransfersPlugin.class);
        registerPlugin(SovereignAppPlugin.class);
        registerPlugin(SovereignLocationPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // Visibility flag for the NATIVE delivery socket: while the app is on
    // screen the in-app UI owns the moment, and the native handler must not
    // post an OS notification over it (mirror of the JS appIsForeground gate).
    // onStart/onStop — the pair that actually means "visible": onPause fires
    // for a dialog, a permission prompt, or the shade being pulled while the
    // activity stays fully visible, which is exactly when a heads-up over the
    // conversation would be noise. (The first version used onResume/onPause
    // while its comment argued for this behaviour; the code now agrees.)
    @Override
    public void onStart() {
        super.onStart();
        PushPrefs.setAppVisible(this, true);
    }

    @Override
    public void onStop() {
        PushPrefs.setAppVisible(this, false);
        super.onStop();
    }

    // The floating stream window (PipActivity) borrows this activity's ONE
    // WebView. Coming forward on the user's initiative while it floats means
    // the person chose the app: take the WebView back and drop the window
    // (reclaimIfLive ignores the resume that is the PiP entry's own
    // transition). Going away for good must ALSO take it back first —
    // Capacitor destroys the WebView from onDetachedFromWindow, and it must not
    // do that to a view still attached to another activity's window.
    @Override
    public void onResume() {
        super.onResume();
        resumed = true;
        PipActivity.reclaimIfLive();
    }

    @Override
    public void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override
    public void onDestroy() {
        PipActivity.reclaimNow();
        super.onDestroy();
    }

    @Override
    public void onDetachedFromWindow() {
        PipActivity.reclaimNow();
        super.onDetachedFromWindow();
    }

    /**
     * Float the WebView in the OS picture-in-picture window (see PipActivity
     * for the whole story). UI thread. False when the device cannot.
     */
    public boolean enterPip(int width, int height) {
        return getBridge() != null && PipActivity.start(this, getBridge().getWebView(), width, height);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // Keep getIntent() honest for anyone reading it later; the bridge in
        // super forwards to every plugin's handleOnNewIntent (this activity is
        // singleTask, so widget taps land here while the app runs).
        setIntent(intent);
        super.onNewIntent(intent);
    }
}
