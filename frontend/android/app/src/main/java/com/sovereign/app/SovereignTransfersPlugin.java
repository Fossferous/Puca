package com.sovereign.app;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The JS handle on {@link TransferService}: start it when a transfer begins,
 * push progress into its notification, stop it when the last one finishes.
 *
 * Separate from SovereignFilesPlugin because the two answer different
 * questions — that one is about reaching the filesystem, this one is about
 * staying alive — and because an older APK carrying only the first must fail
 * to find this one cleanly rather than half-work.
 */
@CapacitorPlugin(
    name = "SovereignTransfers",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class SovereignTransfersPlugin extends Plugin {

    /** Is the notification permission granted? On < 33 there is nothing to ask. */
    @PluginMethod
    public void notificationStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", canPostNotifications());
        ret.put("needsRequest", Build.VERSION.SDK_INT >= 33 && !canPostNotifications());
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

    /**
     * Bring the service up. Safe to call repeatedly — Android delivers another
     * onStartCommand to the running instance, which just refreshes the text.
     */
    @PluginMethod
    public void start(PluginCall call) {
        String title = call.getString("title", "Transferring files");
        String text = call.getString("text", "In progress");
        Integer progress = call.getInt("progress", -1);
        try {
            Intent i = new Intent(getContext(), TransferService.class);
            i.putExtra(TransferService.EXTRA_TITLE, title);
            i.putExtra(TransferService.EXTRA_TEXT, text);
            i.putExtra(TransferService.EXTRA_PROGRESS, progress == null ? -1 : progress);
            if (Build.VERSION.SDK_INT >= 26) {
                getContext().startForegroundService(i);
            } else {
                getContext().startService(i);
            }
            call.resolve();
        } catch (Exception e) {
            // Starting an FGS from the background is refused on Android 12+.
            // Report it rather than leaving the caller believing it worked.
            call.reject("could not start the transfer service: " + e.getMessage());
        }
    }

    /** Same call as start(); named for what it does at the call site. */
    @PluginMethod
    public void update(PluginCall call) {
        start(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), TransferService.class));
        } catch (Exception ignored) {
            // Already gone.
        }
        NotificationManager nm =
                (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.cancel(TransferService.NOTIFICATION_ID);
        }
        call.resolve();
    }

    private boolean canPostNotifications() {
        if (Build.VERSION.SDK_INT < 33) return true;
        return getPermissionState("notifications") == com.getcapacitor.PermissionState.GRANTED;
    }
}
