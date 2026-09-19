package com.sovereign.notes;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * About hourly, with any network, while a session is stored: refresh the
 * reminder feed so a due time set on another device fires here even though
 * Púca Notes has not been opened (owner decision; docs/NOTES.md).
 *
 * A platform JobScheduler job — no WorkManager dependency. Persisted across
 * reboots (RECEIVE_BOOT_COMPLETED). Doze and App Standby decide when it
 * really runs: roughly hourly for an app in regular use, much less often for
 * one left unopened for days, which is why a due time set elsewhere less than
 * about an hour ahead can arrive late. That is stated to the user, not hidden.
 */
public class ReminderRefreshJob extends JobService {

    static final int JOB_ID = 7302;
    private static final long PERIOD_MS = 60 * 60_000L;
    private static final long FLEX_MS = 15 * 60_000L;
    private static final int TIMEOUT_MS = 15_000;

    /** Idempotent: an already-pending job keeps its schedule. */
    static void schedule(Context ctx) {
        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null || js.getPendingJob(JOB_ID) != null) return;
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(ctx, ReminderRefreshJob.class))
                .setPeriodic(PERIOD_MS, FLEX_MS)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build();
        try {
            js.schedule(job);
        } catch (Exception e) {
            android.util.Log.w("NotesReminders", "could not schedule the refresh: " + e);
        }
    }

    static void cancel(Context ctx) {
        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js != null) js.cancel(JOB_ID);
    }

    static boolean scheduled(Context ctx) {
        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        return js != null && js.getPendingJob(JOB_ID) != null;
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        final Context ctx = getApplicationContext();
        new Thread(() -> {
            int r = ReminderRefresh.NO_SESSION;
            try {
                r = ReminderRefresh.refresh(ctx, TIMEOUT_MS);
                android.util.Log.i("NotesReminders", "background refresh: " + r);
            } catch (Throwable t) {
                android.util.Log.w("NotesReminders", "background refresh failed: " + t);
            } finally {
                // No reschedule-with-backoff: the next period is the retry.
                jobFinished(params, false);
            }
            if (r == ReminderRefresh.NO_SESSION) cancel(ctx);
        }, "notes-reminder-refresh").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }
}
