package com.sovereign.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.WebView;

import androidx.activity.result.ActivityResult;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebMessagePortCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * Shares this phone's screen into a call (the page's half is
 * {@code frontend/src/api/nativeScreenShare.ts}).
 *
 * <ol>
 *   <li>{@code start({width, height, fps, nonce})} asks Android's own consent
 *       ("Start recording or casting with Púca?"), then starts
 *       {@link ScreenShareService} with it.</li>
 *   <li>Once the capture runs, a fresh WebMessageChannel is made and one end
 *       is posted to the page's main frame, at the app's own origin only,
 *       tagged with the page's nonce. JPEG frames go down it; the page answers
 *       each with {@code "ack"} ({@link ScreenShareFrames.Gate}).</li>
 *   <li>The share ends from the page ({@code stop()}, which its track's
 *       {@code stop()} calls), from the notification, or from Android; the
 *       last two send {@code {"type":"ended"}} down the port and fire
 *       {@code shareEnded}, so the page ends the share as it does when a
 *       browser's own "Stop sharing" is pressed.</li>
 * </ol>
 *
 * The port, not a localhost socket: any app on the phone can connect to a
 * socket, and the frames are the person's screen. A port exists only between
 * this process and the one page it was posted to.
 */
@CapacitorPlugin(name = "SovereignScreenShare")
public class SovereignScreenSharePlugin extends Plugin implements ScreenShareService.Listener {

    private final Handler main = new Handler(Looper.getMainLooper());
    /** The start waiting for consent and then for the capture to run. */
    private PluginCall pending;
    private String pendingNonce;
    private int wantW;
    private int wantH;
    private int wantFps;
    private WebMessagePortCompat port;
    /** Which port is current. An ack from an older one (a share replaced)
     *  must not open the new share's gate. The port's own identity cannot say:
     *  androidx hands the callback a fresh wrapper, never the object held here
     *  (comparing them dropped every ack, and a share sent two frames). */
    private int portGeneration;
    private boolean binary;

