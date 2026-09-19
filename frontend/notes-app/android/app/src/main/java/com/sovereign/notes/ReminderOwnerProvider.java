package com.sovereign.notes;

import android.Manifest;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationManagerCompat;

import java.util.List;
import java.util.Map;

/**
 * Púca asks here, before posting a due-item notification on a phone that also
 * has Púca Notes: "will you announce it?" — owner decision: when Notes is
 * installed AND actually able to deliver reminders, Notes owns them and Púca
 * stays quiet, so one due item is one notification, never zero.
 *
 * READ-ONLY and one row: {@code ownsDueReminders} = 1 or 0, from
 * {@link ReminderRules#ownsDueReminders} (live session, the same account Púca
 * names in the {@code account} query parameter, the feed read within three
 * hours, notifications allowed, the alarm set when something is owed).
 *
 * Only Púca can ask: the provider is guarded by a permission with
 * protectionLevel="signature", granted by Android solely to an app signed with
 * the same key (Púca and Púca Notes both release-sign with the Púca keystore).
 * Nothing else is exposed — no id, no time, no count — and no write exists.
 *
 * Absence is the old answer: a Púca Notes APK from before this provider has
 * none, Púca's query then fails, and Púca notifies as it always did.
 */
public class ReminderOwnerProvider extends ContentProvider {

    static final String AUTHORITY = "com.sovereign.notes.reminderowner";
    static final String COLUMN = "ownsDueReminders";

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        Context ctx = getContext();
        boolean owns = false;
        if (ctx != null) {
            try {
                owns = ReminderRules.ownsDueReminders(state(ctx), uri.getQueryParameter("account"),
                        System.currentTimeMillis());
            } catch (Exception e) {
                owns = false; // never "yes" on a failure: Púca then notifies
            }
        }
        MatrixCursor c = new MatrixCursor(new String[] { COLUMN });
        c.addRow(new Object[] { owns ? 1 : 0 });
        android.util.Log.i("NotesReminders", "reminder owner asked: " + (owns ? "yes" : "no"));
        return c;
    }

    static ReminderRules.OwnerState state(Context ctx) {
        String token;
        String account;
        long lastSync;
        List<ReminderPlan.Entry> entries;
        Map<String, String> fired;
        synchronized (ReminderStore.LOCK) {
            token = ReminderStore.token(ctx);
            account = ReminderStore.account(ctx);
            lastSync = ReminderStore.lastSync(ctx);
            entries = ReminderStore.entries(ctx);
            fired = ReminderStore.fired(ctx);
        }
        long now = System.currentTimeMillis();
        boolean alarmNeeded = ReminderPlan.alarmAt(ReminderPlan.plan(entries, fired, now), now) >= 0;
        return new ReminderRules.OwnerState(token != null, account, lastSync,
                notificationsAllowed(ctx), alarmNeeded, ReminderAlarms.present(ctx));
    }

    /** The runtime permission (13+), the app-level switch, and the Reminders
     *  channel: any one off and a reminder would be posted into nothing. */
    static boolean notificationsAllowed(Context ctx) {
        if (Build.VERSION.SDK_INT >= 33
                && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return false;
        return !NotesNotifier.remindersChannelOff(ctx);
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("read-only");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only");
    }
}
