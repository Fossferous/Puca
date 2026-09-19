package com.sovereign.notes;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.util.List;
import java.util.Map;

/**
 * The ONE alarm: set for the next moment a reminder is owed, from the stored
 * entries and fired markers. One is enough because one notification collapses
 * everything due at once; re-armed after every fire, sync, refresh and boot.
 *
 * Exact when Android lets us (USE_EXACT_ALARM on 13+, SCHEDULE_EXACT_ALARM on
 * 12-12L, nothing needed below), otherwise inexact-while-idle, which Doze may
 * push back by minutes — the page's banner says so when that is the case.
 */
final class ReminderAlarms {

    private static final int REQUEST_CODE = 7301;

    private ReminderAlarms() {}

    static boolean exactAllowed(Context ctx) {
        if (Build.VERSION.SDK_INT < 31) return true;
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    private static PendingIntent pending(Context ctx) {
        Intent i = new Intent(ctx, ReminderReceiver.class).setAction(ReminderReceiver.ACTION_FIRE);
        return PendingIntent.getBroadcast(ctx, REQUEST_CODE, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Recompute and (re)set the alarm, or cancel it when nothing is owed. */
    static void arm(Context ctx) {
        List<ReminderPlan.Entry> entries;
        Map<String, String> fired;
        synchronized (ReminderStore.LOCK) {
            entries = ReminderStore.entries(ctx);
            fired = ReminderStore.fired(ctx);
        }
        long now = System.currentTimeMillis();
        long at = ReminderPlan.alarmAt(ReminderPlan.plan(entries, fired, now), now);
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = pending(ctx);
        if (at < 0) {
            am.cancel(pi);
            pi.cancel(); // and the record, so present() reads "no alarm"
            return;
        }
        try {
            if (exactAllowed(ctx)) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (SecurityException e) {
            // Exact permission revoked between the check and the call.
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    /**
     * Is this app's alarm PendingIntent alive? A force-stop cancels every
     * PendingIntent the app owns (and with them its alarms), so "absent while
     * something is owed" means the alarm cannot fire. Every cancel here also
     * cancels the PendingIntent, so present() is false after one of ours too.
     */
    static boolean present(Context ctx) {
        Intent i = new Intent(ctx, ReminderReceiver.class).setAction(ReminderReceiver.ACTION_FIRE);
        return PendingIntent.getBroadcast(ctx, REQUEST_CODE, i,
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE) != null;
    }

    static void cancel(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = pending(ctx);
        if (am != null) am.cancel(pi);
        pi.cancel();
    }
}
