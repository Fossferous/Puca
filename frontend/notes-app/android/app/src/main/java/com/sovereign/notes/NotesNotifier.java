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
    /** The session ended: DEFAULT importance (it sounds and shows in the
     *  shade), because until the user signs in again Notes cannot see new or
     *  changed due times — and Púca is only quiet while Notes can. Its own
     *  channel: a channel's importance cannot be raised after creation, and
     *  the low-importance status channel must stay low for the ongoing
     *  location notification. */
    static final String CH_SESSION = "notes_session";

    /** Where a notification, a launcher shortcut, the quick tile or the
     *  home-screen widget asks the page to land (NotesNativePlugin). One
     *  vocabulary for all four, so the Java side has a single source and this
     *  class's content-free contract covers every entry point. */
    static final String EXTRA_NAV = "notes_nav";
    static final String NAV_REMINDERS = "reminders";
    /** The page checks its own session and lands on sign-in if it is dead. */
    static final String NAV_SIGNIN = "signin";
    /** Open the composer. Four constants, no ids, no user data - what the
     *  launcher, the shade and the home screen may hold. */
    static final String NAV_COMPOSE_LIST = "compose-list";
    static final String NAV_COMPOSE_NOTE = "compose-note";
    static final String NAV_COMPOSE_DRAW = "compose-draw";
    static final String NAV_COMPOSE_PHOTO = "compose-photo";

    /** The ONE item a due notification came for, when exactly one did. An
     *  integer the server already holds in clear and already sends this
     *  phone in the content-free feed - never a title, never item text. */
    static final String EXTRA_ITEM = "notes_item";

    static final int ID_DUE = 7401;
    static final int ID_STALE = 7402;
    static final int ID_PLACE = 7403;
    static final int ID_LOCATION_ONGOING = 7404;
    static final int ID_PLACES_PAUSED = 7405;
    /** The quick-settings tile's own PendingIntent request code (see the
     *  distinct-requestCode note on openApp). The widget's four live in
     *  NotesWidgetProvider, clear of these. */
    static final int RC_TILE = 7406;

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
        if (nm.getNotificationChannel(CH_SESSION) == null) {
            NotificationChannel ch = new NotificationChannel(
                    CH_SESSION, "Sign-in needed", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("Your session ended, so reminders set elsewhere cannot reach this phone until you sign in.");
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
        return openApp(ctx, requestCode, nav, -1L);
    }

    /** As above, naming the one item that came due (or -1 for none). */
    static PendingIntent openApp(Context ctx, int requestCode, String nav, long itemId) {
        return PendingIntent.getActivity(ctx, requestCode, openIntent(ctx, nav, itemId),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** The launch intent itself, for a caller that wants to start the
     *  activity directly (the quick-settings tile) rather than wrap it. */
    static Intent openIntent(Context ctx, String nav, long itemId) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (nav != null) open.putExtra(EXTRA_NAV, nav);
        if (itemId > 0) open.putExtra(EXTRA_ITEM, itemId);
        return open;
    }

    /** ONE collapsing notification for everything due right now.
     *  `soleItemId` is the single item that came due, or -1 when several did
     *  (ReminderPlan.soleDue): a tap then opens that item's note instead of
     *  the Reminders list. The notification's WORDS never change - it is
     *  still dueText(count), a count and nothing else. The request code stays
     *  ID_DUE: FLAG_UPDATE_CURRENT updates the extras of the existing
     *  PendingIntent, so no second code is needed and none should be added. */
    static void postDue(Context ctx, int count, long soleItemId) {
        if (count <= 0) return;
        ensureChannels(ctx);
        NotificationManager nm = nm(ctx);
        if (nm == null) return;
        try {
            nm.notify(ID_DUE, new NotificationCompat.Builder(ctx, CH_REMINDERS)
                    .setContentTitle("Púca Notes")
                    .setContentText(ReminderPlan.dueText(count))
                    .setSmallIcon(android.R.drawable.ic_popup_reminder)
                    .setContentIntent(openApp(ctx, ID_DUE, NAV_REMINDERS, soleItemId))
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

    /** The session died (a 401 from the refresh or the pre-fire check):
     *  once, at DEFAULT importance, and a tap (or its button) opens Notes on
     *  sign-in. */
    static void postStale(Context ctx) {
        ensureChannels(ctx);
        NotificationManager nm = nm(ctx);
        if (nm == null) return;
        PendingIntent signIn = openApp(ctx, ID_STALE, NAV_SIGNIN);
        try {
            nm.notify(ID_STALE, new NotificationCompat.Builder(ctx, CH_SESSION)
                    .setContentTitle("Púca Notes")
                    .setContentText("Sign in again to keep getting reminders")
                    .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                    .setContentIntent(signIn)
                    .addAction(0, "Sign in", signIn)
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setCategory(NotificationCompat.CATEGORY_STATUS)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
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
