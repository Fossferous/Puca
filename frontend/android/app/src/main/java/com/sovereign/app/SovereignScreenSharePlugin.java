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
import android.util.Log;
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
 *       {@link ScreenShareService} with it and a new share id
 *       ({@link ScreenShareSlot}).</li>
 *   <li>Once the capture runs, a fresh WebMessageChannel is made and one end
 *       is posted to the page's main frame, at the app's own origin only,
 *       tagged with the page's nonce. JPEG frames go down it; the page answers
 *       each with {@code "ack"} ({@link ScreenShareFrames.Gate}).</li>
 *   <li>The share ends from the page ({@code stop()}, which its track's
 *       {@code stop()} calls), from the notification, or from Android; the
 *       last two send {@code {"type":"ended"}} down the port and fire
 *       {@code shareEnded} with the share's id, so the page ends the share as
 *       it does when a browser's own "Stop sharing" is pressed.</li>
 *   <li>A page that goes away (a reload, an in-app update swapping the bundle,
 *       a renderer crash) takes its share with it: the next page, as it boots,
 *       calls {@code pageReady()}, which ends whatever share is running and
 *       refuses any start still waiting on Android's dialog. Nothing else would
 *       end a share whose page is gone, and it would keep capturing the
 *       screen, and its notification, for nobody.</li>
 * </ol>
 *
 * The port, not a localhost socket: any app on the phone can connect to a
 * socket, and the frames are the person's screen. A port exists only between
 * this process and the one page it was posted to.
 *
 * Threads: plugin methods run on Capacitor's plugin thread, the consent result
 * and the page events on the main thread, the service's events on its capture
 * thread. The waiting start lives in the (synchronised) slot; everything about
 * the port is touched on the main thread only.
 */
@CapacitorPlugin(name = "SovereignScreenShare")
public class SovereignScreenSharePlugin extends Plugin implements ScreenShareService.Listener {

    private static final String TAG = "PucaScreenShare";
    private final Handler main = new Handler(Looper.getMainLooper());
    /** The start waiting for consent and then for the capture to run. */
    private final ScreenShareSlot<PluginCall> slot = new ScreenShareSlot<>();

    // Main thread only.
    private WebMessagePortCompat port;
    /** The share the port carries (0: none). Events of any other share leave
     *  the port alone. */
    private long portShareId;
    /** Which port is current. An ack from an older one (a share replaced)
     *  must not open the new share's gate. The port's own identity cannot say:
     *  androidx hands the callback a fresh wrapper, never the object held here
     *  (comparing them dropped every ack, and a share sent two frames). */
    private int portGeneration;
    private boolean binary;

    /**
     * The page says it has just started (api/nativeScreenShare.ts, at boot):
     * whatever an earlier page left, a running share or a start waiting on
     * Android's dialog, belongs to nobody. The page asks, rather than this
     * listening for the WebView's own page-started event: Capacitor's
     * WebViewListener.onPageStarted never fired for a reload on the emulator,
     * while every page that boots runs this.
     */
    @PluginMethod
    public void pageReady(PluginCall call) {
        main.post(() -> {
            boolean wasSharing = ScreenShareService.isSharing();
            boolean wasWaiting = slot.busy();
            pageGone("page ready");
            JSObject ret = new JSObject();
            ret.put("endedShare", wasSharing);
            ret.put("refusedStart", wasWaiting);
            call.resolve(ret);
        });
    }

    /** Main thread: the page that held any share, or was waiting to, is gone. */
    private void pageGone(String why) {
        Log.i(TAG, why + ": sharing=" + ScreenShareService.isSharing() + " waiting=" + slot.busy());
        if (ScreenShareService.isSharing()) {
            ScreenShareService.stopSharing(getContext(), "The page that shared it went away");
        }
        closePort();
        finish(slot.takeAny(), null, "The page that asked for it went away", "ended");
    }

