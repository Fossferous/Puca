package com.sovereign.notes;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.util.List;
import java.util.Map;

/**
 * The alarm went off: post what is due, remember it fired, arm the next one.
 *
 * Before firing it asks the server once (a few seconds, no retries) when a
 * session is stored, so an item completed or re-timed on another device since
 * the last refresh is not announced. Offline, it fires from what it has —
 * a reminder a little stale beats a missed one. Not exported: only this
 * app's own PendingIntent reaches it.
 */
public class ReminderReceiver extends BroadcastReceiver {

    static final String ACTION_FIRE = "com.sovereign.notes.REMINDER_FIRE";
    /** Connect + read budget for the verify fetch; a receiver has ~10 s. */
    private static final int VERIFY_TIMEOUT_MS = 4000;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_FIRE.equals(intent.getAction())) return;
        final Context ctx = context.getApplicationContext();
        final PendingResult pr = goAsync();
        new Thread(() -> {
            try {
                ReminderRefresh.refresh(ctx, VERIFY_TIMEOUT_MS);
                fireDue(ctx);
            } catch (Throwable t) {
                android.util.Log.w("NotesReminders", "fire failed: " + t);
            } finally {
                pr.finish();
            }
        }, "notes-reminder-fire").start();
    }

    /** Post one notification for everything owed, record the markers, re-arm.
     *  Markers are recorded even when the post cannot be shown (permission
     *  off): otherwise the alarm would re-fire the same items forever. */
    static void fireDue(Context ctx) {
        int count;
        synchronized (ReminderStore.LOCK) {
            List<ReminderPlan.Entry> entries = ReminderStore.entries(ctx);
            Map<String, String> fired = ReminderStore.fired(ctx);
            ReminderPlan.Result r = ReminderPlan.plan(entries, fired, System.currentTimeMillis());
            count = r.dueNow.size();
            ReminderStore.setFired(ctx, r.prunedFired);
        }
        if (count > 0) NotesNotifier.postDue(ctx, count);
        ReminderAlarms.arm(ctx);
    }
}
