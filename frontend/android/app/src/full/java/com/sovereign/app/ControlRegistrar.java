package com.sovereign.app;

import android.app.PendingIntent;

import com.sovereign.app.control.PhoneControl;
import com.sovereign.app.control.ShareHost;
import com.sovereign.app.control.SovereignPhoneControlPlugin;

/**
 * FULL build: wires control of this phone from a call (the :phone-control
 * module) into the app. Lite compiles src/lite/java's ControlRegistrar
 * instead, which does nothing, and never sees the module (app/build.gradle).
 *
 * The module needs two things from the app's screen share, and gets them
 * through {@link ShareHost}: what the share captures right now, and a line
 * with an action on the share's notification while someone is in control.
 */
final class ControlRegistrar {

    private ControlRegistrar() {}

    /** Before super.onCreate, with the other plugins. */
    static void register(MainActivity activity) {
        activity.registerPlugin(SovereignPhoneControlPlugin.class);
        PhoneControl.install(activity.getApplicationContext(), new ShareHost() {
            @Override
            public long[] shareState() {
                return ScreenShareService.contentState();
            }

            @Override
            public void setShareNotice(String line, String actionLabel, PendingIntent action) {
                ScreenShareService.setNotice(line, actionLabel, action);
            }
        });
    }
}