    /** Whether this phone can share its screen from the app at all, and
     *  whether a share is running (one this page may not know of). */
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
        if (slot.busy()) {
            call.reject("A screen share is already starting", "busy");
            return;
        }
        String nonce = call.getString("nonce");
        if (nonce == null || nonce.isEmpty()) {
            call.reject("start needs a nonce", "bad-request");
            return;
        }
        MediaProjectionManager mpm =
                (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            call.reject("Screen capture is not available on this phone", "unsupported");
            return;
        }
        if (ScreenShareService.isSharing()) {
            // The page lost track of a share it started. Its end carries its
            // own id, so it cannot answer this start.
            ScreenShareService.stopSharing(getContext(), "Replaced by a new share");
        }
        slot.begin(call, call.getCallbackId(), nonce,
                call.getInt("width", 1280), call.getInt("height", 720), call.getInt("fps", 30));
        call.setKeepAlive(true);
        startActivityForResult(call, mpm.createScreenCaptureIntent(), "onConsent");
    }

    @ActivityCallback
    private void onConsent(PluginCall call, ActivityResult result) {
        if (call == null) {
            // The call did not survive the dialog (the activity was recreated
            // under it). Forget the start, or every later Share is refused as
            // busy.
            slot.takeAny();
            return;
        }
        ScreenShareSlot.Pending<PluginCall> p = slot.forCall(call.getCallbackId());
        Log.i(TAG, "consent answered: ok=" + (result.getResultCode() == Activity.RESULT_OK) + " for the waiting start=" + (p != null));
        if (p == null) {
            // Not the start that is waiting (its page went away while the
            // dialog was open): nobody to share to, whatever was answered.
            call.setKeepAlive(false);
            call.reject("This screen share was replaced", "ended");
            if (getBridge() != null) getBridge().releaseCall(call);
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            finish(slot.take(p.id), null, "The screen share was not allowed", "denied");
            return;
        }
        ScreenShareService.setListener(this);
        Intent i = new Intent(getContext(), ScreenShareService.class)
                .setAction(ScreenShareService.ACTION_START)
                .putExtra(ScreenShareService.EXTRA_SHARE_ID, p.id)
                .putExtra(ScreenShareService.EXTRA_RESULT_CODE, result.getResultCode())
                .putExtra(ScreenShareService.EXTRA_RESULT_DATA, result.getData())
                .putExtra(ScreenShareService.EXTRA_WIDTH, p.width)
                .putExtra(ScreenShareService.EXTRA_HEIGHT, p.height)
                .putExtra(ScreenShareService.EXTRA_FPS, p.fps);
        try {
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
            else getContext().startService(i);
        } catch (Exception e) {
            finish(slot.take(p.id), null, "Android refused the screen-share service: " + e.getMessage(), "failed");
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
     *  the page's track). Answers what is captured now, once the capture
     *  thread has applied it. */
    @PluginMethod
    public void resize(PluginCall call) {
        ScreenShareService.resize(call.getInt("width", 1280), call.getInt("height", 720), call.getInt("fps", 30), now -> {
            if (now == null) {
                call.reject("Nothing is being shared", "not-sharing");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("width", now[0]);
            ret.put("height", now[1]);
            ret.put("fps", now[2]);
            call.resolve(ret);
        });
    }

    // ---- ScreenShareService.Listener --------------------------------------

    @Override
    public void onStarted(long shareId, int width, int height, int fps) {
        main.post(() -> {
            ScreenShareSlot.Pending<PluginCall> p = slot.take(shareId);
            Log.i(TAG, "share " + shareId + " started: page waiting=" + (p != null));
            if (p == null) {
                // Nobody is waiting for THIS share (its page went away).
                if (ScreenShareService.sharingId() == shareId) {
                    ScreenShareService.stopSharing(getContext(), "Nobody to share to");
                }
                return;
            }
            try {
                openPort(shareId, p.nonce, width, height);
            } catch (Exception e) {
                ScreenShareService.stopSharing(getContext(), "No way to hand the picture to the app");
                finish(p, null, "The picture could not be handed to the app: " + e.getMessage(), "failed");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("width", width);
            ret.put("height", height);
            ret.put("fps", fps);
            ret.put("binary", binary);
            ret.put("shareId", shareId);
            finish(p, ret, null, null);
        });
    }

    @Override
    public void onFailed(long shareId, String message) {
        main.post(() -> {
            if (portShareId == shareId) closePort();
            finish(slot.take(shareId), null, message, "failed");
        });
    }

    @Override
    public void onFrame(long shareId, byte[] jpeg) {
        main.post(() -> {
            WebMessagePortCompat p = port;
            if (p == null || portShareId != shareId) {
                ScreenShareService.frameAcknowledged();
                return;
            }
            try {
                if (binary) {
                    p.postMessage(new WebMessageCompat(jpeg));
                } else {
                    p.postMessage(new WebMessageCompat(Base64.encodeToString(jpeg, Base64.NO_WRAP)));
                }
            } catch (Exception e) {
                ScreenShareService.frameAcknowledged();
            }
        });
    }

    @Override
    public void onEnded(long shareId, String reason) {
        main.post(() -> {
            boolean pageHasIt = port != null && portShareId == shareId;
            if (pageHasIt) {
                try {
                    JSONObject m = new JSONObject();
                    m.put("type", "ended");
                    m.put("reason", reason);
                    port.postMessage(new WebMessageCompat(m.toString()));
                } catch (Exception ignored) {
                    // the page is gone; the event below still tells it
                }
                closePort();
            }
            finish(slot.take(shareId), null, reason, "ended");
            if (pageHasIt) {
                JSObject ev = new JSObject();
                ev.put("reason", reason);
                ev.put("shareId", shareId);
                notifyListeners("shareEnded", ev);
            }
        });
    }

    // ---- the port -----------------------------------------------------------

    /** Main thread. */
    private void openPort(long shareId, String nonce, int width, int height) throws Exception {
        closePort();
        WebView web = getBridge().getWebView();
        WebMessagePortCompat[] ports = WebViewCompat.createWebMessageChannel(web);
        port = ports[0];
        portShareId = shareId;
        final int generation = ++portGeneration;
        binary = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER);
        port.setWebMessageCallback(new WebMessagePortCompat.WebMessageCallbackCompat() {
            @Override
            public void onMessage(WebMessagePortCompat from, WebMessageCompat message) {
                if (generation != portGeneration || port == null || message == null) return;
                String data = message.getType() == WebMessageCompat.TYPE_STRING ? message.getData() : null;
                if ("ack".equals(data)) ScreenShareService.frameAcknowledged();
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
        portShareId = 0;
        portGeneration++;
        if (p != null) {
            try { p.close(); } catch (Exception ignored) { /* already closed */ }
        }
    }

    /** Answers a start that was taken out of the slot (null: nothing to do). */
    private void finish(ScreenShareSlot.Pending<PluginCall> p, JSObject ok, String error, String code) {
        if (p == null) return;
        PluginCall call = p.call;
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
        finish(slot.takeAny(), null, "The app was closed", "ended");
        ScreenShareService.setListener(null);
        super.handleOnDestroy();
    }
}
