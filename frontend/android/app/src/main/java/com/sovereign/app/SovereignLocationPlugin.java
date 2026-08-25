package com.sovereign.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Location for task place-reminders — permissions, one-shot fixes for saving
 * a place, and handing the fence set to KeepAliveService's geofence engine.
 *
 * PRIVACY CONTRACT (mirrors taskPlaces.ts): coordinates never leave the
 * device. This plugin never makes a network call; fences are persisted
 * content-free ({taskId, lat, lon, r} — no labels) in app-private prefs, and
 * evaluation happens in-process against OS fixes. There is deliberately no
 * Play Services / Firebase dependency: the whole APK builds and runs on
 * de-Googled Android, and this feature must too.
 *
 * Separate plugin (not more SovereignApp methods) for the usual reason: an
 * older APK must fail the FIRST call cleanly so the JS side latches off,
 * rather than half-working.
 */
@CapacitorPlugin(
    name = "SovereignLocation",
    permissions = {
        @Permission(alias = "location", strings = {
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        }),
        @Permission(alias = "backgroundLocation", strings = {
            Manifest.permission.ACCESS_BACKGROUND_LOCATION,
        }),
    }
)
public class SovereignLocationPlugin extends Plugin {

    private static final long SINGLE_FIX_TIMEOUT_MS = 20_000L;
    /** A last-known fix older than this is another errand entirely. */
    private static final long LAST_KNOWN_MAX_AGE_MS = 2 * 60_000L;

