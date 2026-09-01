package com.sovereign.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import android.util.Base64;
import android.view.View;

import androidx.core.app.NotificationCompat;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The app-level native bridge: staying alive in the background, posting
 * message notifications, and carrying navigation intents (home-screen widget
 * buttons, notification taps) into the WebView.
 *
 * Separate from SovereignFiles/SovereignTransfers for the same reason those
 * are separate from each other: an older APK must fail to find this plugin
 * cleanly (the JS side degrades silently) rather than half-work.
 */
@CapacitorPlugin(
    name = "SovereignApp",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class SovereignAppPlugin extends Plugin {

    /** Where a widget button or a notification tap asks the app to land. */
    public static final String EXTRA_NAV = "sovereign_nav";

    public static final String MSG_CHANNEL_ID = "sovereign_messages";
    /** Tag on every message notification, so clearing them can never touch the
     *  keep-alive service's own (untagged) foreground notification. Public:
     *  KeepAliveService posts geofence-arrival notifications under the same
     *  tag so the foreground-clear sweep retires them too. */
    public static final String MSG_TAG = "sovereign_msg";

    /** Nav target from the intent that STARTED the activity, held until the
     *  web app is ready to ask (it boots seconds later, behind the OTA gate). */
    private static volatile String pendingNav;

    /** The last soft-keyboard reading dispatched, or null when nothing has been
     *  measured on this WebView. A LEVEL signal, unlike pendingNav: served by
     *  keyboardState() and never cleared on read, because a listener that
     *  registers after the keyboard opened would otherwise learn nothing until
     *  the next inset dispatch. Static so it survives the plugin instance;
     *  reset when a listener is installed on a fresh WebView. */
    private static volatile ImeInsets lastIme;

    /** The live plugin, for PipActivity to notify JS through. A WebView reload
     *  (OTA apply) makes a new instance; the newest one wins. */
    private static volatile SovereignAppPlugin instance;

    @Override
    public void load() {
        instance = this;
        createMessagesChannel();
        // The app is open — a "Notifications are paused" notice left by
        // KeepAliveService.onTaskRemoved is stale the moment the user can see
        // the app itself (the Settings health row now owns truth-telling).
        // The service's own restart also cancels it, but that only happens
        // when delivery is re-enabled; this covers opening the app with
        // notifications off or while signed out.
        NotificationManager nm =
                (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(KeepAliveService.NOTIFICATION_ID + 1);
        Intent launch = getActivity() == null ? null : getActivity().getIntent();
        if (launch != null) {
            String nav = launch.getStringExtra(EXTRA_NAV);
            if (nav != null && !nav.isEmpty()) {
                pendingNav = nav;
                // Consumed: an activity recreation (rotation, theme change)
                // re-delivers the same intent, and a stale nav yanking the
                // user away mid-use would look like the app changing its mind.
                launch.removeExtra(EXTRA_NAV);
            }
        }
        installKeyboardInsetListener();
    }

    // --- Soft-keyboard geometry -------------------------------------------

    /**
     * Report where the soft keyboard's top edge is, so the remote-control view
     * can keep the remote text caret in the strip above it.
     *
     * ON THE WEBVIEW, NOT ITS PARENT. Capacitor's built-in SystemBars plugin
     * owns the PARENT's listener (SystemBars.java:162) and a View has exactly
     * one — attaching there would silently replace it, taking the safe-area /
     * edge-to-edge handling with it. Nothing here consumes anything either:
     * a listener REPLACES the view's own handler, so the insets are handed on
     * with ViewCompat.onApplyWindowInsets(v, insets), which is not the same as
     * returning them and is the opposite of returning CONSUMED.
     *
     * This resizes nothing. The app deliberately has no viewport-fit=cover, so
     * SystemBars applies no IME margin and the layout viewport does not shrink;
     * the web layer does its own layout from these numbers. Adding
     * viewport-fit=cover instead would switch on real env(safe-area-inset-*)
     * app-wide — a broad visual change in place of a local one. It is also what
     * keeps this listener reachable: SystemBars' parent listener returns the
     * insets UNCONSUMED on the no-cover path and WindowInsetsCompat.CONSUMED on
     * the cover path, so adding viewport-fit=cover would silently stop this
     * from ever firing (JS then falls back rather than breaking).
     *
     * API 30+ only: WindowInsetsCompat.Type.ime() is not reliably reported
     * below R and minSdk here is 24, so on an older phone this stays silent for
     * ever, keyboardState() answers with the "nothing measured" marker, and the
     * JS ladder (visualViewport, then an assumed fraction) is the live path
     * there — not dead code.
     */
    private void installKeyboardInsetListener() {
        if (Build.VERSION.SDK_INT < 30) return;
        Bridge bridge = getBridge();
        final View web = bridge == null ? null : bridge.getWebView();
        if (web == null) return;
        // A fresh WebView (activity recreation) makes the previous reading
        // meaningless — its topPx was measured against a view that no longer
        // exists. Null, not UNKNOWN: worthNotifying() then treats the first
        // dispatch as news, and it arrives with the next layout pass.
        lastIme = null;
        // setOnApplyWindowInsetsListener and getLocationInWindow are UI-thread
        // only. load() already runs there, but posting makes that a guarantee
        // rather than an assumption and costs one message loop.
        web.post(() -> ViewCompat.setOnApplyWindowInsetsListener(web, (v, insets) -> {
            try {
                boolean visible = insets.isVisible(WindowInsetsCompat.Type.ime());
                int imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
                int[] loc = new int[2];
                v.getLocationInWindow(loc);
                View root = v.getRootView();
                int windowH = root == null ? v.getHeight() : root.getHeight();
                // The IME inset is measured from the WINDOW's bottom, and the
                // WebView need not start at the window's top (status bar,
                // cutout) — so subtract where this view actually begins.
                int topPx = (windowH - imeBottom) - loc[1];
                ImeInsets next = new ImeInsets(visible, topPx, v.getHeight());
                if (ImeInsets.worthNotifying(lastIme, next)) {
                    lastIme = next;
                    JSObject data = new JSObject();
                    data.put("visible", next.visible);
                    // Raw pixels; JS converts against its own clientHeight.
                    data.put("topPx", next.topPx);
                    data.put("viewHeightPx", next.viewHeightPx);
                    // NOT retained. A retained event replays a stale band after
                    // an OTA apply's WebView reload — the same shape of bug the
                    // static nav target caused (see mobileApp.ts:470-475).
                    // keyboardState() is the late-subscriber answer instead.
                    notifyListeners("keyboard", data);
                }
            } catch (Exception ignored) {
                // An inset read that throws must never cost the WebView its own
                // inset handling, which happens on the line below.
            }
            return ViewCompat.onApplyWindowInsets(v, insets);
        }));
    }

    /**
     * The last soft-keyboard reading, for a caller that started watching after
     * the keyboard was already up. Never one-shot (contrast consumeLaunchNav):
     * this is a level, and clearing it on read would make the second reader lie.
     * {visible:false, topPx:-1, viewHeightPx:-1} means nothing has measured it —
     * an old OS, or the first layout pass has not happened yet — which the
     * caller must treat differently from a measured "no keyboard".
     */
    @PluginMethod
    public void keyboardState(PluginCall call) {
        ImeInsets s = lastIme;
        if (s == null) s = ImeInsets.UNKNOWN;
        JSObject ret = new JSObject();
        ret.put("visible", s.visible);
        ret.put("topPx", s.topPx);
        ret.put("viewHeightPx", s.viewHeightPx);
        call.resolve(ret);
    }

    /**
     * Raise the soft keyboard for whatever the WebView currently has focused.
     *
     * WHY NATIVE. The remote-control view opens the keyboard by itself when a
     * tap lands in a text box on the OTHER machine — which it only learns ~100
     * to 900 ms later, from the host's caret report, long after the tap's own
     * gesture is over. Blink raises the IME on a programmatic focus() only
     * while it judges the frame user-activated, and that judgement has proved
     * unreliable in this WebView (the keyboard overlay's focus had to be moved
     * into the opening tap's layout effect to work at all). Android's
     * {@link InputMethodManager#showSoftInput} has no such condition: if the
     * focused WebView has an input connection — it does, the moment the web
     * layer has focused a field — the IME comes up.
     *
     * TWICE, 120 ms apart, and that is load-bearing. The web layer focuses its
     * field and then calls this; the renderer's text-input-state update and
     * this bridge call both cross to the browser process on unrelated pipes, so
     * the first showSoftInput can land while Chromium still thinks nothing is
     * editable (no input connection → the call is a no-op that returns
     * false). The second is past that race. showSoftInput on an IME that is
     * already up is itself a no-op, so the pair never produces a flicker.
     *
     * Flags 0, not SHOW_IMPLICIT: the user DID tap; this is a direct request.
     * Resolves {@code {ok}} from the FIRST call's answer — diagnostic only; the
     * JS side does not branch on it.
     */
    @PluginMethod
    public void showKeyboard(PluginCall call) {
        Bridge bridge = getBridge();
        final View web = bridge == null ? null : bridge.getWebView();
        final android.app.Activity a = getActivity();
        if (web == null || a == null) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("reason", "no webview");
            call.resolve(ret);
            return;
        }
        final android.view.inputmethod.InputMethodManager imm =
            (android.view.inputmethod.InputMethodManager)
                a.getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm == null) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("reason", "no input method service");
            call.resolve(ret);
            return;
        }
        // UI thread only: requestFocus and showSoftInput both touch the view
        // hierarchy, and a plugin method runs on Capacitor's own thread.
        web.post(() -> {
            boolean ok;
            try {
                // The WebView normally has focus already (the user tapped it);
                // this is insurance against a notification shade or dialog
                // having taken it, since showSoftInput only serves the focused
                // view.
                web.requestFocus();
                ok = imm.showSoftInput(web, 0);
            } catch (Exception e) {
                ok = false;
            }
            web.postDelayed(() -> {
                try {
                    imm.showSoftInput(web, 0);
                } catch (Exception ignored) {
                    // Best effort; the first call already answered the JS side.
                }
            }, 120);
            JSObject ret = new JSObject();
            ret.put("ok", ok);
            call.resolve(ret);
        });
    }

    // --- Picture-in-picture (the floating stream window) --------------------

    /** Is the OS PiP window available on this device? Android 8+ with the
     *  system feature. The JS side hides the Pop-out control otherwise. */
    @PluginMethod
    public void pipSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", PipActivity.supported(getContext()));
        call.resolve(ret);
    }

    /**
     * Float the app's WebView in a picture-in-picture window shaped like the
     * video ({@code width}/{@code height} are the video's pixel dimensions).
     * See PipActivity for why this is a second activity that borrows the
     * WebView rather than MainActivity entering PiP itself. Resolves
     * {@code {ok:false, reason}} when PiP is not available; a refusal by the OS
     * after launch arrives as a {@code pipModeChanged {active:false}} event.
     */
    @PluginMethod
    public void enterPip(PluginCall call) {
        final int w = call.getInt("width", 16);
        final int h = call.getInt("height", 9);
        final android.app.Activity a = getActivity();
        if (!(a instanceof MainActivity)) {
            call.resolve(fail("no activity to float"));
            return;
        }
        if (!PipActivity.supported(a)) {
            call.resolve(fail("picture-in-picture is not available on this device"));
            return;
        }
        a.runOnUiThread(() -> {
            boolean ok = ((MainActivity) a).enterPip(w, h);
            call.resolve(ok ? ok() : fail("could not open the floating window"));
        });
    }

    /** Take the floating window down (the stream ended, or the app itself is
     *  bringing the video back). Does NOT bring the app forward. */
    @PluginMethod
    public void exitPip(PluginCall call) {
        PipActivity.finishIfLive();
        call.resolve(ok());
    }

    /** PipActivity → JS: the floating window appeared / went away. */
    static void notifyPip(boolean active) {
        SovereignAppPlugin p = instance;
        if (p == null) return;
        JSObject data = new JSObject();
        data.put("active", active);
        p.notifyListeners("pipModeChanged", data);
    }

    private static JSObject ok() {
        JSObject o = new JSObject();
        o.put("ok", true);
        return o;
    }

    private static JSObject fail(String reason) {
        JSObject o = new JSObject();
        o.put("ok", false);
        o.put("reason", reason);
        return o;
    }

    /**
     * The phone's clipboard as text, for "Send clipboard" in a remote-control
     * session. Native or nothing: the Android System WebView implements the
     * async-clipboard WRITE but not READ — navigator.clipboard.readText()
     * rejects with NotAllowedError because WebView has no clipboard-read
     * permission delegate — so the JS side cannot do this itself. Android 10+
     * lets the FOREGROUND app read the primary clip, which is exactly the
     * situation here (the user just tapped the menu item). Returns
     * {ok:true, text} for a TEXT clip (text "" when the clipboard is empty),
     * {ok:false, reason} for a non-text clip or when it could not be read.
     * getText(), never coerceToText(): coercion turns a copied image or file
     * into its content:// URI string, which would then be "pasted" onto the
     * remote machine as a path that means nothing there.
     */
    @PluginMethod
    public void readClipboard(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            android.content.ClipboardManager cm =
                (android.content.ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) {
                ret.put("ok", false);
                ret.put("reason", "no clipboard service");
                call.resolve(ret);
                return;
            }
            android.content.ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) {
                ret.put("ok", true);
                ret.put("text", "");
                call.resolve(ret);
                return;
            }
            CharSequence cs = clip.getItemAt(0).getText();
            if (cs == null) {
                ret.put("ok", false);
                ret.put("reason", "the clipboard does not contain text");
                call.resolve(ret);
                return;
            }
            ret.put("ok", true);
            ret.put("text", cs.toString());
            call.resolve(ret);
        } catch (SecurityException e) {
            // Background reads are refused on Android 10+; we should never be
            // here (the read follows a tap) but say so rather than lie.
            ret.put("ok", false);
            ret.put("reason", "Android refused the clipboard read (app not in the foreground)");
            call.resolve(ret);
        }
    }

    /** A widget tap while the app is already running (singleTask -> onNewIntent). */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String nav = intent == null ? null : intent.getStringExtra(EXTRA_NAV);
        if (nav == null || nav.isEmpty()) return;
        intent.removeExtra(EXTRA_NAV);
        pendingNav = nav;
        JSObject data = new JSObject();
        data.put("target", nav);
        notifyListeners("navigate", data);
    }

    /** One-shot: the nav target this launch was asked to land on, if any. */
    @PluginMethod
    public void consumeLaunchNav(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("target", pendingNav);
        pendingNav = null;
        call.resolve(ret);
    }

    /**
     * Declare the complete desired keep-alive state. Idempotent: the service
     * is started/updated when any reason is set, stopped when none is.
     */
    @PluginMethod
    public void setKeepAlive(PluginCall call) {
        boolean control = Boolean.TRUE.equals(call.getBoolean("control", false));
        boolean notify = Boolean.TRUE.equals(call.getBoolean("notify", false));
        // Location reminders (task place fences). Absent from older JS —
        // getBoolean's default keeps those senders meaning what they said.
        boolean geofence = Boolean.TRUE.equals(call.getBoolean("geofence", false));
        try {
            if (control || notify || geofence) {
                Intent i = new Intent(getContext(), KeepAliveService.class);
                i.putExtra(KeepAliveService.EXTRA_CONTROL, control);
                i.putExtra(KeepAliveService.EXTRA_NOTIFY, notify);
                i.putExtra(KeepAliveService.EXTRA_GEOFENCE, geofence);
                if (Build.VERSION.SDK_INT >= 26) {
                    getContext().startForegroundService(i);
                } else {
                    getContext().startService(i);
                }
            } else {
                getContext().stopService(new Intent(getContext(), KeepAliveService.class));
            }
            call.resolve();
        } catch (Exception e) {
            // Starting an FGS from the background is refused on Android 12+
            // unless one is already running. Report it — the JS side treats a
            // reject as "the session will not survive backgrounding" and can
            // say so.
            call.reject("could not update the keep-alive service: " + e.getMessage());
        }
    }

    /**
     * Post (or replace) a message notification. `key` is a stable string like
     * "dm:42" — reusing it replaces that conversation's earlier notification
     * instead of stacking an unread pile.
     */
    @PluginMethod
    public void notify(PluginCall call) {
        // Body extracted to SovereignNotifier so the FCM service — which runs
        // with no bridge and possibly no WebView at all — posts through the
        // exact same channel/tag/key-hash and the two paths replace rather
        // than stack.
        SovereignNotifier.post(
                getContext(),
                call.getString("key", "puca"),
                call.getString("title", "Puca"),
                call.getString("body", ""),
                call.getString("nav", ""));
        call.resolve();
    }

    // --- Native delivery bridge (self-hosted push) ------------------------

    /**
     * Hand the native delivery socket its connection credentials: the app's
     * OWN WebSocket URL and the session JWT (which lives in WebView storage
     * Java cannot read). Null token clears them — the socket then idles.
     * Called on login, on token renewal, and cleared on logout. There is no
     * third party in this path; that is the point of it.
     */
    @PluginMethod
    public void setNativeDelivery(PluginCall call) {
        String wsUrl = call.getString("wsUrl");
        String token = call.getString("token");
        // Device id the socket CLAIMS at connect, so "sign out this device"
        // can hang it up server-side. Kill-only; never treated as identity.
        String deviceId = call.getString("deviceId");
        // Compare BEFORE writing: a reconnect is only owed when something the
        // socket actually connects with has moved. The JS side re-syncs on
        // every device attestation, i.e. on every WebView reconnect, and
        // dropping a healthy delivery socket each time was pure churn — it
        // doubled the reconnect rate on a flaky network and helped crowd the
        // per-user session cap.
        boolean changed = DeliveryCreds.changed(
                PushPrefs.wsUrl(getContext()),
                PushPrefs.authToken(getContext()),
                PushPrefs.deliveryDeviceId(getContext()),
                wsUrl, token, deviceId);

        if (wsUrl == null || token == null) {
            PushPrefs.setDelivery(getContext(), null, null);
            PushPrefs.setDeliveryDeviceId(getContext(), null);
        } else {
            PushPrefs.setDelivery(getContext(), wsUrl, token);
            // Null means "not enrolled YET this boot", not "no device": the
            // id arrives on a later attestation re-sync, and clearing here on
            // every start would erase the previous session's correct claim —
            // leaving "sign out this device" unable to reach this socket.
            if (deviceId != null && !deviceId.isEmpty()) {
                PushPrefs.setDeliveryDeviceId(getContext(), deviceId);
            }
        }
        // A running service reconnects with the new credentials immediately;
        // a stopped one picks them up on its next start.
        if (changed) {
            KeepAliveService.deliveryCredentialsChanged();
        }
        call.resolve();
    }

    /**
     * This device's FCM WAKE token, so JS can register it with the server
     * (registration needs the JWT, which Java cannot read). The token
     * addresses a doorbell whose payload is a constant — it is the only thing
     * about this phone that ever reaches Google's push service. Resolves
     * {token: null} when Firebase isn't configured in this build; a token
     * parked by onNewToken while the app was dead takes priority (newest).
     */
    @PluginMethod
    public void wakeToken(PluginCall call) {
        String pending = PushPrefs.takePendingWakeToken(getContext());
        try {
            // Firebase auto-init is disabled in the manifest, so registration
            // with Google happens HERE and nowhere else — at the first point a
            // signed-in user has actually asked for the doorbell, rather than
            // silently when the process starts, before sign-in and before any
            // consent. Idempotent, and the setting persists, so later launches
            // re-register on their own without asking again.
            com.google.firebase.messaging.FirebaseMessaging.getInstance().setAutoInitEnabled(true);
            com.google.firebase.messaging.FirebaseMessaging.getInstance().getToken()
                    .addOnCompleteListener(task -> {
                        JSObject ret = new JSObject();
                        if (task.isSuccessful() && task.getResult() != null) {
                            ret.put("token", task.getResult());
                        } else {
                            ret.put("token", pending);
                            ret.put("reason", task.getException() == null
                                    ? "no token" : String.valueOf(task.getException().getMessage()));
                        }
                        call.resolve(ret);
                    });
        } catch (Exception e) {
            // No FirebaseApp = built without google-services.json. The socket
            // still delivers while alive; only the doorbell is absent.
            JSObject ret = new JSObject();
            ret.put("token", pending);
            ret.put("reason", "firebase not configured: " + e.getMessage());
            call.resolve(ret);
        }
    }

    /**
     * Mirror the JS notification gates into PushPrefs, where the WebView-less
     * FCM handler can read them. Called on login and on every mute/block
     * change — the mirror going stale is the data-message design silently
     * degrading to "notify for everything".
     */
    @PluginMethod
    public void syncPushGates(PluginCall call) {
        JSObject mutedServers = call.getObject("mutedServers", new JSObject());
        JSObject mutedChannels = call.getObject("mutedChannels", new JSObject());
        JSArray blocked = call.getArray("blockedIds");
        Boolean enabled = call.getBoolean("pushEnabled", true);
        // Absent from older JS bundles — default TRUE so an OTA lagging behind
        // this APK cannot silently switch background delivery off.
        Boolean background = call.getBoolean("backgroundDelivery", true);
        PushPrefs.setGates(
                getContext(),
                mutedServers == null ? "{}" : mutedServers.toString(),
                mutedChannels == null ? "{}" : mutedChannels.toString(),
                blocked == null ? "[]" : blocked.toString(),
                enabled == null || enabled,
                background == null || background);
        call.resolve();
    }

    /** Bind (userId) or clear (null) the signed-in account. Clearing wipes the
     *  whole mirror — the next account must not inherit this one's gates. */
    @PluginMethod
    public void setPushAccount(PluginCall call) {
        String userId = call.getString("userId");
        PushPrefs.setAccount(getContext(), userId);
        call.resolve();
    }

    /**
     * Replace the dynamic launcher shortcuts (long-press the app icon) with
     * the given conversations. Items: { id, label, nav, icon? } where icon is
     * a raw base64 PNG (no data: prefix). An empty list clears them. The id
     * doubles as the notification shortcutId, so it must be the nav string.
     */
    @PluginMethod
    public void setConversationShortcuts(PluginCall call) {
        try {
            Context ctx = getContext();
            JSArray items = call.getArray("items");
            int max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(ctx);
            // The three static shortcuts (res/xml/shortcuts.xml) share the
            // per-activity budget; exceeding it makes setDynamicShortcuts
            // throw rather than truncate.
            int room = Math.max(0, max - 3);
            List<ShortcutInfoCompat> shortcuts = new ArrayList<>();
            for (int i = 0; items != null && i < items.length() && shortcuts.size() < room; i++) {
                JSONObject o = items.getJSONObject(i);
                String id = o.optString("id", "");
                String label = o.optString("label", "");
                String nav = o.optString("nav", "");
                if (id.isEmpty() || label.isEmpty() || nav.isEmpty()) continue;
                // The action is not decoration: a shortcut intent without one
                // throws IllegalArgumentException at build().
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setClass(ctx, MainActivity.class);
                intent.putExtra(EXTRA_NAV, nav);
                ShortcutInfoCompat.Builder b = new ShortcutInfoCompat.Builder(ctx, id)
                        .setShortLabel(label)
                        .setLongLabel(label)
                        .setLongLived(true)
                        .setCategories(Collections.singleton("android.shortcut.conversation"))
                        .setIntent(intent);
                String icon = o.optString("icon", "");
                if (!icon.isEmpty()) {
                    try {
                        byte[] png = Base64.decode(icon, Base64.DEFAULT);
                        Bitmap bmp = BitmapFactory.decodeByteArray(png, 0, png.length);
                        if (bmp != null) b.setIcon(IconCompat.createWithAdaptiveBitmap(bmp));
                    } catch (Exception ignored) {
                        // A bad icon must not cost the shortcut itself.
                    }
                }
                shortcuts.add(b.build());
            }
            ShortcutManagerCompat.setDynamicShortcuts(ctx, shortcuts);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not set launcher shortcuts: " + e.getMessage());
        }
    }

    /** Opening a conversation ranks its shortcut for the launcher and for
     *  Direct Share. Unknown ids are a no-op by contract. */
    @PluginMethod
    public void reportShortcutUsed(PluginCall call) {
        String id = call.getString("id", "");
        if (id != null && !id.isEmpty()) {
            try {
                ShortcutManagerCompat.reportShortcutUsed(getContext(), id);
            } catch (Exception ignored) {
                // Ranking is best-effort; never surface a failure for it.
            }
        }
        call.resolve();
    }

    /** Clear message notifications — all of them, or one key's. Never touches
     *  the keep-alive service's foreground notification (different tag). */
    @PluginMethod
    public void clearNotifications(PluginCall call) {
        NotificationManager nm =
                (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            call.resolve();
            return;
        }
        String key = call.getString("key");
        if (key != null && !key.isEmpty()) {
            nm.cancel(MSG_TAG, key.hashCode());
        } else {
            for (StatusBarNotification sbn : nm.getActiveNotifications()) {
                if (MSG_TAG.equals(sbn.getTag())) {
                    nm.cancel(MSG_TAG, sbn.getId());
                }
            }
        }
        call.resolve();
    }

    /** Is the notification permission granted? On < 33 there is nothing to ask. */
    @PluginMethod
    public void notificationStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", canPostNotifications());
        ret.put("needsRequest", Build.VERSION.SDK_INT >= 33 && !canPostNotifications());
        // `blocked`: states a granted runtime permission cannot see —
        // notifications switched off for the app as a whole (pre-33 devices
        // have no runtime grant, so this is their ONLY off switch), or the
        // Messages channel itself silenced. Re-requesting cannot fix either;
        // only the system settings screen can, which is why the JS side
        // routes `blocked` there instead of at the permission prompt.
        boolean enabled = androidx.core.app.NotificationManagerCompat
                .from(getContext()).areNotificationsEnabled();
        boolean channelOff = false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm =
                    (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel ch = nm == null ? null : nm.getNotificationChannel(MSG_CHANNEL_ID);
            channelOff = ch != null && ch.getImportance() == NotificationManager.IMPORTANCE_NONE;
        }
        ret.put("blocked", !enabled || channelOff);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || canPostNotifications()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationResult");
    }

    @PermissionCallback
    private void notificationResult(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", canPostNotifications());
        call.resolve(ret);
    }

    private boolean canPostNotifications() {
        if (Build.VERSION.SDK_INT < 33) return true;
        return getPermissionState("notifications") == com.getcapacitor.PermissionState.GRANTED;
    }

    /**
     * Is this app exempt from battery optimisations? Doze suspends network
     * for non-exempt apps regardless of any foreground service, which starves
     * the WebSocket that carries all notification DATA here (the wake signal
     * reconnects it but delivers nothing itself).
     * Without the wake signal configured, a messenger needs this exemption to deliver with the screen
     * off — same ask Signal/Conversations/ntfy make.
     */
    @PluginMethod
    public void batteryStatus(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject ret = new JSObject();
        ret.put("ignoring", pm != null
                && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(ret);
    }

    /**
     * Fire the system "let this app always run in the background?" dialog.
     * The result is not delivered here — the JS side re-polls batteryStatus
     * when the app regains visibility. Unlike POST_NOTIFICATIONS there is no
     * two-denial lockout: this dialog can always be shown again.
     */
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            // Some OEM builds strip the dialog; the JS side falls back to
            // text instructions when this rejects.
            call.reject("battery exemption dialog unavailable: " + e.getMessage());
        }
    }

    /**
     * Deep-link to Android's notification settings for this app — the only
     * recovery once POST_NOTIFICATIONS hits the two-denial lockout, where
     * requesting again is a silent no-op.
     */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            Intent i;
            if (Build.VERSION.SDK_INT >= 26) {
                i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            } else {
                i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:" + getContext().getPackageName()));
            }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not open notification settings: " + e.getMessage());
        }
    }

    private void createMessagesChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm =
                (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(MSG_CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                MSG_CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("New messages and friend requests.");
        ch.setShowBadge(true);
        nm.createNotificationChannel(ch);
    }
}
