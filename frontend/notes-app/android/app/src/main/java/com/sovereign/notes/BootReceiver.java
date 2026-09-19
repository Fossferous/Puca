package com.sovereign.notes;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Re-arm after anything that wipes or skews alarms: a reboot, an update of
 * this app, the clock or time zone being changed, or the exact-alarm grant
 * changing. Alarms do not survive a reboot on Android; the refresh job does
 * (persisted), but it is re-scheduled here too in case it was dropped.
 *
 * Location reminders are resumed here as far as Android allows a location
 * service to start from the background; where it refuses, NotesGeofenceService
 * posts one "Open Púca Notes once to resume location reminders" notice.
 *
 * Exported because system broadcasts must reach it; every action it answers
 * is a protected broadcast (or, for MY_PACKAGE_REPLACED, sent only to this
 * app), and it reads nothing from the intent beyond the action.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) return;
        switch (action) {
            case Intent.ACTION_BOOT_COMPLETED:
            case Intent.ACTION_MY_PACKAGE_REPLACED:
            case Intent.ACTION_TIME_CHANGED:
            case Intent.ACTION_TIMEZONE_CHANGED:
            case "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED":
                break;
            default:
                return;
        }
        Context ctx = context.getApplicationContext();
        ReminderAlarms.arm(ctx);
        String token;
        synchronized (ReminderStore.LOCK) {
            token = ReminderStore.token(ctx);
        }
        if (token != null) ReminderRefreshJob.schedule(ctx);
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            NotesGeofenceService.resumeInBackground(ctx);
        }
    }
}
