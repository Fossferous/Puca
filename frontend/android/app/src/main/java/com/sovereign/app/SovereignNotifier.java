package com.sovereign.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/**
 * Posts (or replaces) a message notification — from ANY process state.
 *
 * Extracted from SovereignAppPlugin.notify because that method needs a live
 * Capacitor bridge call, and the FCM service runs with no WebView and possibly
 * no JS ever loaded (a high-priority data message cold-starts the process and
 * instantiates only the service). Three callers converge here: the plugin (the
 * WebSocket path), KeepAliveService (geofence arrivals), and
 * NativeDelivery (the background socket). Converging matters beyond reuse:
 * the `key.hashCode()` id under MSG_TAG is what makes a push and a
 * WebSocket-path notification for the same conversation REPLACE each other
 * instead of stacking, and clearNotifications clears both.
 */
public final class SovereignNotifier {

    private SovereignNotifier() {}

    public static void post(Context ctx, String key, String title, String body, String nav) {
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        // The plugin creates the channel at load, but a cold-started process
        // never ran the bridge — same defensive re-create KeepAliveService's
        // arrival path already carries, for the same reason.
        if (Build.VERSION.SDK_INT >= 26
                && nm.getNotificationChannel(SovereignAppPlugin.MSG_CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(
                    SovereignAppPlugin.MSG_CHANNEL_ID, "Messages",
                    NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("New messages and friend requests.");
            ch.setShowBadge(true);
            nm.createNotificationChannel(ch);
        }

        int id = key.hashCode();
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (nav != null && !nav.isEmpty()) {
            open.putExtra(SovereignAppPlugin.EXTRA_NAV, nav);
        }
        // Distinct requestCode per key: PendingIntents with equal requestCodes
        // collapse to one, and every notification would open the LAST target.
        PendingIntent pi = PendingIntent.getActivity(
                ctx, id, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b =
                new NotificationCompat.Builder(ctx, SovereignAppPlugin.MSG_CHANNEL_ID)
                        .setContentTitle(title)
                        .setContentText(body)
                        .setSmallIcon(android.R.drawable.stat_notify_chat)
                        .setContentIntent(pi)
                        .setAutoCancel(true)
                        .setPriority(NotificationCompat.PRIORITY_HIGH)
                        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                        // A key-replacement must UPDATE, not re-alert: two
                        // paths (JS and native) deliberately share ids so they
                        // replace each other, and without this every
                        // replacement buzzed again.
                        .setOnlyAlertOnce(true)
                        .setDefaults(NotificationCompat.DEFAULT_ALL);

        // Conversation-style rendering on launchers that support it; a nav
        // with no matching shortcut is simply ignored by the OS.
        if (nav != null && nav.startsWith("dm:")) {
            b.setShortcutId(nav);
        }

        nm.notify(SovereignAppPlugin.MSG_TAG, id, b.build());
    }
}
