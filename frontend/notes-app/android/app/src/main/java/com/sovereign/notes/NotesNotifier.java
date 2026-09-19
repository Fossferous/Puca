package com.sovereign.notes;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/**
 * Every notification Púca Notes posts, from any process state (the alarm
 * receiver, the refresh job and the location service all run with no
 * WebView). Same pattern as Púca's SovereignNotifier: channels re-created
 * defensively, FLAG_IMMUTABLE content intents, a nav extra the page routes on.
 *
 * CONTENT-FREE, ALL OF IT. A notification survives on the lock screen, and
 * this app's background code could not read an item's text even if it wanted
 * to (it is end-to-end encrypted and never handed to native code). So every
 * text here is a constant or a count — "An item is due", never what the item
 * says, and never where a place is.
 */
final class NotesNotifier {

    static final String CH_REMINDERS = "notes_reminders";
    static final String CH_PLACES = "notes_places";
    static final String CH_STATUS = "notes_status";

    /** Where a notification tap asks the page to land (NotesNativePlugin). */
    static final String EXTRA_NAV = "notes_nav";
    static final String NAV_REMINDERS = "reminders";

    static final int ID_DUE = 7401;
    static final int ID_STALE = 7402;
    static final int ID_PLACE = 7403;
    static final int ID_LOCATION_ONGOING = 7404;
    static final int ID_PLACES_PAUSED = 7405;

    private NotesNotifier() {}

    static NotificationManager nm(Context ctx) {
        return (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = nm(ctx);
        if (nm == null) return;
        if (nm.getNotificationChannel(CH_REMINDERS) == null) {
            NotificationChannel ch = new NotificationChannel(
                    CH_REMINDERS, "Reminders", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("An item in a note has come due.");
            ch.setShowBadge(true);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CH_PLACES) == null) {
            NotificationChannel ch = new NotificationChannel(
                    CH_PLACES, "Place reminders", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("You arrived at a place an item is waiting for.");
            ch.setShowBadge(true);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CH_STATUS) == null) {
            NotificationChannel ch = new NotificationChannel(
                    CH_STATUS, "Status", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Location reminders running, or something Notes needs you to open it for.");
            ch.setShowBadge(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
    }

    /** Is the Reminders channel switched off by the user? (Status reporting.) */
    static boolean remindersChannelOff(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return false;
        NotificationManager nm = nm(ctx);
        NotificationChannel ch = nm == null ? null : nm.getNotificationChannel(CH_REMINDERS);
        return ch != null && ch.getImportance() == NotificationManager.IMPORTANCE_NONE;
    }

    static PendingIntent openApp(Context ctx, int requestCode, String nav) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (nav != null) open.putExtra(EXTRA_NAV, nav);
        // A distinct requestCode per purpose: equal requestCodes collapse to
        // one PendingIntent and every notification would open the LAST target.
        return PendingIntent.getActivity(ctx, requestCode, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** ONE collapsing notification for everything due right now. */
    static void postDue(Context ctx, int count) {
        if (count <= 0) return;
        ensureChannels(ctx);
        NotificationManager nm = nm(ctx);
        if (nm == null) return;
        try {
            nm.notify(ID_DUE, new NotificationCompat.Builder(ctx, CH_REMINDERS)
                    .setContentTitle("Púca Notes")
                    .setContentText(ReminderPlan.dueText(count))
                    .setSmallIcon(android.R.drawable.ic_popup_reminder)
                    .setContentIntent(openApp(ctx, ID_DUE, NAV_REMINDERS))
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_REMINDER)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setDefaults(NotificationCompat.DEFAULT_ALL)
                    .build());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS revoked: nothing to show it with. The page's
            // banner is what tells the user.
        }
    }

    /** The background refresh lost its session (401): once, quietly. */
    static void postStale(Context ctx) {
        ensureChannels(ctx);
        NotificationManager nm = nm(ctx);
        if (nm == null) return;
        try {
            nm.notify(ID_STALE, new NotificationCompat.Builder(ctx, CH_STATUS)
                    .setContentTitle("Púca Notes")
                    .setContentText("Open Púca Notes to keep reminders up to date")
                    .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                    .setContentIntent(openApp(ctx, ID_STALE, NAV_REMINDERS))
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setCategory(NotificationCompat.CATEGORY_STATUS)
                    .build());
        } catch (SecurityException ignored) { /* as above */ }
    }

    /** Arrival at one or more saved places. A count, never the place. */
    static void postPlaces(Context ctx, int count) {
        if (count <= 0) return;
        ensureChannels(ctx);
        NotificationManager nm = nm(ctx);
        if (nm == null) return;
        String body = count == 1 ? "An item is waiting here" : count + " items are waiting here";
        try {
            nm.notify(ID_PLACE, new NotificationCompat.Builder(ctx, CH_PLACES)
                    .setContentTitle("Púca Notes")
                    .setContentText(body)
                    .setSmallIcon(android.R.drawable.ic_dialog_map)
                    .setContentIntent(openApp(ctx, ID_PLACE, NAV_REMINDERS))
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_REMINDER)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setDefaults(NotificationCompat.DEFAULT_ALL)
                    .build());
        } catch (SecurityException ignored) { /* as above */ }
    }

    /** Location reminders could not restart on their own (after a reboot,
     *  Android refused the location service): the user has to open the app. */
    static void postPlacesPaused(Context ctx) {
        ensureChannels(ctx);
        NotificationManager nm = nm(ctx);
        if (nm == null) return;
        try {
            nm.notify(ID_PLACES_PAUSED, new NotificationCompat.Builder(ctx, CH_STATUS)
                    .setContentTitle("Púca Notes")
                    .setContentText("Open Púca Notes once to resume location reminders")
                    .setSmallIcon(android.R.drawable.ic_dialog_map)
                    .setContentIntent(openApp(ctx, ID_PLACES_PAUSED, NAV_REMINDERS))
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setCategory(NotificationCompat.CATEGORY_STATUS)
                    .build());
        } catch (SecurityException ignored) { /* as above */ }
    }

    /** The location service's own ongoing notification (it must have one). */
    static Notification locationOngoing(Context ctx) {
        ensureChannels(ctx);
        return new NotificationCompat.Builder(ctx, CH_STATUS)
                .setContentTitle("Location reminders on")
                .setContentText("Púca Notes is watching for your saved places on this phone")
                .setSmallIcon(android.R.drawable.ic_dialog_map)
                .setContentIntent(openApp(ctx, ID_LOCATION_ONGOING, NAV_REMINDERS))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }

    static void cancel(Context ctx, int id) {
        NotificationManager nm = nm(ctx);
        if (nm != null) nm.cancel(id);
    }

    /** Sign-out: nothing this session posted stays in the shade. */
    static void cancelSessionNotices(Context ctx) {
        cancel(ctx, ID_DUE);
        cancel(ctx, ID_STALE);
        cancel(ctx, ID_PLACE);
        cancel(ctx, ID_PLACES_PAUSED);
    }
}
