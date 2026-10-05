package com.sovereign.app;

import android.app.Application;
import android.util.Log;

import java.io.File;

/**
 * The app's process start: before any activity, service or receiver of this
 * process runs, and so before any WebView exists in it, remove the plaintext
 * the WebView's blob storage may have left on disk when an earlier run died
 * with decrypted attachments on screen ({@link BlobStorageWipe} says why it
 * is safe only here). Any start counts: opening the app, a push wake, a
 * widget update.
 *
 * <p>Measured on the 2 GB emulator: a run killed with a channel of three
 * videos and three pictures on screen left 79 MB of their plaintext in
 * {@code app_webview/Default/blob_storage}; the WebView alone removed it only
 * when it next started, and a start that did not open it left it there.
 */
public class PucaApplication extends Application {
    private static final String TAG = "PucaApplication";

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            File webview = new File(getApplicationInfo().dataDir, "app_webview");
            BlobStorageWipe.Result r = BlobStorageWipe.wipe(webview);
            if (r.files > 0) Log.i(TAG, "removed " + r.files + " leftover blob_storage file(s), " + (r.bytes / 1024) + " KB");
        } catch (RuntimeException e) {
            // Never stop the app starting over this.
            Log.w(TAG, "blob_storage wipe failed: " + e.getClass().getSimpleName());
        }
    }
}
