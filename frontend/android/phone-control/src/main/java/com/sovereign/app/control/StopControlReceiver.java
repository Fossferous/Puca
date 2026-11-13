package com.sovereign.app.control;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * "Stop control" on the share's notification. Not exported: only the
 * module's own immutable PendingIntent reaches it.
 */
public class StopControlReceiver extends BroadcastReceiver {

    static final String ACTION_STOP = "com.sovereign.app.control.STOP_CONTROL";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            PhoneControl.end(PhoneControl.STOPPED_NOTIFICATION, true);
        }
    }
}