    private boolean granted(String perm) {
        return ContextCompat.checkSelfPermission(getContext(), perm)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean foregroundGranted() {
        return granted(Manifest.permission.ACCESS_FINE_LOCATION)
                || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    private boolean backgroundGranted() {
        // The permission exists from API 29; before that, foreground IS
        // all-the-time (checkSelfPermission on the unknown constant would
        // report denied and wrongly gate the feature off).
        if (Build.VERSION.SDK_INT < 29) return foregroundGranted();
        return granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION);
    }

    @PluginMethod
    public void status(PluginCall call) {
        LocationManager lm =
                (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        boolean locationOn = false;
        if (lm != null) {
            locationOn = Build.VERSION.SDK_INT >= 28
                    ? lm.isLocationEnabled()
                    : lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
                        || lm.isProviderEnabled(LocationManager.GPS_PROVIDER);
        }
        JSObject ret = new JSObject();
        ret.put("foreground", foregroundGranted());
        ret.put("precise", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        ret.put("background", backgroundGranted());
        ret.put("locationOn", locationOn);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestForegroundPermission(PluginCall call) {
        if (foregroundGranted()) {
            foregroundResult(call);
            return;
        }
        requestPermissionForAlias("location", call, "foregroundResult");
    }

    @PermissionCallback
    private void foregroundResult(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", foregroundGranted());
        ret.put("precise", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        call.resolve(ret);
    }

    /**
     * "Allow all the time". MUST be asked separately, after foreground:
     * Android 11+ ignores a request carrying both, and answers this one not
     * with a dialog but by bouncing the user through the app's location
     * settings page. Calling it with foreground still denied resolves false
     * immediately rather than burning the request.
     */
    @PluginMethod
    public void requestBackgroundPermission(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT < 29 || backgroundGranted()) {
            ret.put("granted", backgroundGranted());
            call.resolve(ret);
            return;
        }
        if (!foregroundGranted()) {
            ret.put("granted", false);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("backgroundLocation", call, "backgroundResult");
    }

    @PermissionCallback
    private void backgroundResult(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", backgroundGranted());
        call.resolve(ret);
    }

    /**
     * One-shot fix for "save this place where I'm standing". A single fix by
     * design — no map picker exists because a tile server learns where every
     * pan looks, and no watch is started here (that is the service's job).
     */
    @PluginMethod
    public void currentPosition(PluginCall call) {
        if (!foregroundGranted()) {
            call.reject("no location permission");
            return;
        }
        LocationManager lm =
                (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) {
            call.reject("no location manager");
            return;
        }
        String provider = KeepAliveService.pickProvider(lm);
        if (provider == null) {
            call.reject("location is off");
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                lm.getCurrentLocation(provider, null,
                        ContextCompat.getMainExecutor(getContext()),
                        loc -> finishFix(call, lm, loc));
            } else {
                // Pre-30: requestSingleUpdate has no timeout of its own, and a
                // basement with no GPS would park the call forever. Both the
                // fix and the timeout land on the main looper, but a fix can
                // already be QUEUED when the timeout runs (or vice versa) —
                // `done` makes whichever drains second a no-op instead of a
                // double resolve on the PluginCall.
                Handler h = new Handler(Looper.getMainLooper());
                final boolean[] done = new boolean[1];
                final LocationListener[] box = new LocationListener[1];
                LocationListener once = new LocationListener() {
                    @Override
                    public void onLocationChanged(Location location) {
                        if (done[0]) return;
                        done[0] = true;
                        h.removeCallbacksAndMessages(box);
                        finishFix(call, lm, location);
                    }
                    @Override public void onStatusChanged(String p, int s, android.os.Bundle e) {}
                    @Override public void onProviderEnabled(String p) {}
                    @Override public void onProviderDisabled(String p) {}
                };
                box[0] = once;
                lm.requestSingleUpdate(provider, once, Looper.getMainLooper());
                h.postAtTime(() -> {
                    if (done[0]) return;
                    done[0] = true;
                    try {
                        lm.removeUpdates(once);
                    } catch (SecurityException ignored) { /* already revoked */ }
                    finishFix(call, lm, null);
                }, box, android.os.SystemClock.uptimeMillis() + SINGLE_FIX_TIMEOUT_MS);
            }
        } catch (SecurityException e) {
            call.reject("location permission revoked");
        }
    }

    /** Resolve with the fix, or a fresh-enough last-known one, or reject. */
    private void finishFix(PluginCall call, LocationManager lm, Location loc) {
        if (loc == null) {
            loc = freshLastKnown(lm);
        }
        if (loc == null) {
            call.reject("no location fix");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("lat", loc.getLatitude());
        ret.put("lon", loc.getLongitude());
        ret.put("accuracy", loc.hasAccuracy() ? loc.getAccuracy() : 9999);
        call.resolve(ret);
    }

    private Location freshLastKnown(LocationManager lm) {
        Location best = null;
        try {
            for (String p : lm.getProviders(true)) {
                Location l = lm.getLastKnownLocation(p);
                if (l == null) continue;
                long ageMs = (android.os.SystemClock.elapsedRealtimeNanos()
                        - l.getElapsedRealtimeNanos()) / 1_000_000L;
                if (ageMs > LAST_KNOWN_MAX_AGE_MS) continue;
                if (best == null || l.getAccuracy() < best.getAccuracy()) best = l;
            }
        } catch (SecurityException ignored) { /* revoked mid-call */ }
        return best;
    }

    /**
     * Replace the persisted fence set and wake the engine. Only the four
     * content-free fields are copied — whatever else the JS sends is dropped
     * here so nothing labelled can ever reach native storage.
     */
    @PluginMethod
    public void setFences(PluginCall call) {
        try {
            JSArray fences = call.getArray("fences");
            JSONArray out = new JSONArray();
            for (int i = 0; fences != null && i < fences.length(); i++) {
                JSONObject o = fences.getJSONObject(i);
                String id = o.optString("id", "");
                double lat = o.optDouble("lat", Double.NaN);
                double lon = o.optDouble("lon", Double.NaN);
                double r = o.optDouble("radiusM", Double.NaN);
                if (id.isEmpty() || Double.isNaN(lat) || Double.isNaN(lon) || Double.isNaN(r)) continue;
                JSONObject rec = new JSONObject();
                rec.put("id", id);
                rec.put("lat", lat);
                rec.put("lon", lon);
                rec.put("r", r);
                out.put(rec);
            }
            GeofenceStore.save(getContext(), out);
            KeepAliveService.fencesChanged();
            call.resolve();
        } catch (Exception e) {
            call.reject("could not store fences: " + e.getMessage());
        }
    }

    /** The app's settings page — recovery once background location hits the
     *  silent denial lockout, where requesting again shows nothing. */
    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not open settings: " + e.getMessage());
        }
    }
}