    /** Whether this phone can share its screen from the app at all. */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        String missing = missingWebViewFeature();
        ret.put("available", missing == null);
        ret.put("reason", missing);
        ret.put("sdk", Build.VERSION.SDK_INT);
        ret.put("sharing", ScreenShareService.isSharing());
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String missing = missingWebViewFeature();
        if (missing != null) {
            call.reject("This phone's WebView cannot carry a screen share (" + missing + ")", "unsupported");
            return;
        }
        if (pending != null) {
            call.reject("A screen share is already starting", "busy");
            return;
        }
        String nonce = call.getString("nonce");
        if (nonce == null || nonce.isEmpty()) {
            call.reject("start needs a nonce", "bad-request");
            return;
        }
        if (ScreenShareService.isSharing()) {
            // The page lost track of a share it started (a reload): the old
            // one's port went with the old page, so end it and start afresh.
            ScreenShareService.stopSharing(getContext(), "Replaced by a new share");
        }
        MediaProjectionManager mpm =
                (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            call.reject("Screen capture is not available on this phone", "unsupported");
            return;
        }
        wantW = call.getInt("width", 1280);
        wantH = call.getInt("height", 720);
        wantFps = call.getInt("fps", 30);
        pending = call;
        pendingNonce = nonce;
        call.setKeepAlive(true);
        startActivityForResult(call, mpm.createScreenCaptureIntent(), "onConsent");
    }

    @ActivityCallback
    private void onConsent(PluginCall call, ActivityResult result) {
        if (call == null) {
            // The call did not survive the dialog (the activity was recreated
            // under it). Forget it, or every later Share is refused as busy.
            pending = null;
            pendingNonce = null;
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            finishPending(null, "The screen share was not allowed", "denied");
            return;
        }
        ScreenShareService.setListener(this);
        Intent i = new Intent(getContext(), ScreenShareService.class)
                .setAction(ScreenShareService.ACTION_START)
                .putExtra(ScreenShareService.EXTRA_RESULT_CODE, result.getResultCode())
                .putExtra(ScreenShareService.EXTRA_RESULT_DATA, result.getData())
                .putExtra(ScreenShareService.EXTRA_WIDTH, wantW)
                .putExtra(ScreenShareService.EXTRA_HEIGHT, wantH)
                .putExtra(ScreenShareService.EXTRA_FPS, wantFps);
        try {
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
            else getContext().startService(i);
        } catch (Exception e) {
            finishPending(null, "Android refused the screen-share service: " + e.getMessage(), "failed");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        boolean was = ScreenShareService.isSharing();
        ScreenShareService.stopSharing(getContext(), "Stopped from the app");
        main.post(this::closePort);
        JSObject ret = new JSObject();
        ret.put("stopped", was);
        call.resolve(ret);
    }

    /** A new size and frame rate for the running share (applyConstraints on
     *  the page's track). Answers what is captured now. */
    @PluginMethod
    public void resize(PluginCall call) {
        int[] now = ScreenShareService.resize(
                call.getInt("width", 1280), call.getInt("height", 720), call.getInt("fps", 30));
        if (now == null) {
            call.reject("Nothing is being shared", "not-sharing");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("width", now[0]);
        ret.put("height", now[1]);
        ret.put("fps", now[2]);
        call.resolve(ret);
    }

    // ---- ScreenShareService.Listener --------------------------------------

    @Override
    public void onStarted(int width, int height, int fps) {
        main.post(() -> {
            if (pending == null) {
                // Nobody is waiting (the page went away): no share to keep.
                ScreenShareService.stopSharing(getContext(), "Nobody to share to");
                return;
            }
            try {
                openPort(pendingNonce, width, height);
            } catch (Exception e) {
                ScreenShareService.stopSharing(getContext(), "No way to hand the picture to the app");
                finishPending(null, "The picture could not be handed to the app: " + e.getMessage(), "failed");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("width", width);
            ret.put("height", height);
            ret.put("fps", fps);
            ret.put("binary", binary);
            finishPending(ret, null, null);
        });
    }

    @Override
    public void onFailed(String message) {
        main.post(() -> {
            closePort();
            finishPending(null, message, "failed");
        });
    }

    @Override
    public void onFrame(byte[] jpeg) {
        main.post(() -> {
            WebMessagePortCompat p = port;
            ScreenShareFrames.Gate g = ScreenShareService.gate;
            if (p == null) {
                if (g != null) g.release();
                return;
            }
            try {
                if (binary) {
                    p.postMessage(new WebMessageCompat(jpeg));
                } else {
                    p.postMessage(new WebMessageCompat(Base64.encodeToString(jpeg, Base64.NO_WRAP)));
                }
            } catch (Exception e) {
                if (g != null) g.release();
            }
        });
    }

    @Override
    public void onEnded(String reason) {
        main.post(() -> {
            WebMessagePortCompat p = port;
            if (p != null) {
                try {
                    JSONObject m = new JSONObject();
                    m.put("type", "ended");
                    m.put("reason", reason);
                    p.postMessage(new WebMessageCompat(m.toString()));
                } catch (Exception ignored) {
                    // the page is gone; the event below still tells it
                }
            }
            closePort();
            finishPending(null, reason, "ended");
            JSObject ev = new JSObject();
            ev.put("reason", reason);
            notifyListeners("shareEnded", ev);
        });
    }

    // ---- the port -----------------------------------------------------------

    /** Main thread. */
    private void openPort(String nonce, int width, int height) throws Exception {
        closePort();
        WebView web = getBridge().getWebView();
        WebMessagePortCompat[] ports = WebViewCompat.createWebMessageChannel(web);
        port = ports[0];
        final int generation = ++portGeneration;
        binary = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER);
        port.setWebMessageCallback(new WebMessagePortCompat.WebMessageCallbackCompat() {
            @Override
            public void onMessage(WebMessagePortCompat from, WebMessageCompat message) {
                if (generation != portGeneration || port == null || message == null) return;
                String data = message.getType() == WebMessageCompat.TYPE_STRING ? message.getData() : null;
                if ("ack".equals(data)) {
                    ScreenShareFrames.Gate g = ScreenShareService.gate;
                    if (g != null) g.release();
                }
            }
        });
        JSONObject hello = new JSONObject();
        hello.put("type", "puca-screen-share");
        hello.put("nonce", nonce);
        hello.put("width", width);
        hello.put("height", height);
        hello.put("binary", binary);
        // To the app's own origin only: were the WebView ever showing another
        // page, it would not be handed the screen.
        WebViewCompat.postWebMessage(web, new WebMessageCompat(hello.toString(), new WebMessagePortCompat[] { ports[1] }),
                Uri.parse(getBridge().getLocalUrl()));
    }

    /** Main thread. */
    private void closePort() {
        WebMessagePortCompat p = port;
        port = null;
        portGeneration++;
        if (p != null) {
            try { p.close(); } catch (Exception ignored) { /* already closed */ }
        }
    }

    private void finishPending(JSObject ok, String error, String code) {
        PluginCall call = pending;
        pending = null;
        pendingNonce = null;
        if (call == null) return;
        call.setKeepAlive(false);
        if (ok != null) call.resolve(ok);
        else call.reject(error, code);
        // startActivityForResult saved it with the bridge; a kept-alive call
        // stays there until released.
        if (getBridge() != null) getBridge().releaseCall(call);
    }

    /** Null when the WebView can carry the frames; else the feature it lacks. */
    private static String missingWebViewFeature() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL)) return "message channels";
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE)) return "posting messages";
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE)) return "port messages";
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_SET_MESSAGE_CALLBACK)) return "port callbacks";
        return null;
    }

    @Override
    protected void handleOnDestroy() {
        ScreenShareService.stopSharing(getContext(), "The app was closed");
        closePort();
        ScreenShareService.setListener(null);
        super.handleOnDestroy();
    }
}
