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
 * a reminder a little stale beats a missed one. And when that check finds the
 * session DEAD (401), the items this alarm woke up for are still announced
 * (ReminderRules.entriesToFire): the dead-session path drops passed entries
 * unchecked, and without this the reminder that was firing at that very
 * moment vanished, leaving only the "sign in again" notice. Not exported:
 * only this app's own PendingIntent reaches it.
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
                List<ReminderPlan.Entry> before;
                synchronized (ReminderStore.LOCK) {
                    before = ReminderStore.entries(ctx);
                }
                int outcome = ReminderRefresh.refresh(ctx, VERIFY_TIMEOUT_MS);
                fireDue(ctx, before, outcome);
            } catch (Throwable t) {
                android.util.Log.w("NotesReminders", "fire failed: " + t);
            } finally {
                pr.finish();
            }
        }, "notes-reminder-fire").start();
    }

    /** Post one notification for everything owed, record the markers, re-arm.
     *  Markers are recorded even when the post cannot be shown (permission
     *  off): otherwise the alarm would re-fire the same items forever.
     *  `before` is the store as it was before the pre-fire check and
     *  `outcome` what that check returned (see the class comment). */
    static void fireDue(Context ctx, List<ReminderPlan.Entry> before, int outcome) {
        int count;
        long sole;
        synchronized (ReminderStore.LOCK) {
            long now = System.currentTimeMillis();
            List<ReminderPlan.Entry> entries =
                    ReminderRules.entriesToFire(before, ReminderStore.entries(ctx), outcome, now);
            Map<String, String> fired = ReminderStore.fired(ctx);
            ReminderPlan.Result r = ReminderPlan.plan(entries, fired, now);
            count = r.dueNow.size();
            // The one id a tap may open, or -1 (ReminderPlan.soleDue).
            sole = ReminderPlan.soleDue(r);
            ReminderStore.setFired(ctx, r.prunedFired);
        }
        // A count and the check's outcome only — never an id, a time or a mark.
        android.util.Log.i("NotesReminders", "alarm: " + count + " due (check " + outcome + ")");
        if (count > 0) NotesNotifier.postDue(ctx, count, sole);
        ReminderAlarms.arm(ctx);
    }
}
