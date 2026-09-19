package com.sovereign.notes;

import android.Manifest;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.content.ContextCompat;

/**
 * Location reminders for Púca Notes: a foreground service of type LOCATION
 * only, running exactly while there are fences to watch and a location grant
 * to watch them with.
 *
 * The watch, the adaptive interval and the arrival rule are Púca's
 * (KeepAliveService.java's location half, with GeofenceEngine copied byte for
 * byte — GeofenceParityTest keeps the copies identical). What Notes does NOT
 * carry is Púca's specialUse fallback: this service has one job, so when
 * Android refuses a location service (a background start on 14+ without the
 * "all the time" grant) it stops and says so once, instead of pretending.
 *
 * PRIVACY: never a network call; fixes are compared on-device with circles
 * stored content-free ({taskId, lat, lon, r}) by NotesLocationPlugin; the
 * arrival notification is a count, never a place or an item.
 */
public class NotesGeofenceService extends Service {

    /** Between fixes, ask again only after moving this far (Púca's value). */
    private static final float MIN_DISTANCE_M = 30f;

    private static volatile NotesGeofenceService live;

    private final GeofenceEngine engine = new GeofenceEngine();
    private LocationListener fixListener;
    private long currentIntervalMs;

    static boolean hasForegroundLocation(Context ctx) {
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
    }

    static boolean hasBackgroundLocation(Context ctx) {
        if (Build.VERSION.SDK_INT < 29) return hasForegroundLocation(ctx);
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Start or stop to match the stored fences. Called from the plugin, i.e.
     * with the app in the foreground, where Android allows the start. Returns
     * whether the service is (now) meant to be running.
     */
    static boolean sync(Context ctx) {
        boolean want = !GeofenceStore.load(ctx).isEmpty() && hasForegroundLocation(ctx);
        if (!want) {
            ctx.stopService(new Intent(ctx, NotesGeofenceService.class));
            return false;
        }
        NotesGeofenceService s = live;
        if (s != null) {
            new Handler(Looper.getMainLooper()).post(() -> {
                if (live == s) s.reloadFences();
            });
            return true;
        }
        try {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, NotesGeofenceService.class));
            return true;
        } catch (Exception e) {
            android.util.Log.i("NotesGeofence", "start refused: " + e);
            return false;
        }
    }

    /** After a reboot or an update: resume if Android allows it from here. */
    static void resumeInBackground(Context ctx) {
        if (GeofenceStore.load(ctx).isEmpty()) return;
        if (!hasBackgroundLocation(ctx)) {
            NotesNotifier.postPlacesPaused(ctx);
            return;
        }
        try {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, NotesGeofenceService.class));
        } catch (Exception e) {
            android.util.Log.i("NotesGeofence", "background start refused: " + e);
            NotesNotifier.postPlacesPaused(ctx);
        }
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, NotesGeofenceService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        live = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NotesNotifier.ID_LOCATION_ONGOING, NotesNotifier.locationOngoing(this),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NotesNotifier.ID_LOCATION_ONGOING, NotesNotifier.locationOngoing(this));
            }
        } catch (Exception e) {
            // Deliberately broad: a refused location start is a
            // SecurityException on some releases and a
            // ForegroundServiceStartNotAllowedException (IllegalStateException)
            // on others, and an uncaught throw here is process death. Stopping
            // at once also cancels the "must call startForeground" timer.
            android.util.Log.i("NotesGeofence", "foreground refused: " + e);
            NotesNotifier.postPlacesPaused(this);
            stopSelf();
            return START_NOT_STICKY;
        }
        NotesNotifier.cancel(this, NotesNotifier.ID_PLACES_PAUSED);
        reloadFences();
        if (!engine.hasFences()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        live = null;
        stopLocationWatch();
        super.onDestroy();
    }

    /** Provider preference, as Púca: the platform fused provider (AOSP, no
     *  Play Services), else network, else GPS. Shared with the one-shot fix. */
    static String pickProvider(LocationManager lm) {
        if (Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER)) {
            return LocationManager.FUSED_PROVIDER;
        }
        if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) return LocationManager.NETWORK_PROVIDER;
        if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) return LocationManager.GPS_PROVIDER;
        return null;
    }

    private void reloadFences() {
        engine.setFences(GeofenceStore.load(this));
        boolean want = engine.hasFences() && hasForegroundLocation(this);
        if (want && fixListener == null) {
            startLocationWatch(GeofenceEngine.MIN_INTERVAL_MS);
        } else if (!want) {
            stopLocationWatch();
            if (!engine.hasFences()) stopSelf();
        }
    }

    private void startLocationWatch(long intervalMs) {
        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return;
        String provider = pickProvider(lm);
        if (provider == null) return; // location off: nothing arrives, nothing fires
        LocationListener l = new LocationListener() {
            @Override public void onLocationChanged(Location loc) { onFix(loc); }
            @Override public void onStatusChanged(String p, int s, android.os.Bundle e) {}
            @Override public void onProviderEnabled(String p) {}
            @Override public void onProviderDisabled(String p) {}
        };
        try {
            lm.requestLocationUpdates(provider, intervalMs, MIN_DISTANCE_M, l, Looper.getMainLooper());
            fixListener = l;
            currentIntervalMs = intervalMs;
        } catch (SecurityException ignored) {
            // Revoked between the check and the call: the watch stays off.
        }
    }

    private void stopLocationWatch() {
        if (fixListener == null) return;
        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (lm != null) {
            try {
                lm.removeUpdates(fixListener);
            } catch (SecurityException ignored) { /* already revoked */ }
        }
        fixListener = null;
        currentIntervalMs = 0;
    }

    private void onFix(Location loc) {
        GeofenceEngine.Result r = engine.onFix(
                loc.getLatitude(), loc.getLongitude(),
                loc.hasAccuracy() ? loc.getAccuracy() : 9999f);
        if (!r.fired.isEmpty()) NotesNotifier.postPlaces(this, r.fired.size());
        if (fixListener != null
                && (r.nextIntervalMs < currentIntervalMs / 2 || r.nextIntervalMs > currentIntervalMs * 2)) {
            stopLocationWatch();
            startLocationWatch(r.nextIntervalMs);
        }
    }
}
