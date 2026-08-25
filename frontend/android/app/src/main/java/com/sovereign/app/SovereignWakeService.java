package com.sovereign.app;

import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * The doorbell. Receives the server's constant-payload wake signal and does
 * exactly one thing: gets the delivery socket connected so the parked frames
 * flow — over OUR server, never through here.
 *
 * THIS CLASS NEVER POSTS A NOTIFICATION and never reads the message payload
 * beyond discarding it. The payload is {"w":"1"} by construction (the server's
 * wake::fcm::build_message is the entire wire surface, pinned by a test that
 * asserts the full serialised body). Content, sender names, conversation ids —
 * all of that arrives over the native socket after this fires. What Google
 * carries: a device token, the app id, timing. What Google renders: nothing.
 *
 * A high-priority FCM message grants a short Doze maintenance window and a
 * foreground-service start exemption — the two platform privileges a
 * self-hosted socket cannot obtain on its own, and the entire reason this
 * class exists.
 */
public class SovereignWakeService extends FirebaseMessagingService {

    private static final String TAG = "PucaWake";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        // Deliberately not inspected: there is nothing in it, and acting on
        // payload contents would create the channel this design forbids.
        Log.i(TAG, "wake signal — ensuring delivery socket");
        // The user's switches hold even against a doorbell: no credentials
        // means signed out or opted out of background delivery (the JS side
        // hands the socket nothing in either case), and pushEnabled off means
        // notifications are declined wholesale. A wake for such a phone
        // resurrecting the "Connected" service would be the app overruling
        // its own settings.
        if (!PushPrefs.deliveryOptIn(this)
                || PushPrefs.authToken(this) == null
                || !PushPrefs.pushEnabled(this)) {
            Log.i(TAG, "wake ignored: delivery not configured or declined");
            return;
        }
        KeepAliveService svc = KeepAliveService.liveInstance();
        if (svc != null && svc.pokeDelivery()) {
            return;
        }
        // No service, or one running without a delivery engine (geofence-only,
        // control-only). The high-priority wake grants the FGS-start
        // exemption; ACTION_WAKE starts the delivery socket, which drains the
        // server-side queue.
        //
        // It is an ACTION, not a set of reason extras, and that distinction is
        // load-bearing: reason extras are a DECLARATION of complete desired
        // state, so sending control=false here told a service that was holding
        // a live My Devices session open to let go of it — releasing the CPU
        // wake lock mid-session, and stopping a geofence-only service's
        // location watch on the way past. A doorbell knows only that something
        // is parked; it must not answer questions it was never asked.
        try {
            Intent i = new Intent(this, KeepAliveService.class);
            i.setAction(KeepAliveService.ACTION_WAKE);
            if (Build.VERSION.SDK_INT >= 26) {
                startForegroundService(i);
            } else {
                startService(i);
            }
        } catch (Exception e) {
            // Exemption window missed or policy said no: the frames stay
            // parked server-side (1h TTL) and the next app open drains them.
            Log.i(TAG, "could not start delivery service from wake: " + e.getMessage());
        }
    }

    @Override
    public void onNewToken(String token) {
        // Registering needs the account's JWT, which lives in WebView storage
        // this process cannot read. Park it; pushRegistration.ts drains it on
        // the next app start. Bounded gap, stated rather than papered over.
        PushPrefs.setPendingWakeToken(this, token);
        Log.i(TAG, "wake token rotated; will register on next app start");
    }
}
